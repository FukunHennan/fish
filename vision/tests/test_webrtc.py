import unittest
from fractions import Fraction

import numpy as np

from webrtc import (
    VIDEO_CLOCK_RATE,
    WebRTCServer,
    _LatestFrameBuffer,
    _LatestVideoTrack,
    browser_ice_servers,
)


class WebRTCFrameTests(unittest.TestCase):
    def test_frame_buffer_keeps_only_the_latest_frame(self):
        buffer = _LatestFrameBuffer()
        first = np.zeros((2, 3, 3), dtype=np.uint8)
        second = np.full((2, 3, 3), 7, dtype=np.uint8)

        buffer.update(first, 1.0)
        buffer.update(second, 2.0)

        sequence, frame, timestamp = buffer.wait_for_frame(-1, 0.1)
        self.assertEqual(sequence, 2)
        self.assertEqual(timestamp, 2.0)
        self.assertTrue(np.array_equal(frame, second))

    def test_close_wakes_waiting_consumers(self):
        buffer = _LatestFrameBuffer()
        buffer.close()
        self.assertIsNone(buffer.wait_for_frame(-1, 0.1))

    def test_server_is_constructible_without_public_ice_configuration(self):
        server = WebRTCServer()
        self.assertTrue(browser_ice_servers())
        self.assertEqual(browser_ice_servers()[0]["urls"], "stun:stun.l.google.com:19302")
        server.close()


@unittest.skipIf(_LatestVideoTrack is None, "aiortc is not installed")
class WebRTCTrackTests(unittest.IsolatedAsyncioTestCase):
    async def test_track_uses_aiortc_realtime_timestamps(self):
        source = _LatestFrameBuffer()
        source.update(np.zeros((2, 3, 3), dtype=np.uint8))
        track = _LatestVideoTrack(source)

        first = await track.recv()
        source.update(np.ones((2, 3, 3), dtype=np.uint8))
        second = await track.recv()

        self.assertEqual(first.time_base, Fraction(1, VIDEO_CLOCK_RATE))
        self.assertEqual(second.time_base, Fraction(1, VIDEO_CLOCK_RATE))
        self.assertGreater(second.pts, first.pts)
        self.assertEqual(second.pts - first.pts, VIDEO_CLOCK_RATE // 30)


if __name__ == "__main__":
    unittest.main()
