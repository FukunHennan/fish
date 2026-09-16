import unittest
from types import SimpleNamespace

import numpy as np

from perception import FishDetector, VisionPipeline, resolve_inference_device


class DetectorDeviceTests(unittest.TestCase):
    def test_cuda_index_is_strict_and_never_falls_back_to_cpu(self):
        with self.assertRaisesRegex(RuntimeError, "CPU fallback is disabled"):
            resolve_inference_device(0, "cpu", cuda_available=False)
        self.assertEqual(resolve_inference_device(0, "cuda:0", cuda_available=True), 0)
        self.assertEqual(resolve_inference_device("cpu", "cpu"), "cpu")
        self.assertEqual(resolve_inference_device(0, "cpu", cuda_available=True), 0)

    def test_colour_signature_distinguishes_coloured_fish_regions(self):
        green = np.full((80, 120, 3), (0, 220, 0), dtype=np.uint8)
        red = np.full((80, 120, 3), (0, 0, 220), dtype=np.uint8)
        self.assertEqual(FishDetector._colour_signature(green, [0, 0, 120, 80])[0], "GREEN")
        self.assertEqual(FishDetector._colour_signature(red, [0, 0, 120, 80])[0], "RED")


class TargetSelectionTests(unittest.TestCase):
    def make_pipeline(self):
        detector = SimpleNamespace()
        reference = SimpleNamespace()
        velocity = SimpleNamespace(reset=lambda: None)
        return VisionPipeline(detector, reference, velocity, lambda *args: None)

    def test_locked_target_does_not_guess_when_track_id_changes(self):
        pipeline = self.make_pipeline()
        pipeline.set_target_track(7)
        first = pipeline._select_target({
            "detections": [{
                "trackId": 7,
                "center": [100.0, 120.0],
                "bbox": [80.0, 100.0, 120.0, 140.0],
                "confidence": 0.8,
            }],
        })

        second = pipeline._select_target({
            "detections": [{
                "trackId": 8,
                "center": [108.0, 123.0],
                "bbox": [88.0, 103.0, 128.0, 143.0],
                "confidence": 0.7,
            }],
        })

        self.assertTrue(first["targetFound"])
        self.assertFalse(second["targetFound"])
        self.assertEqual(second["targetTrackId"], 7)
        self.assertEqual(second["track_id"], 7)

    def test_locked_target_does_not_fallback_when_multiple_detections_exist(self):
        pipeline = self.make_pipeline()
        pipeline.set_target_track(7)
        pipeline._select_target({
            "detections": [{
                "trackId": 7,
                "center": [100.0, 120.0],
                "bbox": [80.0, 100.0, 120.0, 140.0],
                "confidence": 0.8,
            }],
        })

        selected = pipeline._select_target({
            "detections": [
                {"trackId": 8, "center": [104.0, 122.0], "bbox": [84.0, 102.0, 124.0, 142.0], "confidence": 0.7},
                {"trackId": 9, "center": [300.0, 320.0], "bbox": [280.0, 300.0, 320.0, 340.0], "confidence": 0.7},
            ],
        })

        self.assertFalse(selected["targetFound"])


if __name__ == "__main__":
    unittest.main()
