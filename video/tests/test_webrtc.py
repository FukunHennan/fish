import unittest

import time
import asyncio
import json
import os
import tempfile
from fractions import Fraction
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import av

from webrtc import (
    VIDEO_CLOCK_RATE,
    WebRTCServer,
    _LatestFrameBuffer,
    _LatestVideoTrack,
    browser_ice_servers,
)
import crop_region
import webrtc


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
        with patch.object(webrtc, "_cloudflare_turn", SimpleNamespace(configured=False)):
            self.assertTrue(browser_ice_servers())
            self.assertEqual(browser_ice_servers()[0]["urls"], "stun:stun.l.google.com:19302")
        self.assertEqual(server.peer_count, 0)
        server.close()

    def test_candidate_summary_does_not_log_client_addresses(self):
        sdp = "\r\n".join([
            "a=candidate:1 1 udp 1 192.168.1.10 5000 typ host",
            "a=candidate:2 1 udp 1 1.1.1.1 5001 typ relay",
            "a=candidate:3 1 udp 1 abc.local 5002 typ host",
        ])
        self.assertEqual(webrtc._ice_candidate_summary(sdp), {
            "host/private": 1,
            "relay/public": 1,
            "host/hostname": 1,
        })

    def test_cloudflare_turn_uses_temporary_credentials_for_both_peers(self):
        cloudflare_servers = [
            {"urls": ["stun:stun.cloudflare.com:3478"]},
            {
                "urls": [
                    "turn:turn.cloudflare.com:3478?transport=udp",
                    "turn:turn.cloudflare.com:443?transport=udp",
                ],
                "username": "temporary-user",
                "credential": "temporary-password",
            },
        ]
        issued = []
        def generate():
            issued.append(True)
            return cloudflare_servers

        issuer = SimpleNamespace(configured=True, generate=generate)
        with patch.object(webrtc, "_cloudflare_turn", issuer):
            self.assertEqual(browser_ice_servers(), cloudflare_servers[1:])
            if webrtc.RTCIceServer is not None:
                server_ice = webrtc._ice_servers()
                self.assertEqual(len(server_ice), 1)
                self.assertEqual(server_ice[0].urls, "turn:turn.cloudflare.com:443?transport=udp")
                self.assertEqual(server_ice[0].username, "temporary-user")
                self.assertEqual(server_ice[0].credential, "temporary-password")
                self.assertEqual(len(issued), 2)

    def test_cloudflare_outage_never_silently_downgrades_live_video_to_stun(self):
        issuer = SimpleNamespace(configured=True, generate=lambda: (_ for _ in ()).throw(webrtc.CloudflareTurnError("unavailable")))
        with patch.object(webrtc, "_cloudflare_turn", issuer):
            self.assertEqual(browser_ice_servers(), [])
            if webrtc.RTCIceServer is not None:
                with self.assertRaises(webrtc.WebRTCUnavailable):
                    webrtc._ice_servers()

    def test_replay_requires_cloudflare_turn_without_stun_fallback(self):
        with patch.object(webrtc, "_cloudflare_turn", SimpleNamespace(configured=False)):
            self.assertEqual(webrtc.replay_ice_servers(), [])
            with self.assertRaises(webrtc.WebRTCUnavailable):
                webrtc._replay_server_ice_servers()

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


@unittest.skipIf(_LatestVideoTrack is None, "aiortc is not installed")
class ReplayTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.file_path = os.path.join(self.directory.name, "replay.mp4")
        container = av.open(self.file_path, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=30, options={"preset": "ultrafast", "tune": "zerolatency"})
        stream.width = 64
        stream.height = 64
        stream.pix_fmt = "yuv420p"
        try:
            for frame_index in range(60):
                frame = av.VideoFrame.from_ndarray(np.full((64, 64, 3), frame_index % 6 * 40, dtype=np.uint8), format="bgr24")
                frame.pts = frame_index
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        finally:
            container.close()
        self.server = WebRTCServer()
        self.peer = webrtc.RTCPeerConnection()
        self.turn_patch = patch("webrtc._replay_server_ice_servers", return_value=[])
        self.turn_patch.start()

    async def asyncTearDown(self):
        await self.peer.close()
        self.server.close()
        self.turn_patch.stop()
        self.directory.cleanup()

    async def connect(self, mode):
        await self.peer.setLocalDescription(await self.peer.createOffer())
        answer = await asyncio.to_thread(
            self.server.replay_offer, self.peer.localDescription.sdp,
            self.peer.localDescription.type, self.file_path, mode,
        )
        await self.peer.setRemoteDescription(webrtc.RTCSessionDescription(**answer))

    async def test_h264_replay_streams_real_video_frames(self):
        received = asyncio.get_running_loop().create_future()
        self.peer.addTransceiver("video", direction="recvonly")

        @self.peer.on("track")
        def on_track(track):
            if not received.done():
                received.set_result(track)

        await self.connect("play")
        track = await asyncio.wait_for(received, 10)
        frame = await asyncio.wait_for(track.recv(), 10)
        self.assertEqual((frame.width, frame.height), (64, 64))

    async def test_replay_seek_starts_near_requested_frame(self):
        track = webrtc._ReplayFileTrack(self.file_path, 1100)
        try:
            frame = await asyncio.wait_for(track.recv(), 10)
            next_frame = await asyncio.wait_for(track.recv(), 10)
            self.assertGreater(float(frame.to_ndarray(format="bgr24").mean()), 90)
            self.assertEqual(frame.pts, 0)
            self.assertGreater(next_frame.pts, frame.pts)
        finally:
            track.stop()

    async def test_download_transfers_exact_mp4_bytes(self):
        with open(self.file_path, "ab") as recording:
            recording.write(os.urandom(1024 * 1024))
        received = asyncio.get_running_loop().create_future()
        chunks = []
        unacknowledged = 0
        channel = self.peer.createDataChannel("recording-download")

        @channel.on("open")
        def on_open():
            channel.send("download")

        @channel.on("message")
        def on_message(message):
            nonlocal unacknowledged
            if isinstance(message, bytes):
                chunks.append(message)
                unacknowledged += 1
                if unacknowledged == 4:
                    channel.send("ack")
                    unacknowledged = 0
            elif json.loads(message).get("done") and not received.done():
                received.set_result(b"".join(chunks))

        await self.connect("download")
        data = await asyncio.wait_for(received, 30)
        with open(self.file_path, "rb") as recording:
            self.assertEqual(data, recording.read())


if __name__ == "__main__":
    unittest.main()
