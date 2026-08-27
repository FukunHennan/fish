"""Coordinate mapping for vision control and optional metric calibration.

Tracking and physical measurement are deliberately separated here:

- IMAGE mode maps the full camera frame into the configured control plane, so
  a path drawn in the same image can be followed without a manual pool
  calibration step.
- FIELD mode uses an explicit pool homography when one is available. This is
  the mode to use when centimetre/metre accuracy matters for measurement,
  speed reporting, or turn-radius experiments.

The rest of the navigation stack can therefore consume one consistent control
coordinate system without treating field calibration as a tracking precondition.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

import cv2
import numpy as np

from config import PHYSICAL_HEIGHT, PHYSICAL_WIDTH


@dataclass(frozen=True)
class CoordinateMapping:
    mode: str
    homography: np.ndarray


class ControlCoordinateMapper:
    """Resolve a control transform with optional calibrated field override."""

    def __init__(
        self,
        frame_width: int,
        frame_height: int,
        control_width: float = PHYSICAL_WIDTH,
        control_height: float = PHYSICAL_HEIGHT,
    ):
        self.frame_width = int(frame_width)
        self.frame_height = int(frame_height)
        self.control_width = float(control_width)
        self.control_height = float(control_height)
        if self.frame_width <= 1 or self.frame_height <= 1:
            raise ValueError("画面尺寸必须大于 1 像素")
        if self.control_width <= 0.0 or self.control_height <= 0.0:
            raise ValueError("控制坐标尺寸必须大于零")
        self._image_homography = self._build_image_homography()

    def _build_image_homography(self) -> np.ndarray:
        src = np.float32([
            [0.0, 0.0],
            [self.frame_width - 1.0, 0.0],
            [self.frame_width - 1.0, self.frame_height - 1.0],
            [0.0, self.frame_height - 1.0],
        ])
        dst = np.float32([
            [0.0, 0.0],
            [self.control_width, 0.0],
            [self.control_width, self.control_height],
            [0.0, self.control_height],
        ])
        homography = cv2.getPerspectiveTransform(src, dst)
        if homography is None or not np.isfinite(homography).all():
            raise RuntimeError("无法建立默认画面控制坐标")
        return homography

    def resolve(self, field_homography: Optional[np.ndarray] = None) -> CoordinateMapping:
        if field_homography is not None:
            matrix = np.asarray(field_homography, dtype=np.float64).reshape((3, 3))
            if np.isfinite(matrix).all() and abs(float(np.linalg.det(matrix))) > 1e-12:
                return CoordinateMapping("FIELD", matrix)
        return CoordinateMapping("IMAGE", self._image_homography.copy())

    def map_points(
        self,
        points: Iterable[Sequence[float]],
        field_homography: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        values = np.asarray(list(points), dtype=np.float32).reshape((-1, 2))
        if len(values) == 0 or not np.isfinite(values).all():
            raise ValueError("控制点无效")
        mapping = self.resolve(field_homography)
        transformed = cv2.perspectiveTransform(values.reshape((1, -1, 2)), mapping.homography)[0]
        return np.asarray(transformed, dtype=np.float64)

    def map_point(
        self,
        point: Sequence[float],
        field_homography: Optional[np.ndarray] = None,
    ) -> tuple[float, float]:
        mapped = self.map_points([point], field_homography)[0]
        return float(mapped[0]), float(mapped[1])

    def map_heading(
        self,
        origin: Sequence[float],
        pixel_unit_vector: Sequence[float],
        field_homography: Optional[np.ndarray] = None,
        sample_length_px: float = 30.0,
    ) -> tuple[float, float]:
        origin_value = np.asarray(origin, dtype=np.float64).reshape(2)
        direction = np.asarray(pixel_unit_vector, dtype=np.float64).reshape(2)
        length = float(np.linalg.norm(direction))
        if length <= 1e-9 or not np.isfinite(direction).all():
            raise ValueError("鱼头方向向量无效")
        direction /= length
        mapped = self.map_points(
            [origin_value, origin_value + direction * float(sample_length_px)],
            field_homography,
        )
        delta = mapped[1] - mapped[0]
        mapped_length = float(np.linalg.norm(delta))
        if mapped_length <= 1e-9:
            raise ValueError("鱼头方向映射失败")
        unit = delta / mapped_length
        return float(unit[0]), float(unit[1])
