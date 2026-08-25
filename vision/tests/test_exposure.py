import unittest

import cv2

from interface import apply_manual_exposure


class FakeCapture:
    def __init__(self, value=-6, auto_ok=True, exposure_ok=True, apply=True):
        self.value = value
        self.auto_ok = auto_ok
        self.exposure_ok = exposure_ok
        self.apply = apply

    def get(self, prop):
        return self.value if prop == cv2.CAP_PROP_EXPOSURE else 0

    def set(self, prop, value):
        if prop == cv2.CAP_PROP_AUTO_EXPOSURE:
            return self.auto_ok
        if prop == cv2.CAP_PROP_EXPOSURE:
            if self.apply:
                self.value = value
            return self.exposure_ok
        return False


class ExposureTests(unittest.TestCase):
    def test_success_requires_driver_readback_to_change(self):
        result = apply_manual_exposure(FakeCapture(), 1)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.previous_value, -6)
        self.assertEqual(result.actual_value, -5)
        self.assertTrue(result.supported)

    def test_rejected_manual_mode_is_reported_as_unsupported(self):
        result = apply_manual_exposure(FakeCapture(auto_ok=False), 1)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.actual_value, -5)
        self.assertTrue(result.supported)

    def test_false_exposure_set_return_is_ignored_when_readback_changes(self):
        result = apply_manual_exposure(FakeCapture(exposure_ok=False, apply=True), 1)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.actual_value, -5)

    def test_successful_set_without_readback_change_is_not_success(self):
        result = apply_manual_exposure(FakeCapture(apply=False), -1)
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error_code, "exposure_not_applied")


if __name__ == "__main__":
    unittest.main()
