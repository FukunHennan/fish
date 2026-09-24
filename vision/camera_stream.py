"""Restart-safe camera stream with an explicit platform backend.

The web UI repeatedly opens and closes camera sessions. This implementation
keeps shutdown strict and requires a backend to return a real frame before it
is accepted. Linux uses V4L2 explicitly and never changes capture backends.
"""

from __future__ import annotations

import math
import sys
import threading
import time
from pathlib import Path

import cv2
import crop_region
import video_transform

from config import CAPTURE_FOURCC, TARGET_FPS, TARGET_HEIGHT, TARGET_WIDTH
from interface import (
    apply_manual_exposure_for_device,
    get_manual_exposure_for_device,
    prepare_v4l2_capture,
    set_manual_exposure_for_device,
)


# A USB camera can disappear and come back (unplug/replug, hub reset, driver
# restart).  When no frame has arrived for this long the capture thread stops
# hammering the dead handle and starts rebuilding the stream from scratch.
CAMERA_STALL_RECOVERY_S = 2.0
CAMERA_RECOVERY_RETRY_S = 1.0
CAMERA_RECOVERY_MAX_INDEX = 8
CAMERA_WATCHDOG_POLL_S = 0.25


def _linux_v4l2_present_names(
    root=Path("/sys/class/video4linux"),
    max_index=CAMERA_RECOVERY_MAX_INDEX,
):
    """Map currently registered /dev/videoN indexes to their card names."""
    result = {}
    try:
        children = list(root.glob("video*"))
    except OSError:
        return result
    for child in children:
        suffix = child.name.removeprefix("video")
        if not suffix.isdigit():
            continue
        index = int(suffix)
        if not 0 <= index <= max_index:
            continue
        try:
            name = child.joinpath("name").read_text(encoding="utf-8").strip()
        except OSError:
            name = ""
        result[index] = name
    return result


def _windows_directshow_present_names():
    """Return the current DirectShow camera order without opening devices.

    USB replugging can change the OpenCV index on Windows.  The optional
    pygrabber dependency exposes the stable device display names, so recovery
    can follow the same physical camera to its new index.  An empty result is
    intentionally harmless: the original index remains the fallback.
    """
    if not sys.platform.startswith("win"):
        return {}
    try:
        from pygrabber.dshow_graph import FilterGraph

        return {
            index: str(name).strip()
            for index, name in enumerate(FilterGraph().get_input_devices())
            if str(name).strip()
        }
    except (ImportError, OSError, RuntimeError):
        return {}


def _backend_candidates():
    if sys.platform.startswith("linux"):
        return [("V4L2", cv2.CAP_V4L2)] if hasattr(cv2, "CAP_V4L2") else []

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
    if capture is None:
        return
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


def _positive_capture_value(capture, prop, default):
    """Read a driver property, falling back when UVC reports 0 or -1."""
    value = _safe_get(capture, prop, default)
    return value if value > 0 else float(default)


def _read_fixed_resolution_frame(
    capture,
    attempts=5,
    expected_width=TARGET_WIDTH,
    expected_height=TARGET_HEIGHT,
):
    """Read the first frame that actually matches the configured sensor mode."""
    last_size = None
    for _ in range(attempts):
        try:
            ok, frame = capture.read()
        except (cv2.error, OSError, RuntimeError):
            continue
        if not ok or frame is None:
            continue
        shape = getattr(frame, "shape", None)
        # Lightweight test doubles do not expose ndarray shape.
        if shape is None or len(shape) < 2:
            return frame
        last_size = (int(shape[1]), int(shape[0]))
        if last_size == (expected_width, expected_height):
            return frame
    actual = "unknown" if last_size is None else f"{last_size[0]}x{last_size[1]}"
    raise RuntimeError(
        "camera_frame_resolution_mismatch: "
        f"requested={expected_width}x{expected_height}; actual={actual}"
    )


