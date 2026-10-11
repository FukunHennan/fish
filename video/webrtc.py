"""Low-latency WebRTC publisher for the processed vision frame."""


from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import threading
import time
from fractions import Fraction

import cv2
import crop_region
from cloudflare_turn import CloudflareTurnCredentials, CloudflareTurnError
from recording import MatchVideoRecorder, RecordingError

from config import (
    WEBRTC_OFFER_TIMEOUT_S,
    WEBRTC_STUN_URL,
    WEBRTC_TURN_CREDENTIAL,
    WEBRTC_TURN_URL,
    WEBRTC_TURN_USERNAME,
    WEBRTC_CF_TURN_KEY_ID,
    WEBRTC_CF_TURN_API_TOKEN,
)

_cloudflare_turn = CloudflareTurnCredentials(WEBRTC_CF_TURN_KEY_ID, WEBRTC_CF_TURN_API_TOKEN)

# A browser can remain in ICE ``disconnected`` after the network path has
# disappeared. Keep a short grace period for transient Wi-Fi changes, then
# release the peer so the browser's reconnect watchdog can establish a clean
# session instead of accumulating dead connections.
DISCONNECTED_PEER_GRACE_S = 8.0

try:
    import av
    from av import VideoFrame
    from aiortc import (
        RTCConfiguration,
        RTCIceServer,
        RTCPeerConnection,
        RTCSessionDescription,
        VideoStreamTrack,
    )
    from aiortc.mediastreams import (
        VIDEO_CLOCK_RATE,
        MediaStreamError,
    )
    from aiortc.contrib.media import MediaPlayer
    from aiortc import RTCRtpSender
except ImportError as error:  # pragma: no cover - exercised by environment checks
    VideoFrame = None
    RTCConfiguration = None
    RTCIceServer = None
    RTCPeerConnection = None
    RTCSessionDescription = None
    VideoStreamTrack = object
    MediaStreamError = RuntimeError
    VIDEO_CLOCK_RATE = 90000
    MediaPlayer = None
    RTCRtpSender = None
    _IMPORT_ERROR = error
else:
    _IMPORT_ERROR = None


class WebRTCUnavailable(RuntimeError):
    """Raised when aiortc/PyAV are not installed in the selected environment."""


class _LatestFrameBuffer:
    def __init__(self):
        self._condition = threading.Condition()
        self._frame = None
        self._sequence = 0
        self._timestamp = 0.0
        self._closed = False
        try:
            self._crop_region = crop_region.load()
        except (ValueError, OSError):
            self._crop_region = dict(crop_region.FULL)

    def update(self, frame, timestamp=None):
        if frame is None:
            return
        with self._condition:
            if self._closed:
                return
            self._frame = frame.copy()
            self._sequence += 1
            self._timestamp = float(timestamp if timestamp is not None else time.time())
            self._condition.notify_all()

    def wait_for_frame(self, previous_sequence, timeout, view="cropped"):
        with self._condition:
            changed = self._condition.wait_for(
                lambda: self._closed or (
                    self._frame is not None and self._sequence != previous_sequence
                ),
                timeout=timeout,
            )
            if self._closed:
                return None
            if not changed or self._frame is None or self._sequence == previous_sequence:
                return None
            # update() owns an immutable copy and replaces the reference on the
            # next capture. Viewers can safely share it without another full-frame
            # copy for every peer.
            frame = self._frame
            if view == "cropped":
                frame = crop_region.crop(frame, self._crop_region)
            return self._sequence, frame, self._timestamp

    def latest_frame(self, view="cropped"):
        with self._condition:
            if self._closed or self._frame is None:
                return None
            frame = self._frame
            if view == "cropped":
                frame = crop_region.crop(frame, self._crop_region)
            return self._sequence, frame, self._timestamp

    def set_crop_region(self, region):
        validated = crop_region.validate(region)
        with self._condition:
            self._crop_region = validated
        return validated

    @property
    def closed(self):
        with self._condition:
            return self._closed

    def clear(self):
        with self._condition:
            self._frame = None
            self._sequence = 0
            self._timestamp = 0.0
            self._condition.notify_all()

    def close(self):
        with self._condition:
            self._closed = True
            self._condition.notify_all()


