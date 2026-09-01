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
    ):
        self.block_after_first = block_after_first
        self._opened = opened
        self.first_frame = first_frame
        self.set_error_key = set_error_key
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
        if self.block_after_first:
            self.release_event.wait(timeout=1)
            return False, None
        time.sleep(0.005)
        return True, FakeFrame()

    def release(self):
        self.released = True
        self.release_event.set()


class RestartSafeCameraStreamTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
