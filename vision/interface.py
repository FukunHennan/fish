"""Camera, tablet, preview, and recording adapters."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
import shutil
import subprocess
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
    return apply_manual_exposure_for_device(capture, delta, None)


def _run_v4l2_ctl(device, *args):
    binary = shutil.which("v4l2-ctl")
    if binary is None:
        return None
    try:
        return subprocess.run(
            [binary, "-d", device, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _parse_v4l2_int_control(output, name):
    pattern = re.compile(
        rf"\b{re.escape(name)}\b.*?min=(-?\d+).*?max=(-?\d+).*?step=(-?\d+).*?value=(-?\d+)",
        re.IGNORECASE,
    )
    match = pattern.search(output or "")
    if not match:
        return None
    minimum, maximum, step, value = (int(group) for group in match.groups())
    return {
        "min": minimum,
        "max": maximum,
        "step": max(1, abs(step)),
        "value": value,
    }


def _apply_v4l2_manual_exposure(device_index, delta):
    if device_index is None:
        return None
    device = f"/dev/video{int(device_index)}"
    listed = _run_v4l2_ctl(device, "--list-ctrls")
    if listed is None:
        return None
    if listed.returncode != 0:
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )
    controls = listed.stdout
    if "exposure_auto" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "exposure_auto=1")
    if "auto_exposure" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "auto_exposure=1")
    control_name = None
    exposure = None
    for candidate in ("exposure_time_absolute", "exposure_absolute", "exposure"):
        exposure = _parse_v4l2_int_control(controls, candidate)
        if exposure is not None:
            control_name = candidate
            break
    if exposure is None:
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )
    span = max(1, exposure["max"] - exposure["min"])
    step = max(exposure["step"], int(round(span * 0.05)))
    previous = exposure["value"]
    target = max(exposure["min"], min(exposure["max"], previous + int(delta) * step))
    if target == previous:
        target = max(exposure["min"], min(exposure["max"], previous + int(delta) * exposure["step"]))
    applied = _run_v4l2_ctl(device, "--set-ctrl", f"{control_name}={target}")
    if applied is None or applied.returncode != 0:
        return ExposureResult(
            "failed", True, delta, float(previous), float(previous),
            "exposure_not_applied",
        )
    refreshed = _run_v4l2_ctl(device, "--list-ctrls")
    actual = target
    if refreshed is not None and refreshed.returncode == 0:
        refreshed_exposure = _parse_v4l2_int_control(refreshed.stdout, control_name)
        if refreshed_exposure is not None:
            actual = refreshed_exposure["value"]
    if actual == previous:
        return ExposureResult(
            "failed", True, delta, float(previous), float(actual),
            "exposure_not_applied",
        )
    return ExposureResult("completed", True, delta, float(previous), float(actual))


def apply_manual_exposure_for_device(capture, delta, device_index=None):
    try:
        previous = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if not math.isfinite(previous):
            previous = None
        for manual_value in (0.25, 1.0):
            capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, manual_value)
            target = (previous if previous is not None else -6.0) + delta
            capture.set(cv2.CAP_PROP_EXPOSURE, target)
            actual = float(capture.get(cv2.CAP_PROP_EXPOSURE))
            if not math.isfinite(actual):
                actual = None
            if actual is not None and previous is not None and not math.isclose(actual, previous, abs_tol=1e-6):
                return ExposureResult("completed", True, delta, previous, actual)
            previous = actual if actual is not None else previous
        fallback = _apply_v4l2_manual_exposure(device_index, delta)
        if fallback is not None:
            return fallback
        return ExposureResult(
            "failed", True, delta, previous, previous,
            "exposure_not_applied",
        )
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        fallback = _apply_v4l2_manual_exposure(device_index, delta)
        if fallback is not None:
            return fallback
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )


class CameraStream:
    def __init__(self, src=0):
        self.src = src
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
            result = apply_manual_exposure_for_device(self.cap, delta, self.src)
            if result.status == "completed":
                self.exposure_val = result.actual_value
                print(f"[Camera] Manual exposure changed to {self.exposure_val}")
            else:
                print(f"[Camera] Exposure adjustment failed: {result.error_code}")
            return result

    def update(self):
        while not self.stopped:
            with self.lock:
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
            print("[Camera] Capture thread did not exit within 2 seconds.")


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
            print(f"[Tablet] TCP server started: {self.host}:{self.port}")
            self._accept_thread = threading.Thread(target=self._accept_loop, daemon=True)
            self._accept_thread.start()
            self._sender_thread = threading.Thread(target=self._sender_loop, daemon=True)
            self._sender_thread.start()
            self._receiver_thread = threading.Thread(target=self._receiver_loop, daemon=True)
            self._receiver_thread.start()
        except Exception as error:
            print(f"[Tablet] TCP server failed to start: {error}")

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
                print(f"[Tablet] UI connected: {addr}")
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
                        print(f"[Tablet] UI disconnected: {self.client_addr}")
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
                            "[Tablet] Path plan received: "
                            f"points={num_pts} | mode={mode} | reverse={reverse} | loop={loop_flag}"
                        )
                    elif msg_type == "tracking_error":
                        with self._rx_lock:
                            self._latest_tracking_err = parsed
                    elif msg_type == "command":
                        command = parsed.get("cmd")
                        self._command_queue.put(parsed)
                        print(f"[Tablet] Control command received: {str(command).upper()}")
            except socket.timeout:
                continue
            except (OSError, ConnectionResetError):
                with self._lock:
                    if self.client_socket:
                        print("[Tablet] UI receive channel disconnected")
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
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.encoded_frame = None
        self.frame_sequence = 0
        self.frame_timestamp = 0.0
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
                    print(f"[MJPEG] Viewer limit reached ({self._viewer_count}); rejecting connection")
                    return Response("视频流已被占用，请先关闭其他正在观看的窗口/设备", status=503)
            return Response(
                self.generate(),
                mimetype="multipart/x-mixed-replace; boundary=frame",
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0, no-transform",
                    "Pragma": "no-cache",
                    "Expires": "0",
                    "X-Accel-Buffering": "no",
                },
                direct_passthrough=True,
            )

    @staticmethod
    def _resize_for_stream(frame):
        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            return frame
        scale = min(MJPEG_STREAM_WIDTH / width, MJPEG_STREAM_HEIGHT / height)
        target = (
            max(1, int(round(width * scale))),
            max(1, int(round(height * scale))),
        )
        interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
        return cv2.resize(frame, target, interpolation=interpolation)

    def update(self, frame):
        if frame is None:
            return
        now = time.time()
        if now - self.last_update_t < (1.0 / MJPEG_MAX_FPS):
            return
        self.last_update_t = now
        stream_frame = self._resize_for_stream(frame)
        ok, jpg = cv2.imencode(
            ".jpg",
            stream_frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), MJPEG_JPEG_QUALITY],
        )
        if not ok:
            return
        with self.lock:
            self.encoded_frame = jpg.tobytes()
            self.frame_sequence += 1
            self.frame_timestamp = now
            self.condition.notify_all()

    def generate(self):
        with self._viewer_lock:
            self._viewer_count += 1
            print(f"[MJPEG] Viewer connected; total={self._viewer_count}")

        last_sequence = -1
        try:
            while True:
                with self.lock:
                    self.condition.wait_for(
                        lambda: self.encoded_frame is not None and self.frame_sequence != last_sequence,
                        timeout=1.0,
                    )
                    frame = self.encoded_frame
                    sequence = self.frame_sequence
                    timestamp = self.frame_timestamp
                if frame is None or sequence == last_sequence:
                    continue
                last_sequence = sequence
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    + f"Content-Length: {len(frame)}\r\n".encode("ascii")
                    + f"X-Fish-Frame-Seq: {sequence}\r\n".encode("ascii")
                    + f"X-Fish-Frame-Time: {timestamp:.6f}\r\n\r\n".encode("ascii")
                    + frame
                    + b"\r\n"
                )
        except GeneratorExit:
            pass
        finally:
            with self._viewer_lock:
                self._viewer_count = max(0, self._viewer_count - 1)
                print(f"[MJPEG] Viewer disconnected; total={self._viewer_count}")

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
        print(f"[MJPEG] Stream started: http://0.0.0.0:{self.port}/video.mjpg")
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
            print(f"[Recorder] Disk writer lagged; dropped {self.dropped_frames} frames")
