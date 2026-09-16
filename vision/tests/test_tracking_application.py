import unittest

from main import VisionApplication
from tracking_application import TrackingVisionApplication


class TrackingApplicationStrictModeTests(unittest.TestCase):
    def test_compatibility_application_uses_strict_base(self):
        self.assertTrue(issubclass(TrackingVisionApplication, VisionApplication))
        self.assertIs(
            TrackingVisionApplication._start_tracking,
            VisionApplication._start_tracking,
        )


if __name__ == "__main__":
    unittest.main()
