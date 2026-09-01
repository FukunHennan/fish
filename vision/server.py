"""Loopback process entry point for the headless vision application."""

from __future__ import annotations

import threading
import time
from waitress import serve as waitress_serve

import main as vision_main
from camera_stream import RestartSafeCameraStream
from service import VisionService
from tracking_application import TrackingVisionApplication
from web_api import create_app

# The web UI repeatedly opens and closes preview sessions. Use stricter
# DirectShow shutdown semantics for this path so a new session cannot race a
# capture thread that still owns the USB camera.
vision_main.CameraStream = RestartSafeCameraStream
VisionApplication = TrackingVisionApplication


def start_application_runner(
    camera_index,
    action_source,
    action_result_sink=None,
    application_factory=VisionApplication,
    stop_timeout=5.0,
    startup_timeout=3.0,
):
    application = application_factory(
        camera_index=camera_index,
        headless=True,
        action_source=action_source,
        action_result_sink=action_result_sink,
    )
    thread = threading.Thread(
        target=application.run,
        name="fish-vision-application",
        daemon=True,
    )
    thread.start()

    if hasattr(application, "cam"):
        deadline = time.monotonic() + startup_timeout
        while application.cam is None and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        if application.cam is None and not thread.is_alive():
            error = getattr(application, "last_error", None)
            message = str(error) if error else "vision_application_start_failed"
            raise RuntimeError(message)

    def stop():
        application.request_exit()
        thread.join(timeout=stop_timeout)
        if thread.is_alive():
            raise RuntimeError("vision_application_stop_timeout")

    return stop


def run_http_server(app, serve=waitress_serve):
    serve(app, host="127.0.0.1", port=8091, threads=8)


def main():
    service = None

    def runner_factory(camera_index, _publish):
        return start_application_runner(camera_index, service.next_action, service.publish)

    service = VisionService(runner_factory=runner_factory)
    app = create_app(service)
    run_http_server(app)


if __name__ == "__main__":
    main()
