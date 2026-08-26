"""Headless lifecycle and camera discovery for the web vision service."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from queue import Empty, SimpleQueue
from threading import RLock
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
    def __init__(self, provider, ttl_seconds=30, clock=time.monotonic):
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
    names = (name_provider or _directshow_camera_names)()
    cameras = []

    for index in range(max_index):
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
                cameras.append(info)
                print(
                    f"[CameraCatalog] 发现 {name}: index={index}, "
                    f"backend={backend_name}, {info.width}x{info.height}, fps={info.fps}"
                )
            finally:
                _safe_release(capture)
            continue

        # Keep dependency injection simple for unit tests and special probes.
        capture = open_capture(index)
        try:
            try:
                if not capture.isOpened():
                    continue
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

            cameras.append(_camera_info(index, name, capture))
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
        "path.draw",
        "path.clear",
        "tracking.start",
        "tracking.stop",
        "turn_calibration.toggle",
        "recording.toggle",
        "snapshot.capture",
        "camera.exposure",
        "camera.clahe",
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

    def create_session(self, camera_id, camera_index):
        with self._lock:
            if self._stop_runner is not None:
                return None
            session = VisionSession.new(camera_id, camera_index)
            self._error = ""
            try:
                stop_runner = self._runner_factory(camera_index, self.publish)
            except Exception as error:
                session.fail("camera_open_failed", str(error))
                self._session = session
                return session.snapshot()
            self._stop_runner = stop_runner
            self._camera_index = camera_index
            self._session = session
            session.transition(VisionState.PREVIEWING)
            return session.snapshot()

    def current_session(self):
        with self._lock:
            if self._session is None:
                return {
                    "state": "idle", "sessionId": None,
                    "cameraId": None, "cameraIndex": None,
                    "error": None, "metrics": {}, "lastAction": None,
                }
            return self._session.snapshot()

    def start_processing(self, session_id):
        with self._lock:
            session = self._require_session(session_id)
            if session.state == VisionState.PREVIEWING:
                session.transition(VisionState.PROCESSING)
            return session.snapshot()

    def stop_processing(self, session_id):
        with self._lock:
            session = self._require_session(session_id)
            if session.state == VisionState.TRACKING:
                session.transition(VisionState.PROCESSING)
            if session.state == VisionState.PROCESSING:
                session.transition(VisionState.PREVIEWING)
            return session.snapshot()

    def handle_session_action(self, session_id, action):
        with self._lock:
            session = self._require_session(session_id)
            if session.state not in (VisionState.PROCESSING, VisionState.TRACKING):
                return False
            if not isinstance(action, dict) or action.get("type") not in self.ACTION_TYPES:
                return False
            self._actions.put(action)
            session.last_action = {"type": action["type"], "accepted": True}
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
            return snapshot

    def _require_session(self, session_id):
        if self._session is None:
            raise SessionMismatch("session_mismatch")
        self._session.require_id(session_id)
        return self._session

    def start(self, camera_index):
        return self.create_session(f"camera-{camera_index}", camera_index) is not None

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

        while self.next_action() is not None:
            pass
        return True

    def publish(self, event):
        with self._lock:
            if self._session is None or not isinstance(event, dict):
                return
            self._session.last_action = dict(event)
            if event.get("type") == "camera.exposure":
                self._session.metrics["exposure"] = {
                    "supported": bool(event.get("supported")),
                    "actualValue": event.get("actualValue"),
                    "errorCode": event.get("errorCode"),
                }

    def handle_action(self, action):
        with self._lock:
            if self._stop_runner is None:
                return False
            if not isinstance(action, dict) or action.get("type") not in self.ACTION_TYPES:
                return False
            self._actions.put(action)
            return True

    def next_action(self):
        try:
            return self._actions.get_nowait()
        except Empty:
            return None

    def status(self):
        with self._lock:
            return {
                "state": "running" if self._stop_runner is not None else "stopped",
                "cameraIndex": self._camera_index,
                "error": self._error,
            }
