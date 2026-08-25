"""Camera, tablet, preview, and recording adapters."""

from __future__ import annotations

from dataclasses import dataclass
import math
import threading
import time

import cv2

from config import TARGET_FPS, TARGET_HEIGHT, TARGET_WIDTH


@dataclass(frozen=True)
class ExposureResult:
    status: str
    supported: bool
    requested_delta: int
    previous_value: float | None
    actual_value: float | None
    error_code: str | None = None


def apply_manual_exposure(capture, delta):
    try:
        previous = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if not math.isfinite(previous):
            previous = None
        capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        target = (previous if previous is not None else 0.0) + delta
        capture.set(cv2.CAP_PROP_EXPOSURE, target)
        actual = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if not math.isfinite(actual):
            actual = None
        if actual is None or previous is None or math.isclose(actual, previous, abs_tol=1e-6):
            return ExposureResult(
                "failed", True, delta, previous, actual,
                "exposure_not_applied",
            )
        return ExposureResult("completed", True, delta, previous, actual)
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )


class CameraStream:
    def __init__(self, src=0):
        self.cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
        self.lock = threading.Lock()

        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT)
        self.cap.set(cv2.CAP_PROP_FPS, TARGET_FPS)

        self.real_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.real_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.reported_fps = self.cap.get(cv2.CAP_PROP_FPS)

        self.exposure_val = -6
        self.cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        self.cap.set(cv2.CAP_PROP_EXPOSURE, self.exposure_val)
        self.cap.set(cv2.CAP_PROP_GAIN, 100)

        self.ret, self.frame = self.cap.read()
        self.timestamp = time.time()
        self.sequence = 1 if self.ret else 0
        self.last_success_monotonic = time.monotonic() if self.ret else None
        self.consecutive_failures = 0
        self.stopped = False
        self.measured_fps = TARGET_FPS
        self._last_ts = self.timestamp
        self.thread = threading.Thread(target=self.update, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def adjust_exposure(self, delta):
        with self.lock:
            result = apply_manual_exposure(self.cap, delta)
            if result.status == "completed":
                self.exposure_val = result.actual_value
                print(f"相机手动曝光值调整为: {self.exposure_val}")
            else:
                print(f"相机曝光调整失败: {result.error_code}")
            return result

    def update(self):
        while not self.stopped:
            ret, frame = self.cap.read()
            if ret:
                now = time.time()
                now_monotonic = time.monotonic()
                dt = now - self._last_ts
                if dt > 0:
                    inst_fps = 1.0 / dt
                    self.measured_fps = 0.9 * self.measured_fps + 0.1 * inst_fps
                self._last_ts = now
                with self.lock:
                    self.ret = ret
                    self.frame = frame
                    self.timestamp = now
                    self.sequence += 1
                    self.last_success_monotonic = now_monotonic
                    self.consecutive_failures = 0
            else:
                with self.lock:
                    self.consecutive_failures += 1
                time.sleep(0.001)

    def read(self):
        with self.lock:
            frame = self.frame.copy() if self.frame is not None else None
            return self.ret, frame, self.timestamp

    def snapshot(self):
        """Return the latest frame plus freshness metadata atomically."""
        with self.lock:
            frame = self.frame.copy() if self.frame is not None else None
            last_success = self.last_success_monotonic
            age_s = (
                float("inf")
                if last_success is None
                else max(0.0, time.monotonic() - last_success)
            )
            return {
                "ok": bool(self.ret and frame is not None),
                "frame": frame,
                "timestamp": self.timestamp,
                "sequence": self.sequence,
                "age_s": age_s,
                "consecutive_failures": self.consecutive_failures,
            }

    def release(self):
        self.stopped = True
        self.cap.release()
        if self.thread.is_alive():
            self.thread.join(timeout=2.0)
        if self.thread.is_alive():
            print("相机采集线程未在2秒内退出，进程结束时将由系统回收。")


import json
import queue
import socket
import threading
import time

from config import TABLET_TCP_HOST, TABLET_TCP_PORT


class TabletTCPServer:
    def __init__(self, host=TABLET_TCP_HOST, port=TABLET_TCP_PORT):
        self.host = host
        self.port = port
        self.server_socket = None
        self.client_socket = None
        self.client_addr = None
        self._lock = threading.Lock()
        self._stop = False
        self._accept_thread = None
        self._sender_thread = None
        self._receiver_thread = None
        self._pending_data = None
        self._pending_lock = threading.Lock()
        self._has_pending = threading.Event()
        self._latest_trajectory = None
        self._latest_tracking_err = None
        self._command_queue = queue.Queue()
        self._rx_lock = threading.Lock()
        self.tx_fps = 0.0
        self.rx_fps = 0.0
        self._last_tx_t = time.time()
        self._last_rx_t = time.time()
        self._init_server()

    def _init_server(self):
        try:
            self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server_socket.bind((self.host, self.port))
            self.server_socket.listen(1)
            self.server_socket.settimeout(1.0)
            print(f"平板 TCP 有线双向服务器已启动: {self.host}:{self.port}")
            self._accept_thread = threading.Thread(target=self._accept_loop, daemon=True)
            self._accept_thread.start()
            self._sender_thread = threading.Thread(target=self._sender_loop, daemon=True)
            self._sender_thread.start()
            self._receiver_thread = threading.Thread(target=self._receiver_loop, daemon=True)
            self._receiver_thread.start()
        except Exception as error:
            print(f"平板 TCP 服务器启动失败: {error}")

    def _accept_loop(self):
        while not self._stop:
            try:
                conn, addr = self.server_socket.accept()
                conn.settimeout(0.5)
                with self._lock:
                    if self.client_socket:
                        try:
                            self.client_socket.close()
                        except OSError:
                            pass
                    self.client_socket = conn
                    self.client_addr = addr
                print(f"平板 UI 已建立连接: {addr}")
            except socket.timeout:
                continue
            except (OSError, AttributeError):
                continue

    def _sender_loop(self):
        while not self._stop:
            if not self._has_pending.wait(timeout=0.5):
                continue
            with self._pending_lock:
                data_dict = self._pending_data
                self._has_pending.clear()
            with self._lock:
                sock = self.client_socket
            if sock is None or data_dict is None:
                continue
            try:
                payload = json.dumps(data_dict, ensure_ascii=False, default=float) + "\n"
                sock.sendall(payload.encode("utf-8"))
                now = time.time()
                dt = now - self._last_tx_t
                if dt > 0:
                    self.tx_fps = 0.9 * self.tx_fps + 0.1 * (1.0 / dt)
                self._last_tx_t = now
            except (OSError, BrokenPipeError):
                with self._lock:
                    if self.client_socket:
                        print(f"平板 UI 连接断开: {self.client_addr}")
                        try:
                            self.client_socket.close()
                        except OSError:
                            pass
                        self.client_socket = None

    def _receiver_loop(self):
        buffer = ""
        while not self._stop:
            with self._lock:
                sock = self.client_socket
            if sock is None:
                time.sleep(0.1)
                continue
            try:
                data = sock.recv(2048).decode("utf-8")
                if not data:
                    time.sleep(0.01)
                    continue
                buffer += data
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    now = time.time()
                    dt = now - self._last_rx_t
                    if dt > 0:
                        self.rx_fps = 0.9 * self.rx_fps + 0.1 * (1.0 / dt)
                    self._last_rx_t = now
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    msg_type = parsed.get("type")
                    if msg_type == "trajectory":
                        with self._rx_lock:
                            self._latest_trajectory = parsed
                        num_pts = parsed.get("total_points", len(parsed.get("points", [])))
                        mode = parsed.get("motion_mode", "bionic")
                        reverse = parsed.get("reverse", False)
                        loop_flag = parsed.get("loop", False)
                        print(
                            " [UI 消息] 收到轨迹规划: "
                            f"点数={num_pts} | 模式={mode} | 反向={reverse} | 循环={loop_flag}"
                        )
                    elif msg_type == "tracking_error":
                        with self._rx_lock:
                            self._latest_tracking_err = parsed
                    elif msg_type == "command":
                        command = parsed.get("cmd")
                        self._command_queue.put(parsed)
                        print(f" [UI 消息] 收到控制指令: 【{str(command).upper()}】")
            except socket.timeout:
                continue
            except (OSError, ConnectionResetError):
                with self._lock:
                    if self.client_socket:
                        print("平板 UI 接收通道已断开")
                        try:
                            self.client_socket.close()
                        except OSError:
                            pass
                        self.client_socket = None
            except Exception:
                time.sleep(0.05)

    def send(self, data_dict):
        with self._pending_lock:
            self._pending_data = data_dict
        self._has_pending.set()

    def get_comm_fps(self):
        now = time.time()
        if now - self._last_tx_t > 1.5:
            self.tx_fps *= 0.5
        if now - self._last_rx_t > 1.5:
            self.rx_fps *= 0.5
        return round(self.tx_fps, 1), round(self.rx_fps, 1)

    def get_latest_tracking_error(self):
        with self._rx_lock:
            return self._latest_tracking_err

    def get_latest_trajectory(self):
        with self._rx_lock:
            return self._latest_trajectory

    def get_next_command(self):
        try:
            return self._command_queue.get_nowait()
        except queue.Empty:
            return None

    def close(self):
        self._stop = True
        self._has_pending.set()
        with self._lock:
            if self.client_socket:
                try:
                    self.client_socket.close()
                except OSError:
                    pass
        if self.server_socket:
            try:
                self.server_socket.close()
            except OSError:
                pass
        for thread in (
            self._accept_thread, self._sender_thread, self._receiver_thread
        ):
            if thread is not None and thread.is_alive():
                thread.join(timeout=1.2)


import threading
import time

import cv2
from flask import Flask, Response
from werkzeug.serving import make_server

from config import (
    MJPEG_JPEG_QUALITY,
    MJPEG_MAX_FPS,
    MJPEG_PORT,
    MJPEG_STREAM_HEIGHT,
    MJPEG_STREAM_WIDTH,
)


def has_viewer_capacity(current, maximum):
    return current < maximum


class MJPEGServer:
    def __init__(self, host="0.0.0.0", port=MJPEG_PORT, max_viewers=8):
        self.host = host
        self.port = port
        self.frame = None
        self.lock = threading.Lock()
        self.max_viewers = max_viewers
        self._viewer_count = 0
        self._viewer_lock = threading.Lock()
        self.last_update_t = 0.0
        self.app = Flask(__name__)
        self._server = None
        self._thread = None

        @self.app.route("/video.mjpg")
        def video():
            with self._viewer_lock:
                if not has_viewer_capacity(self._viewer_count, self.max_viewers):
                    print(f"视频流已有 {self._viewer_count} 个客户端在看，拒绝新连接")
                    return Response("视频流已被占用，请先关闭其他正在观看的窗口/设备", status=503)
            return Response(
                self.generate(),
                mimetype="multipart/x-mixed-replace; boundary=frame",
            )

    def update(self, frame):
        if frame is None:
            return
        now = time.time()
        if now - self.last_update_t < (1.0 / MJPEG_MAX_FPS):
            return
        self.last_update_t = now
        small_frame = cv2.resize(frame, (MJPEG_STREAM_WIDTH, MJPEG_STREAM_HEIGHT))
        with self.lock:
            self.frame = small_frame

    def generate(self):
        with self._viewer_lock:
            self._viewer_count += 1
            print(f"视频流新增1个观看者，当前共 {self._viewer_count} 个")

        last_send_t = 0.0
        min_interval = 1.0 / MJPEG_MAX_FPS
        try:
            while True:
                now = time.time()
                wait = min_interval - (now - last_send_t)
                if wait > 0:
                    time.sleep(wait)
                with self.lock:
                    frame = None if self.frame is None else self.frame.copy()
                if frame is None:
                    time.sleep(0.01)
                    continue
                ok, jpg = cv2.imencode(
                    ".jpg",
                    frame,
                    [int(cv2.IMWRITE_JPEG_QUALITY), MJPEG_JPEG_QUALITY],
                )
                if not ok:
                    continue
                last_send_t = time.time()
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + jpg.tobytes()
                    + b"\r\n"
                )
        except GeneratorExit:
            pass
        finally:
            with self._viewer_lock:
                self._viewer_count = max(0, self._viewer_count - 1)
                print(f"视频流断开1个观看者，当前共 {self._viewer_count} 个")

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return self
        self._server = make_server(
            self.host, self.port, self.app, threaded=True
        )
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="MJPEGServer",
            daemon=True,
        )
        self._thread.start()
        print(f"MJPEG视频流已启动: http://0.0.0.0:{self.port}/video.mjpg")
        return self

    def close(self):
        server = self._server
        if server is not None:
            server.shutdown()
            server.server_close()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._server = None
        self._thread = None


