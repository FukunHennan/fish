import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path
import numpy as np
import crop_region as roi
import video_transform as transform
from types import SimpleNamespace
from service import VisionService
from web_api import create_app

class CropTests(unittest.TestCase):
    def test_crop_and_persistence(self):
        region = {"x":.25,"y":.25,"width":.5,"height":.5}
        frame=np.arange(80*100*3).reshape(80,100,3)
        result=roi.crop(frame,region)
        np.testing.assert_array_equal(result,frame[20:60,25:75])
        with tempfile.TemporaryDirectory() as folder, patch.object(roi,"PATH",Path(folder)/"crop.json"):
            roi.save(region); self.assertEqual(roi.load(),region)
            roi.save(roi.FULL); self.assertEqual(roi.load(),roi.FULL)
    def test_invalid_regions_rejected(self):
        for value in [{},dict(roi.FULL,width=0),dict(roi.FULL,x=.1),dict(roi.FULL,x=float('nan'))]:
            with self.assertRaises(ValueError): roi.validate(value)
    def test_preview_restarts_without_old_target(self):
        stopped=[]
        crop_updates=[]
        service=VisionService(runner_factory=lambda *_:lambda:stopped.append(True))
        service.create_session('camera-3',3,'fish')
        with tempfile.TemporaryDirectory() as folder, patch.object(roi,"PATH",Path(folder)/"crop.json"):
            client=create_app(
                service,
                camera_provider=lambda:[],
                webrtc_server=SimpleNamespace(set_crop_region=lambda value:crop_updates.append(value)),
            ).test_client()
            response=client.put('/crop',json={"x":.1,"y":.1,"width":.8,"height":.8})
            self.assertEqual(response.status_code,200)
            self.assertEqual(len(stopped),1)
            self.assertEqual(crop_updates,[{"x":.1,"y":.1,"width":.8,"height":.8}])
            self.assertIsNone(service.current_session()['targetDeviceId'])

    def test_rotation_and_persistence(self):
        frame = np.zeros((5, 5, 3), dtype=np.uint8)
        frame[1, 2] = (10, 20, 30)
        rotated = transform.rotate(frame, 180)
        np.testing.assert_array_equal(rotated[3, 2], (10, 20, 30))
        with tempfile.TemporaryDirectory() as folder, patch.object(transform, "PATH", Path(folder) / "transform.json"):
            self.assertEqual(transform.load(), transform.DEFAULT)
            self.assertEqual(transform.save({"angle": 12.5}), {"angle": 12.5})
            self.assertEqual(transform.load(), {"angle": 12.5})

    def test_invalid_rotation_is_rejected(self):
        for value in ({}, {"angle": True}, {"angle": 181}, {"angle": float("nan")}):
            with self.assertRaises(ValueError):
                transform.validate(value)

    def test_rotation_update_restarts_preview(self):
        stopped = []
        service = VisionService(runner_factory=lambda *_: lambda: stopped.append(True))
        service.create_session("camera-3", 3)
        with tempfile.TemporaryDirectory() as folder, patch.object(transform, "PATH", Path(folder) / "transform.json"):
            client = create_app(service, camera_provider=lambda: []).test_client()
            response = client.put("/rotation", json={"angle": -7.5})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {"angle": -7.5})
            self.assertEqual(len(stopped), 1)
