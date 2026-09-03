"""RoboFish transport and the server-side tracking control session."""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.request
from dataclasses import dataclass


@dataclass
class MotionPidController:
    cross_kp: float = 8.0
    cross_ki: float = 0.4
    cross_kd: float = 1.2
    heading_kp: float = 0.12
    curve_feed_forward: float = 5.0
    cruise_frequency: float = 2.5
    cruise_amplitude: float = 28.0
    slow_distance: float = 0.50
    stop_distance: float = 0.10

    def __post_init__(self):
        self.reset()

    def reset(self):
        self.integral = 0.0
        self.previous_error = 0.0
        self.last_update = None

    def update(self, *, cross_track_error, heading_error_deg, distance_to_target,
               curvature, brake, now):
        if self.last_update is None:
            dt = 0.1
        else:
            dt = now - self.last_update
            if dt <= 0.0:
                dt = 0.1
        self.last_update = now
        self.integral += cross_track_error * dt
        derivative = (cross_track_error - self.previous_error) / dt
        self.previous_error = cross_track_error
        steering = (
            self.cross_kp * cross_track_error
            + self.cross_ki * self.integral
            + self.cross_kd * derivative
            + self.heading_kp * heading_error_deg
            + self.curve_feed_forward * curvature
        )
        scale = distance_to_target / self.slow_distance
        stopped = brake and distance_to_target <= self.stop_distance
        return {
            "mode": "stop" if stopped else "forward",
            "frequency": 0.0 if stopped else self.cruise_frequency * scale,
            "amplitude": 0.0 if stopped else self.cruise_amplitude * scale,
            "bias": 0.0 if stopped else -steering,
        }

