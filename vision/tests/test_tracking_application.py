import unittest
from types import SimpleNamespace

import numpy as np

from control_coordinates import ControlCoordinateMapper
from tracking_application import TrackingVisionApplication


class TrackingApplicationCoordinateTests(unittest.TestCase):
    def make_app(self, field_homography=None):
        app = object.__new__(TrackingVisionApplication)
        app.control_mapper = ControlCoordinateMapper(640, 480)
        app.runtime = SimpleNamespace(
            calibration={"H": field_homography},
            heading={
                "pixel_unit_vector": (1.0, 0.0),
                "world_unit_vector": None,
                "control_heading": None,
                "control_heading_source": None,
            },
        )
        return app

    def test_image_coordinates_are_available_without_field_calibration(self):
        app = self.make_app()
        result = SimpleNamespace(pixel=(319.5, 239.5))

        x, y = app._control_position(result)

        self.assertAlmostEqual(x, app.control_mapper.control_width / 2.0, places=3)
        self.assertAlmostEqual(y, app.control_mapper.control_height / 2.0, places=3)
        self.assertEqual(app._control_mapping().mode, "IMAGE")

    def test_field_homography_overrides_image_mapping(self):
        field = np.eye(3, dtype=np.float64)
        app = self.make_app(field)
        result = SimpleNamespace(pixel=(25.0, 40.0))

        self.assertEqual(app._control_position(result), (25.0, 40.0))
        self.assertEqual(app._control_mapping().mode, "FIELD")

    def test_pixel_heading_can_be_promoted_without_field_calibration(self):
        app = self.make_app()

        app._promote_pixel_heading(None, (320.0, 240.0))

        heading = app.runtime.heading
        self.assertIsNotNone(heading["world_unit_vector"])
        self.assertEqual(heading["control_heading_source"], "IMAGE")
        self.assertGreater(heading["world_unit_vector"][0], 0.99)


if __name__ == "__main__":
    unittest.main()
