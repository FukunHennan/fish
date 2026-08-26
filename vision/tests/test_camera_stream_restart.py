import threading
import time
import unittest
from unittest.mock import patch

from camera_stream import RestartSafeCameraStream


class FakeFrame:
    def copy(self):
        return self


class FakeCapture:
    def __init__(self, block_after_first=False):
        self.block_after_first = block_after_first
        self.read_count = 0
        self.released = False
        self.release_event = threading.Event()

    def set(self, _key, _value):
        return True

    def get(self, key):
        values = {3: 1280, 4: 720, 5: 60}
        return values.get(key, 0)

    def read(self):
        self.read_count += 1
        if self.read_count == 1:
            return True, FakeFrame()
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


if __name__ == "__main__":
    unittest.main()
