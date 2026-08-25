import unittest

from service import CameraInfo, VisionService
from web_api import create_app


class VisionWebApiTests(unittest.TestCase):
    def setUp(self):
        self.stopped = []
        self.service = VisionService(
            runner_factory=lambda index, _publish: lambda: self.stopped.append(index)
        )
        self.app = create_app(
            self.service,
            camera_provider=lambda: [CameraInfo(1, "RERVISION", 640, 480, 60)],
        )
        self.client = self.app.test_client()

    def test_camera_start_action_status_and_stop_contract(self):
        cameras = self.client.get("/cameras")
        self.assertEqual(cameras.status_code, 200)
        self.assertEqual(cameras.get_json()[0]["name"], "RERVISION")

        started = self.client.post("/start", json={"cameraIndex": 1})
        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.get_json()["state"], "running")

        action = self.client.post("/action", json={"type": "tracking.stop"})
        self.assertEqual(action.status_code, 202)
        self.assertEqual(self.service.next_action(), {"type": "tracking.stop"})

        status = self.client.get("/status")
        self.assertEqual(status.get_json()["cameraIndex"], 1)

        stopped = self.client.post("/stop")
        self.assertEqual(stopped.status_code, 200)
        self.assertEqual(stopped.get_json()["state"], "stopped")
        self.assertEqual(self.stopped, [1])

    def test_invalid_requests_are_rejected(self):
        self.assertEqual(self.client.post("/start", json={}).status_code, 400)
        self.assertEqual(
            self.client.post("/action", json={"type": "unknown"}).status_code,
            409,
        )

    def test_camera_endpoint_uses_cache_while_vision_is_running(self):
        class RecordingCatalog:
            def __init__(self):
                self.refresh_flags = []

            def list(self, allow_refresh=True):
                self.refresh_flags.append(allow_refresh)
                return [CameraInfo(1, "RERVISION", 640, 480, 60)]

        catalog = RecordingCatalog()
        app = create_app(self.service, camera_catalog=catalog)
        client = app.test_client()

        client.get("/cameras")
        client.post("/start", json={"cameraIndex": 1})
        client.get("/cameras")

        self.assertEqual(catalog.refresh_flags, [True, False])

    def test_session_preview_processing_action_and_stop_contract(self):
        created = self.client.post(
            "/sessions",
            json={"cameraId": "camera-1", "cameraIndex": 1},
        )
        self.assertEqual(created.status_code, 201)
        session_id = created.get_json()["sessionId"]
        self.assertEqual(created.get_json()["state"], "previewing")

        processing = self.client.post(f"/sessions/{session_id}/processing")
        self.assertEqual(processing.get_json()["state"], "processing")

        action = self.client.post(
            f"/sessions/{session_id}/actions",
            json={"type": "path.clear"},
        )
        self.assertEqual(action.status_code, 202)
        self.assertTrue(action.get_json()["data"]["accepted"])

        stopped = self.client.delete(f"/sessions/{session_id}")
        self.assertEqual(stopped.get_json()["state"], "idle")

    def test_stale_session_action_is_rejected(self):
        created = self.client.post(
            "/sessions",
            json={"cameraId": "camera-1", "cameraIndex": 1},
        ).get_json()

        response = self.client.post(
            "/sessions/old-session/actions",
            json={"type": "path.clear"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"]["code"], "session_mismatch")


if __name__ == "__main__":
    unittest.main()
