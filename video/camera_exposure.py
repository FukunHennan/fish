"""Camera exposure controls."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
import shutil
import subprocess
import sys
import threading
import time

import cv2

from config import CAPTURE_FOURCC, TARGET_FPS, TARGET_HEIGHT, TARGET_WIDTH


@dataclass(frozen=True)
class ExposureResult:
    status: str
    supported: bool
    requested_delta: int | None
    previous_value: float | None
    actual_value: float | None
    error_code: str | None = None
    requested_value: float | None = None
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None


@dataclass(frozen=True)
class ExposureInfo:
    supported: bool
    actual_value: float | None
    minimum: float | None
    maximum: float | None
    step: float | None
    error_code: str | None = None


def apply_manual_exposure(capture, delta):
    return apply_manual_exposure_for_device(capture, delta, None)


def get_manual_exposure_for_device(capture, device_index=None):
    """Read the current manual-exposure value and driver range."""
    if sys.platform.startswith("linux") and device_index is not None:
        device = f"/dev/video{int(device_index)}"
        listed = _run_v4l2_ctl(device, "--list-ctrls")
        if listed is not None and listed.returncode == 0:
            for candidate in ("exposure_time_absolute", "exposure_absolute", "exposure"):
                exposure = _parse_v4l2_int_control(listed.stdout, candidate)
                if exposure is not None:
                    return ExposureInfo(
                        True,
                        float(exposure["value"]),
                        float(exposure["min"]),
                        float(exposure["max"]),
                        float(exposure["step"]),
                    )
            return ExposureInfo(False, None, None, None, None, "exposure_unsupported")

    try:
        actual = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if math.isfinite(actual):
            return ExposureInfo(True, actual, None, None, None)
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        pass
    return ExposureInfo(False, None, None, None, None, "exposure_unsupported")


def _run_v4l2_ctl(device, *args):
    binary = shutil.which("v4l2-ctl")
    if binary is None:
        return None
    try:
        return subprocess.run(
            [binary, "-d", device, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _parse_v4l2_int_control(output, name):
    pattern = re.compile(
        rf"\b{re.escape(name)}\b.*?min=(-?\d+).*?max=(-?\d+)"
        rf"(?:.*?\bstep=(-?\d+))?.*?\bvalue=(-?\d+)",
        re.IGNORECASE,
    )
    match = pattern.search(output or "")
    if not match:
        return None
    minimum, maximum, step, value = match.groups()
    step = int(step) if step is not None else 1
    minimum, maximum, value = int(minimum), int(maximum), int(value)
    return {
        "min": minimum,
        "max": maximum,
        "step": max(1, abs(step)),
        "value": value,
    }


def prepare_v4l2_capture(device_index):
    """Restore a sane streaming exposure state before OpenCV opens the device."""
    if device_index is None:
        return False

    device = f"/dev/video{int(device_index)}"
    listed = _run_v4l2_ctl(device, "--list-ctrls")
    if listed is None or listed.returncode != 0:
        return False

    controls = listed.stdout
    changes = []
    for candidate in ("auto_exposure", "exposure_auto"):
        parsed = _parse_v4l2_int_control(controls, candidate)
        if parsed is None:
            continue
        if parsed["min"] <= 3 <= parsed["max"]:
            changes.append(f"{candidate}=3")
        elif parsed["min"] <= parsed["max"]:
            changes.append(f"{candidate}={parsed['max']}")
        break
    if re.search(r"(?m)^\s+exposure_dynamic_framerate\b", controls):
        changes.append("exposure_dynamic_framerate=0")

    if not changes:
        return False
    applied = _run_v4l2_ctl(device, "--set-ctrl", ",".join(changes))
    if applied is None or applied.returncode != 0:
        return False
    print(f"[Camera] Prepared V4L2 controls: {','.join(changes)}")
    return True


def _apply_v4l2_manual_exposure(device_index, delta):
    if device_index is None:
        return None
    device = f"/dev/video{int(device_index)}"
    listed = _run_v4l2_ctl(device, "--list-ctrls")
    if listed is None:
        return None
    if listed.returncode != 0:
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )
    controls = listed.stdout
    if "exposure_auto" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "exposure_auto=1")
    if "auto_exposure" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "auto_exposure=1")
    control_name = None
    exposure = None
    for candidate in ("exposure_time_absolute", "exposure_absolute", "exposure"):
        exposure = _parse_v4l2_int_control(controls, candidate)
        if exposure is not None:
            control_name = candidate
            break
    if exposure is None:
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )
    span = max(1, exposure["max"] - exposure["min"])
    step = max(exposure["step"], int(round(span * 0.05)))
    previous = exposure["value"]
    target = max(exposure["min"], min(exposure["max"], previous + int(delta) * step))
    if target == previous:
        target = max(exposure["min"], min(exposure["max"], previous + int(delta) * exposure["step"]))
    applied = _run_v4l2_ctl(device, "--set-ctrl", f"{control_name}={target}")
    if applied is None or applied.returncode != 0:
        return ExposureResult(
            "failed", True, delta, float(previous), float(previous),
            "exposure_not_applied", None, float(exposure["min"]),
            float(exposure["max"]), float(exposure["step"]),
        )
    refreshed = _run_v4l2_ctl(device, "--list-ctrls")
    actual = target
    if refreshed is not None and refreshed.returncode == 0:
        refreshed_exposure = _parse_v4l2_int_control(refreshed.stdout, control_name)
        if refreshed_exposure is not None:
            actual = refreshed_exposure["value"]
    if actual == previous:
        return ExposureResult(
            "failed", True, delta, float(previous), float(actual),
            "exposure_not_applied", None, float(exposure["min"]),
            float(exposure["max"]), float(exposure["step"]),
        )
    return ExposureResult(
        "completed", True, delta, float(previous), float(actual),
        None, None, float(exposure["min"]), float(exposure["max"]),
        float(exposure["step"]),
    )


def _set_v4l2_manual_exposure(device_index, value):
    if device_index is None:
        return None
    device = f"/dev/video{int(device_index)}"
    listed = _run_v4l2_ctl(device, "--list-ctrls")
    if listed is None:
        return None
    if listed.returncode != 0:
        return ExposureResult(
            "failed", False, None, None, None, "exposure_unsupported",
        )
    controls = listed.stdout
    control_name = None
    exposure = None
    for candidate in ("exposure_time_absolute", "exposure_absolute", "exposure"):
        exposure = _parse_v4l2_int_control(controls, candidate)
        if exposure is not None:
            control_name = candidate
            break
    if exposure is None:
        return ExposureResult(
            "failed", False, None, None, None, "exposure_unsupported",
        )

    if "exposure_auto" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "exposure_auto=1")
    if "auto_exposure" in controls:
        _run_v4l2_ctl(device, "--set-ctrl", "auto_exposure=1")

    minimum = exposure["min"]
    maximum = exposure["max"]
    step = exposure["step"]
    previous = exposure["value"]
    requested = float(value)
    target = max(minimum, min(maximum, requested))
    target = minimum + round((target - minimum) / step) * step
    target = max(minimum, min(maximum, target))
    if target == previous:
        return ExposureResult(
            "completed", True, None, float(previous), float(previous), None,
            requested, float(minimum), float(maximum), float(step),
        )

    applied = _run_v4l2_ctl(device, "--set-ctrl", f"{control_name}={target}")
    if applied is None or applied.returncode != 0:
        return ExposureResult(
            "failed", True, None, float(previous), float(previous),
            "exposure_not_applied", requested, float(minimum),
            float(maximum), float(step),
        )

    refreshed = _run_v4l2_ctl(device, "--list-ctrls")
    actual = target
    if refreshed is not None and refreshed.returncode == 0:
        refreshed_exposure = _parse_v4l2_int_control(refreshed.stdout, control_name)
        if refreshed_exposure is not None:
            actual = refreshed_exposure["value"]
    if actual == previous:
        return ExposureResult(
            "failed", True, None, float(previous), float(actual),
            "exposure_not_applied", requested, float(minimum),
            float(maximum), float(step),
        )
    return ExposureResult(
        "completed", True, None, float(previous), float(actual), None,
        requested, float(minimum), float(maximum), float(step),
    )


def apply_manual_exposure_for_device(capture, delta, device_index=None):
    if sys.platform.startswith("linux") and device_index is not None:
        fallback = _apply_v4l2_manual_exposure(device_index, delta)
        if fallback is not None:
            return fallback

    try:
        previous = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if not math.isfinite(previous):
            previous = None
        for manual_value in (0.25, 1.0):
            capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, manual_value)
            target = (previous if previous is not None else -6.0) + delta
            capture.set(cv2.CAP_PROP_EXPOSURE, target)
            actual = float(capture.get(cv2.CAP_PROP_EXPOSURE))
            if not math.isfinite(actual):
                actual = None
            if actual is not None and previous is not None and not math.isclose(actual, previous, abs_tol=1e-6):
                return ExposureResult("completed", True, delta, previous, actual)
            previous = actual if actual is not None else previous
        fallback = _apply_v4l2_manual_exposure(device_index, delta)
        if fallback is not None:
            return fallback
        return ExposureResult(
            "failed", True, delta, previous, previous,
            "exposure_not_applied",
        )
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        fallback = _apply_v4l2_manual_exposure(device_index, delta)
        if fallback is not None:
            return fallback
        return ExposureResult(
            "failed", False, delta, None, None, "exposure_unsupported",
        )


def set_manual_exposure_for_device(capture, value, device_index=None):
    """Set an absolute exposure value and verify it with driver readback."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ExposureResult(
            "failed", False, None, None, None, "invalid_exposure_value",
        )
    if not math.isfinite(float(value)):
        return ExposureResult(
            "failed", False, None, None, None, "invalid_exposure_value",
        )

    if sys.platform.startswith("linux") and device_index is not None:
        fallback = _set_v4l2_manual_exposure(device_index, value)
        if fallback is not None:
            return fallback

    try:
        previous = float(capture.get(cv2.CAP_PROP_EXPOSURE))
        if not math.isfinite(previous):
            previous = None
        requested = float(value)
        for manual_value in (0.25, 1.0):
            capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, manual_value)
            accepted = capture.set(cv2.CAP_PROP_EXPOSURE, requested)
            actual = float(capture.get(cv2.CAP_PROP_EXPOSURE))
            if not math.isfinite(actual):
                actual = None
            if actual is not None and (
                previous is None
                or math.isclose(actual, requested, abs_tol=1e-6)
                or not math.isclose(actual, previous, abs_tol=1e-6)
            ):
                return ExposureResult(
                    "completed", True, None, previous, actual, None,
                    requested,
                )
            if accepted and previous is not None and math.isclose(
                actual or previous, previous, abs_tol=1e-6
            ) and math.isclose(requested, previous, abs_tol=1e-6):
                return ExposureResult(
                    "completed", True, None, previous, actual, None,
                    requested,
                )
        return ExposureResult(
            "failed", True, None, previous, previous,
            "exposure_not_applied", requested,
        )
    except (cv2.error, OSError, RuntimeError, TypeError, ValueError):
        return ExposureResult(
            "failed", False, None, None, None, "exposure_unsupported",
            float(value),
        )
