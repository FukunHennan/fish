"""Restart-safe DirectShow camera stream used by the web vision service.

The original CameraStream lives in interface.py.  This implementation keeps
camera shutdown strict: a new session must not be allowed to reopen the same
DirectShow device until the capture thread has actually exited.
"""

from __future__ import annotations

import threading
import time

import cv2

from config import TARGET_FPS, TARGET_HEIGHT, TARGET_WIDTH
from interface import apply_manual_exposure


class RestartSafeCameraStream:
    """Camera capture with deterministic stop/release semantics.

    Normal shutdown first asks the capture loop to stop and gives it a short
    chance to leave ``read()`` naturally.  If the driver is still blocking,
    ``VideoCapture.release()`` is used to break the read.  Shutdown is only
    considered complete after the capture thread has really terminated.
    """

    def __init__(self, src=0):
        self.cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
        self.lock = threading.Lock()
        self._stop_event = threading.Event()
        self._release_lock = threading.Lock()
        self._released = False

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
        self.measured_fps = TARGET_FPS
        self._last_ts = self.timestamp
        self.thread = threading.Thread(
            target=self.update,
            name=f"camera-capture-{src}",
            daemon=True,
        )

    @property
    def stopped(self):
        return self._stop_event.is_set()

    def start(self):
        if self.thread.is_alive():
            return self
        if self._stop_event.is_set():
            raise RuntimeError("camera_stream_cannot_restart")
        self.thread.start()
        return self

    def adjust_exposure(self, delta):
        if self._stop_event.is_set():
            return apply_manual_exposure(_ClosedCapture(), delta)
        with self.lock:
            result = apply_manual_exposure(self.cap, delta)
            if result.status == "completed":
                self.exposure_val = result.actual_value
                print(f"相机手动曝光值调整为: {self.exposure_val}")
            else:
                print(f"相机曝光调整失败: {result.error_code}")
            return result

    def update(self):
        while not self._stop_event.is_set():
            try:
                ret, frame = self.cap.read()
            except (cv2.error, OSError, RuntimeError):
                if self._stop_event.is_set():
                    break
                ret, frame = False, None

            if self._stop_event.is_set():
                break

            if ret:
                now = time.time()
                now_monotonic = time.monotonic()
                dt = now - self._last_ts
                if dt > 0:
                    inst_fps = 1.0 / dt
                    self.measured_fps = 0.9 * self.measured_fps + 0.1 * inst_fps
                self._last_ts = now
                with self.lock:
                    self.ret = True
                    self.frame = frame
                    self.timestamp = now
                    self.sequence += 1
                    self.last_success_monotonic = now_monotonic
                    self.consecutive_failures = 0
            else:
                with self.lock:
                    self.ret = False
                    self.consecutive_failures += 1
                self._stop_event.wait(0.002)

    def read(self):
        with self.lock:
            frame = self.frame.copy() if self.frame is not None else None
            return self.ret, frame, self.timestamp

    def snapshot(self):
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

    def _release_capture(self):
        with self._release_lock:
            if self._released:
                return
            self.cap.release()
            self._released = True

    def release(self):
        self._stop_event.set()

        # Most UVC cameras return from read() quickly.  Avoid calling release()
        # concurrently with read() unless the driver actually needs unblocking.
        if self.thread.is_alive():
            self.thread.join(timeout=0.25)

        if self.thread.is_alive():
            self._release_capture()
            self.thread.join(timeout=3.0)

        if self.thread.is_alive():
            raise RuntimeError("camera_capture_thread_stop_timeout")

        self._release_capture()
        with self.lock:
            self.ret = False
            self.frame = None


class _ClosedCapture:
    """Tiny adapter so exposure calls after stop fail cleanly."""

    def get(self, _key):
        raise RuntimeError("camera_closed")

    def set(self, _key, _value):
        raise RuntimeError("camera_closed")
