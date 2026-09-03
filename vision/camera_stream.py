"""Restart-safe camera stream with backend fallback for the web vision service.

The web UI repeatedly opens and closes camera sessions.  This implementation
keeps shutdown strict and makes startup defensive: a backend must actually
open and return a frame before it is accepted, optional camera properties are
best-effort, and Windows falls back from DirectShow to Media Foundation and
finally OpenCV's automatic backend selection.
"""

from __future__ import annotations

import math
import sys
import threading
import time

import cv2

from config import TARGET_FPS, TARGET_HEIGHT, TARGET_WIDTH
from interface import (
    apply_manual_exposure_for_device,
    get_manual_exposure_for_device,
    prepare_v4l2_capture,
    set_manual_exposure_for_device,
)


def _backend_candidates():
    if sys.platform.startswith("linux"):
        candidates = []
        if hasattr(cv2, "CAP_V4L2"):
            candidates.append(("V4L2", cv2.CAP_V4L2))
        candidates.append(("ANY", None))
        return candidates

    if sys.platform == "darwin":
        candidates = []
        if hasattr(cv2, "CAP_AVFOUNDATION"):
            candidates.append(("AVFOUNDATION", cv2.CAP_AVFOUNDATION))
        candidates.append(("ANY", None))
        return candidates

    candidates = []
    if hasattr(cv2, "CAP_DSHOW"):
        candidates.append(("DSHOW", cv2.CAP_DSHOW))
    if hasattr(cv2, "CAP_MSMF"):
        candidates.append(("MSMF", cv2.CAP_MSMF))
    # None means let OpenCV choose the backend (CAP_ANY semantics).
    candidates.append(("ANY", None))
    return candidates


def _capture_is_opened(capture):
    checker = getattr(capture, "isOpened", None)
    if checker is None:
        # Test doubles and a few legacy wrappers do not expose isOpened().
        return True
    try:
        return bool(checker())
    except (cv2.error, OSError, RuntimeError):
        return False


def _safe_release(capture):
    try:
        capture.release()
    except (cv2.error, OSError, RuntimeError):
        pass


def _safe_set(capture, prop, value, label):
    """Best-effort camera configuration that can never abort startup."""
    try:
        accepted = bool(capture.set(prop, value))
        if not accepted:
            print(f"[Camera] Driver rejected setting: {label}={value}")
        return accepted
    except (cv2.error, OSError, RuntimeError) as error:
        print(f"[Camera] Setting failed; continuing: {label}={value} ({error})")
        return False


def _safe_get(capture, prop, default=0.0):
    try:
        value = float(capture.get(prop))
        return value if math.isfinite(value) else default
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        return default


def _open_working_capture(src):
    errors = []
    for backend_name, backend in _backend_candidates():
        capture = None
        try:
            if backend_name == "V4L2":
                # OpenCV cannot reliably switch V4L2 exposure menu values.
                # Reset stale long-exposure settings before opening the node.
                prepare_v4l2_capture(src)
            if backend is None:
                capture = cv2.VideoCapture(src)
            else:
                capture = cv2.VideoCapture(src, backend)
        except (cv2.error, OSError, RuntimeError) as error:
            errors.append(f"{backend_name}: open exception: {error}")
            continue

        if not _capture_is_opened(capture):
            errors.append(f"{backend_name}: not opened")
            _safe_release(capture)
            continue

        # A deep driver queue makes the browser display old frames after a
        # network or CPU stall. This is optional because some backends reject
        # the property during startup.
        if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
            _safe_set(capture, cv2.CAP_PROP_BUFFERSIZE, 1, "BUFFERSIZE")

        # Do not touch FPS/resolution until the backend proves it can deliver a
        # frame. This avoids backend-specific startup failures.
        try:
            ok, frame = capture.read()
        except (cv2.error, OSError, RuntimeError) as error:
            errors.append(f"{backend_name}: first read exception: {error}")
            _safe_release(capture)
            continue

        if not ok or frame is None:
            errors.append(f"{backend_name}: no first frame")
            _safe_release(capture)
            continue

        print(f"[Camera] Opened index {src} with {backend_name}")
        return capture, backend_name, frame

    detail = "; ".join(errors) if errors else "no backend candidates"
    raise RuntimeError(f"camera_open_failed: index={src}; {detail}")


