"""Authoritative lifecycle state for one browser-visible vision session."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import secrets
from typing import Any, Optional


class VisionState(str, Enum):
    IDLE = "idle"
    OPENING = "opening"
    PREVIEWING = "previewing"
    PROCESSING = "processing"
    TRACKING = "tracking"
    STOPPING = "stopping"
    ERROR = "error"


class InvalidTransition(RuntimeError):
    pass


class SessionMismatch(RuntimeError):
    pass


_TRANSITIONS = {
    VisionState.IDLE: {VisionState.OPENING},
    VisionState.OPENING: {
        VisionState.PREVIEWING,
        VisionState.STOPPING,
        VisionState.ERROR,
    },
    VisionState.PREVIEWING: {
        VisionState.PROCESSING,
        VisionState.STOPPING,
        VisionState.ERROR,
    },
    VisionState.PROCESSING: {
        VisionState.PREVIEWING,
        VisionState.TRACKING,
        VisionState.STOPPING,
        VisionState.ERROR,
    },
    VisionState.TRACKING: {
        VisionState.PROCESSING,
        VisionState.STOPPING,
        VisionState.ERROR,
    },
    VisionState.STOPPING: {VisionState.IDLE, VisionState.ERROR},
    VisionState.ERROR: {VisionState.OPENING, VisionState.STOPPING, VisionState.IDLE},
}


@dataclass
class VisionSession:
    session_id: str
    camera_id: Optional[str]
    camera_index: Optional[int]
    target_device_id: Optional[str]
    state: VisionState
    error: Optional[dict[str, str]] = None
    metrics: dict[str, Any] = field(default_factory=dict)
    last_action: Optional[dict[str, Any]] = None

    @classmethod
    def new(cls, camera_id: str, camera_index: int, target_device_id: Optional[str] = None) -> "VisionSession":
        return cls(
            session_id=secrets.token_urlsafe(24),
            camera_id=camera_id,
            camera_index=camera_index,
            target_device_id=target_device_id,
            state=VisionState.OPENING,
        )

    def transition(self, target: VisionState) -> None:
        target = VisionState(target)
        if target not in _TRANSITIONS[self.state]:
            raise InvalidTransition(f"{self.state.value} -> {target.value}")
        self.state = target

    def require_id(self, session_id: str) -> None:
        if not session_id or session_id != self.session_id:
            raise SessionMismatch("session_mismatch")

    def fail(self, code: str, message: str) -> None:
        if self.state != VisionState.ERROR:
            self.transition(VisionState.ERROR)
        self.error = {"code": code, "message": message}

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "sessionId": self.session_id,
            "cameraId": self.camera_id,
            "cameraIndex": self.camera_index,
            "targetDeviceId": self.target_device_id,
            "error": self.error,
            "metrics": dict(self.metrics),
            "lastAction": self.last_action,
        }
