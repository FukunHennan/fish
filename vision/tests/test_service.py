import unittest

from service import CameraCatalog, CameraInfo, VisionService, enumerate_cameras


class FakeCapture:
    def __init__(self, opened, width=640, height=480, fps=30, frames=None, set_error=None):
        self._opened = opened
        self._values = {3: width, 4: height, 5: fps}
        self._frames = list(frames if frames is not None else [(True, object())])
        self._set_error = set_error
        self.released = False

    def isOpened(self):
        return self._opened

    def get(self, key):
        return self._values.get(key, 0)

    def set(self, _key, _value):
        if self._set_error:
            raise self._set_error
        return True

    def read(self):
        return self._frames.pop(0) if self._frames else (False, None)

    def release(self):
        self.released = True


class CameraEnumerationTests(unittest.TestCase):
    def test_directshow_names_bound_the_number_of_indexes_probed(self):
        opened = []

        def open_capture(index):
            opened.append(index)
            return FakeCapture(opened=True)

        cameras = enumerate_cameras(
            max_index=8,
            open_capture=open_capture,
            name_provider=lambda: ["Integrated Camera", "Global Shutter Camera"],
        )

        self.assertEqual(opened, [0, 1])
        self.assertEqual([camera.index for camera in cameras], [0, 1])

    def test_only_openable_cameras_are_returned_and_released(self):
        captures = {
            0: FakeCapture(False),
            1: FakeCapture(True, 1280, 720, 60),
            2: FakeCapture(False),
        }

        cameras = enumerate_cameras(
            max_index=3,
            open_capture=lambda index: captures[index],
            name_provider=lambda: ["Integrated Camera", "RERVISION", "Virtual Camera"],
        )

        self.assertEqual(
            cameras,
            [CameraInfo(index=1, name="RERVISION", width=1280, height=720, fps=60)],
        )
        self.assertTrue(all(capture.released for capture in captures.values()))

    def test_camera_without_a_readable_first_frame_is_excluded(self):
        capture = FakeCapture(True, frames=[(False, None)] * 3)

        cameras = enumerate_cameras(
            max_index=1,
            open_capture=lambda _index: capture,
            name_provider=lambda: ["Broken Virtual Camera"],
            probe_attempts=3,
        )

        self.assertEqual(cameras, [])
        self.assertTrue(capture.released)

    def test_camera_configuration_exception_is_contained(self):
        capture = FakeCapture(True, set_error=RuntimeError("driver rejected"))

        cameras = enumerate_cameras(
            max_index=1,
            open_capture=lambda _index: capture,
            name_provider=lambda: ["Unstable Camera"],
        )

        self.assertEqual(cameras, [])
        self.assertTrue(capture.released)

    def test_camera_catalog_reuses_expensive_enumeration_within_ttl(self):
        calls = []
        catalog = CameraCatalog(
            provider=lambda: calls.append(True) or [CameraInfo(1, "RERVISION", 640, 480, 60)],
            ttl_seconds=10,
            clock=lambda: 100,
        )

        first = catalog.list()
        second = catalog.list()

        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1)

    def test_camera_catalog_does_not_reopen_devices_while_refresh_is_disabled(self):
        now = [0]
        calls = []
        catalog = CameraCatalog(
            provider=lambda: calls.append(True) or [CameraInfo(1, "RERVISION", 640, 480, 60)],
            ttl_seconds=10,
            clock=lambda: now[0],
        )

        self.assertEqual(catalog.list()[0].name, "RERVISION")
        now[0] = 20
        self.assertEqual(catalog.list(allow_refresh=False)[0].name, "RERVISION")
        self.assertEqual(len(calls), 1)


class VisionServiceLifecycleTests(unittest.TestCase):
    def test_start_and_stop_expose_stable_status(self):
        started = []
        stopped = []

        service = VisionService(
            runner_factory=lambda camera_index, publish: (
                started.append(camera_index),
                lambda: stopped.append(camera_index),
            )[1]
        )

        self.assertTrue(service.start(1))
        self.assertFalse(service.start(1))
        self.assertEqual(service.status()["state"], "running")
        self.assertEqual(service.status()["cameraIndex"], 1)

        self.assertTrue(service.stop())
        self.assertFalse(service.stop())
        self.assertEqual(service.status()["state"], "stopped")
        self.assertEqual(started, [1])
        self.assertEqual(stopped, [1])

    def test_failed_stop_keeps_camera_reserved_and_blocks_restart(self):
        def runner_factory(_camera_index, _publish):
            def stop():
                raise RuntimeError("vision_application_stop_timeout")
            return stop

        service = VisionService(runner_factory=runner_factory)
        self.assertTrue(service.start(1))

        self.assertFalse(service.stop())
        self.assertEqual(service.status()["state"], "running")
        self.assertEqual(service.status()["cameraIndex"], 1)
        self.assertIn("vision_application_stop_timeout", service.status()["error"])
        self.assertEqual(service.current_session()["state"], "error")
        self.assertFalse(service.start(2))

    def test_actions_are_validated_before_reaching_runner(self):
        service = VisionService(runner_factory=lambda _index, _publish: lambda: None)
        service.start(1)

        accepted = service.handle_action({"type": "path.draw", "points": [[10, 20], [30, 40]]})
        rejected = service.handle_action({"type": "shell.execute", "value": "bad"})

        self.assertTrue(accepted)
        self.assertFalse(rejected)
        self.assertEqual(
            service.next_action(),
            {"type": "path.draw", "points": [[10, 20], [30, 40]]},
        )
        self.assertIsNone(service.next_action())

    def test_selection_modes_are_accepted_while_running(self):
        service = VisionService(runner_factory=lambda _index, _publish: lambda: None)
        service.start(1)

        for action_type in ("marker.select", "heading.select", "calibration.toggle"):
            with self.subTest(action_type=action_type):
                self.assertTrue(service.handle_action({"type": action_type}))

    def test_stop_discards_pending_canvas_actions_before_restart(self):
        service = VisionService(runner_factory=lambda _index, _publish: lambda: None)
        service.start(1)
        self.assertTrue(service.handle_action({
            "type": "path.draw",
            "points": [[10, 20], [30, 40]],
        }))

        service.stop()
        self.assertFalse(service.handle_action({"type": "path.clear"}))
        service.start(1)

        self.assertIsNone(service.next_action())

    def test_exposure_completion_is_visible_in_session_status(self):
        service = VisionService(runner_factory=lambda _index, _publish: lambda: None)
        snapshot = service.create_session("camera-1", 1)
        service.publish({
            "type": "camera.exposure",
            "actionId": "action-1",
            "status": "completed",
            "supported": True,
            "actualValue": -5,
            "errorCode": None,
        })

        current = service.current_session()
        self.assertEqual(current["sessionId"], snapshot["sessionId"])
        self.assertEqual(current["metrics"]["exposure"]["actualValue"], -5)
        self.assertEqual(current["lastAction"]["actionId"], "action-1")


if __name__ == "__main__":
    unittest.main()
