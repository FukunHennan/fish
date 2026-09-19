"""RoboFish vision scheduler and application entry point.

All cross-feature wiring lives here.  Perception, path control, presentation,
camera/network adapters, and persistence remain independently testable.
"""

from __future__ import annotations

import os
import threading
import time
import traceback

import cv2
import numpy as np

from config import (
    CAMERA_STALE_TIMEOUT_S,
    DISPLAY_MAX_FPS,
    MARKER_PROFILE_PATH,
    OUTPUT_DIR,
    TABLET_TCP_HOST,
    TABLET_TCP_PORT,
    TARGET_FPS,
    TARGET_HEIGHT,
    TARGET_WIDTH,
    TURN_CALIBRATION_PATH,
    WORK_DIR,
    YOLO_CONF_THRESHOLD,
    YOLO_DEVICE,
    YOLO_IMG_SIZE,
    YOLO_MODEL_PATH,
)
from control import ControlDecision, RoboFishComm, VisionControlSession
from interface import (
    AsyncVideoRecorder,
    CameraStream,
    MJPEGServer,
    TabletTCPServer,
)
from navigation import (
    PathGuidance,
    TurnCalibrationError,
    TurnCalibrationSession,
    VelocityEstimator,
    compensate_camera_latency,
    load_turn_calibrations,
    save_turn_calibration,
)
from perception import (
    FishDetector,
    FixedReferenceTracker,
    ReferenceSource,
    VisionPipeline,
    build_calibration_homography,
)
from session import TrackingMode
from ui import (
    VisionHud,
    VisionMouseController,
    VisionPresentation,
    VisionToolbar,
    create_runtime_state,
)
from web_actions import translate_web_action


PATH_START_TOLERANCE_M = 0.40
PATH_AUTO_ANCHOR_MAX_M = 1.00