VIDEO_PROFILES = {"compact": (480, 360), "smooth": (640, 480), "hd": (1280, 960), "full": (1920, 1440)}

def _resize_for_video(frame, quality="smooth"):
    height, width = frame.shape[:2]
    if width <= 0 or height <= 0:
        return frame
    max_width, max_height = VIDEO_PROFILES[quality]
    scale = min(1.0, max_width / width, max_height / height)
    target = (
        max(1, int(round(width * scale))),
        max(1, int(round(height * scale))),
    )
    if target == (width, height):
        return frame
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(frame, target, interpolation=interpolation)


def _ice_servers():
    cloudflare_servers = _cloudflare_ice_servers()
    if _cloudflare_turn.configured:
        if not cloudflare_servers:
            raise WebRTCUnavailable("Cloudflare TURN 暂时不可用")
        servers = []
        for server in cloudflare_servers:
            urls = server.get("urls", [])
            urls = urls if isinstance(urls, list) else [urls]
            turn_url = next((url for url in urls if url == "turn:turn.cloudflare.com:443?transport=udp"), None)
            if not turn_url:
                turn_url = next((url for url in urls if url.startswith(("turn:", "turns:"))), None)
            if turn_url:
                servers.append(RTCIceServer(
                    urls=turn_url,
                    username=server["username"],
                    credential=server["credential"],
                ))
        return servers
    servers = []
    if WEBRTC_STUN_URL:
        servers.append(RTCIceServer(urls=WEBRTC_STUN_URL))
    if WEBRTC_TURN_URL:
        servers.append(RTCIceServer(
            urls=WEBRTC_TURN_URL,
            username=WEBRTC_TURN_USERNAME,
            credential=WEBRTC_TURN_CREDENTIAL,
        ))
    return servers


def browser_ice_servers():
    cloudflare_servers = _cloudflare_ice_servers()
    if _cloudflare_turn.configured:
        return [server for server in (cloudflare_servers or []) if any(
            url.startswith(("turn:", "turns:"))
            for url in (server["urls"] if isinstance(server["urls"], list) else [server["urls"]])
        )]
    servers = []
    if WEBRTC_STUN_URL:
        servers.append({"urls": WEBRTC_STUN_URL})
    if WEBRTC_TURN_URL:
        servers.append({
            "urls": WEBRTC_TURN_URL,
            "username": WEBRTC_TURN_USERNAME,
            "credential": WEBRTC_TURN_CREDENTIAL,
        })
    return servers


def replay_ice_servers():
    servers = _cloudflare_ice_servers()
    if not servers:
        return []
    return [server for server in servers if any(
        url.startswith(("turn:", "turns:"))
        for url in (server["urls"] if isinstance(server["urls"], list) else [server["urls"]])
    )]


def _replay_server_ice_servers():
    servers = replay_ice_servers()
    if not servers:
        raise WebRTCUnavailable("Cloudflare TURN 不可用，无法播放或下载录像")
    ice_servers = []
    for server in servers:
        urls = server["urls"] if isinstance(server["urls"], list) else [server["urls"]]
        turn_url = next((url for url in urls if url == "turn:turn.cloudflare.com:443?transport=udp"), None)
        if turn_url is None:
            turn_url = next(url for url in urls if url.startswith(("turn:", "turns:")))
        ice_servers.append(RTCIceServer(
            urls=turn_url,
            username=server["username"],
            credential=server["credential"],
        ))
    return ice_servers


def _cloudflare_ice_servers():
    if not _cloudflare_turn.configured:
        return None
    try:
        return _cloudflare_turn.generate()
    except CloudflareTurnError as error:
        logging.warning("Cloudflare TURN unavailable: %s", error)
        return None


def _ice_candidate_summary(sdp):
    summary = {}
    for line in sdp.splitlines():
        if not line.startswith("a=candidate:"):
            continue
        fields = line.split()
        if len(fields) < 8 or fields[6] != "typ":
            continue
        candidate_type = fields[7]
        try:
            address = ipaddress.ip_address(fields[4])
            scope = "private" if not address.is_global else "public"
        except ValueError:
            scope = "hostname"
        key = f"{candidate_type}/{scope}"
        summary[key] = summary.get(key, 0) + 1
    return summary


