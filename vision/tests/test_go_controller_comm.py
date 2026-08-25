import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from control import RoboFishComm


class CaptureHandler(BaseHTTPRequestHandler):
    messages = []
    event = threading.Event()

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.__class__.messages.append(json.loads(body))
        self.__class__.event.set()
        payload = json.dumps({"sent": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        return


class GoControllerCommTests(unittest.TestCase):
    def setUp(self):
        CaptureHandler.messages = []
        CaptureHandler.event.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/vision/device-command"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

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

        self.assertEqual([item["operation"] for item in CaptureHandler.messages], ["start", "update", "stop"])
        update = CaptureHandler.messages[1]
        self.assertEqual(update["sequence"], 1)
        self.assertEqual(update["crossTrackError"], 0.2)
        self.assertEqual(update["headingErrorDeg"], -12.0)
        self.assertEqual(update["curvature"], 0.4)


if __name__ == "__main__":
    unittest.main()
