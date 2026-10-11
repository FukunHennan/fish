import unittest

from video_probe import interval, summarize


class VideoProbeTests(unittest.TestCase):
    def samples(self):
        return [{"timestampMs": stamp, "framesDecoded": frames, "renderedFrames": frames,
                 "packetsReceived": packets, "packetsLost": lost, "bytesReceived": size,
                 "maxFrameGapMs": 50, "rttMs": 180,
                 "selectedPath": {"local": "relay", "remote": "host"}}
                for stamp, frames, packets, lost, size in [(1000, 30, 100, 1, 50000), (6000, 180, 595, 6, 350000)]]

    def test_interval_uses_counter_deltas_not_lifetime_average(self):
        result = interval(*self.samples())
        self.assertEqual(result, {"fps": 30, "renderedFps": 30, "kbps": 480, "lossPercent": 1})

    def test_no_frames_and_unverified_relay_fail(self):
        summary = summarize([], [], "relay", 20, 3000)
        self.assertFalse(summary["passed"])
        self.assertIn("no_video_frames", summary["reasons"])
        self.assertIn("relay_path_not_verified", summary["reasons"])

    def test_freeze_or_disconnect_fails_even_with_good_average_fps(self):
        samples = self.samples()
        self.assertTrue(summarize(samples, [], "relay", 20, 3000)["passed"])
        samples[-1]["maxFrameGapMs"] = 4000
        summary = summarize(samples, [{"connection": "disconnected"}], "relay", 20, 3000)
        self.assertFalse(summary["passed"])
        self.assertEqual(summary["reasons"], ["video_freeze", "connection_interrupted"])

    def test_missing_counters_are_not_reported_as_zero_loss(self):
        self.assertEqual(interval({"timestampMs": 0}, {"timestampMs": 1000}), {})

    def test_high_decode_fps_cannot_hide_low_rendered_fps_or_packet_loss(self):
        samples = self.samples()
        samples[-1]["renderedFrames"] = 80
        samples[-1]["packetsLost"] = 51
        result = summarize(samples, [], "relay", 20, 3000)
        self.assertFalse(result["passed"])
        self.assertIn("low_rendered_fps", result["reasons"])
        self.assertIn("high_packet_loss", result["reasons"])


if __name__ == "__main__":
    unittest.main()
