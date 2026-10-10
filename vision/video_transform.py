"""Persistent, capture-wide video transforms applied before cropping."""

from __future__ import annotations

import math

import cv2

import camera_settings


DEFAULT = {"angle": 0.0}


def validate(value):
    if not isinstance(value, dict):
        raise ValueError("画面旋转参数无效")
    angle = value.get("angle")
    if isinstance(angle, bool) or not isinstance(angle, (int, float)):
        raise ValueError("旋转角度必须是数字")
    angle = float(angle)
    if not math.isfinite(angle) or angle < -180.0 or angle > 180.0:
        raise ValueError("旋转角度必须在 -180° 到 180° 之间")
    return {"angle": angle}


def load():
    return {"angle": camera_settings.load()["rotationAngle"]}


def save(value):
    value = validate(value)
    camera_settings.save(rotationAngle=value["angle"])
    return value


def rotate(frame, angle):
    """Rotate within the original canvas so normalized crop coordinates stay stable."""
    angle = float(angle)
    if abs(angle) < 0.001:
        return frame
    height, width = frame.shape[:2]
    center = ((width - 1) / 2.0, (height - 1) / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(
        frame,
        matrix,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