import csv
import queue
import threading

import cv2


class AsyncVideoRecorder:
    def __init__(self, path, fourcc, fps, frame_size, csv_path):
        self.video_out = cv2.VideoWriter(path, fourcc, fps, frame_size)
        self.csv_file = open(csv_path, "w", newline="")
        self.csv_writer = csv.writer(self.csv_file)
        self.csv_writer.writerow([
            "timestamp",
            "pixel_u",
            "pixel_v",
            "physical_x",
            "physical_y",
        ])
        self.queue = queue.Queue(maxsize=300)
        self.stopped = False
        self.dropped_frames = 0
        self.thread = threading.Thread(target=self._writer_loop, daemon=True)
        self.thread.start()

    def submit(self, frame, csv_row):
        try:
            self.queue.put_nowait((frame, csv_row))
        except queue.Full:
            self.dropped_frames += 1

    def _writer_loop(self):
        while not (self.stopped and self.queue.empty()):
            try:
                frame, csv_row = self.queue.get(timeout=0.1)
            except queue.Empty:
                continue
            self.video_out.write(frame)
            if csv_row is not None:
                self.csv_writer.writerow(csv_row)

    def close(self):
        self.stopped = True
        if self.thread.is_alive():
            self.thread.join()
        self.video_out.release()
        self.csv_file.close()
        if self.dropped_frames > 0:
            print(f"录制过程中磁盘写入跟不上，丢弃了 {self.dropped_frames} 帧")