def _open_working_capture(src):
    from camera_policy import camera_blocked
    if camera_blocked(src):
        raise RuntimeError("该摄像头已被项目禁用，请使用 Global Shutter Camera")
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

        # Two buffers allow capture while the previous MJPEG frame is decoded.
        # A single buffer halved measured capture FPS on this camera.
        if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
            _safe_set(capture, cv2.CAP_PROP_BUFFERSIZE, 2, "BUFFERSIZE")

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
    """Camera capture with restart-safe stop/release and a fixed backend."""

    def __init__(self, src=0):
        self.src = src
        self.lock = threading.Lock()
        self.capture_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._release_lock = threading.Lock()
        self._released = False
        self._recovering = False
        self.recovery_attempts = 0
        self.last_recovery_error = ""

        self.cap, self.backend_name, first_frame = _open_working_capture(src)
        if sys.platform.startswith("linux"):
            present_names = _linux_v4l2_present_names()
        else:
            present_names = _windows_directshow_present_names()
        self.device_name = present_names.get(src, "")
        try:
            self._configure_capture()
            first_frame = _read_fixed_resolution_frame(
                self.cap,
                expected_width=self.source_width,
                expected_height=self.source_height,
            )
        except Exception:
            _safe_release(self.cap)
            raise
        first_frame = video_transform.rotate(first_frame, self.rotation_angle)

        self.ret = True
        self.frame = first_frame
        self.timestamp = time.time()
        self.sequence = 1
        self.last_success_monotonic = time.monotonic()
        self.consecutive_failures = 0
        # CAP_PROP_FPS is only a driver claim.  It is intentionally not used
        # as telemetry or scheduling input; measured_fps starts unknown and is
        # derived from real frame arrival intervals in update().
        self.measured_fps = 0.0
        self._last_ts = self.timestamp
        self.thread = threading.Thread(
            target=self.update,
            name=f"camera-capture-{src}-{self.backend_name.lower()}",
            daemon=True,
        )
        self._watchdog_thread = threading.Thread(
            target=self._watch_capture,
            name=f"camera-watchdog-{src}",
            daemon=True,
        )

        print(
            "[Camera] Initialized: "
            f"backend={self.backend_name}, "
            f"actual={self.real_width}x{self.real_height}, "
            f"driver_fps={self.reported_fps:.1f}, measured_fps=pending"
        )

    def _configure_capture(self):
        """Apply stream preferences and refresh state for the current capture.

        __init__ runs this before the capture thread exists; recovery runs it
        while holding capture_lock so exposure callers never see a
        half-configured capture.
        """
        capture = self.cap
        # Fix the sensor mode but let the driver negotiate the fastest real
        # frame rate available for that mode.  Writing a desired FPS is not
        # useful on this camera: the driver accepts arbitrary values without
        # changing delivery cadence.
        self.requested_fps = None
        _safe_set(
            capture,
            cv2.CAP_PROP_FOURCC,
            cv2.VideoWriter_fourcc(*CAPTURE_FOURCC),
            "FOURCC",
        )
        _safe_set(capture, cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH, "WIDTH")
        _safe_set(capture, cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT, "HEIGHT")

        # DirectShow/MSMF may transiently report -1x-1 while a USB camera is
        # being re-enumerated.  Treat that as unknown and retain the requested
        # mode; accepting a negative size would make the first-frame contract
        # fail and cause the web UI to enter an endless reconnect loop.
        self.real_width = int(
            _positive_capture_value(capture, cv2.CAP_PROP_FRAME_WIDTH, TARGET_WIDTH)
        )
        self.real_height = int(
            _positive_capture_value(capture, cv2.CAP_PROP_FRAME_HEIGHT, TARGET_HEIGHT)
        )
        self.reported_fps = _safe_get(
            capture, cv2.CAP_PROP_FPS, 0.0
        )
        if (self.real_width, self.real_height) != (TARGET_WIDTH, TARGET_HEIGHT):
            print(
                "[Camera] Requested sensor mode unavailable; locking the session "
                f"to negotiated mode {self.real_width}x{self.real_height} "
                f"instead of {TARGET_WIDTH}x{TARGET_HEIGHT}"
            )

        self.source_width = self.real_width
        self.source_height = self.real_height
        self.crop_region = crop_region.load()
        self.rotation_angle = video_transform.load()["angle"]
        self.rotation_ms = 0.0
        x, y, right, bottom = crop_region.bounds(
            self.crop_region, self.real_width, self.real_height
        )
        self.real_width, self.real_height = right - x, bottom - y

        if not hasattr(self, "exposure_val"):
            self.exposure_val = -6
        if self.backend_name != "V4L2":
            # OpenCV exposure values use a different scale on Linux V4L2.
            # Writing the Windows-style -6 value can select a multi-second
            # exposure and sharply reduce the camera's real delivery rate.
            _safe_set(
                capture, cv2.CAP_PROP_AUTO_EXPOSURE, 0.25, "AUTO_EXPOSURE"
            )
            _safe_set(
                capture, cv2.CAP_PROP_EXPOSURE, self.exposure_val, "EXPOSURE"
            )
            _safe_set(capture, cv2.CAP_PROP_GAIN, 100, "GAIN")
        self.exposure_supported = False
        self.exposure_min = None
        self.exposure_max = None
        self.exposure_step = None
        self.exposure_error_code = None
        self._refresh_exposure_info()

    def _recovery_candidates(self):
        """Indexes to probe while rebuilding the stream.

        The original index comes first.  When Linux renumbers /dev/videoN
        after a replug, the same physical card can be found again by its
        sysfs name; metadata nodes are tried too but only a node that can
        actually deliver a frame will be adopted.
        """
        if sys.platform.startswith("linux"):
            present = _linux_v4l2_present_names()
            ordered = [self.src]
            if self.device_name:
                ordered.extend(
                    index
                    for index in sorted(present)
                    if index != self.src and present[index] == self.device_name
                )
            return [index for index in ordered if index in present]
        if sys.platform.startswith("win") and self.device_name:
            present = _windows_directshow_present_names()
            ordered = [
                index
                for index in sorted(present)
                if present[index] == self.device_name
            ]
            # Keep the original index first when the driver still exposes it;
            # duplicate names are possible, so all matching indexes are tried.
            if self.src in ordered:
                ordered.remove(self.src)
            return [self.src, *ordered]
        return [self.src]

    def _start_recovery(self, force=False):
        with self.lock:
            self.ret = False
            if self._recovering:
                return
            self._recovering = True
        print(
            f"[Camera] No frame for {CAMERA_STALL_RECOVERY_S:.0f}s; "
            f"rebuilding capture for index {self.src}"
        )
        self.recovery_attempts = 0
        acquired = self.capture_lock.acquire(timeout=0.05 if force else -1)
        if acquired:
            try:
                stale = self.cap
                self.cap = None
            finally:
                self.capture_lock.release()
        else:
            # Some Windows DirectShow drivers block forever inside read().
            # Releasing the handle from the watchdog is the only way to wake
            # that thread and let normal recovery rebuild the capture.
            stale = self.cap
            self.cap = None
        _safe_release(stale)

    def _watch_capture(self):
        while not self._stop_event.wait(CAMERA_WATCHDOG_POLL_S):
            with self.lock:
                recovering = self._recovering
                last_success = self.last_success_monotonic
            if recovering or last_success is None:
                continue
            if time.monotonic() - last_success >= CAMERA_STALL_RECOVERY_S:
                self._start_recovery(force=True)

    def _attempt_recovery(self):
        """Try to open a working capture; returns True when adopted."""
        candidates = self._recovery_candidates()
        if not candidates:
            self.last_recovery_error = "camera node not present"
            self.recovery_attempts += 1
            if self.recovery_attempts <= 3 or self.recovery_attempts % 10 == 0:
                print(
                    f"[Camera] Reopen attempt {self.recovery_attempts} failed: "
                    f"{self.last_recovery_error}"
                )
            return False

        for source in candidates:
            if self._stop_event.is_set() or self._released:
                return False
            try:
                capture, backend_name, first_frame = _open_working_capture(source)
            except RuntimeError as error:
                self.last_recovery_error = str(error)
                continue
            if self._stop_event.is_set() or self._released:
                _safe_release(capture)
                return False
            try:
                self._adopt_capture(capture, backend_name, first_frame, source)
            except (cv2.error, OSError, RuntimeError) as error:
                self.last_recovery_error = str(error)
                _safe_release(capture)
                continue
            return True

        self.recovery_attempts += 1
        if self.recovery_attempts <= 3 or self.recovery_attempts % 10 == 0:
            print(
                f"[Camera] Reopen attempt {self.recovery_attempts} failed: "
                f"{self.last_recovery_error}"
            )
        return False

    def _adopt_capture(self, capture, backend_name, first_frame, source):
        with self.capture_lock:
            previous = self.cap
            self.src = source
            self.cap = capture
            self.backend_name = backend_name
            if sys.platform.startswith("win") and not self.device_name:
                self.device_name = _windows_directshow_present_names().get(source, "")
            self._configure_capture()
            first_frame = _read_fixed_resolution_frame(
                self.cap,
                expected_width=self.source_width,
                expected_height=self.source_height,
            )
            first_frame = video_transform.rotate(first_frame, self.rotation_angle)
            _safe_release(previous)

        now = time.time()
        now_monotonic = time.monotonic()
        with self.lock:
            self.ret = True
            self.frame = first_frame
            self.timestamp = now
            self.sequence += 1
            self.last_success_monotonic = now_monotonic
            self.consecutive_failures = 0
        self.measured_fps = 0.0
        self._last_ts = now
        self._recovering = False
        print(
            f"[Camera] Recovered with {backend_name} at index {source}: "
            f"{self.real_width}x{self.real_height}; "
            f"driver_fps={self.reported_fps:.1f}, measured_fps=pending"
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
        self._watchdog_thread.start()
        return self

    def adjust_exposure(self, delta):
        if self._stop_event.is_set() or self.cap is None:
            return apply_manual_exposure_for_device(_ClosedCapture(), delta, self.src)
        with self.capture_lock:
            if self.cap is None:
                return apply_manual_exposure_for_device(
                    _ClosedCapture(), delta, self.src
                )
            result = apply_manual_exposure_for_device(self.cap, delta, self.src)
            self._apply_exposure_result(result)
            return result

    def set_exposure(self, value):
        if self._stop_event.is_set() or self.cap is None:
            return set_manual_exposure_for_device(_ClosedCapture(), value, self.src)
        with self.capture_lock:
            if self.cap is None:
                return set_manual_exposure_for_device(
                    _ClosedCapture(), value, self.src
                )
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
            if self._recovering:
                if self._attempt_recovery():
                    continue
                if self._stop_event.is_set():
                    break
                self._stop_event.wait(CAMERA_RECOVERY_RETRY_S)
                continue

            try:
                # Keep the shared frame state readable while a driver blocks.
                with self.capture_lock:
                    ret, frame = (
                        self.cap.read()
                        if self.cap is not None else (False, None)
                    )
            except (cv2.error, OSError, RuntimeError) as error:
                if self._stop_event.is_set():
                    break
                print(f"[Camera] Frame read failed: {error}")
                ret, frame = False, None

            if self._stop_event.is_set():
                break

            if self._recovering:
                continue

            if ret and frame is not None:
                transform_started = time.perf_counter()
                frame = video_transform.rotate(frame, self.rotation_angle)
                transform_ms = (time.perf_counter() - transform_started) * 1000.0
                self.rotation_ms = 0.8 * self.rotation_ms + 0.2 * transform_ms
                now = time.time()
                now_monotonic = time.monotonic()
                dt = now - self._last_ts
                if dt > 0:
                    inst_fps = 1.0 / dt
                    self.measured_fps = (
                        inst_fps
                        if self.measured_fps <= 0
                        else 0.9 * self.measured_fps + 0.1 * inst_fps
                    )
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
                stale_s = time.monotonic() - self.last_success_monotonic
                if stale_s >= CAMERA_STALL_RECOVERY_S:
                    self._start_recovery()
                else:
                    self._stop_event.wait(0.01)

    def read(self):
        with self.lock:
            frame = crop_region.crop(self.frame, self.crop_region) if self.frame is not None else None
            return self.ret, frame, self.timestamp

    def snapshot(self, copy_frame=True, apply_crop=True):
        with self.lock:
            if self.frame is None:
                frame = None
            else:
                region = self.crop_region if apply_crop else crop_region.FULL
                x, y, right, bottom = crop_region.bounds(
                    region, self.frame.shape[1], self.frame.shape[0]
                )
                if copy_frame:
                    frame = self.frame[y:bottom, x:right].copy()
                # The capture thread replaces, rather than mutates, each
                # ndarray. A full-frame reference is therefore safe to read
                # after releasing the lock and avoids a redundant 6 MB copy.
                else:
                    frame = self.frame if (x, y, right, bottom) == (
                        0, 0, self.frame.shape[1], self.frame.shape[0]
                    ) else self.frame[y:bottom, x:right].copy()
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
        if self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=1.0)

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
