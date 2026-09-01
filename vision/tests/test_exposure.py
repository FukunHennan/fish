import unittest
from unittest.mock import patch

import cv2

from interface import (
    apply_manual_exposure,
    apply_manual_exposure_for_device,
    prepare_v4l2_capture,
)


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
    def test_v4l2_capture_preparation_restores_auto_exposure_and_fps(self):
        class Completed:
            def __init__(self, stdout="", returncode=0):
                self.stdout = stdout
                self.returncode = returncode

        controls = (
            "auto_exposure 0x0 (menu) : min=0 max=3 default=3 value=1\n"
            "  exposure_dynamic_framerate 0x0 (bool) : default=0 value=1"
        )
        calls = []

        def fake_run(args, **_kwargs):
            calls.append(args)
            if "--list-ctrls" in args:
                return Completed(controls)
            return Completed()

        with patch("interface.shutil.which", return_value="/usr/bin/v4l2-ctl"), patch(
            "interface.subprocess.run", side_effect=fake_run
        ):
            prepared = prepare_v4l2_capture(0)

        self.assertTrue(prepared)
        self.assertIn("auto_exposure=3,exposure_dynamic_framerate=0", calls[-1][-1])

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

    def test_v4l2_fallback_is_used_when_opencv_readback_does_not_change(self):
        calls = []

        class Completed:
            def __init__(self, stdout="", returncode=0):
                self.stdout = stdout
                self.returncode = returncode

        control_before = "exposure_auto 0x0 (menu) : min=0 max=3 default=3 value=3\nexposure_absolute 0x0 (int) : min=3 max=2031 step=1 default=250 value=100"
        control_after = "exposure_auto 0x0 (menu) : min=0 max=3 default=3 value=1\nexposure_absolute 0x0 (int) : min=3 max=2031 step=1 default=250 value=201"

        def fake_run(args, **_kwargs):
            calls.append(args)
            if "--list-ctrls" in args:
                return Completed(control_after if len([c for c in calls if "--list-ctrls" in c]) > 1 else control_before)
            return Completed()

        with patch("interface.shutil.which", return_value="/usr/bin/v4l2-ctl"), patch("interface.subprocess.run", side_effect=fake_run):
            result = apply_manual_exposure_for_device(FakeCapture(apply=False), 1, 0)

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.previous_value, 100)
        self.assertEqual(result.actual_value, 201)
        self.assertTrue(any("exposure_auto=1" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
