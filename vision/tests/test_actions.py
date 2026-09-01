import unittest

from web_actions import translate_web_action


class WebActionTranslationTests(unittest.TestCase):
    def test_pointer_and_path_events_use_existing_runtime_actions(self):
        self.assertEqual(
            translate_web_action({"type": "calibration.point", "x": 12, "y": 34}),
            ("APPLY_POOL_POINT", (12, 34)),
        )
        self.assertEqual(
            translate_web_action({
                "type": "marker.roi",
                "x": 10,
                "y": 20,
                "x2": 80,
                "y2": 90,
            }),
            ("APPLY_MARKER_ROI", (10, 20, 80, 90)),
        )
        self.assertEqual(
            translate_web_action({
                "type": "path.draw",
                "points": [[1, 2], [3, 4]],
            }),
            ("SET_PATH", [(1, 2), (3, 4)]),
        )

    def test_toolbar_events_map_to_existing_commands(self):
        cases = {
            "marker.select": "MARKER_ROI",
            "heading.select": "HEAD_DIRECTION",
            "calibration.toggle": "POOL_CALIB",
            "path.clear": "CLEAR_PATH",
            "tracking.start": "START",
            "tracking.stop": "STOP",
            "turn_calibration.toggle": "TURN_CALIB",
            "recording.toggle": "RECORD",
            "snapshot.capture": "SNAPSHOT",
            "camera.clahe": "CLAHE",
            "system.stop": "STOP",
        }
        for web_type, runtime_action in cases.items():
            with self.subTest(web_type=web_type):
                self.assertEqual(
                    translate_web_action({"type": web_type}),
                    runtime_action,
                )

    def test_overlay_visibility_action_is_translated(self):
        self.assertEqual(
            translate_web_action({
                "type": "overlay.set",
                "overlays": {"detections": False, "paths": True},
            }),
            ("OVERLAY_OPTIONS", {"detections": False, "paths": True}),
        )
        self.assertIsNone(
            translate_web_action({
                "type": "overlay.set",
                "overlays": {"detections": "no"},
            })
        )

    def test_out_of_frame_coordinates_and_bad_paths_are_rejected(self):
        self.assertIsNone(
            translate_web_action(
                {"type": "heading.point", "x": 641, "y": 1},
                frame_size=(640, 480),
            )
        )
        self.assertIsNone(
            translate_web_action({"type": "path.draw", "points": [[1, 2]]})
        )


if __name__ == "__main__":
    unittest.main()
