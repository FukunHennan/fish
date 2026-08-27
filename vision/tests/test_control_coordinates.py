import os
import sys

import numpy as np

VISION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if VISION_DIR not in sys.path:
    sys.path.insert(0, VISION_DIR)

from control_coordinates import ControlCoordinateMapper


def test_image_mapping_covers_control_plane():
    mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
    points = mapper.map_points([(0, 0), (639, 479)])
    assert np.allclose(points[0], [0.0, 0.0], atol=1e-6)
    assert np.allclose(points[1], [3.2, 1.6], atol=1e-6)
    assert mapper.resolve().mode == "IMAGE"


def test_field_homography_overrides_image_mapping():
    mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
    field = np.array([
        [0.01, 0.0, 0.5],
        [0.0, 0.01, 0.25],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    mapped = mapper.map_point((100, 50), field)
    assert mapper.resolve(field).mode == "FIELD"
    assert np.allclose(mapped, [1.5, 0.75], atol=1e-6)


def test_heading_mapping_preserves_direction():
    mapper = ControlCoordinateMapper(640, 480, control_width=3.2, control_height=1.6)
    heading = mapper.map_heading((320, 240), (1, 0))
    assert heading[0] > 0.999
    assert abs(heading[1]) < 1e-6
