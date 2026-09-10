import threading
import time
import unittest
from unittest.mock import patch

import cv2

from camera_stream import RestartSafeCameraStream


class FakeFrame:
    def copy(self):
        return self


class FakeCapture:
    def __init__(
        self,
        block_after_first=False,
        opened=True,
        first_frame=True,
        set_error_key=None,
        fail_after_reads=None,
    ):
        self.block_after_first = block_after_first
        self._opened = opened
        self.first_frame = first_frame
        self.set_error_key = set_error_key
        self.fail_after_reads = fail_after_reads
        self.read_count = 0
        self.released = False
        self.release_event = threading.Event()

    def isOpened(self):
        return self._opened

    def set(self, key, _value):
        if self.set_error_key is not None and key == self.set_error_key:
            raise cv2.error("simulated driver error")
        return True

    def get(self, key):
        values = {3: 1280, 4: 720, 5: 60}
        return values.get(key, 0)

    def read(self):
        self.read_count += 1
        if self.read_count == 1:
            return (True, FakeFrame()) if self.first_frame else (False, None)
        if (
            self.fail_after_reads is not None
            and self.read_count > self.fail_after_reads
        ):
            return False, None
        if self.block_after_first:
            self.release_event.wait(timeout=1)
            return False, None
        time.sleep(0.005)
        return True, FakeFrame()

    def release(self):
        self.released = True
        self.release_event.set()


def wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


