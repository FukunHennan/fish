import json
import threading
import time
import unittest
from urllib.error import HTTPError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from control import RoboFishComm


class CaptureHandler(BaseHTTPRequestHandler):
    status = 200
    messages = []
    event = threading.Event()
    response = {"sent": True, "acknowledged": True, "success": True, "code": "OK"}

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.__class__.messages.append(json.loads(body))
        self.__class__.event.set()
        payload = json.dumps(self.__class__.response).encode()
        self.send_response(self.__class__.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        return


class GoControllerCommTests(unittest.TestCase):
    def setUp(self):
        CaptureHandler.status = 200
        CaptureHandler.messages = []
        CaptureHandler.event.clear()
        CaptureHandler.response = {"sent": True, "acknowledged": True, "success": True, "code": "OK"}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/vision/device-command"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_rejected_session_disables_further_motion(self):
        comm = RoboFishComm(controller_url=self.url)
        try:
            self.assertTrue(comm.ensure_hybrid_mode())
            CaptureHandler.status = 409
            with self.assertRaises(HTTPError):
                comm._request_motion("forward", 2.5, 20, 0)
            self.assertFalse(comm._motion_enabled)
            self.assertFalse(comm._send_async({"kind": "motion", "mode": "forward"}))
        finally:
            CaptureHandler.status = 200
            comm.close()

    def test_braking_stop_uses_stop_operation(self):
        comm = RoboFishComm(controller_url=self.url)
        try:
            self.assertTrue(comm.ensure_hybrid_mode())
            comm._request_motion("stop", 0, 0, 0)
            self.assertEqual(CaptureHandler.messages[-1]["operation"], "stop")
            self.assertFalse(comm._motion_enabled)
        finally:
            comm.close()

    def test_start_update_and_stop_use_go_json_contract(self):
        comm = RoboFishComm(controller_url=self.url)
        self.assertTrue(comm.ensure_hybrid_mode())
        comm.process_tracking_error(
            cross_m=0.2,
            along_m=0.0,
            dist_m=0.8,
            speed_mps=0.1,
            curve_severity=0.3,
            brake_request=False,
            heading_error_deg=-12,
            path_curvature_per_m=0.4,
        )
        deadline = time.time() + 1
        while len(CaptureHandler.messages) < 2 and time.time() < deadline:
            CaptureHandler.event.wait(0.05)
            CaptureHandler.event.clear()
        self.assertTrue(comm.stop_now())
        comm.stopped = True
        comm.thread.join(timeout=1)

        self.assertEqual([item["operation"] for item in CaptureHandler.messages], ["start", "motion", "stop"])
        motion = CaptureHandler.messages[1]
        self.assertEqual(motion["mode"], "forward")
        self.assertGreater(motion["frequency"], 2.4)
        self.assertGreater(motion["amplitude"], 26.0)
        self.assertAlmostEqual(motion["bias"], -4.568)

    def test_turn_calibration_uses_repeating_in_place_turn_commands(self):
        comm = RoboFishComm(controller_url=self.url)
        try:
            self.assertTrue(comm.ensure_hybrid_mode())
            CaptureHandler.event.clear()
            self.assertTrue(comm.start_continuous_turn("left"))
            deadline = time.time() + 1
            while len(CaptureHandler.messages) < 2 and time.time() < deadline:
                CaptureHandler.event.wait(0.05)
                CaptureHandler.event.clear()
            self.assertGreaterEqual(len(CaptureHandler.messages), 2)
            motion = CaptureHandler.messages[-1]
            self.assertEqual(motion["operation"], "motion")
            self.assertEqual(motion["mode"], "left")
            self.assertEqual(motion["frequency"], 3.0)
            self.assertEqual(motion["amplitude"], 45.0)
            time.sleep(0.12)
            self.assertTrue(comm.maintain_continuous_turn("left"))
        finally:
            comm.stop_now()
            comm.close()

    def test_visual_motion_parameters_follow_measured_motion(self):
        comm = RoboFishComm(controller_url=self.url)
        try:
            slow = comm._motion_pid.update(
                cross_track_error=0.0,
                heading_error_deg=0.0,
                distance_to_target=0.8,
                curvature=0.0,
                brake=False,
                now=1.0,
                speed_mps=0.0,
            )
            fast = comm._motion_pid.update(
                cross_track_error=0.0,
                heading_error_deg=0.0,
                distance_to_target=0.8,
                curvature=0.0,
                brake=False,
                now=1.1,
                speed_mps=0.18,
            )
            # A slow fish receives more propulsion; a fish already at cruise
            # speed is allowed to settle instead of using fixed user limits.
            self.assertGreater(slow["frequency"], fast["frequency"])
            self.assertGreater(slow["amplitude"], fast["amplitude"])
        finally:
            comm.close()

    def test_large_steering_uses_directional_tail_mode(self):
        comm = RoboFishComm(controller_url=self.url)
        try:
            left = comm._motion_pid.update(
                cross_track_error=0.0,
                heading_error_deg=0.0,
                distance_to_target=0.8,
                curvature=0.0,
                brake=False,
                now=1.0,
                speed_mps=0.1,
                steering_demand=0.5,
            )
            right = comm._motion_pid.update(
                cross_track_error=0.0,
                heading_error_deg=0.0,
                distance_to_target=0.8,
                curvature=0.0,
                brake=False,
                now=1.1,
                speed_mps=0.1,
                steering_demand=-0.5,
            )
            self.assertEqual(left["mode"], "left")
            self.assertEqual(right["mode"], "right")
            self.assertEqual(left["bias"], 0.0)
            self.assertEqual(right["bias"], 0.0)
        finally:
            comm.close()

    def test_device_rejection_does_not_enable_vision_motion(self):
        CaptureHandler.response = {
            "sent": True, "acknowledged": True, "success": False,
            "code": "VISION_NOT_ACTIVE", "message": "rejected",
        }
        comm = RoboFishComm(controller_url=self.url)
        self.assertFalse(comm.ensure_hybrid_mode())
        self.assertFalse(comm.start_forward_calibration())
        comm.stopped = True
        comm.thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