class RoboFishComm:
    def __init__(self, controller_url="http://127.0.0.1:8081/api/vision/device-command"):
        self.base_url = controller_url
        self.cmd_queue = queue.Queue(maxsize=1)
        self.stopped = False
        self.mcu_hz = 0.0
        self._last_send_t = time.time()
        self._last_cmd_t = 0.0
        self._last_params = None
        self.vision_seq = 0
        self._state_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._control_session = 0
        self._session_id = ""
        self._motion_enabled = False
        self._device_id = ""
        self._motion_pid = MotionPidController()
        self.thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.thread.start()
        print(f"Vision motion routed through Go controller -> {self.base_url}")

    def _post(self, payload, timeout=0.5):
        payload = dict(payload)
        if self._device_id:
            payload["deviceId"] = self._device_id
        request = urllib.request.Request(
            self.base_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "RoboFish-Visual-Tracker",
                "Connection": "close",
            },
            method="POST",
        )
        internal_token = os.environ.get("FISH_VISION_INTERNAL_TOKEN", "").strip()
        if internal_token:
            request.add_header("X-Fish-Vision-Internal", internal_token)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("sent"):
            raise RuntimeError("没有唯一在线机器鱼可接收运动命令")
        if not result.get("acknowledged"):
            raise RuntimeError(result.get("message") or "机器鱼响应超时")
        if not result.get("success"):
            code = result.get("code") or "DEVICE_REJECTED"
            message = result.get("message") or "机器鱼拒绝执行运动命令"
            raise RuntimeError(f"{code}: {message}")
        return result

    def set_device_id(self, device_id):
        self._device_id = str(device_id or "").strip()

    def _request_motion(self, mode, frequency, amplitude, bias, timeout=0.3):
        return self._post({
            "operation": "motion",
            "sessionId": self._session_id,
            "mode": str(mode),
            "frequency": float(frequency),
            "amplitude": float(amplitude),
            "bias": float(bias),
        }, timeout=timeout)

    def _worker_loop(self):
        while not self.stopped:
            try:
                params = self.cmd_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                with self._request_lock:
                    if not self._command_is_current(params):
                        continue
                    if params.get("kind") == "motion":
                        request_started = time.perf_counter()
                        payload = self._request_motion(
                            params["mode"],
                            params["frequency"],
                            params["amplitude"],
                            params["bias"],
                            timeout=0.3,
                        )
                        latency_ms = (time.perf_counter() - request_started) * 1000.0
                        print(
                            f"[MOTION Forwarded] seq={params['seq']} "
                            f"RTT={latency_ms:.1f}ms"
                        )
                    else:
                        self._post({"operation": "stop", "sessionId": self._session_id}, timeout=0.2)

                now = time.time()
                dt = now - self._last_send_t
                if dt > 0:
                    self.mcu_hz = 0.9 * self.mcu_hz + 0.1 * (1.0 / dt)
                self._last_send_t = now
            except Exception as error:
                if params.get("kind") == "motion":
                    print(
                        f"[MOTION ACK Failed] seq={params.get('seq', '-')} "
                        f"mode={params.get('mode', '-')} "
                        f"error={error}"
                    )
                else:
                    print(f"[Go Forwarding] Failed: {error}")

    def get_mcu_hz(self):
        if time.time() - self._last_send_t > 1.5:
            self.mcu_hz *= 0.5
        return round(self.mcu_hz, 1)

    def _command_is_current(self, params):
        if params.get("kind") != "motion":
            return True
        with self._state_lock:
            return (
                self._motion_enabled
                and params.get("session") == self._control_session
            )

    def _clear_queue(self):
        while not self.cmd_queue.empty():
            try:
                self.cmd_queue.get_nowait()
            except queue.Empty:
                break

    def _send_async(self, params):
        now = time.time()
        is_stop = params.get("action") == "stop" or (
            params.get("kind") == "motion" and params.get("mode") == "stop"
        )
        if not is_stop and (now - self._last_cmd_t < 0.1):
            return False
        self._last_cmd_t = now
        if params.get("kind") == "motion":
            with self._state_lock:
                if not self._motion_enabled:
                    return False
                params = dict(params, session=self._control_session)
        self._last_params = params
        self._clear_queue()
        try:
            self.cmd_queue.put_nowait(params)
            return True
        except queue.Full:
            return False

    def set_mode(self, motion_mode):
        mode_map = {
            "bionic": "mode_bionic",
            "propeller": "mode_prop",
            "prop": "mode_prop",
            "hybrid": "mode_hybrid",
        }
        target_mode = mode_map.get(str(motion_mode).lower(), "mode_bionic")
        print(f"[HTTP Command] Switching fish mode to {target_mode}")
        self._send_async({"action": target_mode})

    def ensure_hybrid_mode(self):
        """Start a new control session after a serialized propulsion stop."""
        with self._state_lock:
            self._control_session += 1
            session = self._control_session
            self._motion_enabled = False
        self._motion_pid.reset()
        self._clear_queue()
        try:
            with self._request_lock:
                self._session_id = f"vision-{session}-{time.time_ns()}"
                self._post({"operation": "start", "sessionId": self._session_id}, timeout=1.0)
            with self._state_lock:
                if self._control_session != session:
                    return False
                self._motion_enabled = True
            print(
                f"[HTTP Vision Ready] Session {session} established; "
                "all previous PID commands invalidated"
            )
            return True
        except Exception as error:
            print(f"[HTTP Vision Ready] Failed: {error}")
            return False

    def start_forward_calibration(self, duration_ms=3200):
        if not self._session_id:
            return False
        try:
            self._post({"operation": "calibrate-forward", "sessionId": self._session_id, "durationMs": int(duration_ms)}, timeout=1.0)
            print("[Vision Calibration] Server forward preset started")
            return True
        except Exception as error:
            print(f"[Vision Calibration] Forward preset failed: {error}")
            return False

    def send_command(self, cmd_str):
        if cmd_str in ["stop", "emergency_stop"]:
            print("[HTTP Command] Emergency stop / propulsion stop")
            return self.stop_now()

    def stop_now(self):
        """Invalidate old PID work, then serialize STOP behind any in-flight request."""
        with self._state_lock:
            self._control_session += 1
            self._motion_enabled = False
        self._motion_pid.reset()
        self._last_params = None
        self._clear_queue()
        try:
            with self._request_lock:
                self._post({"operation": "stop", "sessionId": self._session_id}, timeout=1.0)
            print("[HTTP Response] Propulsion stopped")
            return True
        except Exception as error:
            print(f"[HTTP Stop] Failed: {error}")
            return False

    def process_tracking_error(
        self,
        cross_m,
        along_m,
        dist_m,
        speed_mps=0.0,
        curve_severity=0.0,
        brake_request=False,
        cross_track_m=0.0,
        heading_error_deg=0.0,
        path_curvature_per_m=0.0,
        steering_demand=0.0,
    ):
        """Calculate motion on the server and send final servo parameters."""
        self.vision_seq = (self.vision_seq + 1) & 0x7FFFFFFF
        motion = self._motion_pid.update(
            cross_track_error=float(cross_m),
            heading_error_deg=float(heading_error_deg),
            distance_to_target=float(dist_m),
            curvature=float(path_curvature_per_m),
            brake=bool(brake_request),
            now=time.monotonic(),
        )
        queued = self._send_async({
            "kind": "motion",
            "seq": self.vision_seq,
            **motion,
        })
        if queued:
            print(
                f"[MOTION Queued] seq={self.vision_seq} "
                f"mode={motion['mode']} frequency={motion['frequency']:.3f} "
                f"amplitude={motion['amplitude']:.3f} bias={motion['bias']:+.3f} "
                f"brake={'yes' if brake_request else 'no'}"
            )
        return queued

    def close(self):
        self.stop_now()
        self.stopped = True
        if self.thread.is_alive():
            self.thread.join(timeout=1.0)


