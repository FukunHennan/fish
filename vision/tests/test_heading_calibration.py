import unittest

import numpy as np

from main import estimate_motion_heading


class HeadingCalibrationTests(unittest.TestCase):
    def test_stable_multi_frame_motion_produces_heading(self):
        x = np.linspace(100.0, 180.0, 40)
        y = 220.0 + np.sin(np.linspace(0.0, 3.0, 40)) * 1.2
        result = estimate_motion_heading(np.column_stack((x, y)))
        self.assertGreater(result["unit"][0], 0.99)
        self.assertGreater(result["consistency"], 0.8)
        self.assertGreater(result["linearity"], 0.95)

    def test_too_few_frames_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "轨迹帧不足"):
            estimate_motion_heading(np.column_stack((np.arange(10), np.arange(10))))

    def test_short_motion_is_rejected(self):
        points = np.column_stack((np.linspace(10.0, 18.0, 30), np.zeros(30)))
        with self.assertRaisesRegex(ValueError, "运动距离不足"):
            estimate_motion_heading(points)

    def test_unstable_backtracking_motion_is_rejected(self):
        phase = np.linspace(0.0, 12.0 * np.pi, 60)
        x = np.linspace(0.0, 50.0, 60) + np.sin(phase) * 22.0
        y = np.linspace(0.0, 6.0, 60)
        with self.assertRaisesRegex(ValueError, "方向不稳定"):
            estimate_motion_heading(np.column_stack((x, y)))


if __name__ == "__main__":
    unittest.main()
