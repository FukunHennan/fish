"""Metric motion estimation, path guidance, and turn calibration."""

from __future__ import annotations

from collections import deque
import math

import numpy as np


def _unit(vector):
    value = np.asarray(vector, dtype=np.float64).reshape(2)
    length = float(np.linalg.norm(value))
    if not np.isfinite(value).all() or length <= 1e-9:
        raise ValueError("方向向量无效")
    return value / length


def compensate_camera_latency(
    position, velocity, latency_s, max_prediction_m=0.12
):
    """按速度向前预测相机延迟，并限制最大补偿距离。"""
    current = np.asarray(position, dtype=np.float64).reshape(2)
    motion = np.asarray(velocity, dtype=np.float64).reshape(2)
    if not np.isfinite(current).all() or not np.isfinite(motion).all():
        raise ValueError("位置或速度无效")
    offset = motion * max(0.0, float(latency_s))
    offset_length = float(np.linalg.norm(offset))
    limit = max(0.0, float(max_prediction_m))
    if offset_length > limit and offset_length > 1e-9:
        offset *= limit / offset_length
    return current + offset


def resample_polyline(points, spacing_m=0.03):
    """按累计弧长等距重采样折线，保留首尾点并移除重复点。"""
    path = np.asarray(points, dtype=np.float64).reshape((-1, 2))
    if len(path) < 2 or not np.isfinite(path).all():
        raise ValueError("轨迹至少需要两个有限坐标点")
    spacing_m = float(spacing_m)
    if spacing_m <= 0.0:
        raise ValueError("轨迹采样间距必须大于零")

    kept = [path[0]]
    for point in path[1:]:
        if float(np.linalg.norm(point - kept[-1])) > 1e-6:
            kept.append(point)
    path = np.asarray(kept, dtype=np.float64)
    if len(path) < 2:
        raise ValueError("轨迹有效长度为零")

    lengths = np.linalg.norm(np.diff(path, axis=0), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
    total = float(cumulative[-1])
    samples = np.arange(0.0, total, spacing_m, dtype=np.float64)
    if len(samples) == 0 or total - float(samples[-1]) > 1e-9:
        samples = np.append(samples, total)
    else:
        samples[-1] = total

    output = np.empty((len(samples), 2), dtype=np.float64)
    segment = 0
    for index, distance in enumerate(samples):
        while segment + 1 < len(cumulative) - 1 and distance > cumulative[segment + 1]:
            segment += 1
        segment_length = lengths[segment]
        ratio = 0.0 if segment_length <= 1e-9 else (
            distance - cumulative[segment]
        ) / segment_length
        output[index] = path[segment] + ratio * (path[segment + 1] - path[segment])
    return output


class VelocityEstimator:
    """用短窗口直线拟合估计平移速度，抑制鱼尾逐帧摆动和单帧尖峰。"""

    def __init__(
        self,
        history_seconds=0.40,
        min_span_seconds=0.12,
        min_samples=3,
        blend=0.45,
        max_speed_mps=0.80,
    ):
        self.history_seconds = float(history_seconds)
        self.min_span_seconds = float(min_span_seconds)
        self.min_samples = int(min_samples)
        self.blend = float(np.clip(blend, 0.0, 1.0))
        self.max_speed_mps = float(max_speed_mps)
        self.reset()

    def reset(self, position=None, timestamp=None):
        self._history = deque()
        self.velocity = None
        if position is not None and timestamp is not None:
            self._history.append(
                (float(timestamp), np.asarray(position, dtype=np.float64).reshape(2))
            )

    def update(self, position, timestamp):
        now = float(timestamp)
        current = np.asarray(position, dtype=np.float64).reshape(2)
        if not np.isfinite(current).all() or not math.isfinite(now):
            return None if self.velocity is None else self.velocity.copy()

        if self._history and now <= self._history[-1][0]:
            return None if self.velocity is None else self.velocity.copy()
        self._history.append((now, current.copy()))
        while self._history and now - self._history[0][0] > self.history_seconds:
            self._history.popleft()
        if len(self._history) < self.min_samples:
            return None if self.velocity is None else self.velocity.copy()

        times = np.asarray([sample[0] for sample in self._history], dtype=np.float64)
        positions = np.asarray([sample[1] for sample in self._history], dtype=np.float64)
        span = float(times[-1] - times[0])
        if span < self.min_span_seconds:
            return None if self.velocity is None else self.velocity.copy()

        centred_t = times - float(np.mean(times))
        denominator = float(np.dot(centred_t, centred_t))
        if denominator <= 1e-9:
            return None if self.velocity is None else self.velocity.copy()
        raw_velocity = np.sum(
            centred_t[:, None] * positions, axis=0
        ) / denominator
        raw_speed = float(np.linalg.norm(raw_velocity))
        if not np.isfinite(raw_velocity).all():
            return None if self.velocity is None else self.velocity.copy()

        # 超过机器鱼物理可能范围的结果来自色块跳变；不让它污染制动判断。
        if raw_speed > self.max_speed_mps:
            if self.velocity is not None:
                return self.velocity.copy()
            raw_velocity *= self.max_speed_mps / max(raw_speed, 1e-9)

        if self.velocity is None:
            self.velocity = raw_velocity
        else:
            self.velocity = (
                self.blend * raw_velocity + (1.0 - self.blend) * self.velocity
            )
        return self.velocity.copy()


class HeadingEstimator:
    """以人工初始方向启动，运动稳定后用一段位移平滑更新航向。"""

    def __init__(
        self,
        history_seconds=0.60,
        min_span_seconds=0.25,
        min_displacement_m=0.020,
        min_speed_mps=0.08,
        blend=0.20,
    ):
        self.history_seconds = float(history_seconds)
        self.min_span_seconds = float(min_span_seconds)
        self.min_displacement_m = float(min_displacement_m)
        self.min_speed_mps = float(min_speed_mps)
        self.blend = float(blend)
        self.velocity_estimator = VelocityEstimator(
            history_seconds=history_seconds,
            min_span_seconds=min_span_seconds,
            blend=0.30,
        )
        self.heading = None
        self.source = "INVALID"

    def reset(self, initial_heading, position=None, timestamp=None):
        self.heading = _unit(initial_heading)
        self.source = "INITIAL"
        self._last_sample_time = (
            float(timestamp) if timestamp is not None else None
        )
        self.velocity_estimator.reset(position, timestamp)
        return self.heading.copy()

    def update(self, position, timestamp, allow_course_update=True):
        if self.heading is None:
            raise RuntimeError("必须先设置人工初始航向")
        if not allow_course_update:
            return self.heading.copy(), self.source

        now = float(timestamp)
        current = np.asarray(position, dtype=np.float64).reshape(2)
        if not np.isfinite(current).all() or not math.isfinite(now):
            return self.heading.copy(), self.source
        if self._last_sample_time is not None and now <= self._last_sample_time:
            return self.heading.copy(), self.source
        self._last_sample_time = now
        velocity = self.velocity_estimator.update(current, now)
        if velocity is None:
            return self.heading.copy(), self.source
        speed = float(np.linalg.norm(velocity))
        if speed < self.min_speed_mps:
            return self.heading.copy(), self.source

        course = velocity / speed
        # 精确 180° 更像色块跳变；正常急转会经过中间方向，允许快速跟随。
        if float(np.dot(course, self.heading)) <= -0.95:
            return self.heading.copy(), self.source
        blended = (1.0 - self.blend) * self.heading + self.blend * course
        self.heading = _unit(blended)
        self.source = "COURSE"
        return self.heading.copy(), self.source


class PathGuidance:
    """等距路径、单向进度和曲率前馈循迹的统一 owner。"""

    def __init__(
        self,
        spacing_m=0.03,
        lookahead_m=0.24,
        min_lookahead_m=0.10,
        full_attraction_error_m=0.18,
        curve_preview_m=0.32,
        estimated_min_turn_radius_m=0.20,
        left_turn_radius_m=None,
        right_turn_radius_m=None,
        max_x_error_m=(1.0 / 3.0),
        arrival_radius_m=0.20,
        brake_radius_m=0.40,
        search_ahead_m=0.45,
    ):
        self.spacing_m = float(spacing_m)
        self.lookahead_m = float(lookahead_m)
        self.min_lookahead_m = min(
            self.lookahead_m, float(min_lookahead_m)
        )
        self.full_attraction_error_m = max(
            1e-6, float(full_attraction_error_m)
        )
        self.curve_preview_m = max(self.spacing_m, float(curve_preview_m))
        # 网页 HYBRID 满转实测直径约 0.40 m。它只作为第一版曲率映射
        # 的可替换参考，不伪装成精确水动力标定值。
        self.estimated_min_turn_radius_m = max(
            0.01, float(estimated_min_turn_radius_m)
        )
        self.max_path_curvature_per_m = (
            1.0 / self.estimated_min_turn_radius_m
        )
        self.left_turn_radius_m = self._validated_turn_radius(
            left_turn_radius_m
        )
        self.right_turn_radius_m = self._validated_turn_radius(
            right_turn_radius_m
        )
        self.max_x_error_m = max(0.01, float(max_x_error_m))
        self.arrival_radius_m = float(arrival_radius_m)
        self.brake_radius_m = max(
            self.arrival_radius_m, float(brake_radius_m)
        )
        self.search_ahead_m = float(search_ahead_m)
        self.heading_estimator = HeadingEstimator()
        self.clear()

    @staticmethod
    def _validated_turn_radius(radius_m):
        if radius_m is None:
            return None
        radius_m = float(radius_m)
        if not math.isfinite(radius_m) or radius_m <= 0.0:
            raise ValueError("实测转圈半径必须大于零")
        return radius_m

    def set_turn_radius(self, direction, radius_m):
        """运行中更新一侧 HYBRID 满转实测半径。"""
        direction = str(direction).upper()
        radius_m = self._validated_turn_radius(radius_m)
        if direction == "LEFT":
            self.left_turn_radius_m = radius_m
        elif direction == "RIGHT":
            self.right_turn_radius_m = radius_m
        else:
            raise ValueError(f"未知转向方向：{direction}")

    def _turn_radius_for_curvature(self, curvature_per_m):
        if curvature_per_m > 0.0 and self.left_turn_radius_m is not None:
            return self.left_turn_radius_m, "MEASURED_LEFT"
        if curvature_per_m < 0.0 and self.right_turn_radius_m is not None:
            return self.right_turn_radius_m, "MEASURED_RIGHT"
        return self.estimated_min_turn_radius_m, "ESTIMATED"

    def clear(self):
        self.path = None
        self.cumulative = None
        self.progress_m = 0.0
        self.segment_index = 0
        self._turn_sign = 0.0
        self.last_result = None

    @property
    def prepared(self):
        return self.path is not None

    def start(self, path_points, position, timestamp, initial_heading):
        self.path = resample_polyline(path_points, self.spacing_m)
        lengths = np.linalg.norm(np.diff(self.path, axis=0), axis=1)
        self.cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
        self.progress_m = 0.0
        self.segment_index = 0
        self._turn_sign = 0.0
        self.last_result = None
        self.heading_estimator.reset(initial_heading, position, timestamp)
        return self.update(position, timestamp, allow_course_update=False)

    def update(
        self, position, timestamp, allow_course_update=True, speed_mps=None
    ):
        if not self.prepared:
            raise RuntimeError("轨迹尚未准备")
        current = np.asarray(position, dtype=np.float64).reshape(2)
        if not np.isfinite(current).all():
            raise ValueError("当前位置无效")

        self._advance_progress(current)
        closest = self._point_at(self.progress_m)
        cross_track_m = float(np.linalg.norm(current - closest))
        off_path_ratio = float(np.clip(
            cross_track_m / self.full_attraction_error_m, 0.0, 1.0
        ))

        # 用两段路径弦线而不是单个 3 cm 小段估算前方曲率，避免手绘轨迹
        # 的像素锯齿被放大成连续左右修舵。默认分别观察 4~12 cm 和
        # 20~32 cm 两个区间；临近终点时自动退化为末段切向。
        total_path_m = float(self.cumulative[-1])
        near_start_m = min(total_path_m, self.progress_m + 0.04)
        near_end_m = min(total_path_m, self.progress_m + 0.12)
        far_end_m = min(total_path_m, self.progress_m + self.curve_preview_m)
        far_start_m = min(
            far_end_m,
            max(self.progress_m + 0.12, far_end_m - 0.12),
        )
        near_tangent = self._chord_direction(near_start_m, near_end_m)
        far_tangent = self._chord_direction(far_start_m, far_end_m)
        tangent_dot = float(np.clip(
            np.dot(near_tangent, far_tangent), -1.0, 1.0
        ))
        # y 向下坐标中取“左转为正”的有符号预览角。
        path_curve_angle_rad = float(math.atan2(
            near_tangent[1] * far_tangent[0]
            - near_tangent[0] * far_tangent[1],
            tangent_dot,
        ))
        near_centre_m = 0.5 * (near_start_m + near_end_m)
        far_centre_m = 0.5 * (far_start_m + far_end_m)
        curve_measure_span_m = max(
            self.spacing_m, far_centre_m - near_centre_m
        )
        path_curvature_per_m = path_curve_angle_rad / curve_measure_span_m
        turn_radius_m, turn_radius_source = self._turn_radius_for_curvature(
            path_curvature_per_m
        )
        curve_feedforward = float(np.clip(
            path_curvature_per_m * turn_radius_m,
            -1.0,
            1.0,
        ))
        path_curve_severity = abs(curve_feedforward)

        # 前视必须在离轨前由前方曲率缩短；离轨只提供额外收紧。直线
        # 使用 0.24 m，接近估计最小半径时连续缩至 0.10 m。
        lookahead_demand = max(path_curve_severity, off_path_ratio)
        active_lookahead_m = (
            self.lookahead_m
            - (self.lookahead_m - self.min_lookahead_m) * lookahead_demand
        )
        lookahead_distance = min(
            total_path_m, self.progress_m + active_lookahead_m
        )
        lookahead = self._point_at(lookahead_distance)
        heading, heading_source = self.heading_estimator.update(
            current, timestamp, allow_course_update=allow_course_update
        )

        # body_left_m 保留为鱼体到前视点的左右诊断值；闭环航向误差
        # 单独使用轨迹切线，避免把离轨误差重复藏进 LOS 航向误差。
        target = lookahead - current
        body_forward_m = float(np.dot(heading, target))
        # y 向下坐标中，鱼体左法向量为 (heading_y, -heading_x)。
        body_left_m = float(heading[1] * target[0] - heading[0] * target[1])
        tangent_body_forward = float(np.dot(heading, near_tangent))
        tangent_body_left = float(
            heading[1] * near_tangent[0]
            - heading[0] * near_tangent[1]
        )
        raw_heading_error_rad = float(math.atan2(
            tangent_body_left, tangent_body_forward
        ))
        if tangent_body_forward < 0.0:
            # 轨迹切线在鱼身后方时只锁住掉头方向，不再切换另一套增益，
            # 因而跨越旧 120°边界时转向幅度保持连续。
            if self._turn_sign == 0.0:
                if abs(raw_heading_error_rad) < math.pi - 1e-6:
                    self._turn_sign = (
                        1.0 if raw_heading_error_rad >= 0.0 else -1.0
                    )
                elif abs(curve_feedforward) > 1e-6:
                    self._turn_sign = 1.0 if curve_feedforward > 0.0 else -1.0
                elif abs(body_left_m) > 1e-6:
                    self._turn_sign = 1.0 if body_left_m > 0.0 else -1.0
                else:
                    self._turn_sign = 1.0
            heading_error_rad = self._turn_sign * abs(raw_heading_error_rad)
        else:
            heading_error_rad = raw_heading_error_rad
            if abs(raw_heading_error_rad) >= math.radians(2.0):
                self._turn_sign = 1.0 if raw_heading_error_rad > 0.0 else -1.0

        heading_feedback = float(np.clip(
            heading_error_rad / (math.pi / 2.0),
            -1.0,
            1.0,
        ))
        path_to_fish = current - closest
        fish_left_of_path_m = float(
            near_tangent[1] * path_to_fish[0]
            - near_tangent[0] * path_to_fish[1]
        )
        signed_cross_track_error_m = -fish_left_of_path_m
        cross_track_feedback = float(np.clip(
            math.atan2(signed_cross_track_error_m, active_lookahead_m)
            / (math.pi / 2.0),
            -1.0,
            1.0,
        ))
        steering_demand = float(np.clip(
            curve_feedforward + heading_feedback + cross_track_feedback,
            -1.0,
            1.0,
        ))
        x_error_m = steering_demand * self.max_x_error_m
        control_severity = abs(steering_demand)
        endpoint_distance = float(np.linalg.norm(current - self.path[-1]))
        remaining = max(0.0, float(self.cumulative[-1]) - self.progress_m)
        drive_distance = max(remaining, endpoint_distance)
        speed_valid = speed_mps is not None and math.isfinite(float(speed_mps))
        measured_speed_mps = max(0.0, float(speed_mps)) if speed_valid else 0.0
        arrived = (
            endpoint_distance <= self.arrival_radius_m
            and remaining <= self.arrival_radius_m
        )
        brake_request = (
            not arrived
            and endpoint_distance <= self.brake_radius_m
            and remaining <= self.brake_radius_m
        )
        result = {
            "cross_m": x_error_m,
            "x_error_m": x_error_m,
            "body_left_m": body_left_m,
            "body_forward_m": body_forward_m,
            "heading_error_deg": math.degrees(heading_error_rad),
            "steering_error_deg": math.degrees(heading_error_rad),
            # 固件用这一无量纲量连续混合直线/满转动力；它与本次真正
            # 下发的总转向需求一致，不再单独用曲率把推进削到 20%。
            "curve_severity": control_severity,
            "path_curve_severity": path_curve_severity,
            "path_curve_angle_deg": math.degrees(path_curve_angle_rad),
            "path_curvature_per_m": path_curvature_per_m,
            "curve_measure_span_m": curve_measure_span_m,
            "curve_feedforward": curve_feedforward,
            "heading_feedback": heading_feedback,
            "cross_track_feedback": cross_track_feedback,
            "steering_demand": steering_demand,
            "estimated_min_turn_radius_m": self.estimated_min_turn_radius_m,
            "turn_radius_m": turn_radius_m,
            "turn_radius_source": turn_radius_source,
            "cross_track_m": cross_track_m,
            "signed_cross_track_error_m": signed_cross_track_error_m,
            "control_severity": control_severity,
            "curve_direction": (
                "LEFT" if path_curve_angle_rad > math.radians(3.0)
                else "RIGHT" if path_curve_angle_rad < math.radians(-3.0)
                else "STRAIGHT"
            ),
            "heading": heading.copy(),
            "heading_source": heading_source,
            "lookahead_m": active_lookahead_m,
            "lookahead_demand": lookahead_demand,
            "off_path_ratio": off_path_ratio,
            "max_x_error_m": self.max_x_error_m,
            "lookahead_point": lookahead.copy(),
            "closest_point": closest.copy(),
            "along_m": self.progress_m,
            "dist_m": remaining,
            "drive_distance_m": drive_distance,
            "end_distance_m": endpoint_distance,
            "speed_mps": measured_speed_mps if speed_valid else None,
            "brake_distance_m": self.brake_radius_m,
            "brake_request": brake_request,
            "seg_index": self.segment_index,
            "arrived": arrived,
            "settled": arrived,
        }
        self.last_result = result
        return result

    def _advance_progress(self, position):
        total = float(self.cumulative[-1])
        search_end = min(total, self.progress_m + self.search_ahead_m)
        first = max(0, int(np.searchsorted(
            self.cumulative, self.progress_m, side="right"
        )) - 1)
        last = min(
            len(self.path) - 2,
            int(np.searchsorted(self.cumulative, search_end, side="right")),
        )
        best_distance_sq = None
        best_progress = self.progress_m
        for index in range(first, last + 1):
            p0 = self.path[index]
            segment = self.path[index + 1] - p0
            length_sq = float(np.dot(segment, segment))
            if length_sq <= 1e-12:
                continue
            projection = float(np.clip(
                np.dot(position - p0, segment) / length_sq, 0.0, 1.0
            ))
            candidate = p0 + projection * segment
            candidate_progress = float(
                self.cumulative[index] + projection * math.sqrt(length_sq)
            )
            if candidate_progress + 1e-9 < self.progress_m:
                continue
            distance_sq = float(np.dot(position - candidate, position - candidate))
            if best_distance_sq is None or distance_sq < best_distance_sq:
                best_distance_sq = distance_sq
                best_progress = candidate_progress

        self.progress_m = max(self.progress_m, min(best_progress, search_end))
        self.segment_index = max(
            self.segment_index,
            min(
                len(self.path) - 2,
                int(np.searchsorted(
                    self.cumulative, self.progress_m, side="right"
                )) - 1,
            ),
        )

    def _point_at(self, distance_m):
        distance = float(np.clip(distance_m, 0.0, self.cumulative[-1]))
        index = min(
            len(self.path) - 2,
            max(0, int(np.searchsorted(
                self.cumulative, distance, side="right"
            )) - 1),
        )
        segment_length = float(self.cumulative[index + 1] - self.cumulative[index])
        ratio = 0.0 if segment_length <= 1e-9 else (
            distance - float(self.cumulative[index])
        ) / segment_length
        return self.path[index] + ratio * (self.path[index + 1] - self.path[index])

    def _tangent_at(self, distance_m):
        distance = float(np.clip(distance_m, 0.0, self.cumulative[-1]))
        index = min(
            len(self.path) - 2,
            max(0, int(np.searchsorted(
                self.cumulative, distance, side="right"
            )) - 1),
        )
        tangent = self.path[index + 1] - self.path[index]
        return _unit(tangent)

    def _chord_direction(self, start_m, end_m):
        total = float(self.cumulative[-1])
        start = float(np.clip(start_m, 0.0, total))
        end = float(np.clip(end_m, start, total))
        chord = self._point_at(end) - self._point_at(start)
        if float(np.linalg.norm(chord)) <= 1e-9:
            return self._tangent_at(0.5 * (start + end))
        return _unit(chord)


from dataclasses import asdict, dataclass
import json
import math
import os
import time
from typing import Dict, Iterable, Optional

import numpy as np


CALIBRATION_VERSION = 1
VALID_DIRECTIONS = ("LEFT", "RIGHT")


class TurnCalibrationError(ValueError):
    """转圈数据不足或质量不合格。"""


@dataclass(frozen=True)
class TurnCircleFit:
    direction: str
    center_x_m: float
    center_y_m: float
    radius_m: float
    rms_residual_m: float
    arc_coverage_deg: float
    sample_count: int
    inlier_count: int
    started_at: float
    ended_at: float

    @property
    def diameter_m(self) -> float:
        return 2.0 * self.radius_m

    @property
    def curvature_per_m(self) -> float:
        return 1.0 / self.radius_m

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload.update({
            "diameter_m": self.diameter_m,
            "curvature_per_m": self.curvature_per_m,
            "mode": "HYBRID",
            "turn_strength": 1.0,
        })
        return payload

    @classmethod
    def from_dict(cls, payload: dict) -> "TurnCircleFit":
        direction = str(payload["direction"]).upper()
        if direction not in VALID_DIRECTIONS:
            raise TurnCalibrationError(f"未知转向方向：{direction}")
        result = cls(
            direction=direction,
            center_x_m=float(payload["center_x_m"]),
            center_y_m=float(payload["center_y_m"]),
            radius_m=float(payload["radius_m"]),
            rms_residual_m=float(payload["rms_residual_m"]),
            arc_coverage_deg=float(payload["arc_coverage_deg"]),
            sample_count=int(payload["sample_count"]),
            inlier_count=int(payload["inlier_count"]),
            started_at=float(payload["started_at"]),
            ended_at=float(payload["ended_at"]),
        )
        if not math.isfinite(result.radius_m) or result.radius_m <= 0.0:
            raise TurnCalibrationError("保存的转圈半径无效")
        return result


def _algebraic_circle_fit(points: np.ndarray, weights=None):
    """以线性最小二乘求圆；坐标先归一化以改善数值条件。"""
    points = np.asarray(points, dtype=np.float64).reshape((-1, 2))
    origin = np.mean(points, axis=0)
    scale = float(np.sqrt(np.mean(np.sum((points - origin) ** 2, axis=1))))
    if not math.isfinite(scale) or scale <= 1e-6:
        raise TurnCalibrationError("位置几乎没有移动，无法拟合圆")

    normalized = (points - origin) / scale
    x = normalized[:, 0]
    y = normalized[:, 1]
    matrix = np.column_stack((2.0 * x, 2.0 * y, np.ones(len(points))))
    target = x * x + y * y
    if weights is not None:
        root_weight = np.sqrt(np.clip(
            np.asarray(weights, dtype=np.float64).reshape(-1), 1e-6, 1.0
        ))
        matrix = matrix * root_weight[:, None]
        target = target * root_weight

    solution, _, rank, _ = np.linalg.lstsq(matrix, target, rcond=None)
    if rank < 3:
        raise TurnCalibrationError("采样轨迹接近直线，无法拟合转圈半径")
    center_normalized = solution[:2]
    radius_sq = float(solution[2] + np.dot(
        center_normalized, center_normalized
    ))
    if not math.isfinite(radius_sq) or radius_sq <= 0.0:
        raise TurnCalibrationError("圆拟合结果无效")
    center = origin + center_normalized * scale
    radius = math.sqrt(radius_sq) * scale
    return center, radius


def _robust_circle_fit(points: np.ndarray):
    """Huber 迭代后用 MAD 门控剔除少量反光/色块跳点。"""
    weights = np.ones(len(points), dtype=np.float64)
    center = None
    radius = None
    for _ in range(8):
        center, radius = _algebraic_circle_fit(points, weights)
        residuals = np.linalg.norm(points - center, axis=1) - radius
        median = float(np.median(residuals))
        mad = float(np.median(np.abs(residuals - median)))
        robust_scale = max(0.001, 1.4826 * mad)
        huber_limit = 1.5 * robust_scale
        magnitude = np.abs(residuals - median)
        new_weights = np.ones(len(points), dtype=np.float64)
        outside = magnitude > huber_limit
        new_weights[outside] = huber_limit / np.maximum(
            magnitude[outside], 1e-9
        )
        if float(np.max(np.abs(new_weights - weights))) < 1e-3:
            weights = new_weights
            break
        weights = new_weights

    residuals = np.linalg.norm(points - center, axis=1) - radius
    median = float(np.median(residuals))
    mad = float(np.median(np.abs(residuals - median)))
    robust_scale = max(0.001, 1.4826 * mad)
    gate_m = max(0.015, min(0.080, 3.5 * robust_scale))
    inliers = np.abs(residuals - median) <= gate_m
    if int(np.count_nonzero(inliers)) >= 3:
        center, radius = _algebraic_circle_fit(points[inliers])
        residuals = np.linalg.norm(points - center, axis=1) - radius
        inlier_residuals = residuals[inliers]
    else:
        inlier_residuals = residuals
    return center, float(radius), inliers, inlier_residuals


def fit_turn_circle(
    samples: Iterable[Iterable[float]],
    timestamps: Optional[Iterable[float]] = None,
    *,
    min_samples: int = 25,
    min_arc_coverage_deg: float = 180.0,
    min_radius_m: float = 0.04,
    max_radius_m: float = 2.0,
) -> TurnCircleFit:
    """稳健拟合转圈半径，并拒绝样本不足、圆弧不足和高残差结果。"""
    points = np.asarray(list(samples), dtype=np.float64).reshape((-1, 2))
    if len(points) < int(min_samples):
        raise TurnCalibrationError(
            f"有效样本不足：{len(points)}/{int(min_samples)}"
        )
    if not np.isfinite(points).all():
        raise TurnCalibrationError("采样中包含无效坐标")

    if timestamps is None:
        sample_times = np.arange(len(points), dtype=np.float64)
    else:
        sample_times = np.asarray(list(timestamps), dtype=np.float64).reshape(-1)
        if len(sample_times) != len(points) or not np.isfinite(sample_times).all():
            raise TurnCalibrationError("采样时间与位置不匹配")
        if np.any(np.diff(sample_times) <= 0.0):
            raise TurnCalibrationError("采样时间必须严格递增")

    center, radius, inlier_mask, inlier_residuals = _robust_circle_fit(points)
    inlier_count = int(np.count_nonzero(inlier_mask))
    if inlier_count < int(min_samples):
        raise TurnCalibrationError(
            f"剔除跳点后样本不足：{inlier_count}/{int(min_samples)}"
        )
    if inlier_count < math.ceil(0.70 * len(points)):
        raise TurnCalibrationError("反光或色块跳点过多，可靠样本不足 70%")
    if not (float(min_radius_m) <= radius <= float(max_radius_m)):
        raise TurnCalibrationError(
            f"拟合半径 {radius:.3f}m 超出允许范围 "
            f"{float(min_radius_m):.2f}~{float(max_radius_m):.2f}m"
        )

    inlier_points = points[inlier_mask]
    angles = np.unwrap(np.arctan2(
        inlier_points[:, 1] - center[1],
        inlier_points[:, 0] - center[0],
    ))
    net_angle = float(angles[-1] - angles[0])
    arc_coverage_deg = abs(math.degrees(net_angle))
    if arc_coverage_deg < float(min_arc_coverage_deg):
        raise TurnCalibrationError(
            f"圆弧覆盖不足：{arc_coverage_deg:.1f}°/"
            f"{float(min_arc_coverage_deg):.0f}°，请至少转过半圈"
        )

    signed_steps = np.sign(net_angle) * np.diff(angles)
    forward_angle = float(np.sum(np.clip(signed_steps, 0.0, None)))
    backward_angle = float(np.sum(np.clip(-signed_steps, 0.0, None)))
    if forward_angle <= 1e-6 or backward_angle > max(
        math.radians(30.0), 0.35 * forward_angle
    ):
        raise TurnCalibrationError("转圈方向变化过多，请保持同一方向再测一次")

    rms_residual_m = float(np.sqrt(np.mean(inlier_residuals ** 2)))
    max_allowed_rms_m = max(0.035, 0.20 * radius)
    if rms_residual_m > max_allowed_rms_m:
        raise TurnCalibrationError(
            f"圆拟合残差过大：{rms_residual_m:.3f}m，"
            "请检查反光、鱼尾丢失或场地标定"
        )

    # y 向下坐标：角度递减为左转，角度递增为右转。
    direction = "LEFT" if net_angle < 0.0 else "RIGHT"
    return TurnCircleFit(
        direction=direction,
        center_x_m=float(center[0]),
        center_y_m=float(center[1]),
        radius_m=radius,
        rms_residual_m=rms_residual_m,
        arc_coverage_deg=arc_coverage_deg,
        sample_count=len(points),
        inlier_count=inlier_count,
        started_at=float(sample_times[0]),
        ended_at=float(sample_times[-1]),
    )


class TurnCalibrationSession:
    """供 UI 使用的一次转圈被动采样会话。"""

    def __init__(self, min_sample_spacing_m: float = 0.003):
        self.min_sample_spacing_m = max(0.0, float(min_sample_spacing_m))
        self.active = False
        self.points = []
        self.timestamps = []
        self.skipped_samples = 0

    @property
    def sample_count(self) -> int:
        return len(self.points)

    def start(self, position=None, timestamp=None) -> None:
        self.points = []
        self.timestamps = []
        self.skipped_samples = 0
        self.active = True
        if position is not None and timestamp is not None:
            self.add(position, timestamp)

    def add(self, position, timestamp) -> bool:
        if not self.active:
            return False
        point = np.asarray(position, dtype=np.float64).reshape(2)
        now = float(timestamp)
        if not np.isfinite(point).all() or not math.isfinite(now):
            self.skipped_samples += 1
            return False
        if self.timestamps and now <= self.timestamps[-1]:
            self.skipped_samples += 1
            return False
        if self.points:
            distance = float(np.linalg.norm(point - self.points[-1]))
            if distance < self.min_sample_spacing_m:
                self.skipped_samples += 1
                return False
        self.points.append(point.copy())
        self.timestamps.append(now)
        return True

    def cancel(self) -> None:
        self.active = False
        self.points = []
        self.timestamps = []
        self.skipped_samples = 0

    def finish(self) -> TurnCircleFit:
        if not self.active:
            raise TurnCalibrationError("当前没有正在进行的转圈测量")
        self.active = False
        return fit_turn_circle(self.points, self.timestamps)


def load_turn_calibrations(path: str) -> Dict[str, TurnCircleFit]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    if int(payload.get("version", -1)) != CALIBRATION_VERSION:
        raise TurnCalibrationError("转圈标定文件版本不支持")
    results = {}
    for direction, entry in payload.get("directions", {}).items():
        result = TurnCircleFit.from_dict(entry)
        if result.direction != str(direction).upper():
            raise TurnCalibrationError("转圈标定方向字段不一致")
        results[result.direction] = result
    return results


def save_turn_calibration(path: str, result: TurnCircleFit) -> None:
    try:
        existing = load_turn_calibrations(path)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        existing = {}
    existing[result.direction] = result
    payload = {
        "version": CALIBRATION_VERSION,
        "updated_at": time.time(),
        "note": "HYBRID 满转视觉拟合；左右分别保存，仅作为曲率前馈端点",
        "directions": {
            direction: existing[direction].to_dict()
            for direction in VALID_DIRECTIONS
            if direction in existing
        },
    }
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary_path = f"{path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    os.replace(temporary_path, path)

