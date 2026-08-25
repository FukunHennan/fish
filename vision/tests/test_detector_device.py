import unittest

from perception import resolve_inference_device


class DetectorDeviceTests(unittest.TestCase):
    def test_cuda_index_falls_back_when_loaded_model_is_on_cpu(self):
        self.assertEqual(resolve_inference_device(0, "cpu"), "cpu")
        self.assertEqual(resolve_inference_device(0, "cuda:0"), 0)
        self.assertEqual(resolve_inference_device("cpu", "cpu"), "cpu")


if __name__ == "__main__":
    unittest.main()