if _IMPORT_ERROR is None:
    class _LatestVideoTrack(VideoStreamTrack):
        def __init__(self, source, quality="smooth", view="cropped"):
            super().__init__()
            self._source = source
            self._quality = quality
            self._view = view
            self._sequence = -1
            self._pts = 0
            self._timestamp_origin = None

        async def recv(self):
            while True:
                item = await asyncio.to_thread(
                    self._source.wait_for_frame,
                    self._sequence,
                    1.0,
                    self._view,
                )
                if item is None:
                    if self._source.closed or self.readyState != "live":
                        raise MediaStreamError
                    continue
                sequence, frame, frame_timestamp = item
                self._sequence = sequence
                if (
                    frame_timestamp > 0
                    and time.time() - frame_timestamp > 2.0
                ):
                    # Viewing tolerates processing jitter independently of motion safety.
                    # Never push an excessively old frame into the browser after a
                    # processing/network stall. Wait for a newer capture.
                    continue
                video_frame = VideoFrame.from_ndarray(_resize_for_video(frame, self._quality), format="bgr24")
                if self._timestamp_origin is None:
                    self._timestamp_origin = frame_timestamp
                    self._pts = 0
                else:
                    measured_pts = round(
                        max(0.0, frame_timestamp - self._timestamp_origin)
                        * VIDEO_CLOCK_RATE
                    )
                    self._pts = max(self._pts + 1, measured_pts)
                video_frame.pts = self._pts
                video_frame.time_base = Fraction(1, VIDEO_CLOCK_RATE)
                return video_frame


    class _ReplayFileTrack(VideoStreamTrack):
        def __init__(self, file_path, start_ms):
            super().__init__()
            self._container = av.open(file_path)
            self._stream = next((stream for stream in self._container.streams if stream.type == "video"), None)
            if self._stream is None:
                self._container.close()
                raise ValueError("录像没有可播放的视频")
            self._target_seconds = start_ms / 1000
            self._container.seek(start_ms * 1000, backward=True)
            self._frames = self._container.decode(self._stream)
            self._first_time = None
            self._started = None
            self._last_elapsed = -1 / 30

        async def recv(self):
            if self.readyState != "live":
                raise MediaStreamError
            while True:
                frame = await asyncio.to_thread(next, self._frames, None)
                if frame is None:
                    self.stop()
                    raise MediaStreamError
                frame_time = frame.time
                if frame_time is None:
                    continue
                if frame_time + 0.001 < self._target_seconds:
                    continue
                if self._first_time is None:
                    self._first_time = frame_time
                    self._started = time.monotonic()
                elapsed = max(frame_time - self._first_time, self._last_elapsed + 1 / 30)
                self._last_elapsed = elapsed
                delay = self._started + elapsed - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                frame.pts = round(elapsed * VIDEO_CLOCK_RATE)
                frame.time_base = Fraction(1, VIDEO_CLOCK_RATE)
                return frame

        def stop(self):
            if self.readyState != "ended":
                super().stop()
                self._container.close()
else:
    _LatestVideoTrack = None
    _ReplayFileTrack = None


