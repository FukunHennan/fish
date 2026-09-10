"""Normalized crop shared by capture, display and recognition."""
import json
import math
from pathlib import Path
from config import CACHE_DIR

PATH = Path(CACHE_DIR) / "camera-crop.json"
FULL = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}

def validate(value):
    if not isinstance(value, dict):
        raise ValueError("裁剪区域无效")
    result = {}
    for key in FULL:
        item = value.get(key)
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError("裁剪参数必须是有限数字")
        result[key] = float(item)
    x, y, w, h = (result[k] for k in FULL)
    if x < 0 or y < 0 or w < .05 or h < .05 or x+w > 1.000001 or y+h > 1.000001:
        raise ValueError("区域必须在画面内，宽高至少为全画面的 5%")
    return result

def load():
    if not PATH.exists(): return dict(FULL)
    return validate(json.loads(PATH.read_text()))

def save(value):
    value = validate(value)
    PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(PATH)
    return value

def bounds(region, width, height):
    x = int(region["x"] * width); y = int(region["y"] * height)
    right = min(width, round((region["x"]+region["width"]) * width))
    bottom = min(height, round((region["y"]+region["height"]) * height))
    return x, y, right, bottom

def crop(frame, region):
    x,y,r,b = bounds(region, frame.shape[1], frame.shape[0])
    return frame[y:b, x:r].copy()
