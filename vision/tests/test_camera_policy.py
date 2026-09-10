from pathlib import Path
import tempfile
import unittest
from camera_policy import camera_blocked

class CameraPolicyTests(unittest.TestCase):
    def test_blocks_identity_not_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, name in [(0, "Global Shutter Camera"), (7, "USB2.0 FHD UVC WebCam")]:
                node = root / f"video{index}"
                node.mkdir()
                (node / "name").write_text(name)
            self.assertFalse(camera_blocked(0, root=root))
            self.assertTrue(camera_blocked(7, root=root))
            self.assertTrue(camera_blocked("/dev/video7", root=root))
    def test_named_camera(self):
        self.assertTrue(camera_blocked(99, "USB2.0 FHD UVC WebCam"))
        self.assertFalse(camera_blocked(99, "Global Shutter Camera"))
