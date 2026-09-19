"""Server-side competition recording from the exact player video view."""

from __future__ import annotations

from datetime import datetime
from fractions import Fraction
from pathlib import Path
import os
import re
import threading
import time

import av
import cv2


_SAFE_ID = re.compile(r"[^A-Za-z0-9_-]+")
_TIME_BASE = Fraction(1, 1000)


class RecordingError(RuntimeError):
    """Raised when a competition recording cannot be started or finalized."""


def _safe_recording_id(value):
    cleaned = _SAFE_ID.sub("-", str(value or "").strip()).strip("-")
    if not cleaned:
        raise RecordingError("recordingId 不能为空")
    return cleaned[:96]


def _safe_file_stem(value):
    """Keep readable Unicode event names while removing path punctuation."""
    parts = []
    pending_separator = False
    for character in str(value or "").strip():
        if character.isalnum() or character in ("-", "_"):
            if pending_separator and parts and parts[-1] not in ("-", "_"):
                parts.append("_")
            parts.append(character)
            pending_separator = False
        else:
            pending_separator = True
    cleaned = "".join(parts).strip("-_")
    return (cleaned or "未命名赛事")[:80]


class MatchVideoRecorder:
    """Encode unique cropped camera frames into a browser-playable H.264 MP4.

    ``source`` is the same latest-frame buffer used by the player WebRTC
    track.  It receives camera-wide frames after rotation and applies the
    shared crop when ``view='cropped'`` is requested, so replay and the live
    player view use exactly the same geometry.
    """

    def __init__(self, output_dir, recording_id, source, metadata=None):
        self.recording_id = _safe_recording_id(recording_id)
        self.source = source
        self.metadata = dict(metadata or {})
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        latest = source.latest_frame(view="cropped")
        if latest is None:
            raise RecordingError("当前没有可录制的选手视频帧")
        sequence, frame, timestamp = latest
        if frame is None or getattr(frame, "ndim", 0) != 3:
            raise RecordingError("选手视频帧无效")

        height, width = frame.shape[:2]
        # H.264 yuv420p requires even dimensions. Removing at most one edge
        # pixel preserves the crop without stretching or inventing pixels.
        self.width = int(width) & ~1
        self.height = int(height) & ~1
        if self.width < 2 or self.height < 2:
            raise RecordingError("选手有效区尺寸过小，无法录像")

        stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
        event_name = _safe_file_stem(self.metadata.get("matchNo") or self.recording_id)
        self.file_name = f"{event_name}_{stamp}.mp4"
        self.path = self.output_dir / self.file_name
        self.partial_path = self.output_dir / f".{self.file_name}.partial"
        self.started_at = datetime.now().astimezone().isoformat()
        self._started_timestamp = float(timestamp or time.time())
        self._last_timestamp = self._started_timestamp
        self._previous_sequence = int(sequence) - 1
        self._last_pts = -1
        self._frame_count = 0
        self._dropped_frames = 0
        self._error = None
        self._discard = False
        self._stop_event = threading.Event()
        self._lock = threading.RLock()

        try:
            self._container = av.open(
                str(self.partial_path),
                mode="w",
                format="mp4",
                options={"movflags": "+faststart"},
            )
            # 60 is the encoder timing grid, not a frame generator or cap.
            # Frames retain real capture timestamps and are never duplicated.
            self._stream = self._container.add_stream(
                "libx264",
                rate=60,
                options={"preset": "ultrafast", "crf": "23", "tune": "zerolatency"},
            )
            self._stream.width = self.width
            self._stream.height = self.height
            self._stream.pix_fmt = "yuv420p"
        except Exception as error:
            self._close_container_quietly()
            self.partial_path.unlink(missing_ok=True)
            raise RecordingError(f"无法创建 H.264 录像：{error}") from error

        self._thread = threading.Thread(
            target=self._writer_loop,
            name=f"match-recorder-{self.recording_id}",
            daemon=True,
        )
        self._thread.start()

    @property
    def active(self):
        return self._thread.is_alive() and not self._stop_event.is_set()

    def _close_container_quietly(self):
        container = getattr(self, "_container", None)
        if container is None:
            return
        try:
            container.close()
        except Exception:
            pass
        self._container = None

    def _encode(self, frame, timestamp):
        frame = frame[: self.height, : self.width]
        if frame.shape[1] != self.width or frame.shape[0] != self.height:
            frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)
        pts = max(
            self._last_pts + 1,
            int(round(max(0.0, float(timestamp) - self._started_timestamp) * 1000.0)),
        )
        video_frame = av.VideoFrame.from_ndarray(frame, format="bgr24")
        video_frame.pts = pts
        video_frame.time_base = _TIME_BASE
        for packet in self._stream.encode(video_frame):
            self._container.mux(packet)
        self._last_pts = pts
        self._last_timestamp = float(timestamp)
        self._frame_count += 1

    def _writer_loop(self):
        try:
            while not self._stop_event.is_set():
                item = self.source.wait_for_frame(
                    self._previous_sequence,
                    timeout=0.25,
                    view="cropped",
                )
                if item is None:
                    continue
                sequence, frame, timestamp = item
                if self._previous_sequence >= 0 and sequence > self._previous_sequence + 1:
                    self._dropped_frames += sequence - self._previous_sequence - 1
                self._previous_sequence = sequence
                self._encode(frame, timestamp)
            for packet in self._stream.encode():
                self._container.mux(packet)
        except Exception as error:
            with self._lock:
                self._error = str(error)
        finally:
            self._close_container_quietly()
            try:
                if self._discard or self._error:
                    self.partial_path.unlink(missing_ok=True)
                    if self._discard:
                        self.path.unlink(missing_ok=True)
                else:
                    os.replace(self.partial_path, self.path)
            except OSError as error:
                with self._lock:
                    self._error = self._error or str(error)

    def stop(self, discard=False, timeout=10.0):
        self._discard = bool(discard)
        self._stop_event.set()
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            raise RecordingError("等待录像文件封存超时")
        status = self.status()
        if status["error"] and not discard:
            raise RecordingError(status["error"])
        return status

    def status(self):
        with self._lock:
            duration_ms = max(
                0,
                int(round((self._last_timestamp - self._started_timestamp) * 1000.0)),
            )
            average_fps = (
                self._frame_count * 1000.0 / duration_ms
                if duration_ms > 0 and self._frame_count > 1
                else 0.0
            )
            return {
                "active": self.active,
                "recordingId": self.recording_id,
                "fileName": self.file_name,
                "startedAt": self.started_at,
                "durationMs": duration_ms,
                "frameCount": self._frame_count,
                "droppedFrames": self._dropped_frames,
                "averageFps": average_fps,
                "width": self.width,
                "height": self.height,
                "view": "cropped",
                "transform": "rotation+crop",
                "error": self._error,
                "metadata": self.metadata,
            }
