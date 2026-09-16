import unittest
from fractions import Fraction
from unittest import mock

import numpy as np

from config import WEBRTC_MAX_FPS
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
        self.assertEqual(server.peer_count, 0)
        server.close()

    def test_nominal_camera_jitter_does_not_drop_every_other_frame(self):
        server = WebRTCServer()
        frame = np.zeros((2, 3, 3), dtype=np.uint8)
        with mock.patch("webrtc.time.monotonic", side_effect=[1.0, 1.031, 1.064]):
            server.update(frame)
            server.update(frame)
            server.update(frame)
        self.assertEqual(server._source._sequence, 3)
        server.close()


@unittest.skipIf(_LatestVideoTrack is None, "aiortc is not installed")
class WebRTCTrackTests(unittest.IsolatedAsyncioTestCase):
    async def test_viewers_have_independent_resolution_and_source_is_unchanged(self):
        source = _LatestFrameBuffer()
        source.update(np.zeros((1944, 2592, 3), dtype=np.uint8))
        low = _LatestVideoTrack(source, "smooth")
        high = _LatestVideoTrack(source, "full")
        first = await low.recv()
        second = await high.recv()
        self.assertEqual((first.width, first.height), (640, 480))
        self.assertEqual((second.width, second.height), (1920, 1440))
        self.assertEqual(source.wait_for_frame(-1, 0.1)[1].shape, (1944, 2592, 3))
        low.stop()
        high.stop()

    async def test_short_frame_gap_does_not_end_track(self):
        import asyncio
        source = _LatestFrameBuffer()
        track = _LatestVideoTrack(source)
        pending = asyncio.create_task(track.recv())
        await asyncio.sleep(1.15)
        self.assertFalse(pending.done())
        source.update(np.zeros((48, 64, 3), dtype=np.uint8))
        frame = await asyncio.wait_for(pending, 1)
        self.assertEqual(frame.width, 64)
        track.stop()
        source.close()

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
        self.assertEqual(
            second.pts - first.pts,
            round(VIDEO_CLOCK_RATE / WEBRTC_MAX_FPS),
        )


if __name__ == "__main__":
    unittest.main()
