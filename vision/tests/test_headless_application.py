import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from main import VisionApplication


class HeadlessVisionApplicationTests(unittest.TestCase):
    def test_effective_frame_is_calibrated_without_corner_markers(self):
        app = VisionApplication.__new__(VisionApplication)
        app.runtime = SimpleNamespace(calibration={
            "H": None,
            "is_calibrating": False,
            "manual_locked": False,
            "auto_locked": False,
            "auto_prev_points": None,
            "frame_size": None,
        })
        result = SimpleNamespace(frame=np.zeros((100, 200, 3), dtype=np.uint8))

        app._update_frame_calibration(result)

        self.assertTrue(app.runtime.calibration["auto_locked"])
        self.assertEqual(app.runtime.calibration["frame_size"], (200, 100))
        corners = cv2.perspectiveTransform(
            np.float32([[[0, 0], [199, 99]]]),
            app.runtime.calibration["H"],
        )[0]
        np.testing.assert_allclose(corners[0], [0.0, 0.0], atol=1e-5)
        np.testing.assert_allclose(corners[1], [3.14, 1.6], atol=1e-5)

    def test_publish_frame_accepts_object_frame_sink(self):
        frames = []
        app = VisionApplication.__new__(VisionApplication)
        app.mjpeg = SimpleNamespace(update=lambda image: frames.append(("mjpeg", image)))
        app.frame_sink = SimpleNamespace(update=lambda image: frames.append(("webrtc", image)))
        image = np.zeros((10, 10, 3), dtype=np.uint8)

        app._publish_frame(image)

        self.assertEqual([kind for kind, _ in frames], ["mjpeg", "webrtc"])

    def test_camera_publisher_is_independent_of_perception_loop(self):
        frames = []
        snapshots = iter([
            {"ok": True, "sequence": 1, "frame": np.zeros((10, 20, 3), dtype=np.uint8), "timestamp": 1.0},
            {"ok": True, "sequence": 1, "frame": np.zeros((10, 20, 3), dtype=np.uint8), "timestamp": 1.0},
            {"ok": True, "sequence": 2, "frame": np.ones((10, 20, 3), dtype=np.uint8), "timestamp": 2.0},
        ])
        app = VisionApplication.__new__(VisionApplication)
        app._exit_requested = False
        calls = []

        def snapshot(**kwargs):
            calls.append(kwargs)
            try:
                return next(snapshots)
            except StopIteration:
                app._exit_requested = True
                return {"ok": False, "sequence": 2, "frame": None, "timestamp": 2.0}

        app.cam = SimpleNamespace(snapshot=snapshot)
        app._publish_frame = lambda frame, timestamp=None: frames.append((frame.copy(), timestamp))

        app._publish_camera_frames()

        self.assertEqual([timestamp for _, timestamp in frames], [1.0, 2.0])
        self.assertEqual([int(frame[0, 0, 0]) for frame, _ in frames], [0, 1])
        self.assertTrue(calls)
        self.assertTrue(all(call == {"copy_frame": False, "apply_crop": False} for call in calls))

    def test_headless_input_accepts_internal_lifecycle_commands(self):
        actions = deque(["PROCESSING_START", "PROCESSING_STOP"])
        app = VisionApplication(
            camera_index=1,
            headless=True,
            action_source=lambda: actions.popleft() if actions else None,
        )
        app.runtime = SimpleNamespace(pending_actions=deque())

        app._queue_input_actions()

        self.assertEqual(
            list(app.runtime.pending_actions),
            ["PROCESSING_START", "PROCESSING_STOP"],
        )

    def test_headless_mode_consumes_web_actions_without_opencv_window_calls(self):
        actions = deque([
            {"type": "path.draw", "points": [[10, 20], [30, 40]]},
            {"type": "tracking.stop"},
        ])
        app = VisionApplication(
            camera_index=1,
            headless=True,
            action_source=lambda: actions.popleft() if actions else None,
        )
        app.runtime = SimpleNamespace(pending_actions=deque())

        with patch("main.cv2.waitKey") as wait_key, patch("main.cv2.imshow") as show:
            app._queue_input_actions()
            app._display(np.zeros((10, 10, 3), dtype=np.uint8))

        wait_key.assert_not_called()
        show.assert_not_called()
        self.assertEqual(
            list(app.runtime.pending_actions),
            [("SET_PATH", [(10, 20), (30, 40)]), "STOP"],
        )

        app.request_exit()
        self.assertTrue(app._exit_requested)

    def test_clear_path_also_clears_motion_trajectory(self):
        app = VisionApplication.__new__(VisionApplication)
        cleared = []
        app.runtime = SimpleNamespace(
            drawn_path={"pixels": [(1, 2)], "drawing": False, "active": False, "segment": 2},
            trajectory=deque([(3, 4), (5, 6)]),
        )
        app.presentation = SimpleNamespace(clear_trajectory=lambda: cleared.append(True) or app.runtime.trajectory.clear())
        app.control = SimpleNamespace(stop=lambda *args, **kwargs: None)
        app._safe_stop = lambda *args, **kwargs: None

        app._clear_path()

        self.assertEqual(list(app.runtime.trajectory), [])
        self.assertEqual(app.runtime.drawn_path["pixels"], [])
        self.assertEqual(cleared, [True])


if __name__ == "__main__":
    unittest.main()
