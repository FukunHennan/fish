"""Camera settings stored alongside the other program settings."""

from __future__ import annotations

import json
import math
import os
import threading
from config import PROGRAM_CONFIG_PATH


PATH = PROGRAM_CONFIG_PATH
_lock = threading.Lock()
DEFAULT = {"rotationAngle": 0.0, "exposure": -6.0}


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name}必须是数字")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name}必须是有限数字")
    return value


def _read():
    data = json.loads(PATH.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or not isinstance(data.get("environment"), dict):
        raise ValueError("program.json 缺少 environment 对象")
    camera = data.get("camera", {})
    if not isinstance(camera, dict):
        raise ValueError("program.json 的 camera 必须是对象")
    return data, camera


def load():
    _, camera = _read()
    angle = _number(camera.get("rotationAngle", DEFAULT["rotationAngle"]), "旋转角度")
    if angle < -180 or angle > 180:
        raise ValueError("旋转角度必须在 -180° 到 180° 之间")
    return {
        "rotationAngle": angle,
        "exposure": _number(camera.get("exposure", DEFAULT["exposure"]), "曝光值"),
    }


def save(**changes):
    with _lock:
        data, camera = _read()
        candidate = {**camera, **changes}
        angle = _number(candidate.get("rotationAngle", DEFAULT["rotationAngle"]), "旋转角度")
        if angle < -180 or angle > 180:
            raise ValueError("旋转角度必须在 -180° 到 180° 之间")
        exposure = _number(candidate.get("exposure", DEFAULT["exposure"]), "曝光值")
        data["camera"] = {**camera, "rotationAngle": angle, "exposure": exposure}
        temporary = PATH.with_name(f"{PATH.name}.{os.getpid()}.tmp")
        try:
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(PATH)
        finally:
            temporary.unlink(missing_ok=True)
        return {"rotationAngle": angle, "exposure": exposure}
