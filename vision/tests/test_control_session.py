import unittest

import numpy as np

from control import VisionControlSession


class _Velocity:
    velocity = np.array([0.10, 0.0], dtype=float)


class _Heading:
    velocity_estimator = _Velocity()


class _Path:
    prepared = True
    heading_estimator = _Heading()

    def __init__(self):
        self.positions = []

    def start(self, path, position, timestamp, heading):
        self.positions.append(np.asarray(position, dtype=float))
        return {"seg_index": 0}

    def update(self, position, timestamp, allow_course_update, speed_mps):
        self.positions.append(np.asarray(position, dtype=float))
        return {
            "seg_index": 0,
            "settled": False,
            "x_error_m": 0.0,
            "along_m": 0.1,
            "drive_distance_m": 1.0,
            "speed_mps": speed_mps,
            "curve_severity": 0.0,
            "brake_request": False,
            "cross_track_m": 0.0,
            "heading_error_deg": 0.0,
            "path_curvature_per_m": 0.0,
            "steering_demand": 0.0,
        }

    def clear(self):
        self.prepared = False


class ControlSessionTests(unittest.TestCase):
    def test_brief_target_loss_keeps_motion_with_bounded_prediction(self):
        path = _Path()
        session = VisionControlSession(path, target_loss_grace_s=1.5)
        session.prepare([[0.0, 0.0], [1.0, 0.0]], [0.0, 0.0], 10.0, [1.0, 0.0])
        session.activate({"seg_index": 0})

        first = session.update(
            calibrated=True,
            position=[0.0, 0.0],
            frame_time=10.0,
            now=10.0,
            allow_course_update=False,
            speed_mps=0.1,
        )
        held = session.update(
            calibrated=True,
            position=None,
            frame_time=10.4,
            now=10.4,
            allow_course_update=False,
            speed_mps=0.0,
        )

        self.assertIsNotNone(first.pid)
        self.assertIsNotNone(held.pid)
        self.assertFalse(held.stop_required)
        self.assertEqual(held.status, "HYBRID TARGET HOLD")
        self.assertLessEqual(float(np.linalg.norm(path.positions[-1])), 0.08)

    def test_prolonged_target_loss_stops_motion(self):
        path = _Path()
        session = VisionControlSession(path, target_loss_grace_s=1.5)
        session.prepare([[0.0, 0.0], [1.0, 0.0]], [0.0, 0.0], 10.0, [1.0, 0.0])
        session.activate({"seg_index": 0})
        session.update(
            calibrated=True,
            position=[0.0, 0.0],
            frame_time=10.0,
            now=10.0,
            allow_course_update=False,
            speed_mps=0.1,
        )

        session.update(
            calibrated=True,
            position=None,
            frame_time=12.0,
            now=12.0,
            allow_course_update=False,
            speed_mps=0.0,
        )
        stopped = session.update(
            calibrated=True,
            position=None,
            frame_time=13.6,
            now=13.6,
            allow_course_update=False,
            speed_mps=0.0,
        )

        self.assertTrue(stopped.stop_required)
        self.assertEqual(stopped.status, "TARGET LOST")


if __name__ == "__main__":
    unittest.main()