def estimate_motion_heading(points, min_samples=20, min_distance_px=18.0):
    points = np.asarray(points, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < min_samples:
        raise ValueError(f"有效轨迹帧不足：{len(points) if points.ndim else 0} / {min_samples}")
    edge = max(3, len(points) // 6)
    displacement = np.mean(points[-edge:], axis=0) - np.mean(points[:edge], axis=0)
    distance = float(np.linalg.norm(displacement))
    path_distance = float(np.sum(np.linalg.norm(np.diff(points, axis=0), axis=1)))
    consistency = distance / max(path_distance, 1e-6)
    centered = points - np.mean(points, axis=0)
    singular = np.linalg.svd(centered, compute_uv=False)
    linearity = float((singular[0] ** 2) / max(float(np.sum(singular ** 2)), 1e-6))
    if distance < min_distance_px:
        raise ValueError(f"运动距离不足：{distance:.1f} px，需要至少 {min_distance_px:.0f} px")
    if consistency < 0.55 or linearity < 0.75:
        raise ValueError(f"轨迹方向不稳定：一致性 {consistency:.2f}，线性度 {linearity:.2f}")
    return {"unit": displacement / distance, "distance": distance, "consistency": consistency, "linearity": linearity}


class VisionApplication:
    """Own service lifecycle and coordinate data-only feature snapshots."""

    WINDOW_NAME = "AUV YOLO Tracker (RoboFish PID)"

    def __init__(
        self,
        camera_index=1,
        headless=False,
        action_source=None,
        action_result_sink=None,
        frame_sink=None,
        yolo_model_path=None,
        tracking_mode=TrackingMode.YOLO.value,
        camera_factory=None, detector_factory=None, comm_factory=None, tablet_factory=None,
    ):
        self.camera_factory = camera_factory or CameraStream
        self.detector_factory = detector_factory or FishDetector
        self.comm_factory = comm_factory or RoboFishComm
        self.tablet_factory = tablet_factory or TabletTCPServer
        self.camera_index = camera_index
        self.yolo_model_path = yolo_model_path or YOLO_MODEL_PATH
        self.tracking_mode = TrackingMode(tracking_mode or TrackingMode.YOLO.value)
        self.headless = headless
        self.action_source = action_source
        self.action_result_sink = action_result_sink
        self.frame_sink = frame_sink
        self.cam = None
        self.last_error = None
        self.tablet = None
        self.mjpeg = None
        self.fish_comm = None
        self.detector = None
        self.reference_tracker = None
        self.pipeline = None
        self.control = None
        self.presentation = None
        self.turn_session = None
        self.turn_results = {}
        self.runtime = None
        self.recorder = None
        self.is_recording = False
        self.status = "READY"
        self.last_result = None
        self.last_decision = ControlDecision(status="READY")
        self._last_camera_sequence = -1
        self._last_display_t = 0.0
        self._last_loop_t = time.perf_counter()
        self._loop_fps = 0.0
        self._exit_requested = False
        self._stop_latched_reason = None
        self._last_web_metrics_t = 0.0
        self._frame_publisher_thread = None
        self._forward_calibration = None
        self._turn_calibration_direction = None
        self.processing_enabled = False
        self._heading_calibration_result = {
            "status": "idle", "progress": 0.0, "sampleCount": 0,
            "message": "无需预先标定，启动后按实际位移自动修正方向",
        }

    def run(self):
        os.chdir(WORK_DIR)
        self._print_startup()
        try:
            if not self._start():
                return 1
            self._loop()
            return 0
        except Exception as error:
            self.last_error = error
            print(f"Unhandled runtime error: {error}")
            traceback.print_exc()
            self._safe_stop("FAULT", force=True)
            return 1
        finally:
            self._close()

    def request_exit(self):
        self._exit_requested = True

    def _publish_frame(self, image, frame_time=None):
        if self.mjpeg is not None:
            self.mjpeg.update(image)
        if self.frame_sink is not None:
            update = getattr(self.frame_sink, "update", None)
            if callable(update):
                try:
                    update(image, frame_time)
                except TypeError:
                    # Preserve compatibility with older one-argument sinks.
                    update(image)
            elif callable(self.frame_sink):
                self.frame_sink(image)

    def _publish_camera_frames(self):
        """Publish capture frames independently from perception throughput.

        Full-resolution perception can run much slower than the camera,
        especially on an integrated GPU. WebRTC must still receive every
        fresh capture frame so enabling YOLO does not turn the video stream
        into a low-frame-rate slideshow that codecs render as blurry motion.
        """
        last_sequence = -1
        while not self._exit_requested:
            camera = self.cam
            if camera is None:
                time.sleep(0.01)
                continue
            try:
                # Publish the uncropped camera frame. WebRTC selects either
                # the full referee view or the shared effective region per
                # viewer, while recognition continues to use cropped frames.
                snapshot = camera.snapshot(copy_frame=False, apply_crop=False)
            except TypeError:
                # Keep compatibility with lightweight camera doubles and
                # older camera adapters that expose snapshot() without the
                # optional copy_frame argument.
                snapshot = camera.snapshot()
            sequence = snapshot.get("sequence", -1)
            frame = snapshot.get("frame")
            if snapshot.get("ok") and frame is not None and sequence != last_sequence:
                last_sequence = sequence
                self._publish_frame(frame, snapshot.get("timestamp"))
                continue
            time.sleep(0.002)

    def _start_frame_publisher(self):
        if not self.headless or self.frame_sink is None:
            return
        self._frame_publisher_thread = threading.Thread(
            target=self._publish_camera_frames,
            name="camera-webrtc-publisher",
            daemon=True,
        )
        self._frame_publisher_thread.start()

    def _print_startup(self):
        print("\n" + "=" * 60)
        print("Starting YOLO RoboFish tracking and vision control...")
        print(f"Working directory: {WORK_DIR}")
        print(
            f"Capture target: {TARGET_WIDTH}x{TARGET_HEIGHT}; "
            "FPS negotiated by camera and measured from real frames"
        )
        print(f"Camera stale timeout: {CAMERA_STALE_TIMEOUT_S * 1000:.0f} ms")
        print(f"Tablet TCP: {TABLET_TCP_HOST}:{TABLET_TCP_PORT}")
        print("Fish control: routed through the local Go controller")
        print("=" * 60 + "\n")

    def _start(self):
        self.cam = self.camera_factory(src=self.camera_index).start()
        if not self.cam.ret:
            print("Unable to open camera; check USB connection and camera index.")
            return False

        self.tablet = self.tablet_factory(
            host=TABLET_TCP_HOST, port=TABLET_TCP_PORT
        )
        # WebRTC is the only browser transport. MJPEG is kept as a testable
        # compatibility class, but is not started in the production service.
        self.mjpeg = None
        self.fish_comm = self.comm_factory()
        self.detector = self.detector_factory(
            model_path=self.yolo_model_path,
            conf=YOLO_CONF_THRESHOLD,
            imgsz=YOLO_IMG_SIZE,
            device=YOLO_DEVICE,
        )
        self.reference_tracker = FixedReferenceTracker(
            profile_path=MARKER_PROFILE_PATH,
            enable_rigid_body=False,
        )
        self._report_marker_profile()
        self.pipeline = VisionPipeline(
            self.detector,
            self.reference_tracker,
            VelocityEstimator(
                history_seconds=0.40,
                min_span_seconds=0.12,
                blend=0.45,
                max_speed_mps=0.80,
            ),
            compensate_camera_latency,
        )
        self.pipeline.set_single_fish_mode(
            self.tracking_mode == TrackingMode.SINGLE_FISH
        )

        self.runtime = create_runtime_state(
            ReferenceSource.INVALID,
        )
        path_guidance = self._create_path_guidance()
        self.control = VisionControlSession(path_guidance)
        self.turn_session = TurnCalibrationSession()
        toolbar = VisionToolbar()
        self.presentation = VisionPresentation(
            toolbar, VisionHud(), self.runtime.trajectory,
            web_clean=self.headless,
        )
        if not self.headless:
            mouse = VisionMouseController(
                frame_width=self.cam.real_width,
                frame_height=self.cam.real_height,
                toolbar=toolbar,
                pending_actions=self.runtime.pending_actions,
                pointer_state=self.runtime.pointer,
                marker_roi_state=self.runtime.marker_roi,
                heading_state=self.runtime.heading,
                calibration_state=self.runtime.calibration,
                drawn_path_state=self.runtime.drawn_path,
            )
            display_width = 960
            display_height = int(
                display_width * self.cam.real_height / self.cam.real_width
            )
            cv2.namedWindow(self.WINDOW_NAME, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(self.WINDOW_NAME, display_width, display_height)
            cv2.setMouseCallback(self.WINDOW_NAME, mouse)
            startup = self.cam.snapshot()
            if startup["frame"] is not None:
                cv2.imshow(self.WINDOW_NAME, startup["frame"])
                cv2.waitKey(1)
        self._start_frame_publisher()
        print("Vision preview started; YOLO processing is disabled by default.")
        return True

    def _create_path_guidance(self):
        try:
            self.turn_results = load_turn_calibrations(TURN_CALIBRATION_PATH)
        except (OSError, ValueError, TypeError) as error:
            self.turn_results = {}
            print(f"Turn calibration unavailable; using estimated radius: {error}")
        left = self.turn_results.get("LEFT")
        right = self.turn_results.get("RIGHT")
        return PathGuidance(
            spacing_m=0.03,
            lookahead_m=0.24,
            min_lookahead_m=0.10,
            full_attraction_error_m=0.18,
            curve_preview_m=0.32,
            estimated_min_turn_radius_m=0.20,
            left_turn_radius_m=left.radius_m if left else None,
            right_turn_radius_m=right.radius_m if right else None,
            max_x_error_m=(1.0 / 3.0),
            arrival_radius_m=0.20,
            brake_radius_m=0.40,
        )

    def _report_marker_profile(self):
        if self.reference_tracker.is_profiled:
            print(f"Tail marker profile loaded: {MARKER_PROFILE_PATH}")
        elif self.reference_tracker.profile_load_error:
            print(f"Tail marker profile invalid: {self.reference_tracker.profile_load_error}")
        else:
            print("Tail marker has not been calibrated.")

    def _loop(self):
        while not self._exit_requested:
            if not self.headless and cv2.getWindowProperty(
                self.WINDOW_NAME, cv2.WND_PROP_VISIBLE
            ) < 1:
                self._safe_stop("WINDOW CLOSED", force=True)
                break

            snapshot = self.cam.snapshot()
            measured_fps = float(getattr(self.cam, "measured_fps", 0.0) or 0.0)
            stale_timeout = max(
                CAMERA_STALE_TIMEOUT_S,
                3.0 / measured_fps if measured_fps > 0 else 3.0,
            )
            if snapshot["age_s"] > stale_timeout:
                self._safe_stop(
                    "CAMERA STALE",
                    force=self._stop_latched_reason != "CAMERA STALE",
                )
                self._service_ui_without_frame()
                continue
            if (
                not snapshot["ok"]
                or snapshot["frame"] is None
                or snapshot["sequence"] == self._last_camera_sequence
            ):
                self._service_ui_without_frame()
                continue
            self._last_camera_sequence = snapshot["sequence"]
            if self.status == "CAMERA STALE":
                self.status = "READY"
                self.control.status = "READY"
                print("Camera stream recovered; tracking remains stopped.")
            self._stop_latched_reason = None

            if not self.processing_enabled:
                self._update_loop_fps()
                image = snapshot["frame"] if self.headless else self.presentation.render_preview(
                    snapshot["frame"], snapshot["timestamp"],
                    camera_fps=self.cam.measured_fps, loop_fps=self._loop_fps,
                )
                if self._frame_publisher_thread is None:
                    self._publish_frame(image, snapshot["timestamp"])
                self._publish_preview_metrics(snapshot["frame"], snapshot["timestamp"])
                self._display(image)
                self._queue_input_actions()
                self._handle_pending_actions(None, image)
                continue

            result = self.pipeline.process(
                snapshot["frame"],
                snapshot["timestamp"],
                self.runtime.calibration["H"],
            )
            self.last_result = result
            if self.headless and result.display_pixel is not None:
                cx, cy = result.display_pixel
                if not self.runtime.trajectory:
                    self.runtime.trajectory.append((cx, cy))
                else:
                    last_x, last_y = self.runtime.trajectory[-1]
                    if (cx - last_x) ** 2 + (cy - last_y) ** 2 >= 9.0:
                        self.runtime.trajectory.append((cx, cy))
            self.runtime.frame["latest"] = result.frame.copy()
            self.runtime.frame["reference_position"] = result.pixel
            self.runtime.frame["reference_source"] = result.reference.source
            self.runtime.frame["tail_marker_position"] = (
                result.reference.metrics.get("tail_marker_position")
            )
            self._update_loop_fps()
            self._update_frame_calibration(result)
            self._collect_turn_sample(result)
            self._update_forward_calibration(result)
            self._handle_tablet_commands()
            self.last_decision = self._update_control(result)

            image = self._render_and_publish(result, self.last_decision)
            self._display(image)
            self._queue_input_actions()
            self._handle_pending_actions(result, image)

    def _service_ui_without_frame(self):
        self._queue_input_actions()
        if self.last_result is not None:
            self._handle_pending_actions(self.last_result, self.last_result.frame)
        time.sleep(0.001)

    def _update_loop_fps(self):
        now = time.perf_counter()
        dt = now - self._last_loop_t
        self._last_loop_t = now
        if dt > 0:
            self._loop_fps = 0.9 * self._loop_fps + 0.1 / dt

    def _update_frame_calibration(self, result):
        state = self.runtime.calibration
        if state["is_calibrating"] or state["manual_locked"]:
            return
        height, width = result.frame.shape[:2]
        frame_size = (int(width), int(height))
        if state.get("frame_size") == frame_size and state["H"] is not None:
            return
        points = np.float32([
            [0.0, 0.0],
            [float(max(1, width - 1)), 0.0],
            [float(max(1, width - 1)), float(max(1, height - 1))],
            [0.0, float(max(1, height - 1))],
        ])
        homography, error = build_calibration_homography(points, width, height)
        if error:
            state["H"] = None
            state["auto_locked"] = False
            state["frame_size"] = None
            print(f"Effective-frame calibration failed: {error}")
            return
        state["H"] = homography
        state["auto_locked"] = True
        state["auto_prev_points"] = points.copy()
        state["frame_size"] = frame_size
        print(f"Effective-frame calibration ready: {width}x{height}; no ArUco markers required.")

    def _collect_turn_sample(self, result):
        if self.turn_session.active and result.direct_marker_world_position is not None:
            self.turn_session.add(
                result.direct_marker_world_position, result.frame_time
            )
        if self.turn_session.active and self._turn_calibration_direction:
            maintain_turn = getattr(
                self.fish_comm, "maintain_continuous_turn", None
            )
            if callable(maintain_turn):
                maintain_turn(self._turn_calibration_direction)

    def _handle_tablet_commands(self):
        command = self.tablet.get_next_command()
        if command and command.get("cmd") in ("stop", "emergency_stop"):
            status = (
                "EMERGENCY STOP"
                if command.get("cmd") == "emergency_stop" else "STOPPED"
            )
            self._safe_stop(status, force=True)

    def _update_control(self, result):
        decision = self.control.update(
            calibrated=self.runtime.calibration["H"] is not None,
            position=result.control_position,
            frame_time=result.frame_time,
            now=time.monotonic(),
            # YOLO and single-fish positions are real motion observations too;
            # restricting course updates to the optional tail marker made
            # automatic direction correction impossible in normal tracking.
            allow_course_update=result.reference.source in {
                ReferenceSource.MARKER,
                ReferenceSource.YOLO,
                ReferenceSource.RIGID_BODY,
            },
            speed_mps=result.speed or 0.0,
        )
        self.status = decision.status
        self.runtime.drawn_path["active"] = self.control.active
        self.runtime.drawn_path["segment"] = self.control.segment
        if decision.guidance and decision.guidance["heading_source"] in {
            "COURSE", "COURSE_REVERSED"
        }:
            heading = self.runtime.heading
            heading["control_heading"] = tuple(
                float(value) for value in decision.guidance["heading"]
            )
            heading["control_heading_source"] = decision.guidance["heading_source"]
        if decision.stop_required:
            self._safe_stop(decision.status, force=True)
            if decision.message:
                print(decision.message)
        elif decision.pid is not None:
            self.fish_comm.process_tracking_error(**decision.pid)
        return decision

    def _render_and_publish(self, result, decision):
        rates = self.tablet.get_comm_fps()
        mcu_hz = self.fish_comm.get_mcu_hz()
        image = result.frame if self.headless else self.presentation.render(
            result, calibration=self.runtime.calibration,
            marker_roi=self.runtime.marker_roi, heading=self.runtime.heading,
            drawn_path=self.runtime.drawn_path, decision=decision,
            control_active=self.control.active, turn_session=self.turn_session,
            status=self.status, recording=self.is_recording,
            camera_fps=self.cam.measured_fps, loop_fps=self._loop_fps,
            exposure=self.cam.exposure_val, tablet_rates=rates, mcu_hz=mcu_hz,
            clahe_enabled=self.pipeline.use_clahe,
        )
        if not self.headless and self.presentation.overlay_options.get("plannedPath", False):
            self._draw_tablet_trajectory(image)
        telemetry = self.presentation.telemetry(
            result,
            calibration=self.runtime.calibration,
            heading=self.runtime.heading,
            turn_session=self.turn_session,
            turn_results=self.turn_results,
            decision=decision,
            loop_fps=self._loop_fps,
            camera_fps=self.cam.measured_fps,
            exposure=self.cam.exposure_val,
            tablet_rates=rates,
            mcu_hz=mcu_hz,
            clahe_enabled=self.pipeline.use_clahe,
        )
        self.tablet.send(telemetry)
        if self._frame_publisher_thread is None:
            self._publish_frame(image, result.frame_time)
        self._publish_web_metrics(result)
        if self.is_recording and self.recorder is not None:
            current = result.current_position
            row = [
                f"{result.frame_time:.4f}",
                f"{result.pixel[0]:.2f}" if result.pixel else "",
                f"{result.pixel[1]:.2f}" if result.pixel else "",
                f"{current[0]:.4f}" if current else "",
                f"{current[1]:.4f}" if current else "",
            ]
            self.recorder.submit(image, row)
        return image

    def _draw_tablet_trajectory(self, image):
        message = self.tablet.get_latest_trajectory()
        homography = self.runtime.calibration["H"]
        if not message or homography is None:
            return
        points = message.get("points", [])
        if len(points) < 2:
            return
        try:
            inverse = np.linalg.inv(homography)
            world = np.float32([[point for point in points]])
            pixels = cv2.perspectiveTransform(world, inverse)[0]
            pixels = np.asarray(pixels, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(image, [pixels], False, (255, 0, 255), 2, cv2.LINE_AA)
        except (ValueError, np.linalg.LinAlgError, cv2.error):
            return

    def _display(self, image):
        if self.headless:
            return
        now = time.perf_counter()
        if now - self._last_display_t >= 1.0 / DISPLAY_MAX_FPS:
            cv2.imshow(self.WINDOW_NAME, image)
            self._last_display_t = now

    def _queue_input_actions(self):
        if self.headless:
            if self.action_source is None:
                return
            while True:
                web_action = self.action_source()
                if web_action is None:
                    return
                if isinstance(web_action, str):
                    # Lifecycle commands are queued by VisionService directly.
                    # They are already runtime actions and must not be treated
                    # as browser action dictionaries.
                    self.runtime.pending_actions.append(web_action)
                    continue
                if not isinstance(web_action, dict):
                    continue
                if web_action.get("type") == "target.select":
                    self.runtime.pending_actions.append(web_action)
                    continue
                if web_action.get("deviceId") and self.fish_comm is not None:
                    self.fish_comm.set_device_id(web_action.get("deviceId"))
                frame_size = None
                if self.cam is not None:
                    frame_size = (self.cam.real_width, self.cam.real_height)
                runtime_action = translate_web_action(web_action, frame_size)
                if runtime_action is not None:
                    if web_action.get("type") == "camera.exposure":
                        metadata = {
                            "actionId": web_action.get("actionId"),
                            "type": "camera.exposure",
                        }
                        if isinstance(runtime_action, tuple):
                            runtime_action = (
                                runtime_action[0],
                                {**metadata, "value": runtime_action[1]},
                            )
                        else:
                            runtime_action = (runtime_action, metadata)
                    self.runtime.pending_actions.append(runtime_action)
            return
        key = cv2.waitKey(1) & 0xFF
        actions = {
            ord("q"): "EXIT",
            ord(" "): "STOP",
            ord("["): "EXP_DOWN",
            ord("]"): "EXP_UP",
            ord("a"): "RECORD",
            ord("b"): "SNAPSHOT",
            ord("t"): "POOL_CALIB",
            ord("c"): "CLAHE",
            ord("m"): "MARKER_ROI",
        }
        if key in (10, 13):
            self.runtime.pending_actions.append("START")
        elif key in actions:
            self.runtime.pending_actions.append(actions[key])

    def _handle_pending_actions(self, result, rendered_image):
        while self.runtime.pending_actions:
            item = self.runtime.pending_actions.popleft()
            action, payload = item if isinstance(item, tuple) else (item, None)
            if isinstance(action, dict) and action.get("type") == "target.select":
                self._safe_stop("TARGET CHANGED", force=True)
                self.pipeline.set_target_track(action.get("trackId"))
                self._heading_calibration_result = {
                    "status": "idle",
                    "progress": 0.0,
                    "sampleCount": 0,
                    "message": "目标已切换，启动后按实际位移自动修正方向",
                }
                continue
            if action == "EXIT":
                self._safe_stop("EXIT", force=True)
                self._exit_requested = True
                return
            if action in ("STOP", "PATH_EDIT_STARTED"):
                self._safe_stop("STOPPED", force=True)
            elif action == "CLEAR_PATH":
                self._clear_path()
            elif action == "SET_PATH":
                self._safe_stop("PATH EDITED", force=self.control.active)
                self.runtime.drawn_path["pixels"] = list(payload)
                self.runtime.drawn_path["drawing"] = False
                self.runtime.drawn_path["active"] = False
                self.runtime.drawn_path["segment"] = 0
            elif action == "TRACKING_MODE":
                self.tracking_mode = TrackingMode(payload)
                self._safe_stop("TRACKING MODE CHANGED", force=True)
                self.pipeline.reset_motion()
                self.pipeline.set_single_fish_mode(
                    self.tracking_mode == TrackingMode.SINGLE_FISH
                )
                if self.tracking_mode == TrackingMode.SINGLE_FISH:
                    self.pipeline.set_target_track(None)
                self._heading_calibration_result = {
                    "status": "idle",
                    "progress": 0.0,
                    "sampleCount": 0,
                    "message": "模式已切换，启动后按实际位移自动修正方向",
                }
                print(f"Tracking mode changed to {self.tracking_mode.value}.")
            elif action == "START":
                self._start_tracking(result)
            elif action == "TURN_CALIB":
                self._toggle_turn_calibration(result)
            elif action == "MARKER_ROI":
                self._toggle_marker_roi()
            elif action == "APPLY_MARKER_ROI":
                self._apply_marker_roi(payload)
            elif action == "HEAD_DIRECTION":
                self._toggle_head_direction()
            elif action == "AUTO_HEAD_DIRECTION":
                self._start_heading_calibration(result)
            elif action == "APPLY_HEAD_DIRECTION":
                self._apply_head_direction(payload)
            elif action == "POOL_CALIB":
                self._toggle_pool_calibration()
            elif action == "APPLY_POOL_POINT":
                self._apply_pool_point(payload)
            elif action == "RECORD":
                self._toggle_recording()
            elif action == "SNAPSHOT":
                self._save_snapshot(rendered_image)
            elif action == "CLAHE":
                enabled = self.pipeline.toggle_clahe()
                print(f"CLAHE: {'enabled' if enabled else 'disabled'}")
            elif action == "EXP_DOWN":
                self._publish_exposure(self.cam.adjust_exposure(-1), payload)
            elif action == "EXP_UP":
                self._publish_exposure(self.cam.adjust_exposure(1), payload)
            elif action == "SET_EXPOSURE":
                self._publish_exposure(
                    self.cam.set_exposure(payload["value"]),
                    payload,
                )
            elif action == "OVERLAY_OPTIONS":
                self.presentation.set_overlay_options(payload)
            elif action == "PROCESSING_START":
                self.processing_enabled = True
                self.pipeline.reset_motion()
                self.detector.start()
                print("YOLO processing started.")
            elif action == "PROCESSING_STOP":
                self.processing_enabled = False
                self._safe_stop("PROCESSING STOPPED", force=True)
                self.pipeline.reset_motion()
                self.detector.close()
                print("YOLO processing stopped; preview remains available.")

    def _publish_exposure(self, result, metadata):
        if self.action_result_sink is None:
            return
        self.action_result_sink({
            "type": "camera.exposure",
            "actionId": (metadata or {}).get("actionId"),
            "status": result.status,
            "supported": result.supported,
            "requestedDelta": result.requested_delta,
            "requestedValue": result.requested_value,
            "previousValue": result.previous_value,
            "actualValue": result.actual_value,
            "minimum": result.minimum,
            "maximum": result.maximum,
            "step": result.step,
            "errorCode": result.error_code,
        })

    def _exposure_metrics(self):
        return {
            "supported": bool(getattr(self.cam, "exposure_supported", False)),
            "actualValue": getattr(self.cam, "exposure_val", None),
            "minimum": getattr(self.cam, "exposure_min", None),
            "maximum": getattr(self.cam, "exposure_max", None),
            "step": getattr(self.cam, "exposure_step", None),
            "errorCode": getattr(self.cam, "exposure_error_code", None),
        }

    def _publish_web_metrics(self, result):
        if self.action_result_sink is None:
            return
        now = time.monotonic()
        if now - self._last_web_metrics_t < 0.5:
            return
        self._last_web_metrics_t = now
        height, width = result.frame.shape[:2]
        yolo = dict(result.yolo_status)
        yolo["lastInferenceError"] = yolo.pop("last_inference_error", None)
        yolo["loadSeconds"] = yolo.pop("load_seconds", None)
        yolo["inferFps"] = result.yolo_result.get("infer_fps", 0.0)
        yolo["detections"] = result.yolo_result.get("detections", [])
        yolo["detectionCount"] = len(yolo["detections"])
        yolo["targetTrackId"] = result.yolo_result.get("targetTrackId")
        yolo["targetFound"] = result.yolo_result.get("targetFound")
        calibration_ready = self.runtime.calibration["H"] is not None
        path_ready = len(self.runtime.drawn_path["pixels"]) >= 2
        selected_track_id = yolo.get("targetTrackId")
        single_fish_mode = self.tracking_mode == TrackingMode.SINGLE_FISH
        target_detected = bool(result.control_position is not None)
        if selected_track_id is not None and not single_fish_mode:
            target_detected = bool(yolo.get("targetFound"))
        elif selected_track_id is None and not single_fish_mode:
            target_detected = yolo["detectionCount"] == 1
        position_ready = result.control_position is not None
        heading_ready = (
            self.runtime.heading["world_unit_vector"] is not None
            or self.runtime.heading.get("pixel_unit_vector") is not None
        )
        calibrating_heading = self._forward_calibration is not None
        if calibrating_heading:
            sample_count = len(self._forward_calibration["samples"])
            heading_calibration = {
                "status": "running",
                "progress": min(0.95, sample_count / 60.0),
                "sampleCount": sample_count,
                "message": "持续采集运动轨迹，正在评估方向稳定性",
            }
        else:
            heading_calibration = dict(self._heading_calibration_result)
        tracking_active = bool(self.control.active)
        blockers = []
        if not bool(yolo.get("ready")):
            blockers.append("等待 YOLO 就绪")
        if yolo["detectionCount"] == 0:
            blockers.append("未检测到机器鱼")
        elif selected_track_id is not None and not target_detected:
            blockers.append(f"目标 #{selected_track_id} 暂未识别")
        elif not single_fish_mode and selected_track_id is None and yolo["detectionCount"] > 1:
            blockers.append("检测到多条鱼，请锁定单一目标")
        if not calibration_ready:
            blockers.append("场地尚未标定")
        if not path_ready:
            blockers.append("尚未绘制有效轨迹")
        if not position_ready:
            blockers.append("缺少可用于控制的鱼位置")
        if self.turn_session.active:
            blockers.append("转圈测量尚未结束")
        if tracking_active:
            stage = "TRACKING"
        elif calibrating_heading:
            stage = "HEADING_CALIBRATING"
        elif not blockers:
            stage = "READY"
        elif bool(yolo.get("ready")):
            stage = "PREPARING"
        else:
            stage = "INITIALIZING"
        self.action_result_sink({
            "type": "system.metrics",
            "metrics": {
                "frame": {"width": int(width), "height": int(height)},
                "cameraFrame": {
                    "width": int(getattr(self.cam, "source_width", width)),
                    "height": int(getattr(self.cam, "source_height", height)),
                },
                "crop": getattr(self.cam, "crop_region", {"x":0,"y":0,"width":1,"height":1}),
                "rotationAngle": float(getattr(self.cam, "rotation_angle", 0.0)),
                "rotationMs": float(getattr(self.cam, "rotation_ms", 0.0)),
                "frameLatencyMs": max(0.0, (time.time() - result.frame_time) * 1000.0),
                "yolo": yolo,
                "overlays": dict(self.presentation.overlay_options),
                "overlayGeometry": {
                    "plannedPath": [list(point) for point in self.runtime.drawn_path["pixels"]],
                    "trajectory": [list(point) for point in self.runtime.trajectory],
                },
                "cameraFps": self.cam.measured_fps,
                "visionFps": self._loop_fps,
                "exposure": self._exposure_metrics(),
                "workflow": {
                    "stage": stage,
                    "status": self.status,
                    "targetDetected": target_detected,
                    "targetCount": yolo["detectionCount"],
                    "poolCalibrated": calibration_ready,
                    "pathReady": path_ready,
                    "pathPointCount": len(self.runtime.drawn_path["pixels"]),
                    "positionReady": position_ready,
                    "headingCalibrated": heading_ready,
                    "headingSource": self.runtime.heading.get("control_heading_source"),
                    "autoDirectionCorrection": not heading_ready,
                    "courseDirectionMismatch": bool(
                        self.last_decision.guidance
                        and self.last_decision.guidance.get("direction_mismatch")
                    ),
                    "headingCalibrating": calibrating_heading,
                    "headingCalibration": heading_calibration,
                    "trackingMode": self.tracking_mode.value,
                    "canCalibrateHeading": target_detected and not calibrating_heading and not tracking_active,
                    "trackingActive": tracking_active,
                    "canStart": not blockers and not calibrating_heading,
                    "blockers": blockers,
                },
            },
        })

    def _publish_preview_metrics(self, frame, frame_time):
        if self.action_result_sink is None:
            return
        now = time.monotonic()
        if now - self._last_web_metrics_t < 0.5:
            return
        self._last_web_metrics_t = now
        height, width = frame.shape[:2]
        self.action_result_sink({
            "type": "system.metrics",
            "metrics": {
                "frame": {"width": int(width), "height": int(height)},
                "cameraFrame": {
                    "width": int(getattr(self.cam, "source_width", width)),
                    "height": int(getattr(self.cam, "source_height", height)),
                },
                "crop": getattr(self.cam, "crop_region", {"x":0,"y":0,"width":1,"height":1}),
                "rotationAngle": float(getattr(self.cam, "rotation_angle", 0.0)),
                "rotationMs": float(getattr(self.cam, "rotation_ms", 0.0)),
                "frameLatencyMs": max(0.0, (time.time() - frame_time) * 1000.0),
                "yolo": {
                    "enabled": False,
                    "loading": False,
                    "ready": False,
                    "error": None,
                    "lastInferenceError": None,
                    "loadSeconds": None,
                    "inferFps": 0.0,
                    "detections": [],
                    "detectionCount": 0,
                },
                "overlays": dict(self.presentation.overlay_options),
                "overlayGeometry": {
                    "plannedPath": [],
                    "trajectory": [],
                },
                "cameraFps": self.cam.measured_fps,
                "visionFps": self._loop_fps,
                "exposure": self._exposure_metrics(),
                "workflow": {
                    "stage": "PREVIEW",
                    "status": self.status,
                    "targetDetected": False,
                    "targetCount": 0,
                    "trackingActive": False,
                    "trackingMode": self.tracking_mode.value,
                    "canStart": False,
                    "blockers": ["视觉识别未启动"],
                },
            },
        })

    def _safe_stop(self, status, *, force=False):
        was_active = self.control.stop(status) if self.control is not None else False
        self.status = status
        if self.runtime is not None:
            self.runtime.drawn_path["active"] = False
        if self.fish_comm is None:
            return
        reason_changed = self._stop_latched_reason != status
        if (force or was_active) and (reason_changed or was_active):
            self.fish_comm.stop_now()
            self._stop_latched_reason = status

    def _clear_path(self):
        self._safe_stop("PATH CLEARED", force=True)
        state = self.runtime.drawn_path
        state["pixels"].clear()
        state["drawing"] = False
        state["segment"] = 0
        self._clear_motion_trajectory()
        if self.presentation is not None and hasattr(self.presentation, "clear_trajectory"):
            self.presentation.clear_trajectory()
        self.control.stop("PATH CLEARED", clear_path=True)

    def _clear_motion_trajectory(self):
        if self.runtime is not None and hasattr(self.runtime, "trajectory"):
            self.runtime.trajectory.clear()

    def _start_tracking(self, result):
        calibration = self.runtime.calibration
        drawn = self.runtime.drawn_path
        heading = self.runtime.heading
        if self.turn_session.active:
            print("Complete turn calibration first.")
            return
        if calibration["H"] is None:
            print("Cannot start: pool calibration is required.")
            return
        if len(drawn["pixels"]) < 2:
            print("Cannot start: draw a path first.")
            return
        if result.control_position is None:
            print("Cannot start: no reliable tail position.")
            return
        pixels = np.float32([[[x, y] for x, y in drawn["pixels"]]])
        path_world = cv2.perspectiveTransform(pixels, calibration["H"])[0]
        current_position = np.asarray(result.control_position, dtype=np.float64)
        start_distance = float(np.linalg.norm(current_position - path_world[0]))
        if not np.isfinite(start_distance):
            reason = "PATH INVALID: 路径起点或当前鱼位置无效"
            self.control.stop(reason, clear_path=True)
            self.status = reason
            print("Path start distance is not finite.")
            return
        if start_distance > PATH_AUTO_ANCHOR_MAX_M:
            reason = (
                f"PATH INVALID: 起点距离鱼 {start_distance:.2f} m，"
                f"超过安全接入范围 {PATH_AUTO_ANCHOR_MAX_M:.2f} m；"
                "请把路径首点画在鱼附近"
            )
            self.control.stop(reason, clear_path=True)
            self.status = reason
            print(f"Path starts {start_distance:.2f} m from fish; draw closer to the fish.")
            return

        # A hand-drawn line often starts a little away from the detected fish.
        # Connect that short gap to the live position instead of rejecting an
        # otherwise valid route. Long gaps remain an explicit safety error.
        control_path_world = path_world
        if start_distance > PATH_START_TOLERANCE_M:
            control_path_world = np.vstack((current_position, path_world))
            print(
                f"Path auto-anchored to fish position ({start_distance:.2f} m gap)."
            )

        startup_heading = heading["control_heading"] or heading["world_unit_vector"]
        if startup_heading is None:
            # The drawn path itself is a safe initial reference.  Real motion
            # takes over as soon as enough displacement is observed.
            delta = np.asarray(control_path_world[1], dtype=np.float64) - np.asarray(
                control_path_world[0], dtype=np.float64
            )
            length = float(np.linalg.norm(delta))
            startup_heading = delta / length if length > 1e-9 else None
        if startup_heading is None:
            print("Cannot start: path direction is invalid.")
            return
        try:
            initial = self.control.prepare(
                control_path_world, result.control_position,
                result.frame_time, startup_heading,
            )
        except (ValueError, RuntimeError) as error:
            reason = f"PATH INVALID: {error}"
            self.control.stop(reason, clear_path=True)
            self.status = reason
            print(f"Path preparation failed: {error}")
            return
        if not self.fish_comm.ensure_hybrid_mode():
            reason = "CONTROL OFFLINE: 设备控制会话未建立或设备控制权被占用"
            self.control.stop(reason)
            self.status = reason
            print("Fish did not acknowledge vision control readiness.")
            return
        self.fish_comm.vision_seq = 0
        self.control.activate(initial)
        drawn["active"] = True
        self.status = self.control.status
        print(f"Tracking started with {len(self.control.path_guidance.path)} path points.")

    def _start_heading_calibration(self, result):
        if self._forward_calibration is not None:
            print("Forward heading calibration is already running.")
            return
        if result.pixel is None:
            print("Cannot calibrate heading: no single fish is locked.")
            return
        selected_track_id = result.yolo_result.get("targetTrackId")
        single_fish_mode = self.tracking_mode == TrackingMode.SINGLE_FISH
        if selected_track_id is None and len(result.yolo_result.get("detections", [])) != 1:
            if not single_fish_mode:
                print("Cannot calibrate heading: exactly one fish must be detected.")
                return
        if selected_track_id is not None and not single_fish_mode and not result.yolo_result.get("targetFound"):
            print(f"Cannot calibrate heading: target #{selected_track_id} is not visible.")
            return
        if not self.fish_comm.ensure_hybrid_mode():
            message = "设备未确认视觉控制会话，请检查机器鱼在线状态"
            self._heading_calibration_result = {
                "status": "failed",
                "progress": 0.0,
                "sampleCount": 0,
                "message": message,
            }
            print(f"Cannot calibrate heading: {message}")
            return
        start_forward = getattr(self.fish_comm, "start_continuous_forward", None)
        if callable(start_forward):
            started = start_forward()
        else:
            started = self.fish_comm.start_forward_calibration(3200)
        if not started:
            self._safe_stop("CAL_FORWARD_FAILED", force=True)
            self._heading_calibration_result = {"status": "failed", "progress": 0.0, "sampleCount": 0, "message": "设备未确认前进标定指令"}
            return
        self._forward_calibration = {
            "started": time.monotonic(),
            "samples": [(time.monotonic(), np.asarray(result.pixel, dtype=np.float64), np.asarray(result.control_position, dtype=np.float64) if result.control_position is not None else None)],
            "lost_frames": 0,
        }
        self._heading_calibration_result = {"status": "running", "progress": 0.0, "sampleCount": 1, "message": "开始采集运动轨迹"}
        self.status = "CAL_FORWARD"
        print("Automatic forward-heading calibration started from the locked fish.")

    def _update_forward_calibration(self, result):
        state = self._forward_calibration
        if state is None:
            return
        now = time.monotonic()
        detections = result.yolo_result.get("detections", [])
        selected_track_id = result.yolo_result.get("targetTrackId")
        single_fish_mode = self.tracking_mode == TrackingMode.SINGLE_FISH
        target_valid = (
            bool(result.yolo_result.get("targetFound"))
            if selected_track_id is not None
            else len(detections) == 1
        )
        if single_fish_mode:
            target_valid = result.pixel is not None
        if result.pixel is not None and target_valid:
            state["samples"].append((now, np.asarray(result.pixel, dtype=np.float64), np.asarray(result.control_position, dtype=np.float64) if result.control_position is not None else None))
            state["lost_frames"] = 0
        else:
            state["lost_frames"] += 1
        maintain_forward = getattr(self.fish_comm, "maintain_continuous_forward", None)
        if callable(maintain_forward):
            maintain_forward()
        if state["lost_frames"] > 60:
            self._forward_calibration = None
            self._fail_heading_calibration("目标连续丢失，已停止方向标定", len(state["samples"]))
            return
        if now - state["started"] < 3.4:
            return
        samples = state["samples"]
        if len(samples) < 20:
            self._heading_calibration_result = {
                "status": "running",
                "progress": min(0.95, len(samples) / 20.0),
                "sampleCount": len(samples),
                "message": "数据不足，鱼正在连续运动采样",
            }
            return
        points = np.asarray([sample[1] for sample in samples], dtype=np.float64)
        try:
            estimate = estimate_motion_heading(points)
        except ValueError:
            self._heading_calibration_result = {
                "status": "running",
                "progress": min(0.95, len(samples) / 60.0),
                "sampleCount": len(samples),
                "message": "方向数据暂不稳定，鱼正在连续运动采样",
            }
            return
        pixel_unit = estimate["unit"]
        pixel_distance = estimate["distance"]
        consistency = estimate["consistency"]
        linearity = estimate["linearity"]
        heading = self.runtime.heading
        heading.update({
            "pixel_unit_vector": tuple(float(v) for v in pixel_unit),
            "angle_deg": float((np.degrees(np.arctan2(-pixel_unit[1], pixel_unit[0])) + 360.0) % 360.0),
            "selecting": False,
        })
        world_samples = [sample[2] for sample in samples if sample[2] is not None]
        if len(world_samples) >= 6:
            world_edge = max(2, len(world_samples) // 6)
            world_displacement = np.mean(world_samples[-world_edge:], axis=0) - np.mean(world_samples[:world_edge], axis=0)
            world_distance = float(np.linalg.norm(world_displacement))
            if world_distance >= 0.015:
                world_unit = world_displacement / world_distance
                heading.update({
                    "world_unit_vector": tuple(float(v) for v in world_unit),
                    "control_heading": tuple(float(v) for v in world_unit),
                    "control_heading_source": "MOTION",
        })
        self.fish_comm.stop_now()
        self._forward_calibration = None
        self.status = "HEADING_READY"
        self._heading_calibration_result = {"status": "completed", "progress": 1.0, "sampleCount": len(samples), "message": f"方向确认完成：{heading['angle_deg']:.1f}°，位移 {pixel_distance:.1f}px，一致性 {consistency:.2f}", "angleDeg": heading["angle_deg"], "distancePx": pixel_distance, "consistency": consistency, "linearity": linearity}
        print(f"Automatic forward heading ready: {heading['angle_deg']:.1f} deg, samples={len(samples)}, travel={pixel_distance:.1f} px, consistency={consistency:.2f}, linearity={linearity:.2f}")

    def _fail_heading_calibration(self, message, sample_count):
        self._safe_stop("CAL_FORWARD_FAILED", force=True)
        self._heading_calibration_result = {"status": "failed", "progress": 1.0, "sampleCount": sample_count, "message": message}
        print(f"Automatic heading failed: {message}")

    def _promote_pixel_heading(self, homography, pixel):
        heading = self.runtime.heading
        if heading["world_unit_vector"] is not None or heading.get("pixel_unit_vector") is None:
            return
        if homography is None or pixel is None:
            return
        origin = np.asarray(pixel, dtype=np.float32)
        tip = origin + np.asarray(heading["pixel_unit_vector"], dtype=np.float32) * 30.0
        world = cv2.perspectiveTransform(np.float32([[origin, tip]]), homography)[0]
        delta = np.asarray(world[1] - world[0], dtype=np.float64)
        length = float(np.linalg.norm(delta))
        if length <= 1e-6:
            return
        unit = delta / length
        heading.update({
            "world_unit_vector": tuple(float(v) for v in unit),
            "control_heading": tuple(float(v) for v in unit),
            "control_heading_source": "MOTION",
        })

    def _toggle_turn_calibration(self, result):
        if self.turn_session.active:
            self.fish_comm.stop_now()
            try:
                fit = self.turn_session.finish()
                save_turn_calibration(TURN_CALIBRATION_PATH, fit)
            except (TurnCalibrationError, OSError) as error:
                self.status = "READY"
                print(f"Turn calibration was not saved: {error}")
                return
            self.turn_results[fit.direction] = fit
            self.control.path_guidance.set_turn_radius(
                fit.direction, fit.radius_m
            )
            self._turn_calibration_direction = None
            self.status = "TURN CALIBRATED"
            print(f"{fit.direction} turn radius saved: {fit.radius_m:.3f} m")
            return
        if self.runtime.calibration["H"] is None:
            print("Cannot measure: pool calibration is required.")
            return
        if result.direct_marker_world_position is None:
            print("Cannot measure: tail marker must be locked directly.")
            return
        direction = (
            "right"
            if "LEFT" in self.turn_results and "RIGHT" not in self.turn_results
            else "left"
        )
        if not self.fish_comm.ensure_hybrid_mode():
            self.status = "READY"
            print("Cannot measure: fish did not acknowledge calibration control.")
            return
        start_turn = getattr(self.fish_comm, "start_continuous_turn", None)
        if not callable(start_turn) or not start_turn(direction):
            self.fish_comm.stop_now()
            self.status = "READY"
            print(f"Cannot measure: failed to start {direction} turn.")
            return
        self._safe_stop("TURN CALIBRATING", force=self.control.active)
        self._cancel_selection_modes()
        self.turn_session.start(
            result.direct_marker_world_position, result.frame_time
        )
        self._turn_calibration_direction = direction
        self.status = "TURN CALIBRATING"
        print(
            f"Turn calibration started with {direction} turn; "
            "click again to stop and fit the circle."
        )

    def _toggle_marker_roi(self):
        self._safe_stop("SELECT MARKER ROI", force=self.control.active)
        self.turn_session.cancel()
        self.runtime.calibration["is_calibrating"] = False
        self.runtime.heading["selecting"] = False
        state = self.runtime.marker_roi
        state["selecting"] = not state["selecting"]
        state["dragging"] = False
        state["start"] = None
        state["end"] = None
        self.status = "SELECT MARKER ROI" if state["selecting"] else "READY"

    def _apply_marker_roi(self, roi):
        state = self.runtime.marker_roi
        try:
            profile = self.reference_tracker.calibrate_from_roi(
                self.runtime.frame["latest"], roi, save=True
            )
            found = self.reference_tracker.last_calibration
        except Exception as error:
            state["selecting"] = True
            state["dragging"] = False
            state["start"] = state["end"] = None
            self.status = "MARKER ROI RETRY"
            print(f"Tail marker calibration failed: {error}")
            return
        state["selecting"] = False
        state["dragging"] = False
        state["start"] = state["end"] = None
        state["confirmed_bbox"] = found["marker_bbox"]
        state["confirmed_center"] = found["marker_center"]
        state["confirmed_until"] = time.time() + 3.0
        self.status = "MARKER READY"
        print(f"Tail marker profile saved: H={profile.hue_center:.1f}+/-{profile.hue_tolerance:.1f}")

    def _toggle_head_direction(self):
        self._safe_stop("SELECT HEAD DIRECTION", force=self.control.active)
        self.turn_session.cancel()
        self.runtime.calibration["is_calibrating"] = False
        self.runtime.marker_roi["selecting"] = False
        state = self.runtime.heading
        state["selecting"] = not state["selecting"]
        self.status = "SELECT HEAD DIRECTION" if state["selecting"] else "READY"

    def _apply_head_direction(self, head_point):
        state = self.runtime.heading
        tail_point = self.runtime.frame["tail_marker_position"]
        homography = self.runtime.calibration["H"]
        if homography is None or tail_point is None:
            print("Valid pool calibration and tail center are required.")
            return
        head = tuple(float(value) for value in head_point)
        tail = tuple(float(value) for value in tail_point)
        delta = np.asarray(head) - np.asarray(tail)
        length = float(np.linalg.norm(delta))
        if length < 15.0:
            print("Heading point is too close to the tail; select it again.")
            return
        world = cv2.perspectiveTransform(
            np.float32([[tail, head]]), homography
        )[0]
        world_delta = world[1] - world[0]
        world_length = float(np.linalg.norm(world_delta))
        if world_length <= 1e-6:
            print("Heading mapping failed.")
            return
        unit = world_delta / world_length
        state.update({
            "tail_point": tail,
            "head_point": head,
            "unit_vector": tuple(float(v) for v in delta / length),
            "world_unit_vector": tuple(float(v) for v in unit),
            "control_heading": tuple(float(v) for v in unit),
            "control_heading_source": "CALIBRATED",
            "angle_deg": float(
                (np.degrees(np.arctan2(-unit[1], unit[0])) + 360.0) % 360.0
            ),
            "confirmed_until": time.time() + 5.0,
            "selecting": False,
        })
        self.status = "HEAD DIRECTION READY"

    def _toggle_pool_calibration(self):
        self._safe_stop("CALIBRATING", force=self.control.active)
        self.turn_session.cancel()
        state = self.runtime.calibration
        state["is_calibrating"] = not state["is_calibrating"]
        self.runtime.marker_roi["selecting"] = False
        self.runtime.heading["selecting"] = False
        state["pts_raw"].clear()
        state["pts_disp"].clear()
        if state["is_calibrating"]:
            self._clear_path()
            state.update({
                "H": None,
                "manual_locked": False,
                "auto_locked": False,
                "auto_stable_count": 0,
                "auto_prev_points": None,
                "frame_size": None,
            })
            self.pipeline.reset_motion()
            self._reset_heading()
            self.status = "CALIBRATING"
            print("Select corners in order: top-left, top-right, bottom-right, bottom-left.")
        else:
            self.status = "UNCALIBRATED"

    def _apply_pool_point(self, point):
        state = self.runtime.calibration
        if not state["is_calibrating"]:
            return
        state["pts_raw"].append([int(point[0]), int(point[1])])
        if len(state["pts_raw"]) < 4:
            return
        frame = self.runtime.frame.get("latest")
        frame_height, frame_width = (
            frame.shape[:2] if frame is not None
            else (self.cam.real_height, self.cam.real_width)
        )
        homography, error = build_calibration_homography(
            state["pts_raw"], frame_width, frame_height
        )
        if error:
            print(f"Manual calibration failed: {error}")
            state["pts_raw"].clear()
            return
        state["H"] = homography
        state["manual_locked"] = True
        state["frame_size"] = (int(frame_width), int(frame_height))
        state["is_calibrating"] = False
        print("Manual pool calibration completed.")

    def _cancel_selection_modes(self):
        self.runtime.calibration["is_calibrating"] = False
        self.runtime.marker_roi["selecting"] = False
        self.runtime.heading["selecting"] = False

    def _reset_heading(self):
        state = self.runtime.heading
        for key in (
            "tail_point", "head_point", "unit_vector", "world_unit_vector",
            "control_heading", "control_heading_source", "angle_deg",
        ):
            state[key] = None

    def _toggle_recording(self):
        if self.is_recording:
            self.recorder.close()
            self.recorder = None
            self.is_recording = False
            print("Recording saved.")
            return
        stamp = time.strftime("%Y%m%d_%H%M%S")
        fps = max(1.0, round(self.cam.measured_fps, 1))
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        self.recorder = AsyncVideoRecorder(
            path=os.path.join(OUTPUT_DIR, f"auv_record_{stamp}.mp4"),
            fourcc=cv2.VideoWriter_fourcc(*"mp4v"),
            fps=fps,
            frame_size=(self.cam.real_width, self.cam.real_height),
            csv_path=os.path.join(OUTPUT_DIR, f"auv_data_{stamp}.csv"),
        )
        self.is_recording = True
        print(f"Recording started at {fps} FPS")

    @staticmethod
    def _save_snapshot(image):
        milliseconds = int((time.time() * 1000) % 1000)
        name = f"auv_frame_{time.strftime('%Y%m%d_%H%M%S')}_{milliseconds:03d}.jpg"
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        path = os.path.join(OUTPUT_DIR, name)
        cv2.imwrite(path, image)
        print(f"Snapshot saved: {path}")

    def _close(self):
        print("\nStopping propulsion and releasing vision resources...")
        self._exit_requested = True
        publisher = self._frame_publisher_thread
        if publisher is not None and publisher.is_alive():
            publisher.join(timeout=1.0)
        if self.fish_comm is not None:
            self.fish_comm.close()
        if self.tablet is not None:
            self.tablet.close()
        if self.mjpeg is not None:
            self.mjpeg.close()
        if self.frame_sink is not None:
            close_session = getattr(self.frame_sink, "close_session", None)
            if close_session is not None:
                close_session()
        if self.detector is not None:
            self.detector.close()
        if self.cam is not None:
            self.cam.release()
        if self.recorder is not None:
            self.recorder.close()
        if not self.headless:
            cv2.destroyAllWindows()
        print("Vision application exited safely.")


def main():
    return VisionApplication(camera_index=1).run()


if __name__ == "__main__":
    raise SystemExit(main())
