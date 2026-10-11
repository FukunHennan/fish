import tempfile

import time
import unittest
from pathlib import Path

import av
import numpy as np

from recording import MatchVideoRecorder
from webrtc import _LatestFrameBuffer


class MatchVideoRecorderTests(unittest.TestCase):
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
            self.assertEqual(recorder._stream.codec_context.gop_size, 30)
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

    def test_wall_clock_jump_does_not_corrupt_recording_duration(self):
        source = _LatestFrameBuffer()
        started = time.time()
        source.update(np.zeros((48, 64, 3), dtype=np.uint8), started)

        with tempfile.TemporaryDirectory() as folder:
            recorder = MatchVideoRecorder(folder, "clock-jump", source)
            source.update(np.ones((48, 64, 3), dtype=np.uint8), started + 3600.0)
            time.sleep(0.05)
            source.update(np.full((48, 64, 3), 2, dtype=np.uint8), started - 10.0)
            time.sleep(0.1)
            status = recorder.stop()

            self.assertGreaterEqual(status["frameCount"], 2)
            self.assertLess(status["durationMs"], 5000)

            path = Path(folder) / status["fileName"]
            with av.open(str(path)) as container:
                frames = list(container.decode(video=0))
            pts_values = [frame.pts for frame in frames]
            self.assertEqual(pts_values, sorted(pts_values))

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
