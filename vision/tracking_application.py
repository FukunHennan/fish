"""Web tracking application with field calibration optional.

The legacy VisionApplication still owns camera, perception, recording and
metric field-calibration features.  This subclass changes only the tracking
coordinate policy: a full-frame control mapping is always available, while a
real pool homography automatically overrides it when present.
"""

from __future__ import annotations

import time

import numpy as np

from control_coordinates import ControlCoordinateMapper
from main import VisionApplication
from navigation import VelocityEstimator
from perception import ReferenceSource


class TrackingVisionApplication(VisionApplication):
    """Run path tracking in image-derived coordinates when no field map exists."""

    def _start(self):
        if not super()._start():
            return False
        self.control_mapper = ControlCoordinateMapper(
            self.cam.real_width, self.cam.real_height
        )
        self.control_velocity = VelocityEstimator(
            history_seconds=0.40,
            min_span_seconds=0.12,
            blend=0.45,
            max_speed_mps=0.80,
        )
        return True

    def _field_homography(self):
        return self.runtime.calibration["H"]

    def _control_mapping(self):
        return self.control_mapper.resolve(self._field_homography())

    def _control_position(self, result):
        if result.pixel is None:
            return None
        return self.control_mapper.map_point(
            result.pixel, self._field_homography()
        )

    def _control_heading(self, pixel):
        heading = self.runtime.heading
        pixel_unit = heading.get("pixel_unit_vector")
        if pixel is None or pixel_unit is None:
            return None
        return self.control_mapper.map_heading(
            pixel, pixel_unit, self._field_homography()
        )

    def _promote_pixel_heading(self, homography, pixel):
        del homography
        heading = self.runtime.heading
        if heading.get("pixel_unit_vector") is None or pixel is None:
            return
        unit = self._control_heading(pixel)
        if unit is None:
            return
        heading.update({
            "world_unit_vector": unit,
            "control_heading": unit,
            "control_heading_source": self._control_mapping().mode,
        })

    def _update_control(self, result):
        position = self._control_position(result)
        speed = 0.0
        if position is not None:
            estimate = self.control_velocity.update(position, result.frame_time)
            if estimate is not None:
                speed = float(np.linalg.norm(estimate))
        else:
            self.control_velocity.reset()

        decision = self.control.update(
            calibrated=True,
            position=position,
            frame_time=result.frame_time,
            now=time.monotonic(),
            allow_course_update=result.reference.source == ReferenceSource.MARKER,
            speed_mps=speed,
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

    def _start_tracking(self, result):
        drawn = self.runtime.drawn_path
        heading = self.runtime.heading
        if self.turn_session.active:
            print("Complete turn calibration first.")
            return
        if len(drawn["pixels"]) < 2:
            print("Cannot start: draw a path first.")
            return
        position = self._control_position(result)
        if position is None:
            print("Cannot start: no reliable fish position.")
            return

        self._promote_pixel_heading(self._field_homography(), result.pixel)
        startup_heading = heading.get("control_heading") or heading.get("world_unit_vector")
        if startup_heading is None:
            print("Cannot start: run direction calibration first.")
            return

        path_control = self.control_mapper.map_points(
            drawn["pixels"], self._field_homography()
        )
        try:
            initial = self.control.prepare(
                path_control, position, result.frame_time, startup_heading
            )
        except (ValueError, RuntimeError) as error:
            self.control.stop("PATH INVALID", clear_path=True)
            print(f"Path preparation failed: {error}")
            return

        start_distance = float(np.linalg.norm(
            np.asarray(position) - self.control.path_guidance.path[0]
        ))
        if start_distance > 0.40:
            self.control.stop("PATH INVALID", clear_path=True)
            print(
                f"Path starts {start_distance:.2f} control units from fish; "
                "draw closer to the fish."
            )
            return
        if not self.fish_comm.ensure_hybrid_mode():
            self.control.stop("CONTROL OFFLINE")
            print("Fish did not acknowledge vision control readiness.")
            return
        self.fish_comm.vision_seq = 0
        self.control.activate(initial)
        drawn["active"] = True
        self.status = self.control.status
        print(
            f"Tracking started in {self._control_mapping().mode} coordinates "
            f"with {len(self.control.path_guidance.path)} path points."
        )

    def _publish_web_metrics(self, result):
        sink = self.action_result_sink
        if sink is None:
            return
        captured = []
        self.action_result_sink = captured.append
        try:
            super()._publish_web_metrics(result)
        finally:
            self.action_result_sink = sink
        if not captured:
            return

        payload = captured[-1]
        workflow = payload.get("metrics", {}).get("workflow", {})
        blockers = [
            value for value in workflow.get("blockers", [])
            if value not in ("场地尚未标定", "缺少可用于控制的鱼位置")
        ]
        position_ready = result.pixel is not None
        if not position_ready:
            blockers.append("缺少可用于控制的鱼位置")
        workflow.update({
            "positionReady": position_ready,
            "fieldCalibrated": self._field_homography() is not None,
            "controlCoordinateMode": self._control_mapping().mode,
            "canStart": not blockers and not workflow.get("headingCalibrating", False),
            "blockers": blockers,
        })
        if workflow.get("trackingActive"):
            workflow["stage"] = "TRACKING"
        elif workflow.get("headingCalibrating"):
            workflow["stage"] = "HEADING_CALIBRATING"
        elif workflow.get("headingCalibrated") and not blockers:
            workflow["stage"] = "READY"
        sink(payload)
