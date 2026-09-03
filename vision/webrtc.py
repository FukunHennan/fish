"""Low-latency WebRTC publisher for the processed vision frame."""

from __future__ import annotations

import asyncio
import threading
import time

import cv2

from config import (
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    CAMERA_STALE_TIMEOUT_S,
    WEBRTC_MAX_FPS,
    WEBRTC_OFFER_TIMEOUT_S,
    WEBRTC_STUN_URL,
    WEBRTC_TURN_CREDENTIAL,
    WEBRTC_TURN_URL,
    WEBRTC_TURN_USERNAME,
)

try:
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
except ImportError as error:  # pragma: no cover - exercised by environment checks
    VideoFrame = None
    RTCConfiguration = None
    RTCIceServer = None
    RTCPeerConnection = None
    RTCSessionDescription = None
    VideoStreamTrack = object
    MediaStreamError = RuntimeError
    VIDEO_CLOCK_RATE = 90000
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

    def wait_for_frame(self, previous_sequence, timeout):
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
            return self._sequence, self._frame.copy(), self._timestamp

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


def _resize_for_video(frame):
    height, width = frame.shape[:2]
    if width <= 0 or height <= 0:
        return frame
    scale = min(VIDEO_WIDTH / width, VIDEO_HEIGHT / height)
    target = (
        max(1, int(round(width * scale))),
        max(1, int(round(height * scale))),
    )
    if target == (width, height):
        return frame
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(frame, target, interpolation=interpolation)


def _ice_servers():
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


if _IMPORT_ERROR is None:
    class _LatestVideoTrack(VideoStreamTrack):
        def __init__(self, source):
            super().__init__()
            self._source = source
            self._sequence = -1

        async def recv(self):
            while True:
                item = await asyncio.to_thread(
                    self._source.wait_for_frame,
                    self._sequence,
                    1.0,
                )
                if item is None:
                    raise MediaStreamError
                sequence, frame, frame_timestamp = item
                self._sequence = sequence
                if (
                    frame_timestamp > 0
                    and time.time() - frame_timestamp > CAMERA_STALE_TIMEOUT_S
                ):
                    # Never push an old frame into the browser after a
                    # processing/network stall. Wait for a newer capture.
                    continue
                # Let aiortc own the 90 kHz real-time clock. Using the camera
                # sequence as PTS makes dropped frames change playback speed.
                pts, time_base = await self.next_timestamp()
                video_frame = VideoFrame.from_ndarray(frame, format="bgr24")
                video_frame.pts = pts
                video_frame.time_base = time_base
                return video_frame
else:
    _LatestVideoTrack = None


class WebRTCServer:
    """Own the asyncio loop and peer connections independently of Flask."""

    def __init__(self):
        self.available = _IMPORT_ERROR is None
        self._source = _LatestFrameBuffer()
        self._pcs = set()
        self._pcs_lock = threading.Lock()
        self._loop = None
        self._thread = None
        self._last_update_t = 0.0
        self._closed = False

    @property
    def import_error(self):
        return _IMPORT_ERROR

    def browser_ice_servers(self):
        return browser_ice_servers()

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
        if not self.available or self._closed or frame is None:
            return
        now = time.monotonic()
        if now - self._last_update_t < 1.0 / max(1, WEBRTC_MAX_FPS):
            return
        self._last_update_t = now
        self._source.update(_resize_for_video(frame), timestamp)

    def offer(self, sdp, offer_type):
        if not self.available:
            raise WebRTCUnavailable(
                "WebRTC 依赖未安装，请安装 aiortc 和 av"
            ) from self.import_error
        if self._closed:
            raise WebRTCUnavailable("WebRTC 服务已关闭")
        self.start()
        future = asyncio.run_coroutine_threadsafe(
            self._handle_offer(sdp, offer_type),
            self._loop,
        )
        try:
            return future.result(timeout=WEBRTC_OFFER_TIMEOUT_S)
        except Exception:
            future.cancel()
            raise

    async def _handle_offer(self, sdp, offer_type):
        pc = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=_ice_servers())
        )
        with self._pcs_lock:
            self._pcs.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in {"failed", "closed"}:
                await self._remove_peer(pc)

        try:
            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=sdp, type=offer_type)
            )
            pc.addTrack(_LatestVideoTrack(self._source))
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
        with self._pcs_lock:
            existed = pc in self._pcs
            self._pcs.discard(pc)
        if existed and pc.connectionState != "closed":
            await pc.close()

    def close_session(self):
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