class RestartSafeCameraStream:
    """Camera capture with restart-safe stop/release and backend fallback."""

    def __init__(self, src=0):
        self.src = src
        self.lock = threading.Lock()
        self.capture_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._release_lock = threading.Lock()
        self._released = False

        self.cap, self.backend_name, first_frame = _open_working_capture(src)

        # Camera properties are preferences, not startup requirements. Some
        # UVC drivers report a lower default FPS than the requested target;
        # asking for more can make reads block for hundreds of milliseconds.
        device_fps = _safe_get(self.cap, cv2.CAP_PROP_FPS, 0.0)
        self.requested_fps = (
            min(TARGET_FPS, device_fps) if device_fps > 0 else TARGET_FPS
        )
        _safe_set(
            self.cap,
            cv2.CAP_PROP_FOURCC,
            cv2.VideoWriter_fourcc(*"MJPG"),
            "FOURCC",
        )
        _safe_set(self.cap, cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH, "WIDTH")
        _safe_set(self.cap, cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT, "HEIGHT")
        _safe_set(self.cap, cv2.CAP_PROP_FPS, self.requested_fps, "FPS")

        self.real_width = int(_safe_get(self.cap, cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH))
        self.real_height = int(_safe_get(self.cap, cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT))
        self.reported_fps = _safe_get(self.cap, cv2.CAP_PROP_FPS, self.requested_fps)

        self.exposure_val = -6
        if self.backend_name != "V4L2":
            # OpenCV exposure values use a different scale on Linux V4L2.
            # Writing the Windows-style -6 value can select a multi-second
            # exposure and reduce a 30 FPS camera to roughly 2 FPS.
            _safe_set(self.cap, cv2.CAP_PROP_AUTO_EXPOSURE, 0.25, "AUTO_EXPOSURE")
            _safe_set(self.cap, cv2.CAP_PROP_EXPOSURE, self.exposure_val, "EXPOSURE")
            _safe_set(self.cap, cv2.CAP_PROP_GAIN, 100, "GAIN")
        self.exposure_supported = False
        self.exposure_min = None
        self.exposure_max = None
        self.exposure_step = None
        self.exposure_error_code = None
        self._refresh_exposure_info()

        self.ret = True
        self.frame = first_frame
        self.timestamp = time.time()
        self.sequence = 1
        self.last_success_monotonic = time.monotonic()
        self.consecutive_failures = 0
        self.measured_fps = max(1.0, self.reported_fps)
        self._last_ts = self.timestamp
        self.thread = threading.Thread(
            target=self.update,
            name=f"camera-capture-{src}-{self.backend_name.lower()}",
            daemon=True,
        )

        print(
            "[Camera] Initialized: "
            f"backend={self.backend_name}, "
            f"actual={self.real_width}x{self.real_height}@{self.reported_fps:.1f}"
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
            return apply_manual_exposure_for_device(_ClosedCapture(), delta, self.src)
        with self.capture_lock:
            result = apply_manual_exposure_for_device(self.cap, delta, self.src)
            self._apply_exposure_result(result)
            return result

    def set_exposure(self, value):
        if self._stop_event.is_set():
            return set_manual_exposure_for_device(_ClosedCapture(), value, self.src)
        with self.capture_lock:
            result = set_manual_exposure_for_device(self.cap, value, self.src)
            self._apply_exposure_result(result)
            return result

    def _refresh_exposure_info(self):
        info = get_manual_exposure_for_device(self.cap, self.src)
        self.exposure_supported = info.supported
        self.exposure_min = info.minimum
        self.exposure_max = info.maximum
        self.exposure_step = info.step
        self.exposure_error_code = info.error_code
        if info.actual_value is not None:
            self.exposure_val = info.actual_value

    def _apply_exposure_result(self, result):
        if result.status == "completed" and result.actual_value is not None:
            self.exposure_val = result.actual_value
            print(f"[Camera] Manual exposure changed to {self.exposure_val}")
        else:
            print(f"[Camera] Exposure adjustment failed: {result.error_code}")
        self.exposure_supported = result.supported
        self.exposure_min = result.minimum
        self.exposure_max = result.maximum
        self.exposure_step = result.step
        self.exposure_error_code = result.error_code

    def update(self):
        while not self._stop_event.is_set():
            try:
                # Keep the shared frame state readable while a driver blocks.
                with self.capture_lock:
                    ret, frame = self.cap.read()
            except (cv2.error, OSError, RuntimeError) as error:
                if self._stop_event.is_set():
                    break
                print(f"[Camera] Frame read failed: {error}")
                ret, frame = False, None

            if self._stop_event.is_set():
                break

            if ret and frame is not None:
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
                self._stop_event.wait(0.01)

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
                "backend": self.backend_name,
            }

    def _release_capture(self):
        with self._release_lock:
            if self._released:
                return
            _safe_release(self.cap)
            self._released = True

    def release(self):
        self._stop_event.set()

        # Most UVC cameras return from read() quickly. Avoid calling release()
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
        print(f"[Camera] Released camera backend={self.backend_name}")


class _ClosedCapture:
    """Tiny adapter so exposure calls after stop fail cleanly."""

    def get(self, _key):
        raise RuntimeError("camera_closed")

    def set(self, _key, _value):
        raise RuntimeError("camera_closed")
