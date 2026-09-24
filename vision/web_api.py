"""Loopback-only HTTP contract consumed by the Go controller."""

from __future__ import annotations

from datetime import datetime
from threading import Lock
import json
import os
from queue import Empty

from flask import Flask, Response, jsonify, request, stream_with_context, g, send_from_directory

import crop_region
import video_transform
from camera_policy import camera_blocked
from service import CameraCatalog, UNSET, enumerate_cameras
from config import OUTPUT_DIR, YOLO_MODEL_PATH, list_yolo_models, resolve_yolo_model
from recording import RecordingError
from session import InvalidTransition, SessionMismatch
from webrtc import WebRTCServer, WebRTCUnavailable


def create_app(service, camera_provider=None, camera_catalog=None, webrtc_server=None):
    app = Flask(__name__)
    lifecycle_lock = Lock()

    @app.before_request
    def serialize_camera_mutations():
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and (request.path.startswith("/sessions") or request.path.startswith("/recordings") or request.path in ("/crop", "/rotation", "/start", "/stop", "/action")):
            lifecycle_lock.acquire()
            g.camera_mutation_locked = True

    @app.teardown_request
    def release_camera_mutation(_error):
        if g.pop("camera_mutation_locked", False):
            lifecycle_lock.release()

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

    @app.before_request
    def reject_blocked_camera():
        if request.method in ("POST", "PUT", "PATCH"):
            body = request.get_json(silent=True)
            if isinstance(body, dict) and "cameraIndex" in body and camera_blocked(body["cameraIndex"]):
                return jsonify({"message": "该摄像头已被项目禁用，请使用 Global Shutter Camera"}), 403

    @app.route("/crop", methods=["GET", "PUT"])
    def crop_settings():
        if request.method == "GET":
            return jsonify(crop_region.load())
        if webrtc_server is not None and getattr(webrtc_server, "recording_status", lambda: {})().get("active"):
            return jsonify({"message": "比赛录像进行中，不能修改选手有效区"}), 409
        current = service.current_session()
        if current and current.get("state") in ("processing", "tracking"):
            return jsonify({"message": "请先关闭识别和循迹，再调整裁剪"}), 409
        try:
            region = crop_region.validate(request.get_json(silent=True))
            crop_region.save(region)
        except (ValueError, OSError) as error:
            return jsonify({"message": str(error)}), 400
        if webrtc_server is not None:
            webrtc_server.set_crop_region(region)
        if current and current.get("state") == "previewing":
            service.stop_session(current["sessionId"])
            service.create_session(current["cameraId"], current["cameraIndex"])
        return jsonify(region)

    @app.get("/cameras")
    def cameras():
        running = service.status()["state"] == "running"
        return jsonify([
            camera.to_dict()
            for camera in camera_catalog.list(allow_refresh=not running)
            if not camera_blocked(camera.index, camera.name)
        ])

    @app.route("/rotation", methods=["GET", "PUT"])
    def rotation_settings():
        if request.method == "GET":
            return jsonify(video_transform.load())
        if webrtc_server is not None and getattr(webrtc_server, "recording_status", lambda: {})().get("active"):
            return jsonify({"message": "比赛录像进行中，不能修改画面旋转"}), 409
        current = service.current_session()
        if current and current.get("state") in ("processing", "tracking"):
            return jsonify({"message": "请先关闭识别和循迹，再调整画面旋转"}), 409
        try:
            transform = video_transform.save(request.get_json(silent=True))
        except (ValueError, OSError) as error:
            return jsonify({"message": str(error)}), 400
        if current and current.get("state") == "previewing":
            service.stop_session(current["sessionId"])
            service.create_session(current["cameraId"], current["cameraIndex"])
        return jsonify(transform)

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
            "activePeers": webrtc_server.peer_count,
            "iceServers": webrtc_server.browser_ice_servers(),
        })

    @app.post("/recordings")
    def start_recording():
        if webrtc_server is None:
            return jsonify({"message": "视频服务未配置，无法录像"}), 503
        body = request.get_json(silent=True) or {}
        recording_id = body.get("recordingId")
        if not isinstance(recording_id, str) or not recording_id.strip():
            return jsonify({"message": "recordingId 不能为空"}), 400
        current = service.current_session()
        if current.get("state") not in ("previewing", "processing", "tracking"):
            return jsonify({"message": "请先启动真实相机视频，再开始比赛"}), 409
        metadata = {
            key: body.get(key)
            for key in ("matchNo", "group", "venue", "blueName", "redName")
            if body.get(key) is not None
        }
        try:
            status = webrtc_server.start_recording(
                os.path.join(OUTPUT_DIR, "recordings"),
                recording_id.strip(),
                metadata=metadata,
            )
        except RecordingError as error:
            return jsonify({"message": str(error)}), 409
        return jsonify({"recording": status}), 201

    @app.get("/recordings/current")
    def current_recording():
        if webrtc_server is None:
            return jsonify({"recording": {"active": False, "recordingId": None}})
        return jsonify({"recording": webrtc_server.recording_status()})

    @app.delete("/recordings/<recording_id>")
    def stop_recording(recording_id):
        if webrtc_server is None:
            return jsonify({"message": "视频服务未配置，无法结束录像"}), 503
        discard = request.args.get("discard", "").lower() in ("1", "true", "yes")
        try:
            status = webrtc_server.stop_recording(recording_id, discard=discard)
        except RecordingError as error:
            return jsonify({"message": str(error)}), 409
        return jsonify({"recording": status})

    @app.get("/recordings/files/<path:file_name>")
    def recording_file(file_name):
        if file_name != os.path.basename(file_name) or not file_name.lower().endswith(".mp4"):
            return jsonify({"message": "录像文件名无效"}), 400
        return send_from_directory(
            os.path.join(OUTPUT_DIR, "recordings"),
            file_name,
            mimetype="video/mp4",
            conditional=True,
        )

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
            quality = body.get("quality", "smooth")
            if quality not in ("smooth", "hd", "full"):
                return jsonify({"error": {"message": "无效的观看清晰度"}}), 400
            view = body.get("view", "cropped")
            if view not in ("cropped", "full"):
                return jsonify({"error": {"message": "无效的视频视图"}}), 400
            answer = webrtc_server.offer(sdp, offer_type, quality=quality, view=view)
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
        target_track_id = body.get("targetTrackId")
        yolo_model = body.get("yoloModel")
        tracking_mode = body.get("trackingMode", "yolo")
        if not isinstance(camera_index, int) or camera_index < 0 or not camera_id:
            snapshot = service.current_session()
            return envelope(
                snapshot, ok=False,
                error={"code": "invalid_camera", "message": "摄像头参数无效"},
                status=400,
            )
        if target_device_id is not None and not isinstance(target_device_id, str):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_target_device", "message": "目标设备 ID 无效"}, status=400)
        if target_track_id is not None and (
            isinstance(target_track_id, bool)
            or not isinstance(target_track_id, int)
            or target_track_id < 0
        ):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_target_track", "message": "目标编号无效"}, status=400)
        if yolo_model is not None and not isinstance(yolo_model, str):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_yolo_model", "message": "YOLO 模型参数无效"}, status=400)
        if not isinstance(tracking_mode, str):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_tracking_mode", "message": "循迹模式参数无效"}, status=400)
        tracking_mode = tracking_mode.strip()
        if tracking_mode not in ("yolo", "single_fish"):
            snapshot = service.current_session()
            return envelope(snapshot, ok=False, error={"code": "invalid_tracking_mode", "message": "循迹模式参数无效"}, status=400)
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
            target_track_id,
            tracking_mode or "yolo",
        )
        if snapshot is not None:
            snapshot["yoloModel"] = (
                yolo_model_name
                or os.path.basename(YOLO_MODEL_PATH)
            )
            snapshot["trackingMode"] = tracking_mode or "yolo"
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
                    try:
                        snapshot = updates.get(timeout=15)
                    except Empty:
                        # Keep the SSE response active through Cloudflare and
                        # other idle HTTP intermediaries. This is a comment
                        # frame, so browsers do not treat it as a state update.
                        yield ": keep-alive\n\n"
                        continue
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
        target_track_id = body.get("targetTrackId")
        if target_device_id is not None and not isinstance(target_device_id, str):
            return envelope(
                service.current_session(),
                ok=False,
                error={"code": "invalid_target_device", "message": "目标设备 ID 无效"},
                status=400,
            )
        if target_track_id is not None and (
            isinstance(target_track_id, bool)
            or not isinstance(target_track_id, int)
            or target_track_id < 0
        ):
            return envelope(
                service.current_session(),
                ok=False,
                error={"code": "invalid_target_track", "message": "目标编号无效"},
                status=400,
            )
        try:
            snapshot = service.set_target_device(
                session_id,
                target_device_id.strip() if target_device_id else None,
                target_track_id=target_track_id if "targetTrackId" in body else UNSET,
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