class RestartSafeCameraStreamTests(unittest.TestCase):
    def setUp(self):
        # These tests replace VideoCapture with fakes. Keep the host's real
        # camera identity policy out of the fake-device lifecycle tests.
        self.camera_policy = patch(
            "camera_policy.camera_blocked",
            return_value=False,
        )
        self.camera_policy.start()
        self.addCleanup(self.camera_policy.stop)

    def test_release_waits_for_capture_thread_and_releases_device(self):
        capture = FakeCapture(block_after_first=False)
        with patch("camera_stream.cv2.VideoCapture", return_value=capture):
            stream = RestartSafeCameraStream(1).start()
            time.sleep(0.02)
            stream.release()

        self.assertTrue(capture.released)
        self.assertFalse(stream.thread.is_alive())
        self.assertTrue(stream.stopped)

    def test_release_unblocks_a_driver_stuck_in_read(self):
        capture = FakeCapture(block_after_first=True)
        with patch("camera_stream.cv2.VideoCapture", return_value=capture):
            stream = RestartSafeCameraStream(1).start()
            time.sleep(0.02)
            stream.release()

        self.assertTrue(capture.released)
        self.assertFalse(stream.thread.is_alive())

    def test_released_stream_object_cannot_be_started_again(self):
        capture = FakeCapture(block_after_first=False)
        with patch("camera_stream.cv2.VideoCapture", return_value=capture):
            stream = RestartSafeCameraStream(1).start()
            stream.release()
            with self.assertRaisesRegex(RuntimeError, "camera_stream_cannot_restart"):
                stream.start()

    def test_falls_back_when_directshow_cannot_open(self):
        directshow = FakeCapture(opened=False)
        msmf = FakeCapture(opened=True)

        with patch(
            "camera_stream.cv2.VideoCapture",
            side_effect=[directshow, msmf],
        ), patch(
            "camera_stream._backend_candidates",
            return_value=[("DSHOW", 1), ("MSMF", 2)],
        ):
            stream = RestartSafeCameraStream(1)

        self.assertTrue(directshow.released)
        self.assertEqual(stream.backend_name, "MSMF")
        stream.release()

    def test_falls_back_when_backend_opens_but_has_no_first_frame(self):
        directshow = FakeCapture(opened=True, first_frame=False)
        msmf = FakeCapture(opened=True, first_frame=True)

        with patch(
            "camera_stream.cv2.VideoCapture",
            side_effect=[directshow, msmf],
        ), patch(
            "camera_stream._backend_candidates",
            return_value=[("DSHOW", 1), ("MSMF", 2)],
        ):
            stream = RestartSafeCameraStream(1)

        self.assertTrue(directshow.released)
        self.assertEqual(stream.backend_name, "MSMF")
        stream.release()

    def test_fps_configuration_exception_does_not_abort_camera_startup(self):
        capture = FakeCapture(
            opened=True,
            first_frame=True,
            set_error_key=cv2.CAP_PROP_FPS,
        )

        with patch(
            "camera_stream.cv2.VideoCapture",
            return_value=capture,
        ), patch(
            "camera_stream._backend_candidates",
            return_value=[("DSHOW", 1)],
        ):
            stream = RestartSafeCameraStream(1)

        self.assertEqual(stream.backend_name, "DSHOW")
        self.assertTrue(stream.ret)
        stream.release()

    def test_auto_rebuilds_capture_after_device_failure(self):
        dying = FakeCapture()
        healthy = FakeCapture()
        opened = []

        def fake_open(source):
            opened.append(source)
            if len(opened) == 1:
                return dying, "ANY", FakeFrame()
            return healthy, "ANY", FakeFrame()

        with patch(
            "camera_stream._open_working_capture",
            side_effect=fake_open,
        ), patch(
            "camera_stream._linux_v4l2_present_names",
            return_value={1: "Global Shutter Camera: Global S"},
        ), patch(
            "camera_stream.CAMERA_STALL_RECOVERY_S",
            0.05,
        ), patch(
            "camera_stream.CAMERA_RECOVERY_RETRY_S",
            0.01,
        ):
            stream = RestartSafeCameraStream(1).start()
            self.assertTrue(wait_until(lambda: dying.read_count >= 3))
            dying.fail_after_reads = dying.read_count

            self.assertTrue(
                wait_until(
                    lambda: stream.cap is healthy and not stream._recovering
                ),
                "capture should be rebuilt after the device goes away",
            )
            self.assertTrue(wait_until(lambda: healthy.read_count >= 2))
            stream.release()

        self.assertTrue(dying.released)
        self.assertTrue(healthy.released)
        self.assertFalse(stream.thread.is_alive())

    def test_recovery_finds_same_camera_at_new_v4l2_index(self):
        original = FakeCapture()
        replacement = FakeCapture()
        name_calls = []
        opened = []

        def present_names():
            name_calls.append(1)
            if len(name_calls) == 1:
                return {1: "Global Shutter Camera: Global S"}
            return {
                1: "USB2.0 FHD UVC WebCam",
                2: "Global Shutter Camera: Global S",
            }

        def fake_open(source):
            opened.append(source)
            if len(opened) == 1:
                return original, "ANY", FakeFrame()
            if source == 1:
                # Replugged the other camera into the old node.
                raise RuntimeError("该摄像头已被项目禁用")
            if source == 2:
                return replacement, "ANY", FakeFrame()
            raise RuntimeError("camera_open_failed")

        with patch(
            "camera_stream._open_working_capture",
            side_effect=fake_open,
        ), patch(
            "camera_stream._linux_v4l2_present_names",
            side_effect=present_names,
        ), patch(
            "camera_stream.CAMERA_STALL_RECOVERY_S",
            0.05,
        ), patch(
            "camera_stream.CAMERA_RECOVERY_RETRY_S",
            0.01,
        ):
            stream = RestartSafeCameraStream(1).start()
            self.assertTrue(wait_until(lambda: original.read_count >= 3))
            original.fail_after_reads = original.read_count

            self.assertTrue(
                wait_until(
                    lambda: stream.cap is replacement and not stream._recovering
                ),
                "recovery should follow the camera to its new node",
            )
            self.assertEqual(stream.src, 2)
            self.assertEqual(stream.backend_name, "ANY")
            stream.release()

        self.assertEqual(opened, [1, 1, 2])
        self.assertTrue(original.released)
        self.assertTrue(replacement.released)


if __name__ == "__main__":
    unittest.main()
