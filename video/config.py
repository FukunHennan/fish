"""Configuration for camera capture and browser video transport."""


import os
import json
from pathlib import Path


WORK_DIR = os.path.dirname(os.path.abspath(__file__))
PROGRAM_CONFIG_PATH = Path(WORK_DIR).parent / "config" / "program.json"
with open(PROGRAM_CONFIG_PATH, "r", encoding="utf-8-sig") as program_file:
    _program_environment = json.load(program_file)["environment"]
if not isinstance(_program_environment, dict):
    raise ValueError("program.json 的 environment 必须是对象")
for _name, _value in _program_environment.items():
    if not isinstance(_value, str) or not _name.startswith(("FISH_", "ROBOFISH_")):
        raise ValueError("program.json 包含无效环境变量")
    os.environ.setdefault(_name, _value)

ASSET_DIR = os.path.join(WORK_DIR, "assets")
CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.join(WORK_DIR, ".cache")), "RoboFishVision")
OUTPUT_DIR = os.path.join(os.path.dirname(WORK_DIR), "output", "vision")
os.makedirs(CACHE_DIR, exist_ok=True)
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

# Optional camera calibration data remains for field ruler geometry.
TURN_CALIBRATION_PATH = os.path.join(ASSET_DIR, "turn_calibration.local.json")

# Tablet and RoboFish communication.
TABLET_TCP_HOST = "0.0.0.0"
TABLET_TCP_PORT = 9998
ROBOFISH_IP = "192.168.4.1"
ROBOFISH_PORT = 80

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
WEBRTC_CF_TURN_KEY_ID = os.environ.get("FISH_WEBRTC_CF_TURN_KEY_ID", "").strip()
WEBRTC_CF_TURN_API_TOKEN = os.environ.get("FISH_WEBRTC_CF_TURN_API_TOKEN", "").strip()

# Local preview.
DISPLAY_MAX_FPS = 30


