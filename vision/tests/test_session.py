import unittest

from session import (
    InvalidTransition,
    SessionMismatch,
    VisionSession,
    VisionState,
)


class VisionSessionTests(unittest.TestCase):
    def test_only_legal_state_transitions_are_allowed(self):
        session = VisionSession.new(camera_id="camera-1", camera_index=1)
        self.assertEqual(session.state, VisionState.OPENING)
        session.transition(VisionState.PREVIEWING)
        session.transition(VisionState.PROCESSING)
        session.transition(VisionState.TRACKING)
        session.transition(VisionState.STOPPING)
        session.transition(VisionState.IDLE)

        with self.assertRaises(InvalidTransition):
            session.transition(VisionState.TRACKING)

    def test_snapshot_has_stable_web_contract(self):
        session = VisionSession.new(
            camera_id="camera-2",
            camera_index=2,
            target_device_id="fish-2",
            target_track_id=7,
        )
        snapshot = session.snapshot()

        self.assertEqual(snapshot["state"], "opening")
        self.assertEqual(snapshot["cameraId"], "camera-2")
        self.assertEqual(snapshot["cameraIndex"], 2)
        self.assertEqual(snapshot["targetDeviceId"], "fish-2")
        self.assertEqual(snapshot["targetTrackId"], 7)
        self.assertGreaterEqual(len(snapshot["sessionId"]), 24)
        self.assertIsNone(snapshot["error"])

    def test_session_identity_mismatch_is_rejected(self):
        session = VisionSession.new(camera_id="camera-1", camera_index=1)
        with self.assertRaises(SessionMismatch):
            session.require_id("old-session")


if __name__ == "__main__":
    unittest.main()
