import unittest
from types import SimpleNamespace

import numpy as np

from control_coordinates import ControlCoordinateMapper
from session import TrackingMode
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

    def test_path_direction_is_available_without_heading_calibration(self):
        app = self.make_app()

        heading = app._path_start_heading([(10.0, 20.0), (10.0, 40.0)])

        self.assertTrue(np.allclose(heading, (0.0, 1.0)))

    def test_tracking_uses_path_direction_without_direction_calibration(self):
        app = self.make_app()
        app.runtime.heading["pixel_unit_vector"] = None
        app.runtime.heading["world_unit_vector"] = None
        app.runtime.heading["control_heading"] = None
        app.runtime.drawn_path = {"pixels": [(100, 100), (160, 100)], "active": False}
        app.turn_session = SimpleNamespace(active=False)
        app.control = SimpleNamespace(
            stop=lambda *_args, **_kwargs: False,
            prepare=lambda *_args, **_kwargs: {"seg_index": 0},
            activate=lambda _initial: None,
            active=False,
            segment=0,
            status="READY",
        )
        app._stop_latched_reason = None
        app.fish_comm = SimpleNamespace(
            ensure_hybrid_mode=lambda: True,
            vision_seq=0,
        )
        app.status = "READY"

        result = SimpleNamespace(pixel=(100.0, 100.0), frame_time=1.0)

        app._start_tracking(result)

        self.assertTrue(app.runtime.drawn_path["active"])

    def test_single_fish_mode_accepts_locked_target_without_target_found(self):
        app = self.make_app()
        app.tracking_mode = TrackingMode.SINGLE_FISH
        app._forward_calibration = None
        app.fish_comm = SimpleNamespace(
            ensure_hybrid_mode=lambda: True,
            start_forward_calibration=lambda *_args, **_kwargs: True,
            stop_now=lambda: None,
        )
        app._heading_calibration_result = {}
        app.runtime.heading["world_unit_vector"] = None
        app.runtime.heading["control_heading"] = None
        app.runtime.heading["control_heading_source"] = None

        result = SimpleNamespace(
            pixel=(100.0, 120.0),
            control_position=(1.0, 2.0),
            yolo_result={
                "targetTrackId": 7,
                "targetFound": False,
                "detections": [{"trackId": 7}],
            },
        )

        app._start_heading_calibration(result)

        self.assertIsNotNone(app._forward_calibration)
        self.assertEqual(app.status, "CAL_FORWARD")


if __name__ == "__main__":
    unittest.main()
