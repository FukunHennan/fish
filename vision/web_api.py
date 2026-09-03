"""Loopback-only HTTP contract consumed by the Go controller."""

from __future__ import annotations

from datetime import datetime
import json
import os

from flask import Flask, Response, jsonify, request, stream_with_context

from service import CameraCatalog, enumerate_cameras
from config import YOLO_MODEL_PATH, list_yolo_models, resolve_yolo_model
from session import InvalidTransition, SessionMismatch
from webrtc import WebRTCServer, WebRTCUnavailable


def create_app(service, camera_provider=None, camera_catalog=None, webrtc_server=None):
    app = Flask(__name__)
    camera_catalog = camera_catalog or CameraCatalog(
        camera_provider or enumerate_cameras
    )

    def server_clock():
        current = datetime.now().astimezone()
        offset = current.utcoffset()
        return {
            "serverTime": current.timestamp(),
            "serverUtcOffsetMinutes": (
                int(offset.total_seconds() // 60) if offset is not None else 0
            ),
        }

    def build_envelope(snapshot, ok=True, error=None, data=None):
        clock = server_clock()
        snapshot_data = dict(snapshot)
        snapshot_data.update(clock)
        return {
            "ok": ok,
            "state": snapshot["state"],
            "sessionId": snapshot.get("sessionId"),
            "serverTime": clock["serverTime"],
            "serverUtcOffsetMinutes": clock["serverUtcOffsetMinutes"],
            "data": snapshot_data if data is None else data,
            "error": error,
        }

    def envelope(snapshot, ok=True, error=None, status=200, data=None):
        return jsonify(build_envelope(snapshot, ok=ok, error=error, data=data)), status

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

    @app.get("/yolo/models")
    def yolo_models():
        models = list_yolo_models()
        default = os.path.basename(YOLO_MODEL_PATH)
        return jsonify({
            "models": models,
            "default": default if default in models else (models[0] if models else None),
        })

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

    @app.get("/webrtc/config")
    def webrtc_config():
        if webrtc_server is None:
            return jsonify({"available": False, "iceServers": []})
        return jsonify({
            "available": bool(webrtc_server.available),
            "iceServers": webrtc_server.browser_ice_servers(),
        })

    @app.post("/webrtc/offer")
    def webrtc_offer():
        body = request.get_json(silent=True) or {}
        session_id = body.get("sessionId")
        sdp = body.get("sdp")
        offer_type = body.get("type", "offer")
        current = service.current_session()
        if (
            not isinstance(session_id, str)
            or session_id != current.get("sessionId")
            or current.get("state") not in ("previewing", "processing", "tracking")
        ):
            return jsonify({
                "ok": False,
                "error": {"code": "session_mismatch", "message": "视觉会话无效"},
            }), 409
        if not isinstance(sdp, str) or not sdp.strip() or offer_type != "offer":
            return jsonify({
                "ok": False,
                "error": {"code": "invalid_offer", "message": "WebRTC Offer 无效"},
            }), 400
        if webrtc_server is None:
            return jsonify({
                "ok": False,
                "error": {"code": "webrtc_unavailable", "message": "WebRTC 服务未配置"},
            }), 503
        try:
            answer = webrtc_server.offer(sdp, offer_type)
        except WebRTCUnavailable as error:
            return jsonify({
                "ok": False,
                "error": {"code": "webrtc_unavailable", "message": str(error)},
            }), 503
        except Exception as error:
            return jsonify({
                "ok": False,
                "error": {"code": "webrtc_offer_failed", "message": str(error)},
            }), 502
        return jsonify(answer)

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
        target_device_id = body.get("targetDeviceId")
        yolo_model = body.get("yoloModel")
        if not isinstance(camera_index, int) or camera_index < 0 or not camera_id:
            snapshot = service.current_session()
            return envelope(
                snapshot, ok=False,
                error={"code": "invalid_camera", "message": "摄像头参数无效"},
                status=400,
            )
        if target_device_id is not None and (not isinstance(target_device_id, str) or not target_device_id.strip()):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_target_device", "message": "目标设备 ID 无效"}, status=400)
        if yolo_model is not None and not isinstance(yolo_model, str):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_yolo_model", "message": "YOLO 模型参数无效"}, status=400)
        yolo_model_name = yolo_model.strip() if yolo_model else None
        yolo_model_path = resolve_yolo_model(yolo_model_name)
        if yolo_model_name and yolo_model_path is None:
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_yolo_model", "message": "未找到可用的 YOLO .pt 模型"}, status=400)
        snapshot = service.create_session(
            str(camera_id),
            camera_index,
            target_device_id.strip() if target_device_id else None,
            yolo_model_path or YOLO_MODEL_PATH,
        )
        if snapshot is not None:
            snapshot["yoloModel"] = (
                yolo_model_name
                or os.path.basename(YOLO_MODEL_PATH)
            )
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

    @app.get("/events")
    def events():
        updates, unsubscribe = service.subscribe()

        @stream_with_context
        def generate():
            try:
                yield f"event: session\ndata: {json.dumps(build_envelope(service.current_session()), separators=(',', ':'))}\n\n"
                while True:
                    snapshot = updates.get()
                    yield f"event: session\ndata: {json.dumps(build_envelope(snapshot), separators=(',', ':'))}\n\n"
            finally:
                unsubscribe()

        response = Response(generate(), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Accel-Buffering"] = "no"
        return response

    @app.post("/sessions/<session_id>/processing")
    def start_processing(session_id):
        try:
            return envelope(service.start_processing(session_id))
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    @app.post("/sessions/<session_id>/camera")
    def switch_camera(session_id):
        body = request.get_json(silent=True) or {}
        camera_index = body.get("cameraIndex")
        camera_id = body.get("cameraId")
        if not isinstance(camera_index, int) or camera_index < 0 or not camera_id:
            return envelope(
                service.current_session(),
                ok=False,
                error={"code": "invalid_camera", "message": "摄像头参数无效"},
                status=400,
            )
        try:
            snapshot = service.switch_camera(
                session_id, str(camera_id), camera_index
            )
            return envelope(
                snapshot,
                ok=snapshot["state"] != "error",
                status=200,
            )
        except (SessionMismatch, InvalidTransition) as error:
            return session_error(error)

    @app.post("/sessions/<session_id>/target")
    def set_target_device(session_id):
        body = request.get_json(silent=True) or {}
        target_device_id = body.get("targetDeviceId")
        if target_device_id is not None and (
            not isinstance(target_device_id, str)
            or not target_device_id.strip()
        ):
            return envelope(
                service.current_session(),
                ok=False,
                error={"code": "invalid_target_device", "message": "目标设备 ID 无效"},
                status=400,
            )
        try:
            snapshot = service.set_target_device(
                session_id,
                target_device_id.strip() if target_device_id else None,
            )
            if snapshot is None:
                return envelope(
                    service.current_session(),
                    ok=False,
                    error={"code": "invalid_transition", "message": "当前状态不能修改目标设备"},
                    status=409,
                )
            return envelope(snapshot)
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
