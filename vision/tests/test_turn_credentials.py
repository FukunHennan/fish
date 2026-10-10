import io
import json
import tempfile
import unittest
from pathlib import Path

from turn_credentials import CloudflareTurnCredentials, TurnCredentialsError


class TurnCredentialsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "turn-key.json"
        self.path.write_text(json.dumps({"keyId": "test_key", "apiToken": "private-token"}), encoding="utf-8")
        self.now = 1000.0
        self.calls = []

    def opener(self, turn_request, timeout):
        self.calls.append((turn_request, timeout))
        return io.BytesIO(json.dumps({"iceServers": [
            {"urls": ["stun:stun.cloudflare.com:3478"]},
            {"urls": ["turn:turn.cloudflare.com:3478?transport=udp",
                      "turns:turn.cloudflare.com:5349?transport=tcp",
                      "turn:turn.cloudflare.com:53?transport=udp"],
             "username": "temporary-user", "credential": "temporary-password"},
        ]}).encode("utf-8"))

    def test_fetches_and_caches_short_lived_credentials_without_exposing_key(self):
        provider = CloudflareTurnCredentials(self.path, self.opener, lambda: self.now)
        servers = provider.ice_servers()
        self.assertEqual(len(servers), 2)
        self.assertEqual(servers[1]["credential"], "temporary-password")
        self.assertIn("turns:turn.cloudflare.com:5349?transport=tcp", servers[1]["urls"])
        self.assertNotIn("turn:turn.cloudflare.com:53?transport=udp", servers[1]["urls"])
        self.assertNotIn("private-token", json.dumps(servers))
        self.assertEqual(self.calls[0][0].get_header("Authorization"), "Bearer private-token")
        self.assertEqual(self.calls[0][1], 5)
        self.assertEqual(provider.ice_servers(), servers)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(provider.seconds_until_refresh(), 82800)
        self.now += 86400
        provider.ice_servers()
        self.assertEqual(len(self.calls), 2)

    def test_invalid_response_fails_with_safe_message(self):
        provider = CloudflareTurnCredentials(self.path, lambda *_args, **_kwargs: io.BytesIO(b'{"iceServers": []}'))
        with self.assertRaisesRegex(TurnCredentialsError, "TURN") as raised:
            provider.ice_servers()
        self.assertNotIn("private-token", str(raised.exception))

    def test_missing_key_keeps_existing_stun_configuration(self):
        self.path.unlink()
        provider = CloudflareTurnCredentials(self.path)
        self.assertIsNone(provider.ice_servers())


if __name__ == "__main__":
    unittest.main()
