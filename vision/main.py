"""RoboFish vision scheduler and application entry point.

All cross-feature wiring lives here.  Perception, path control, presentation,
camera/network adapters, and persistence remain independently testable.
"""

from __future__ import annotations

import os
import time
import traceback

import cv2
import numpy as np

from config import (
    CAMERA_STALE_TIMEOUT_S,
    DISPLAY_MAX_FPS,
    MARKER_BL,
    MARKER_BR,
    MARKER_PROFILE_PATH,
    MARKER_TL,
    MARKER_TR,
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
from ui import (
    VisionHud,
    VisionMouseController,
    VisionPresentation,
    VisionToolbar,
    create_runtime_state,
)
from web_actions import translate_web_action


class VisionApplication:
    """Own service lifecycle and coordinate data-only feature snapshots."""

    WINDOW_NAME = "AUV YOLO Tracker (RoboFish PID)"

    def __init__(self, camera_index=1, headless=False, action_source=None, action_result_sink=None):
        self.camera_index = camera_index
        self.headless = headless
        self.action_source = action_source
        self.action_result_sink = action_result_sink
        self.cam = None
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

    def run(self):
        os.chdir(WORK_DIR)
        self._print_startup()
        try:
            if not self._start():
                return 1
            self._loop()
            return 0
        except Exception as error:
            print(f"Unhandled runtime error: {error}")
            traceback.print_exc()
            self._safe_stop("FAULT", force=True)
            return 1
        finally:
            self._close()

    def request_exit(self):
        self._exit_requested = True

    def _print_startup(self):
        print("\n" + "=" * 60)
        print("Starting YOLO RoboFish tracking and vision control...")
        print(f"Working directory: {WORK_DIR}")
        print(f"Capture target: {TARGET_WIDTH}x{TARGET_HEIGHT} @ {TARGET_FPS} FPS")
        print(f"Camera stale timeout: {CAMERA_STALE_TIMEOUT_S * 1000:.0f} ms")
        print(f"Tablet TCP: {TABLET_TCP_HOST}:{TABLET_TCP_PORT}")
        print("Fish control: routed through the local Go controller")
        print("=" * 60 + "\n")

    def _start(self):
        self.cam = CameraStream(src=self.camera_index).start()
        if not self.cam.ret:
            print("Unable to open camera; check USB connection and camera index.")
            return False

        self.tablet = TabletTCPServer(
            host=TABLET_TCP_HOST, port=TABLET_TCP_PORT
        )
        self.mjpeg = MJPEGServer()
        self.mjpeg.start()
        self.fish_comm = RoboFishComm()
        self.detector = FishDetector(
            model_path=YOLO_MODEL_PATH,
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
        self.detector.start()
        print("Vision service started.")
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
            if snapshot["age_s"] > CAMERA_STALE_TIMEOUT_S:
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

            result = self.pipeline.process(
                snapshot["frame"],
                snapshot["timestamp"],
                self.runtime.calibration["H"],
            )
            self.last_result = result
            self.runtime.frame["latest"] = result.frame.copy()
            self.runtime.frame["reference_position"] = result.pixel
            self.runtime.frame["reference_source"] = result.reference.source
            self.runtime.frame["tail_marker_position"] = (
                result.reference.metrics.get("tail_marker_position")
            )
            self._update_loop_fps()
            self._update_auto_calibration(result)
            self._collect_turn_sample(result)
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

    def _update_auto_calibration(self, result):
        state = self.runtime.calibration
        corners = result.corner_pixels
        if len(corners) == 4 and not state["manual_locked"] and not state["auto_locked"]:
            points = np.float32([
                corners[MARKER_TL], corners[MARKER_TR],
                corners[MARKER_BR], corners[MARKER_BL],
            ])
            previous = state["auto_prev_points"]
            if previous is not None and float(
                np.max(np.linalg.norm(points - previous, axis=1))
            ) <= 2.0:
                state["auto_stable_count"] += 1
            else:
                state["auto_stable_count"] = 1
            state["auto_prev_points"] = points.copy()
            if state["auto_stable_count"] >= 15:
                homography, error = build_calibration_homography(
                    points, self.cam.real_width, self.cam.real_height
                )
                if error:
                    state["auto_stable_count"] = 0
                    print(f"Automatic calibration not locked: {error}")
                else:
                    state["H"] = homography
                    state["auto_locked"] = True
                    print("Automatic calibration locked from four stable ArUco corners.")
        elif len(corners) < 4:
            state["auto_stable_count"] = 0
            state["auto_prev_points"] = None

    def _collect_turn_sample(self, result):
        if self.turn_session.active and result.direct_marker_world_position is not None:
            self.turn_session.add(
                result.direct_marker_world_position, result.frame_time
            )

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
            allow_course_update=result.reference.source == ReferenceSource.MARKER,
            speed_mps=result.speed or 0.0,
        )
        self.status = decision.status
        self.runtime.drawn_path["active"] = self.control.active
        self.runtime.drawn_path["segment"] = self.control.segment
        if decision.guidance and decision.guidance["heading_source"] == "COURSE":
            heading = self.runtime.heading
            heading["control_heading"] = tuple(
                float(value) for value in decision.guidance["heading"]
            )
            heading["control_heading_source"] = "COURSE"
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
        image = self.presentation.render(
            result,
            calibration=self.runtime.calibration,
            marker_roi=self.runtime.marker_roi,
            heading=self.runtime.heading,
            drawn_path=self.runtime.drawn_path,
            decision=decision,
            control_active=self.control.active,
            turn_session=self.turn_session,
            status=self.status,
            recording=self.is_recording,
            camera_fps=self.cam.measured_fps,
            loop_fps=self._loop_fps,
            exposure=self.cam.exposure_val,
            tablet_rates=rates,
            mcu_hz=mcu_hz,
            clahe_enabled=self.pipeline.use_clahe,
        )
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
        self.mjpeg.update(image)
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
                frame_size = None
                if self.cam is not None:
                    frame_size = (self.cam.real_width, self.cam.real_height)
                runtime_action = translate_web_action(web_action, frame_size)
                if runtime_action is not None:
                    if web_action.get("type") == "camera.exposure":
                        runtime_action = (runtime_action, {
                            "actionId": web_action.get("actionId"),
                            "type": "camera.exposure",
                        })
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

    def _publish_exposure(self, result, metadata):
        if self.action_result_sink is None:
            return
        self.action_result_sink({
            "type": "camera.exposure",
            "actionId": (metadata or {}).get("actionId"),
            "status": result.status,
            "supported": result.supported,
            "requestedDelta": result.requested_delta,
            "previousValue": result.previous_value,
            "actualValue": result.actual_value,
            "errorCode": result.error_code,
        })

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
        self.action_result_sink({
            "type": "system.metrics",
            "metrics": {
                "frame": {"width": int(width), "height": int(height)},
                "yolo": yolo,
                "cameraFps": self.cam.measured_fps,
                "visionFps": self._loop_fps,
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
        self.control.stop("PATH CLEARED", clear_path=True)

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
        if heading["world_unit_vector"] is None:
            print("Cannot start: heading calibration is required.")
            return
        pixels = np.float32([[[x, y] for x, y in drawn["pixels"]]])
        path_world = cv2.perspectiveTransform(pixels, calibration["H"])[0]
        startup_heading = (
            heading["control_heading"] or heading["world_unit_vector"]
        )
        try:
            initial = self.control.prepare(
                path_world, result.control_position,
                result.frame_time, startup_heading,
            )
        except (ValueError, RuntimeError) as error:
            self.control.stop("PATH INVALID", clear_path=True)
            print(f"Path preparation failed: {error}")
            return
        start_distance = float(np.linalg.norm(
            np.asarray(result.control_position) - self.control.path_guidance.path[0]
        ))
        if start_distance > 0.40:
            self.control.stop("PATH INVALID", clear_path=True)
            print(f"Path starts {start_distance:.2f} m from fish; draw closer to the fish.")
            return
        if not self.fish_comm.ensure_hybrid_mode():
            self.control.stop("CONTROL OFFLINE")
            print("Fish did not acknowledge vision control readiness.")
            return
        self.fish_comm.vision_seq = 0
        self.control.activate(initial)
        drawn["active"] = True
        self.status = self.control.status
        print(f"Tracking started with {len(self.control.path_guidance.path)} path points.")

    def _toggle_turn_calibration(self, result):
        if self.turn_session.active:
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
            self.status = "TURN CALIBRATED"
            print(f"{fit.direction} turn radius saved: {fit.radius_m:.3f} m")
            return
        if self.runtime.calibration["H"] is None:
            print("Cannot measure: pool calibration is required.")
            return
        if result.direct_marker_world_position is None:
            print("Cannot measure: tail marker must be locked directly.")
            return
        self._safe_stop("TURN CALIBRATING", force=self.control.active)
        self._cancel_selection_modes()
        self.turn_session.start(
            result.direct_marker_world_position, result.frame_time
        )
        self.status = "TURN CALIBRATING"
        print("Turn calibration started; click again to fit the circle.")

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
        homography, error = build_calibration_homography(
            state["pts_raw"], self.cam.real_width, self.cam.real_height
        )
        if error:
            print(f"Manual calibration failed: {error}")
            state["pts_raw"].clear()
            return
        state["H"] = homography
        state["manual_locked"] = True
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
        if self.fish_comm is not None:
            self.fish_comm.close()
        if self.tablet is not None:
            self.tablet.close()
        if self.mjpeg is not None:
            self.mjpeg.close()
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