from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class ControlDecision:
    status: str
    guidance: Optional[dict[str, Any]] = None
    pid: Optional[dict[str, Any]] = None
    stop_required: bool = False
    message: Optional[str] = None


class VisionControlSession:
    def __init__(self, path_guidance, command_interval_s: float = 0.10):
        self.path_guidance = path_guidance
        self.command_interval_s = float(command_interval_s)
        self.active = False
        self.status = "READY"
        self.segment = 0
        self._last_control_t = float("-inf")

    def prepare(self, path_world, position, frame_time, heading):
        """Prepare geometry without enabling propulsion."""
        self.active = False
        self.segment = 0
        return self.path_guidance.start(
            path_world, position, frame_time, heading
        )

    def activate(self, initial_guidance) -> None:
        self.active = True
        self.status = "HYBRID TRACKING"
        self.segment = int(initial_guidance["seg_index"])
        self._last_control_t = float("-inf")

    def stop(self, status="STOPPED", *, clear_path=False) -> bool:
        """Enter a non-driving state and report whether propulsion may exist."""
        was_active = self.active
        self.active = False
        self.status = status
        if clear_path:
            self.path_guidance.clear()
            self.segment = 0
        return was_active

    def update(
        self,
        *,
        calibrated: bool,
        position,
        frame_time: float,
        now: float,
        allow_course_update: bool,
        speed_mps: float,
    ) -> ControlDecision:
        if not self.active:
            return ControlDecision(status=self.status)
        if not calibrated:
            self.stop("UNCALIBRATED")
            return ControlDecision(
                status=self.status,
                stop_required=True,
                message="场地标定失效，循迹已停止。",
            )
        if position is None:
            self.stop("TARGET LOST")
            return ControlDecision(
                status=self.status,
                stop_required=True,
                message="视觉目标失效，循迹已停止。",
            )
        if not self.path_guidance.prepared:
            self.stop("PATH INVALID")
            return ControlDecision(
                status=self.status,
                stop_required=True,
                message="路径引导状态失效，循迹已停止。",
            )

        guidance = self.path_guidance.update(
            position,
            frame_time,
            allow_course_update=allow_course_update,
            speed_mps=float(speed_mps),
        )
        self.segment = int(guidance["seg_index"])
        if guidance["settled"]:
            self.stop("ARRIVED")
            return ControlDecision(
                status=self.status,
                guidance=guidance,
                stop_required=True,
                message="已进入终点停止圈。",
            )

        pid = None
        if now - self._last_control_t >= self.command_interval_s:
            pid = {
                "cross_m": guidance["x_error_m"],
                "along_m": guidance["along_m"],
                "dist_m": guidance["drive_distance_m"],
                "speed_mps": float(speed_mps),
                "curve_severity": guidance["curve_severity"],
                "brake_request": guidance["brake_request"],
                "cross_track_m": guidance["cross_track_m"],
                "heading_error_deg": guidance["heading_error_deg"],
                "path_curvature_per_m": guidance["path_curvature_per_m"],
                "steering_demand": guidance["steering_demand"],
            }
            self._last_control_t = now
        self.status = (
            "HYBRID BRAKING" if guidance["brake_request"]
            else "HYBRID TRACKING"
        )
        return ControlDecision(
            status=self.status,
            guidance=guidance,
            pid=pid,
        )
