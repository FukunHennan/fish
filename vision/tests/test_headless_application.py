import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from main import VisionApplication


class HeadlessVisionApplicationTests(unittest.TestCase):
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
