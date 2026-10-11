"""Camera capture and frame publishing for the Pro1 video service."""


from __future__ import annotations

import os
import threading
import time
import traceback

import cv2

from config import CAMERA_STALE_TIMEOUT_S, DISPLAY_MAX_FPS, WORK_DIR
from camera_stream import RestartSafeCameraStream as CameraStream


class VisionApplication:
    """Capture and publish camera frames without computer-vision inference."""

    WINDOW_NAME = "RoboFish Camera Preview"

    def __init__(self, camera_index=1, headless=False, action_source=None,
                 action_result_sink=None, frame_sink=None, camera_factory=None):
        self.camera_factory = camera_factory or CameraStream
        self.camera_index = camera_index
        self.headless = headless
        self.action_source = action_source
        self.action_result_sink = action_result_sink
        self.frame_sink = frame_sink
        self.cam = None
        self.last_error = None
        self._last_camera_sequence = -1
        self._last_display_t = 0.0
        self._last_loop_t = time.perf_counter()
        self._loop_fps = 0.0
        self._exit_requested = False
        self._last_web_metrics_t = 0.0
        self._frame_publisher_thread = None

    def run(self):
        os.chdir(WORK_DIR)
        try:
            if not self._start():
                return 1
            self._loop()
            return 0
        except Exception as error:
            self.last_error = error
            print(f"Camera service failed: {error}")
            traceback.print_exc()
            return 1
        finally:
            self._close()

    def request_exit(self):
        self._exit_requested = True

    def _publish_frame(self, image, frame_time=None):
        if self.frame_sink is None:
            return
        update = getattr(self.frame_sink, "update", None)
        if callable(update):
            try:
                update(image, frame_time)
            except TypeError:
                update(image)
        elif callable(self.frame_sink):
            self.frame_sink(image)

    def _publish_camera_frames(self):
        last_sequence = -1
        while not self._exit_requested:
            camera = self.cam
            if camera is None:
                time.sleep(0.01)
                continue
            snapshot = camera.snapshot(copy_frame=False, apply_crop=False)
            sequence = snapshot.get("sequence", -1)
            frame = snapshot.get("frame")
            if snapshot.get("ok") and frame is not None and sequence != last_sequence:
                last_sequence = sequence
                self._publish_frame(frame, snapshot.get("timestamp"))
                continue
            time.sleep(0.002)

    def _start_frame_publisher(self):
        if not self.headless or self.frame_sink is None:
            return
        self._frame_publisher_thread = threading.Thread(
            target=self._publish_camera_frames,
            name="camera-webrtc-publisher",
            daemon=True,
        )
        self._frame_publisher_thread.start()

    def _start(self):
        self.cam = self.camera_factory(src=self.camera_index).start()
        if not self.cam.ret:
            print("Unable to open camera; check USB connection and camera index.")
            return False
        self._start_frame_publisher()
        print(f"Camera-only preview started: {self.cam.real_width}x{self.cam.real_height}")
        return True

    def _loop(self):
        while not self._exit_requested:
            snapshot = self.cam.snapshot()
            if snapshot["age_s"] > CAMERA_STALE_TIMEOUT_S:
                self._queue_input_actions()
                time.sleep(0.01)
                continue
            frame = snapshot.get("frame")
            sequence = snapshot.get("sequence")
            if not snapshot.get("ok") or frame is None or sequence == self._last_camera_sequence:
                self._queue_input_actions()
                time.sleep(0.001)
                continue
            self._last_camera_sequence = sequence
            self._update_loop_fps()
            if self._frame_publisher_thread is None:
                self._publish_frame(frame, snapshot.get("timestamp"))
            self._publish_preview_metrics(frame, snapshot.get("timestamp", time.time()))
            self._display(frame)
            self._queue_input_actions()

    def _update_loop_fps(self):
        now = time.perf_counter()
        interval = now - self._last_loop_t
        self._last_loop_t = now
        if interval > 0:
            measured = 1.0 / interval
            self._loop_fps = measured if not self._loop_fps else self._loop_fps * 0.8 + measured * 0.2

    def _display(self, frame):
        if self.headless:
            return
        now = time.perf_counter()
        if now - self._last_display_t >= 1.0 / DISPLAY_MAX_FPS:
            cv2.imshow(self.WINDOW_NAME, frame)
            self._last_display_t = now
            if cv2.waitKey(1) & 0xFF == ord("q"):
                self.request_exit()

    def _queue_input_actions(self):
        if self.action_source is not None:
            while True:
                action = self.action_source()
                if action is None:
                    break
                if not isinstance(action, dict) or action.get("type") != "camera.exposure":
                    continue
                try:
                    result = self.cam.set_exposure(action["value"]) if "value" in action else self.cam.adjust_exposure(action.get("delta", 0))
                    self._publish_exposure(result, action)
                except Exception as error:
                    if self.action_result_sink is not None:
                        self.action_result_sink({"type": "camera.exposure", "actionId": action.get("actionId"), "status": "failed", "errorCode": str(error)})

    def _publish_exposure(self, result, metadata):
        if self.action_result_sink is None:
            return
        self.action_result_sink({
            "type": "camera.exposure",
            "actionId": (metadata or {}).get("actionId"),
            "status": result.status,
            "supported": result.supported,
            "requestedDelta": result.requested_delta,
            "requestedValue": result.requested_value,
            "previousValue": result.previous_value,
            "actualValue": result.actual_value,
            "minimum": result.minimum,
            "maximum": result.maximum,
            "step": result.step,
            "errorCode": result.error_code,
        })

    def _exposure_metrics(self):
        return {
            "supported": bool(getattr(self.cam, "exposure_supported", False)),
            "actualValue": getattr(self.cam, "exposure_val", None),
            "minimum": getattr(self.cam, "exposure_min", None),
            "maximum": getattr(self.cam, "exposure_max", None),
            "step": getattr(self.cam, "exposure_step", None),
            "errorCode": getattr(self.cam, "exposure_error_code", None),
        }

    def _publish_preview_metrics(self, frame, frame_time):
        if self.action_result_sink is None:
            return
        now = time.monotonic()
        if now - self._last_web_metrics_t < 0.5:
            return
        self._last_web_metrics_t = now
        height, width = frame.shape[:2]
        self.action_result_sink({
            "type": "system.metrics",
            "metrics": {
                "frame": {"width": int(width), "height": int(height)},
                "cameraFrame": {
                    "width": int(getattr(self.cam, "source_width", width)),
                    "height": int(getattr(self.cam, "source_height", height)),
                },
                "crop": getattr(self.cam, "crop_region", {"x": 0, "y": 0, "width": 1, "height": 1}),
                "rotationAngle": float(getattr(self.cam, "rotation_angle", 0.0)),
                "rotationMs": float(getattr(self.cam, "rotation_ms", 0.0)),
                "frameLatencyMs": max(0.0, (time.time() - frame_time) * 1000.0),
                "cameraFps": float(getattr(self.cam, "measured_fps", 0.0)),
                "previewFps": self._loop_fps,
                "exposure": self._exposure_metrics(),
            },
        })

    def _close(self):
        self._exit_requested = True
        publisher = self._frame_publisher_thread
        if publisher is not None and publisher.is_alive():
            publisher.join(timeout=1.0)
        if self.frame_sink is not None:
            close_session = getattr(self.frame_sink, "close_session", None)
            if close_session is not None:
                close_session()
        if self.cam is not None:
            self.cam.release()
        if not self.headless:
            cv2.destroyAllWindows()
        print("Camera preview stopped.")


def main():
    return VisionApplication(camera_index=1).run()


if __name__ == "__main__":
    raise SystemExit(main())
