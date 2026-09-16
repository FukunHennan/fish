"""Strict calibrated coordinate mapping for vision control."""

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
    """Resolve control coordinates only from an explicit field calibration."""

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

    def resolve(self, field_homography: Optional[np.ndarray] = None) -> CoordinateMapping:
        if field_homography is None:
            raise RuntimeError("场地标定是视觉控制的必要条件，未启用图像坐标回退")
        matrix = np.asarray(field_homography, dtype=np.float64).reshape((3, 3))
        if not np.isfinite(matrix).all() or abs(float(np.linalg.det(matrix))) <= 1e-12:
            raise RuntimeError("场地标定矩阵无效")
        return CoordinateMapping("FIELD", matrix)

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
