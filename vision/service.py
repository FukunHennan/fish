"""Headless lifecycle and camera discovery for the web vision service."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from queue import Empty, Queue, SimpleQueue
from threading import RLock
import inspect
import math
import time
from typing import Callable, Optional

import cv2
from camera_stream import _open_working_capture, _safe_get, _safe_release
from session import SessionMismatch, VisionSession, VisionState


@dataclass(frozen=True)
class CameraInfo:
    index: int
    name: str
    width: int
    height: int
    fps: Optional[int]

    def to_dict(self):
        data = asdict(self)
        return {
            "index": data["index"],
            "name": data["name"],
            "width": data["width"],
            "height": data["height"],
            "fps": data["fps"],
        }


class CameraCatalog:
    def __init__(self, provider, ttl_seconds=60, clock=time.monotonic):
        self._provider = provider
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._lock = RLock()
        self._expires_at = 0
        self._items = []

    def list(self, allow_refresh=True):
        with self._lock:
            now = self._clock()
            if not self._items or (allow_refresh and now >= self._expires_at):
                self._items = list(self._provider())
                self._expires_at = now + self._ttl_seconds
            return list(self._items)


def _directshow_camera_names():
    try:
        from pygrabber.dshow_graph import FilterGraph
        return FilterGraph().get_input_devices()
    except (ImportError, OSError):
        return []


def _linux_v4l2_camera_names(max_index=8, root=Path("/sys/class/video4linux")):
    names = []
    for index in range(max_index):
        name = ""
        try:
            name = (root / f"video{index}" / "name").read_text(encoding="utf-8").strip()
        except OSError:
            pass
        names.append(name or f"摄像头 {index}")
    return names


def _linux_v4l2_camera_indexes(max_index=8, root=Path("/sys/class/video4linux")):
    indexes = []
    try:
        candidates = list(root.glob("video*"))
    except OSError:
        return indexes
    for candidate in candidates:
        suffix = candidate.name.removeprefix("video")
        if suffix.isdigit():
            index = int(suffix)
            if 0 <= index < max_index:
                indexes.append(index)
    return sorted(set(indexes))


def _camera_info(index, name, capture):
    reported_fps = _safe_get(capture, cv2.CAP_PROP_FPS, 0.0)
    return CameraInfo(
        index=index,
        name=name,
        width=int(_safe_get(capture, cv2.CAP_PROP_FRAME_WIDTH, 0.0)),
        height=int(_safe_get(capture, cv2.CAP_PROP_FRAME_HEIGHT, 0.0)),
        fps=(
            int(reported_fps)
            if math.isfinite(reported_fps) and reported_fps > 0
            else None
        ),
    )


def enumerate_cameras(
    max_index=8,
    open_capture=None,
    name_provider=None,
    probe_attempts=5,
):
    names_are_complete_device_list = False
    if name_provider is not None:
        names = name_provider()
        names_are_complete_device_list = bool(names)
    else:
        names = _directshow_camera_names()
        names_are_complete_device_list = bool(names)
        if not names:
            names = _linux_v4l2_camera_names(max_index=max_index)
            linux_indexes = _linux_v4l2_camera_indexes(max_index=max_index)
        else:
            linux_indexes = []
    cameras = []
    # DirectShow already gives us the complete ordered device list on Windows.
    # Do not probe indexes beyond it: OpenCV emits scary "index out of range"
    # errors for every missing slot and makes an otherwise healthy scan noisy.
    probe_count = min(max_index, len(names)) if names_are_complete_device_list else max_index
    probe_indexes = range(probe_count)
    if not names_are_complete_device_list and "linux_indexes" in locals() and linux_indexes:
        probe_indexes = linux_indexes
    seen_capture_signatures = set()

    for index in probe_indexes:
        name = names[index] if index < len(names) else f"摄像头 {index}"

        if open_capture is None:
            # Use the exact same DSHOW -> MSMF -> ANY fallback policy as the
            # real camera stream. This prevents discovery from repeatedly
            # assuming DirectShow works when it cannot capture by index.
            try:
                capture, backend_name, _first_frame = _open_working_capture(index)
            except RuntimeError:
                continue
            try:
                info = _camera_info(index, name, capture)
                signature = (info.name, info.width, info.height, info.fps)
                if signature in seen_capture_signatures:
                    continue
                seen_capture_signatures.add(signature)
                cameras.append(info)
                print(
                    f"[CameraCatalog] Found {name}: index={index}, "
                    f"backend={backend_name}, {info.width}x{info.height}, fps={info.fps}"
                )
            finally:
                _safe_release(capture)
            continue

        # Keep dependency injection behavior stable for existing unit tests and
        # special probes: configuration failures still exclude the candidate.
        capture = open_capture(index)
        try:
            try:
                if not capture.isOpened():
                    continue
                capture.set(
                    cv2.CAP_PROP_FOURCC,
                    cv2.VideoWriter_fourcc(*"MJPG"),
                )
            except (cv2.error, OSError, RuntimeError, AttributeError):
                continue

            readable = False
            try:
                for _ in range(probe_attempts):
                    ok, frame = capture.read()
                    if ok and frame is not None:
                        readable = True
                        break
            except (cv2.error, OSError, RuntimeError):
                readable = False
            if not readable:
                continue

            info = _camera_info(index, name, capture)
            signature = (info.name, info.width, info.height, info.fps)
            if signature in seen_capture_signatures:
                continue
            seen_capture_signatures.add(signature)
            cameras.append(info)
        finally:
            _safe_release(capture)

    return cameras


class VisionService:
    ACTION_TYPES = frozenset({
        "calibration.point",
        "calibration.toggle",
        "marker.roi",
        "marker.select",
        "heading.point",
        "heading.select",
        "heading.calibrate",
        "path.draw",
        "path.clear",
        "tracking.start",
        "tracking.stop",
        "turn_calibration.toggle",
        "recording.toggle",
        "snapshot.capture",
        "camera.exposure",
        "camera.clahe",
        "overlay.set",
        "system.stop",
    })

    def __init__(self, runner_factory: Callable):
        self._runner_factory = runner_factory
        self._lock = RLock()
        self._stop_runner = None
        self._camera_index = None
        self._error = ""
        self._actions = SimpleQueue()
        self._session = None
        self._subscribers = set()
        self._last_metrics_notify = 0.0

    def create_session(self, camera_id, camera_index, target_device_id=None, yolo_model=None):
        with self._lock:
            if self._stop_runner is not None:
                return None
            session = VisionSession.new(
                camera_id, camera_index, target_device_id, yolo_model
            )
            self._error = ""
            try:
                parameters = list(inspect.signature(self._runner_factory).parameters.values())
                accepts_model = any(
                    parameter.kind == inspect.Parameter.VAR_POSITIONAL
                    or parameter.kind == inspect.Parameter.VAR_KEYWORD
                    or parameter.name == "yolo_model_path"
                    for parameter in parameters
                ) or len(parameters) >= 3
                if accepts_model:
                    stop_runner = self._runner_factory(
                        camera_index, self.publish, yolo_model
                    )
                else:
                    stop_runner = self._runner_factory(camera_index, self.publish)
            except Exception as error:
                session.fail("camera_open_failed", str(error))
                self._session = session
                return session.snapshot()
            self._stop_runner = stop_runner
            self._camera_index = camera_index
            self._session = session
            session.transition(VisionState.PREVIEWING)
            self._notify()
            return session.snapshot()

    def current_session(self):
        with self._lock:
            if self._session is None:
                return {
                    "state": "idle", "sessionId": None,
                    "cameraId": None, "cameraIndex": None, "targetDeviceId": None,
                    "yoloModel": None,
                    "error": None, "metrics": {}, "lastAction": None,
                }
            return self._session.snapshot()

    def start_processing(self, session_id):
        with self._lock:
            session = self._require_session(session_id)
            if session.state == VisionState.PREVIEWING:
                session.transition(VisionState.PROCESSING)
                self._actions.put("PROCESSING_START")
            self._notify()
            return session.snapshot()

    def stop_processing(self, session_id):
        with self._lock:
            session = self._require_session(session_id)
            was_tracking = session.state == VisionState.TRACKING
            if session.state == VisionState.TRACKING:
                session.transition(VisionState.PROCESSING)
            if session.state == VisionState.PROCESSING:
                session.transition(VisionState.PREVIEWING)
            if was_tracking:
                self._actions.put("STOP")
            self._actions.put("PROCESSING_STOP")
            self._notify()
            return session.snapshot()

    def handle_session_action(self, session_id, action):
        with self._lock:
            session = self._require_session(session_id)
            if not isinstance(action, dict) or action.get("type") not in self.ACTION_TYPES:
                return False
            if action.get("type") in ("overlay.set", "camera.exposure"):
                allowed_states = (VisionState.PREVIEWING, VisionState.PROCESSING, VisionState.TRACKING)
            else:
                allowed_states = (VisionState.PROCESSING, VisionState.TRACKING)
            if session.state not in allowed_states:
                return False
            action = dict(action)
            if session.target_device_id:
                action["deviceId"] = session.target_device_id
            self._actions.put(action)
            session.last_action = {"type": action["type"], "accepted": True}
            self._notify()
            return True

    def stop_session(self, session_id):
        with self._lock:
            session = self._require_session(session_id)
        if not self.stop():
            with self._lock:
                return session.snapshot()
        with self._lock:
            session.transition(VisionState.IDLE)
            snapshot = session.snapshot()
            snapshot["sessionId"] = None
            snapshot["cameraId"] = None
            snapshot["cameraIndex"] = None
            self._session = None
            self._notify()
            return snapshot

    def _require_session(self, session_id):
        if self._session is None:
            raise SessionMismatch("session_mismatch")
        self._session.require_id(session_id)
        return self._session

    def start(self, camera_index):
        return self.create_session(f"camera-{camera_index}", camera_index) is not None

    def set_target_device(self, session_id, target_device_id):
        with self._lock:
            session = self._require_session(session_id)
            if session.state not in (
                VisionState.PREVIEWING,
                VisionState.PROCESSING,
                VisionState.TRACKING,
            ):
                return None
            session.target_device_id = (
                target_device_id.strip() if target_device_id else None
            )
            self._notify()
            return session.snapshot()

    def switch_camera(self, session_id, camera_id, camera_index):
        with self._lock:
            session = self._require_session(session_id)
            target_device_id = session.target_device_id
            if session.camera_index == camera_index:
                return session.snapshot()

        if not self.stop():
            return self.current_session()

        with self._lock:
            if self._session is not None:
                self._session.transition(VisionState.IDLE)
                self._session = None

        snapshot = self.create_session(
            camera_id, camera_index, target_device_id, session.yolo_model
        )
        if snapshot is None:
            return self.current_session()
        return snapshot

    def stop(self):
        with self._lock:
            if self._stop_runner is None:
                return False
            stop_runner = self._stop_runner
            if self._session is not None and self._session.state not in (
                VisionState.STOPPING, VisionState.ERROR
            ):
                self._session.transition(VisionState.STOPPING)

        try:
            stop_runner()
        except Exception as error:
            with self._lock:
                self._error = str(error)
                if self._session is not None:
                    self._session.fail("vision_stop_failed", str(error))
            return False

        with self._lock:
            self._stop_runner = None
            self._camera_index = None
            self._error = ""
            self._notify()

        while self.next_action() is not None:
            pass
        return True

    def publish(self, event):
        with self._lock:
            if self._session is None or not isinstance(event, dict):
                return
            if event.get("type") == "system.metrics":
                metrics = event.get("metrics")
                if isinstance(metrics, dict):
                    self._session.metrics.update(metrics)
                now = time.monotonic()
                if now - self._last_metrics_notify < 0.5:
                    return
                self._last_metrics_notify = now
                self._notify()
                return
            self._session.last_action = dict(event)
            if event.get("type") == "camera.exposure":
                self._session.metrics["exposure"] = {
                    "supported": bool(event.get("supported")),
                    "actualValue": event.get("actualValue"),
                    "minimum": event.get("minimum"),
                    "maximum": event.get("maximum"),
                    "step": event.get("step"),
                    "requestedValue": event.get("requestedValue"),
                    "errorCode": event.get("errorCode"),
                }
            self._notify()

    def handle_action(self, action):
        with self._lock:
            if self._stop_runner is None:
                return False
            if not isinstance(action, dict) or action.get("type") not in self.ACTION_TYPES:
                return False
            self._actions.put(action)
            self._notify()
            return True

    def next_action(self):
        try:
            return self._actions.get_nowait()
        except Empty:
            return None

    def subscribe(self):
        updates = Queue(maxsize=1)
        with self._lock:
            self._subscribers.add(updates)

        def unsubscribe():
            with self._lock:
                self._subscribers.discard(updates)

        return updates, unsubscribe

    def _notify(self):
        snapshot = self.current_session()
        for queue in list(self._subscribers):
            try:
                if queue.full():
                    try:
                        queue.get_nowait()
                    except Empty:
                        pass
                queue.put_nowait(snapshot)
            except Exception:
                self._subscribers.discard(queue)

    def status(self):
        with self._lock:
            return {
                "state": "running" if self._stop_runner is not None else "stopped",
                "cameraIndex": self._camera_index,
                "error": self._error,
            }
