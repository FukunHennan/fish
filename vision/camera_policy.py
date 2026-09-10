"""Project camera exclusions, independent of unstable /dev/video numbering."""
from pathlib import Path

BLOCKED_NAMES = ("usb2.0 fhd uvc webcam",)


def camera_blocked(source, name="", root=Path("/sys/class/video4linux")):
    if name:
        return any(value in str(name).casefold() for value in BLOCKED_NAMES)
    node = None
    if isinstance(source, int):
        node = f"video{source}"
    elif isinstance(source, str):
        if source.isdigit():
            node = f"video{source}"
        elif source.startswith("/dev/"):
            node = Path(source).resolve().name
    if node:
        try:
            device_name = (root / node / "name").read_text().strip().casefold()
            return any(value in device_name for value in BLOCKED_NAMES)
        except OSError:
            pass
    return False
