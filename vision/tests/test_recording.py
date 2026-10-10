import tempfile
import time
import unittest
from collections import deque
from pathlib import Path

import av
import numpy as np

from recording import MatchVideoRecorder
from webrtc import _LatestFrameBuffer


class _QueuedFrameSource:
    def __init__(self, frames):
        self.frames = deque(frames)
        self.first = frames[0]

    def latest_frame(self, view="cropped"):
        return self.first

    def wait_for_frame(self, previous_sequence, timeout=0.25, view="cropped"):
        if self.frames:
            return self.frames.popleft()
        time.sleep(min(timeout, 0.01))
        return None


class MatchVideoRecorderTests(unittest.TestCase):
    def test_high_frame_rate_recording_has_monotonic_decodable_timestamps(self):
        for fps in (90, 120):
            with self.subTest(fps=fps), tempfile.TemporaryDirectory() as folder:
                started = time.time()
                frame = np.zeros((48, 64, 3), dtype=np.uint8)
                frames = [
                    (index, frame, started + index / fps + (0.001 if index % 3 == 0 else 0))
                    for index in range(fps * 2)
                ]
                recorder = MatchVideoRecorder(folder, f"fps-{fps}", _QueuedFrameSource(frames))
                deadline = time.monotonic() + 15
                while recorder.status()["frameCount"] < len(frames) and recorder.active and time.monotonic() < deadline:
                    time.sleep(0.01)
                status = recorder.stop(timeout=20)

                self.assertEqual(status["frameCount"], len(frames))
                self.assertIsNone(status["error"])
                path = Path(folder) / status["fileName"]
                with av.open(str(path)) as container:
                    decoded = list(container.decode(video=0))
                self.assertEqual(len(decoded), len(frames))
                timestamps = [float(item.time) for item in decoded]
                self.assertTrue(all(a < b for a, b in zip(timestamps, timestamps[1:])))
                self.assertAlmostEqual(timestamps[-1], (len(frames) - 1) / fps, delta=0.08)

    def test_records_the_same_cropped_view_used_by_player_webrtc(self):
        source = _LatestFrameBuffer()
        source.set_crop_region({"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5})
        started = time.time()
        source.update(np.full((80, 100, 3), (10, 80, 180), dtype=np.uint8), started)

        with tempfile.TemporaryDirectory() as folder:
            recorder = MatchVideoRecorder(
                folder,
                "match-1",
                source,
                metadata={"matchNo": "第 08 场 · 秋季决赛"},
            )
            for index in range(1, 7):
                frame = np.full((80, 100, 3), (10 + index, 80, 180), dtype=np.uint8)
                source.update(frame, started + index / 15.0)
                time.sleep(0.025)
            time.sleep(0.1)
            status = recorder.stop()

            path = Path(folder) / status["fileName"]
            self.assertTrue(path.is_file())
            self.assertTrue(status["fileName"].startswith("第_08_场_秋季决赛_"))
            self.assertNotIn("match-1", status["fileName"])
            self.assertEqual((status["width"], status["height"]), (50, 40))
            self.assertEqual(status["view"], "cropped")
            self.assertEqual(status["transform"], "rotation+crop")
            self.assertGreaterEqual(status["frameCount"], 2)

            with av.open(str(path)) as container:
                frames = list(container.decode(video=0))
            self.assertGreaterEqual(len(frames), 2)
            self.assertEqual((frames[0].width, frames[0].height), (50, 40))

    def test_discard_removes_partial_and_final_files(self):
        source = _LatestFrameBuffer()
        source.update(np.zeros((48, 64, 3), dtype=np.uint8), time.time())
        with tempfile.TemporaryDirectory() as folder:
            recorder = MatchVideoRecorder(folder, "cancelled", source)
            status = recorder.stop(discard=True)
            self.assertFalse((Path(folder) / status["fileName"]).exists())
            self.assertEqual(list(Path(folder).glob("*.partial")), [])


if __name__ == "__main__":
    unittest.main()
