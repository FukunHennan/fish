"""Loopback process entry point for the headless vision application."""

from __future__ import annotations

import threading
from waitress import serve as waitress_serve

from main import VisionApplication
from service import VisionService
from web_api import create_app


def start_application_runner(
    camera_index,
    action_source,
    action_result_sink=None,
    application_factory=VisionApplication,
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

    def stop():
        application.request_exit()
        thread.join(timeout=5)

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
