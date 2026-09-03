import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from main import VisionApplication


class HeadlessVisionApplicationTests(unittest.TestCase):
    def test_publish_frame_accepts_object_frame_sink(self):
        frames = []
        app = VisionApplication.__new__(VisionApplication)
        app.mjpeg = SimpleNamespace(update=lambda image: frames.append(("mjpeg", image)))
        app.frame_sink = SimpleNamespace(update=lambda image: frames.append(("webrtc", image)))
        image = np.zeros((10, 10, 3), dtype=np.uint8)

        app._publish_frame(image)

        self.assertEqual([kind for kind, _ in frames], ["mjpeg", "webrtc"])

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


if __name__ == "__main__":
    unittest.main()
