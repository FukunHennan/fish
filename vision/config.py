"""Central configuration for the desktop RoboFish vision application.

Keeping deployment values here prevents camera, networking, and control
services from importing the main UI module just to read constants.
"""

from __future__ import annotations

import os
from pathlib import Path


WORK_DIR = os.path.dirname(os.path.abspath(__file__))
ASSET_DIR = os.path.join(WORK_DIR, "assets")
OUTPUT_DIR = os.path.join(os.path.dirname(WORK_DIR), "output", "vision")
CACHE_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.join(WORK_DIR, ".cache")),
    "RoboFishVision",
)
os.makedirs(ASSET_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

# Keep generated third-party caches outside the source directory.
os.environ["YOLO_CONFIG_DIR"] = os.path.join(CACHE_DIR, "ultralytics")
os.environ["MPLCONFIGDIR"] = os.path.join(CACHE_DIR, "matplotlib")
os.makedirs(os.environ["YOLO_CONFIG_DIR"], exist_ok=True)
os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)
os.environ["OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS"] = "0"

# Camera and browser video.  This USB 2.0 Global Shutter Camera negotiates
# 960x540 when asked for 960x720, which is a 16:9 crop and breaks the fixed
# 4:3 contract.  Its stable full-frame 4:3 YUY2 mode is 640x480; keep that as
# the default and allow an explicit deployment override when another sensor
# exposes a verified mode.  Frame rate remains uncapped and is measured from
# real frame arrival intervals rather than the driver's claimed value.
TARGET_WIDTH = int(os.environ.get("FISH_CAPTURE_WIDTH", "640"))
TARGET_HEIGHT = int(os.environ.get("FISH_CAPTURE_HEIGHT", "480"))
CAPTURE_FOURCC = os.environ.get("FISH_CAPTURE_FOURCC", "YUY2").strip().upper()
if len(CAPTURE_FOURCC) != 4:
    CAPTURE_FOURCC = "YUY2"
TARGET_FPS = 0
try:
    DEFAULT_CAMERA_INDEX = int(os.environ.get("FISH_CAMERA_INDEX", "1"))
except ValueError:
    DEFAULT_CAMERA_INDEX = 1
CAMERA_LATENCY_S = 0.30
CAMERA_LATENCY_MAX_PREDICTION_M = 0.12
CAMERA_STALE_TIMEOUT_S = 0.35
ENABLE_CLAHE_DEFAULT = False

# Pool dimensions used to map the cropped/rotated effective frame to metres.
PHYSICAL_WIDTH = 3.14
PHYSICAL_HEIGHT = 1.6

# Fish detection and fixed marker tracking.
YOLO_MODEL_PATH = os.path.join(ASSET_DIR, "best.pt")
YOLO_CONF_THRESHOLD = 0.25
YOLO_IMG_SIZE = int(os.environ.get("FISH_YOLO_IMGSZ", "1920"))
_YOLO_DEVICE_VALUE = os.environ.get("FISH_YOLO_DEVICE", "0").strip()
try:
    YOLO_DEVICE = int(_YOLO_DEVICE_VALUE)
except ValueError:
    YOLO_DEVICE = _YOLO_DEVICE_VALUE
YOLO_DETECT_INTERVAL_S = 0.20
MARKER_PROFILE_PATH = os.path.join(ASSET_DIR, "marker_profile.local.json")
TURN_CALIBRATION_PATH = os.path.join(ASSET_DIR, "turn_calibration.local.json")

# Tablet and RoboFish communication.
TABLET_TCP_HOST = "0.0.0.0"
TABLET_TCP_PORT = 9998
ROBOFISH_IP = "192.168.4.1"
ROBOFISH_PORT = 80

# Position filtering.
POS_SMOOTHING_ALPHA = 0.4

# Browser video transport. WebRTC is the only production browser transport.
MJPEG_PORT = 8090
MJPEG_STREAM_WIDTH = 640
MJPEG_STREAM_HEIGHT = 480
MJPEG_JPEG_QUALITY = 50
MJPEG_MAX_FPS = 0
WEBRTC_OFFER_TIMEOUT_S = 10.0

# STUN enables the common public-NAT case. A TURN server is still required
# when either side is behind a symmetric NAT or restrictive firewall.
WEBRTC_STUN_URL = os.environ.get(
    "FISH_WEBRTC_STUN_URL",
    "stun:stun.l.google.com:19302",
).strip()
# TURN credentials are intentionally exposed to the browser because ICE needs
# them on both sides of the peer connection.
WEBRTC_TURN_URL = os.environ.get("FISH_WEBRTC_TURN_URL", "").strip()
WEBRTC_TURN_USERNAME = os.environ.get("FISH_WEBRTC_TURN_USERNAME", "").strip()
WEBRTC_TURN_CREDENTIAL = os.environ.get("FISH_WEBRTC_TURN_CREDENTIAL", "").strip()

# The browser is a control client, not part of the tracking control loop.
VISION_SESSION_HEARTBEAT_S = 1.0
VISION_SESSION_TIMEOUT_S = 3.0

# Local preview.
DISPLAY_MAX_FPS = 30


def list_yolo_models():
    """Return safe model names available in the local asset directory."""
    try:
        names = [
            path.name
            for path in Path(ASSET_DIR).glob("*.pt")
            if path.is_file()
        ]
    except OSError:
        names = []
    return sorted(set(names), key=str.casefold)


def resolve_yolo_model(model_name=None):
    """Resolve a UI model name without allowing paths outside ``assets``."""
    default_name = os.path.basename(YOLO_MODEL_PATH)
    requested = os.path.basename(str(model_name or default_name).strip())
    if requested not in list_yolo_models():
        return None
    return os.path.join(ASSET_DIR, requested)
