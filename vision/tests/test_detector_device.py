import unittest

import numpy as np

from perception import FishDetector, resolve_inference_device


class DetectorDeviceTests(unittest.TestCase):
    def test_cuda_index_falls_back_when_loaded_model_is_on_cpu(self):
        self.assertEqual(resolve_inference_device(0, "cpu"), "cpu")
        self.assertEqual(resolve_inference_device(0, "cuda:0"), 0)
        self.assertEqual(resolve_inference_device("cpu", "cpu"), "cpu")

    def test_colour_signature_distinguishes_coloured_fish_regions(self):
        green = np.full((80, 120, 3), (0, 220, 0), dtype=np.uint8)
        red = np.full((80, 120, 3), (0, 0, 220), dtype=np.uint8)
        self.assertEqual(FishDetector._colour_signature(green, [0, 0, 120, 80])[0], "GREEN")
        self.assertEqual(FishDetector._colour_signature(red, [0, 0, 120, 80])[0], "RED")


if __name__ == "__main__":
    unittest.main()
