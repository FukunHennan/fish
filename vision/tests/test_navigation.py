import unittest

import numpy as np

from navigation import HeadingEstimator, PathGuidance


class NavigationTests(unittest.TestCase):
    def test_path_guidance_can_start_without_manual_heading(self):
        guidance = PathGuidance(spacing_m=0.03)
        result = guidance.start([[0.0, 0.0], [1.0, 0.0]], [0.0, 0.0], 0.0)
        np.testing.assert_allclose(result["heading"], [1.0, 0.0])
        self.assertEqual(result["heading_source"], "INITIAL")

    def test_opposite_course_is_reported_for_automatic_correction(self):
        estimator = HeadingEstimator(
            min_span_seconds=0.1,
            min_speed_mps=0.01,
        )
        estimator.reset([1.0, 0.0], [0.0, 0.0], 0.0)
        estimator.update([-0.01, 0.0], 0.1, allow_course_update=True)
        heading, source = estimator.update(
            [-0.04, 0.0], 0.2, allow_course_update=True
        )
        np.testing.assert_allclose(heading, [-1.0, 0.0])
        self.assertEqual(source, "COURSE_REVERSED")
        self.assertTrue(estimator.direction_mismatch)


if __name__ == "__main__":
    unittest.main()
