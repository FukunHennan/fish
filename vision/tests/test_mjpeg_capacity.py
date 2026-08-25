import unittest

from interface import has_viewer_capacity


class MjpegCapacityTests(unittest.TestCase):
    def test_multiple_web_clients_are_allowed_up_to_configured_limit(self):
        self.assertTrue(has_viewer_capacity(current=0, maximum=8))
        self.assertTrue(has_viewer_capacity(current=1, maximum=8))
        self.assertFalse(has_viewer_capacity(current=8, maximum=8))


if __name__ == "__main__":
    unittest.main()
