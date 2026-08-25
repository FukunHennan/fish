"""Loopback-only HTTP contract consumed by the Go controller."""

from __future__ import annotations

from flask import Flask, jsonify, request

from service import CameraCatalog, enumerate_cameras
from session import InvalidTransition, SessionMismatch


def create_app(service, camera_provider=None, camera_catalog=None):
    app = Flask(__name__)
    camera_catalog = camera_catalog or CameraCatalog(
        camera_provider or enumerate_cameras
    )

    def envelope(snapshot, ok=True, error=None, status=200, data=None):
        return jsonify({
            "ok": ok,
            "state": snapshot["state"],
            "sessionId": snapshot.get("sessionId"),
            "data": snapshot if data is None else data,
            "error": error,
        }), status

    def session_error(error):
        snapshot = service.current_session()
        code = "session_mismatch" if isinstance(error, SessionMismatch) else "invalid_transition"
        return envelope(
            snapshot, ok=False,
            error={"code": code, "message": str(error)}, status=409,
        )

    @app.get("/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/cameras")
    def cameras():
        running = service.status()["state"] == "running"
        return jsonify([
            camera.to_dict()
            for camera in camera_catalog.list(allow_refresh=not running)
        ])

    @app.post("/start")
    def start():
        body = request.get_json(silent=True) or {}
        camera_index = body.get("cameraIndex")
        if not isinstance(camera_index, int) or camera_index < 0:
            return jsonify({"message": "cameraIndex 必须是非负整数"}), 400
        if not service.start(camera_index):
            return jsonify({"message": "视觉服务已在运行"}), 409
        return jsonify(service.status())

    @app.post("/stop")
    def stop():
        service.stop()
        return jsonify(service.status())

    @app.get("/status")
    def status():
        return jsonify(service.status())

    @app.post("/action")
    def action():
        body = request.get_json(silent=True) or {}
        if not service.handle_action(body):
            return jsonify({"message": "视觉服务未运行或事件无效"}), 409
        return jsonify({"accepted": True}), 202

    @app.post("/sessions")
    def create_session():
        body = request.get_json(silent=True) or {}
        camera_index = body.get("cameraIndex")
        camera_id = body.get("cameraId")
        if not isinstance(camera_index, int) or camera_index < 0 or not camera_id:
            snapshot = service.current_session()
            return envelope(
                snapshot, ok=False,
                error={"code": "invalid_camera", "message": "摄像头参数无效"},
                status=400,
            )
        snapshot = service.create_session(str(camera_id), camera_index)
        if snapshot is None:
            return envelope(
                service.current_session(), ok=False,
                error={"code": "session_exists", "message": "视觉会话已存在"},
                status=409,
            )
        return envelope(snapshot, ok=snapshot["state"] != "error", status=201)

    @app.get("/sessions/current")
    def current_session():
        return envelope(service.current_session())

    @app.post("/sessions/<session_id>/processing")
    def start_processing(session_id):
        try:
            return envelope(service.start_processing(session_id))
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    @app.delete("/sessions/<session_id>/processing")
    def stop_processing(session_id):
        try:
            return envelope(service.stop_processing(session_id))
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    @app.post("/sessions/<session_id>/actions")
    def session_action(session_id):
        body = request.get_json(silent=True) or {}
        try:
            if not service.handle_session_action(session_id, body):
                return envelope(
                    service.current_session(), ok=False,
                    error={"code": "action_rejected", "message": "当前状态不能执行该操作"},
                    status=409,
                )
            return envelope(
                service.current_session(), data={"accepted": True}, status=202,
            )
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    @app.delete("/sessions/<session_id>")
    def delete_session(session_id):
        try:
            return envelope(service.stop_session(session_id))
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    return app
