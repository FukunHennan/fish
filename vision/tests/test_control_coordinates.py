import unittest

import numpy as np

from control_coordinates import ControlCoordinateMapper


class ControlCoordinateTests(unittest.TestCase):
    def test_image_mapping_is_rejected_without_field_calibration(self):
        mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
        with self.assertRaisesRegex(RuntimeError, "必要条件"):
            mapper.map_points([(0, 0), (639, 479)])

    def test_field_homography_is_used(self):
        mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
        field = np.array([
            [0.01, 0.0, 0.5],
            [0.0, 0.01, 0.25],
            [0.0, 0.0, 1.0],
        ], dtype=np.float64)
        mapped = mapper.map_point((100, 50), field)
        self.assertEqual(mapper.resolve(field).mode, "FIELD")
        self.assertTrue(np.allclose(mapped, [1.5, 0.75], atol=1e-6))

    def test_heading_mapping_preserves_direction(self):
        mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
        heading = mapper.map_heading((320, 240), (1, 0), np.eye(3))
        self.assertGreater(heading[0], 0.999)
        self.assertLess(abs(heading[1]), 1e-6)


if __name__ == "__main__":
    unittest.main()
