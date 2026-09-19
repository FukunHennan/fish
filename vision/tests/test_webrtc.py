import unittest
import time
from fractions import Fraction

import numpy as np

from webrtc import (
    VIDEO_CLOCK_RATE,
    WebRTCServer,
    _LatestFrameBuffer,
    _LatestVideoTrack,
    browser_ice_servers,
)
import crop_region


class WebRTCFrameTests(unittest.TestCase):
    def test_frame_buffer_keeps_only_the_latest_frame(self):
        buffer = _LatestFrameBuffer()
        first = np.zeros((2, 3, 3), dtype=np.uint8)
        second = np.full((2, 3, 3), 7, dtype=np.uint8)

        buffer.update(first, 1.0)
        buffer.update(second, 2.0)

        sequence, frame, timestamp = buffer.wait_for_frame(-1, 0.1, view="full")
        self.assertEqual(sequence, 2)
        self.assertEqual(timestamp, 2.0)
        self.assertTrue(np.array_equal(frame, second))

    def test_full_view_keeps_source_and_player_view_uses_crop(self):
        buffer = _LatestFrameBuffer()
        frame = np.arange(8 * 12 * 3, dtype=np.uint8).reshape(8, 12, 3)
        region = {"x": .25, "y": .25, "width": .5, "height": .5}
        buffer.set_crop_region(region)
        buffer.update(frame, 1.0)

        raw = buffer.wait_for_frame(-1, 0.1, view="full")[1]
        cropped = buffer.wait_for_frame(-1, 0.1, view="cropped")[1]

        self.assertEqual(raw.shape, (8, 12, 3))
        np.testing.assert_array_equal(cropped, crop_region.crop(frame, region))

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

    def test_server_forwards_every_real_camera_frame_without_a_rate_cap(self):
        server = WebRTCServer()
        frame = np.zeros((2, 3, 3), dtype=np.uint8)
        server.update(frame, 1.0)
        server.update(frame, 1.001)
        server.update(frame, 1.002)
        self.assertEqual(server._source._sequence, 3)
        server.close()


@unittest.skipIf(_LatestVideoTrack is None, "aiortc is not installed")
class WebRTCTrackTests(unittest.IsolatedAsyncioTestCase):
    async def test_viewers_have_independent_resolution_and_source_is_unchanged(self):
        source = _LatestFrameBuffer()
        source.set_crop_region(crop_region.FULL)
        source.update(np.zeros((1944, 2592, 3), dtype=np.uint8))
        low = _LatestVideoTrack(source, "smooth")
        high = _LatestVideoTrack(source, "full")
        first = await low.recv()
        second = await high.recv()
        self.assertEqual((first.width, first.height), (640, 480))
        self.assertEqual((second.width, second.height), (1920, 1440))
        self.assertEqual(source.wait_for_frame(-1, 0.1, view="full")[1].shape, (1944, 2592, 3))
        low.stop()
        high.stop()

    async def test_short_frame_gap_does_not_end_track(self):
        import asyncio
        source = _LatestFrameBuffer()
        source.set_crop_region(crop_region.FULL)
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
        source.set_crop_region(crop_region.FULL)
        started = time.time()
        source.update(np.zeros((2, 3, 3), dtype=np.uint8), started)
        track = _LatestVideoTrack(source)

        first = await track.recv()
        source.update(np.ones((2, 3, 3), dtype=np.uint8), started + 0.2)
        second = await track.recv()

        self.assertEqual(first.time_base, Fraction(1, VIDEO_CLOCK_RATE))
        self.assertEqual(second.time_base, Fraction(1, VIDEO_CLOCK_RATE))
        self.assertGreater(second.pts, first.pts)
        self.assertEqual(second.pts - first.pts, round(VIDEO_CLOCK_RATE * 0.2))


if __name__ == "__main__":
    unittest.main()