class WebRTCServer:
    """Own the asyncio loop and peer connections independently of Flask."""

    def __init__(self):
        self.available = _IMPORT_ERROR is None
        self._source = _LatestFrameBuffer()
        self._pcs = set()
        self._pcs_lock = threading.Lock()
        self._loop = None
        self._thread = None
        self._closed = False
        self._recording_lock = threading.RLock()
        self._recording = None
        self._last_recording = None
        self._replay_tracks = {}

    @property
    def import_error(self):
        return _IMPORT_ERROR

    @property
    def turn_required(self):
        return _cloudflare_turn.configured

    @property
    def peer_count(self):
        with self._pcs_lock:
            return len(self._pcs)

    def browser_ice_servers(self):
        return browser_ice_servers()

    def replay_ice_servers(self):
        return replay_ice_servers()

    def jpeg_snapshot(self, view="cropped", quality="smooth"):
        """Return one fresh frame for the HTTPS fallback when ICE cannot connect."""
        if view not in ("cropped", "full") or quality not in VIDEO_PROFILES:
            raise ValueError("Invalid JPEG snapshot options")
        item = self._source.latest_frame(view=view)
        if item is None:
            return None
        sequence, frame, timestamp = item
        if timestamp <= 0 or time.time() - timestamp > 2.0:
            return None
        ok, encoded = cv2.imencode(
            ".jpg", _resize_for_video(frame, quality),
            [cv2.IMWRITE_JPEG_QUALITY, 58 if quality == "compact" else 75],
        )
        return (sequence, encoded.tobytes()) if ok else None

    def start(self):
        if not self.available or self._thread is not None:
            return self
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="WebRTCEventLoop",
            daemon=True,
        )
        self._thread.start()
        return self

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()
        self._loop.close()

    def update(self, frame, timestamp=None):
        if self._closed or frame is None:
            return
        # No synthetic frame-rate cap and no duplicated frames.  The latest
        # real camera frame replaces the previous one, so a slow viewer drops
        # old data instead of accumulating latency.
        self._source.update(frame, timestamp)

    def set_crop_region(self, region):
        return self._source.set_crop_region(region)

    def start_recording(self, output_dir, recording_id, metadata=None):
        with self._recording_lock:
            if self._recording is not None and self._recording.active:
                if self._recording.recording_id == recording_id:
                    return self._recording.status()
                raise RecordingError("已有另一场比赛正在录像")
            self._recording = MatchVideoRecorder(
                output_dir,
                recording_id,
                self._source,
                metadata=metadata,
            )
            self._last_recording = None
            return self._recording.status()

    def stop_recording(self, recording_id=None, discard=False):
        with self._recording_lock:
            recorder = self._recording
            if recorder is None:
                if (
                    self._last_recording is not None
                    and (recording_id is None or self._last_recording.get("recordingId") == recording_id)
                ):
                    return dict(self._last_recording)
                raise RecordingError("当前没有正在进行的比赛录像")
            if recording_id is not None and recorder.recording_id != recording_id:
                raise RecordingError("录像编号不匹配")
            status = recorder.stop(discard=discard)
            self._last_recording = dict(status)
            self._recording = None
            return status

    def recording_status(self):
        with self._recording_lock:
            if self._recording is not None:
                return self._recording.status()
            if self._last_recording is not None:
                return dict(self._last_recording)
            return {"active": False, "recordingId": None}

    def offer(self, sdp, offer_type, quality="smooth", view="cropped"):
        if quality not in VIDEO_PROFILES:
            raise ValueError("无效的观看清晰度")
        if view not in ("cropped", "full"):
            raise ValueError("无效的视频视图")
        if not self.available:
            raise WebRTCUnavailable(
                "WebRTC 依赖未安装，请安装 aiortc 和 av"
            ) from self.import_error
        if self._closed:
            raise WebRTCUnavailable("WebRTC 服务已关闭")
        self.start()
        future = asyncio.run_coroutine_threadsafe(
            self._handle_offer(sdp, offer_type, quality, view),
            self._loop,
        )
        try:
            return future.result(timeout=WEBRTC_OFFER_TIMEOUT_S)
        except Exception:
            future.cancel()
            raise

    def replay_offer(self, sdp, offer_type, file_path, mode, start_ms=0):
        if not self.available:
            raise WebRTCUnavailable("WebRTC 依赖未安装") from self.import_error
        if self._closed:
            raise WebRTCUnavailable("WebRTC 服务已关闭")
        if mode not in ("play", "download"):
            raise ValueError("无效的录像模式")
        if type(start_ms) is not int or start_ms < 0 or start_ms > 86400000 or (mode == "download" and start_ms):
            raise ValueError("无效的回放时间")
        self.start()
        future = asyncio.run_coroutine_threadsafe(
            self._handle_replay_offer(sdp, offer_type, file_path, mode, start_ms), self._loop,
        )
        try:
            return future.result(timeout=WEBRTC_OFFER_TIMEOUT_S)
        except Exception:
            future.cancel()
            raise

    async def _handle_replay_offer(self, sdp, offer_type, file_path, mode, start_ms):
        ice_servers = await asyncio.to_thread(_replay_server_ice_servers)
        pc = self._new_peer(ice_servers)
        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=offer_type))
            if mode == "play":
                if start_ms:
                    track = await asyncio.to_thread(_ReplayFileTrack, file_path, start_ms)
                else:
                    player = await asyncio.to_thread(MediaPlayer, file_path, decode=True)
                    if player.video is None:
                        raise ValueError("录像没有可播放的 H.264 视频")
                    track = player.video
                self._replay_tracks[pc] = track
                sender = pc.addTrack(track)
                transceiver = next(item for item in pc.getTransceivers() if item.sender == sender)
                codecs = [codec for codec in RTCRtpSender.getCapabilities("video").codecs
                          if codec.mimeType.lower() == "video/h264"]
                transceiver.setCodecPreferences(codecs)
            else:
                @pc.on("datachannel")
                def on_datachannel(channel):
                    if channel.label != "recording-download":
                        channel.close()
                        return
                    transfer = None
                    acknowledgements = asyncio.Queue(maxsize=1)

                    @channel.on("message")
                    def on_message(message):
                        nonlocal transfer
                        if message == "download" and (transfer is None or transfer.done()):
                            transfer = asyncio.create_task(self._send_recording(channel, file_path, acknowledgements))
                        elif message == "ack" and transfer is not None and not transfer.done() and acknowledgements.empty():
                            acknowledgements.put_nowait(None)

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        except Exception:
            await self._remove_peer(pc)
            raise

    async def _send_recording(self, channel, file_path, acknowledgements):
        try:
            channel.send(json.dumps({"name": os.path.basename(file_path), "size": os.path.getsize(file_path)}))
            with open(file_path, "rb") as recording:
                unacknowledged = 0
                while channel.readyState == "open":
                    chunk = recording.read(8 * 1024)
                    if not chunk:
                        channel.send(json.dumps({"done": True}))
                        return
                    channel.send(chunk)
                    unacknowledged += 1
                    if unacknowledged == 4:
                        await asyncio.wait_for(acknowledgements.get(), timeout=30)
                        unacknowledged = 0
        except Exception:
            if channel.readyState == "open":
                channel.send(json.dumps({"error": "录像下载中断"}))

    def _new_peer(self, ice_servers):
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
        with self._pcs_lock:
            self._pcs.add(pc)
        disconnected_task = None

        async def remove_after_disconnected():
            await asyncio.sleep(DISCONNECTED_PEER_GRACE_S)
            if pc.connectionState == "disconnected":
                await self._remove_peer(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            nonlocal disconnected_task
            if pc.connectionState == "disconnected":
                if disconnected_task is None or disconnected_task.done():
                    disconnected_task = asyncio.create_task(remove_after_disconnected())
                return
            if disconnected_task is not None and not disconnected_task.done():
                disconnected_task.cancel()
                disconnected_task = None
            if pc.connectionState in {"failed", "closed"}:
                await self._remove_peer(pc)
        return pc

    async def _handle_offer(self, sdp, offer_type, quality="smooth", view="cropped"):
        logging.warning("WebRTC offer ICE candidates: %s", _ice_candidate_summary(sdp))
        ice_servers = await asyncio.to_thread(_ice_servers)
        pc = self._new_peer(ice_servers)

        try:
            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=sdp, type=offer_type)
            )
            pc.addTrack(_LatestVideoTrack(self._source, quality, view))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            return {
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type,
            }
        except Exception:
            await self._remove_peer(pc)
            raise

    async def _remove_peer(self, pc):
        track = self._replay_tracks.pop(pc, None)
        if track is not None:
            track.stop()
        with self._pcs_lock:
            existed = pc in self._pcs
            self._pcs.discard(pc)
        if existed and pc.connectionState != "closed":
            await pc.close()

    def close_session(self):
        with self._recording_lock:
            recorder = self._recording
        if recorder is not None:
            try:
                self.stop_recording(recorder.recording_id)
            except RecordingError:
                pass
        if not self.available or self._loop is None:
            self._source.clear()
            return
        future = asyncio.run_coroutine_threadsafe(
            self._close_peers(),
            self._loop,
        )
        try:
            future.result(timeout=WEBRTC_OFFER_TIMEOUT_S)
        except Exception:
            future.cancel()
        self._source.clear()

    async def _close_peers(self):
        with self._pcs_lock:
            peers = list(self._pcs)
            self._pcs.clear()
        if peers:
            for peer in peers:
                track = self._replay_tracks.pop(peer, None)
                if track is not None:
                    track.stop()
            await asyncio.gather(*(pc.close() for pc in peers), return_exceptions=True)

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.close_session()
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._source.close()
        self._loop = None
        self._thread = None
