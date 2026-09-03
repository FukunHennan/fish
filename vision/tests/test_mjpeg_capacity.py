import unittest

import numpy as np

from interface import MJPEGServer, has_viewer_capacity


class MjpegCapacityTests(unittest.TestCase):
    def test_multiple_web_clients_are_allowed_up_to_configured_limit(self):
        self.assertTrue(has_viewer_capacity(current=0, maximum=8))
        self.assertTrue(has_viewer_capacity(current=1, maximum=8))
        self.assertFalse(has_viewer_capacity(current=8, maximum=8))

    def test_stream_resize_preserves_camera_aspect_ratio(self):
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        resized = MJPEGServer._resize_for_stream(frame)

        self.assertEqual(resized.shape[:2], (480, 640))


if __name__ == "__main__":
    unittest.main()
