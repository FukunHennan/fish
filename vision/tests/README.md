# Vision Tests

Run the active suite from the repository root:

```bash
python3 -m unittest discover -s vision/tests -t . -p 'test_*.py'
```

The active tests cover:

- camera discovery, restart, exposure, and crop configuration
- YOLO device selection and target tracking
- single-fish target locking and heading calibration
- path coordinates, navigation, and Go-controller communication
- vision session/API lifecycle and WebRTC contracts

`legacy/` contains compatibility checks for the retired MJPEG browser path.
Those checks are retained for reference but are excluded from the default
vision regression suite.
