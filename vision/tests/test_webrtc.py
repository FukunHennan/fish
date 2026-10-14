import unittest
import time
from fractions import Fraction
from unittest.mock import patch

import numpy as np

from webrtc import (
    VIDEO_CLOCK_RATE,
    WebRTCServer,
    _LatestFrameBuffer,
    _LatestVideoTrack,
    _without_host_candidates,
    browser_ice_servers,
)
import crop_region
import webrtc


class WebRTCFrameTests(unittest.TestCase):
    def test_lan_resolution_increases_without_changing_public_profile(self):
        frame = np.zeros((960, 1280, 3), dtype=np.uint8)
        with patch.object(webrtc, "WEBRTC_ACCESS_MODE", "lan"):
            self.assertEqual(webrtc._resize_for_video(frame).shape[:2], (960, 1280))
        with patch.object(webrtc, "WEBRTC_ACCESS_MODE", "public"):
            self.assertEqual(webrtc._resize_for_video(frame).shape[:2], (480, 640))

    def test_host_only_rejects_relay_and_keeps_direct_candidates(self):
        host = "a=candidate:1 1 udp 100 192.168.1.2 5000 typ host"
        relay = "a=candidate:2 1 udp 80 192.0.2.1 6000 typ relay"
        result = webrtc._host_only_sdp("v=0\r\n" + host + "\r\n" + relay)
        self.assertIn(host, result)
        self.assertNotIn(relay, result)
        with self.assertRaises(webrtc.WebRTCUnavailable):
            webrtc._host_only_sdp("v=0\r\n" + relay)

    def test_lan_video_never_requests_turn_credentials(self):
        with patch.object(webrtc, "WEBRTC_ACCESS_MODE", "lan"), patch.object(
            webrtc.TURN_PROVIDER, "get_ice_servers", side_effect=AssertionError("LAN must not contact TURN")
        ):
            self.assertEqual(webrtc._turn_servers(), [])
            self.assertEqual(webrtc._ice_server_dicts(), [])
            self.assertEqual(browser_ice_servers(), [])

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
        config = server.browser_ice_config()
        self.assertIn("iceServers", config)
        self.assertIn(config["iceTransportPolicy"], ("all", "relay"))
        self.assertEqual(server.peer_count, 0)
        server.close()

    def test_browser_can_use_public_candidates_with_server_turn_relay_required(self):
        turn = {
            "urls": ["turn:turn.example.test:3478?transport=udp"],
            "username": "user",
            "credential": "credential",
        }
        with (
            patch.object(webrtc, "WEBRTC_ICE_TRANSPORT_POLICY", "relay"),
            patch.object(webrtc, "WEBRTC_BROWSER_ICE_TRANSPORT_POLICY", "all"),
            patch.object(webrtc, "WEBRTC_STUN_URL", "stun:stun.example.test:3478"),
            patch.object(webrtc, "_turn_servers", return_value=[turn]),
        ):
            config = WebRTCServer().browser_ice_config()
            server_ice_servers = webrtc._ice_server_dicts()

        self.assertEqual(config["iceTransportPolicy"], "all")
        self.assertTrue(config["turnRequired"])
        self.assertTrue(config["turnConfigured"])
        self.assertEqual(config["iceServers"][0]["urls"], "stun:stun.example.test:3478")
        self.assertTrue(any(url.startswith("turn:") for url in config["iceServers"][1]["urls"]))
        self.assertEqual(server_ice_servers, [turn])

    def test_server_turn_relay_ignores_private_browser_host_candidates(self):
        sdp = "\r\n".join([
            "v=0",
            "a=candidate:1 1 udp 100 192.168.1.20 5000 typ host",
            "a=candidate:2 1 udp 90 203.0.113.20 40000 typ srflx",
            "a=candidate:3 1 udp 80 192.0.2.30 50000 typ relay",
            "a=end-of-candidates",
        ])
        filtered = _without_host_candidates(sdp)
        self.assertNotIn("192.168.1.20", filtered)
        self.assertIn("203.0.113.20", filtered)
        self.assertIn("192.0.2.30", filtered)
        self.assertIn("a=end-of-candidates", filtered)

    def test_server_forwards_every_real_camera_frame_without_a_rate_cap(self):
        server = WebRTCServer()
        frame = np.zeros((2, 3, 3), dtype=np.uint8)
        server.update(frame, 1.0)
        server.update(frame, 1.001)
        server.update(frame, 1.002)
        self.assertEqual(server._source._sequence, 3)
        server.close()

    def test_jpeg_fallback_still_receives_frames_if_webrtc_is_unavailable(self):
        server = WebRTCServer()
        server.available = False
        server.update(np.zeros((48, 64, 3), dtype=np.uint8), time.time())
        snapshot = server.jpeg_snapshot()
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot[0], 1)
        self.assertTrue(snapshot[1].startswith(b"\xff\xd8"))
        server.close()


@unittest.skipIf(_LatestVideoTrack is None, "aiortc is not installed")
class WebRTCTrackTests(unittest.IsolatedAsyncioTestCase):
    async def test_view_changes_reuse_track_without_reconnecting(self):
        from types import SimpleNamespace

        source = _LatestFrameBuffer()
        source.set_crop_region({"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5})
        track = _LatestVideoTrack(source, "smooth", "full")
        server = WebRTCServer()
        server._peer_views["owned-peer"] = (SimpleNamespace(connectionState="connected"), track)
        started = time.time()
        source.update(np.zeros((480, 640, 3), dtype=np.uint8), started)
        first = await track.recv()
        self.assertTrue(server.set_peer_view("owned-peer", "cropped"))
        source.update(np.zeros((480, 640, 3), dtype=np.uint8), started + 0.1)
        second = await track.recv()
        self.assertEqual((first.width, first.height), (640, 480))
        self.assertEqual((second.width, second.height), (320, 240))
        self.assertGreater(second.pts, first.pts)
        self.assertFalse(server.set_peer_view("unknown", "full"))
        track.stop()
        server.close()
    async def test_turn_lookup_does_not_block_media_event_loop(self):
        import asyncio

        def slow_lookup():
            time.sleep(0.15)
            return []

        server = WebRTCServer()
        with patch.object(webrtc, "_ice_servers", side_effect=slow_lookup), patch.object(webrtc, "RTCPeerConnection", side_effect=webrtc.WebRTCUnavailable("test stop")):
            pending = asyncio.create_task(server._handle_offer("v=0", "offer"))
            await asyncio.sleep(0.01)
            self.assertFalse(pending.done())
            with self.assertRaises(webrtc.WebRTCUnavailable):
                await pending
        server.close()

    async def test_30_fps_capture_preserves_24_fps_send_cadence(self):
        from aiortc.mediastreams import MediaStreamError

        class TimedSource:
            closed = False
            sequence = 0

            def wait_for_frame(self, previous_sequence, timeout, view):
                if self.sequence >= 61:
                    self.closed = True
                    return None
                sequence = self.sequence
                self.sequence += 1
                return sequence, np.zeros((2, 3, 3), dtype=np.uint8), 1000 + sequence / 30

        with patch.object(webrtc, "WEBRTC_MAX_FPS", 24), patch.object(webrtc.time, "time", return_value=1000):
            track = _LatestVideoTrack(TimedSource())
            frames = []
            try:
                while True:
                    frames.append(await track.recv())
            except MediaStreamError:
                pass
            finally:
                track.stop()
        self.assertEqual(len(frames), 49)
        self.assertEqual(frames[-1].pts, 2 * VIDEO_CLOCK_RATE)

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
