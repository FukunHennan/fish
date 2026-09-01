"""Translate validated browser gestures into the existing vision runtime actions."""

from __future__ import annotations


SIMPLE_ACTIONS = {
    "marker.select": "MARKER_ROI",
    "heading.select": "HEAD_DIRECTION",
    "heading.calibrate": "AUTO_HEAD_DIRECTION",
    "calibration.toggle": "POOL_CALIB",
    "path.clear": "CLEAR_PATH",
    "tracking.start": "START",
    "tracking.stop": "STOP",
    "turn_calibration.toggle": "TURN_CALIB",
    "recording.toggle": "RECORD",
    "snapshot.capture": "SNAPSHOT",
    "camera.clahe": "CLAHE",
    "system.stop": "STOP",
}


def _point(action, x_name="x", y_name="y", frame_size=None):
    x = action.get(x_name)
    y = action.get(y_name)
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    if frame_size is not None:
        width, height = frame_size
        if x < 0 or y < 0 or x >= width or y >= height:
            return None
    return int(round(x)), int(round(y))


def translate_web_action(action, frame_size=None):
    action_type = action.get("type") if isinstance(action, dict) else None
    if action_type in SIMPLE_ACTIONS:
        return SIMPLE_ACTIONS[action_type]
    if action_type in ("calibration.point", "heading.point"):
        point = _point(action, frame_size=frame_size)
        if point is None:
            return None
        runtime_type = (
            "APPLY_POOL_POINT" if action_type == "calibration.point"
            else "APPLY_HEAD_DIRECTION"
        )
        return runtime_type, point
    if action_type == "marker.roi":
        start = _point(action, frame_size=frame_size)
        end = _point(action, "x2", "y2", frame_size=frame_size)
        if start is None or end is None:
            return None
        return "APPLY_MARKER_ROI", (*start, *end)
    if action_type == "path.draw":
        points = action.get("points")
        if not isinstance(points, list) or len(points) < 2:
            return None
        translated = []
        for value in points:
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                return None
            point = _point({"x": value[0], "y": value[1]}, frame_size=frame_size)
            if point is None:
                return None
            translated.append(point)
        return "SET_PATH", translated
    if action_type == "camera.exposure":
        delta = action.get("value")
        if delta not in (-1, 1):
            return None
        return "EXP_DOWN" if delta < 0 else "EXP_UP"
    if action_type == "overlay.set":
        overlays = action.get("overlays")
        if not isinstance(overlays, dict):
            return None
        payload = {}
        for key in ("detections", "paths"):
            if key in overlays:
                value = overlays.get(key)
                if not isinstance(value, bool):
                    return None
                payload[key] = value
        if not payload:
            return None
        return "OVERLAY_OPTIONS", payload
    return None
