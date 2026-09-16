"""Loopback process entry point for the headless vision application."""

from __future__ import annotations

import threading
import time
from waitress import serve as waitress_serve

import main as vision_main
from camera_stream import RestartSafeCameraStream
from config import DEFAULT_CAMERA_INDEX, resolve_yolo_model
from service import CameraCatalog, VisionService, enumerate_cameras
from web_api import create_app
from webrtc import WebRTCServer

# The web UI repeatedly opens and closes preview sessions. Use stricter
# DirectShow shutdown semantics for this path so a new session cannot race a
# capture thread that still owns the USB camera.
vision_main.CameraStream = RestartSafeCameraStream
VisionApplication = vision_main.VisionApplication


def start_application_runner(
    camera_index,
    action_source,
    action_result_sink=None,
    application_factory=VisionApplication,
    stop_timeout=5.0,
    startup_timeout=3.0,
    frame_sink=None,
    yolo_model_path=None,
    application_sink=None,
    **dependencies,
):
    application_options = {
        "camera_index": camera_index,
        "headless": True,
        "action_source": action_source,
        "action_result_sink": action_result_sink,
    }
    if frame_sink is not None:
        application_options["frame_sink"] = frame_sink
    if yolo_model_path is not None:
        application_options["yolo_model_path"] = yolo_model_path
    application_options.update(dependencies)
    application = application_factory(
        **application_options,
    )
    if application_sink is not None:
        application_sink(application)
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
    root_application = [None]
    webrtc = WebRTCServer().start()

    def runner_factory(camera_index, _publish, yolo_model_path=None, tracking_mode="yolo"):
        return start_application_runner(
            camera_index,
            service.next_action,
            service.publish,
            frame_sink=webrtc,
            yolo_model_path=yolo_model_path,
            tracking_mode=tracking_mode,
            application_sink=lambda application: root_application.__setitem__(0, application),
        )

    service = VisionService(runner_factory=runner_factory)
    camera_catalog = CameraCatalog(enumerate_cameras)
    cameras = camera_catalog.list()
    if cameras:
        selected = next(
            (
                camera
                for camera in cameras
                if camera.index == DEFAULT_CAMERA_INDEX
            ),
            cameras[0],
        )
        snapshot = service.create_session(
            f"camera-{selected.index}",
            selected.index,
        )
        if snapshot is not None and snapshot["state"] == "previewing":
            print(
                f"Default camera preview started: "
                f"{selected.name} (index={selected.index})"
            )
        else:
            print(f"Default camera preview failed: {snapshot}")
    else:
        print("No camera found; waiting for a camera selection from the web UI.")
    app = create_app(
        service,
        camera_catalog=camera_catalog,
        webrtc_server=webrtc,
    )
    from workspaces import WorkspaceDispatcher
    dispatcher = WorkspaceDispatcher(
        app, service, lambda: root_application[0],
        start_application_runner, camera_catalog,
    )
    try:
        run_http_server(dispatcher)
    finally:
        dispatcher.close_all()
        webrtc.close()


if __name__ == "__main__":
    main()
