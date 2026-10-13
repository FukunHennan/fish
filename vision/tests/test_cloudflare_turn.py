import unittest
from unittest.mock import patch

from cloudflare_turn import CloudflareTurnProvider


class CloudflareTurnTests(unittest.TestCase):
    def test_refresh_failure_never_returns_expired_credentials(self):
        provider = CloudflareTurnProvider("key", "token", ttl=600)
        servers = [{"urls": ["turn:example.test:3478"], "username": "user", "credential": "test"}]
        with patch("cloudflare_turn.time.time", return_value=1000), patch.object(provider, "_request_credentials", return_value=servers):
            self.assertEqual(provider.get_ice_servers(), servers)
        with patch.object(provider, "_request_credentials", side_effect=RuntimeError("unavailable")) as request:
            with patch("cloudflare_turn.time.time", return_value=1301):
                self.assertEqual(provider.get_ice_servers(), servers)
                self.assertEqual(provider.get_ice_servers(), servers)
                self.assertEqual(request.call_count, 1)
            with patch("cloudflare_turn.time.time", return_value=1601):
                self.assertEqual(provider.get_ice_servers(), [])
                self.assertEqual(provider.get_ice_servers(), [])
                self.assertEqual(request.call_count, 2)

    def test_successful_refresh_resets_error_and_extends_validity(self):
        provider = CloudflareTurnProvider("key", "token", ttl=600)
        provider._last_error = "previous failure"
        with patch("cloudflare_turn.time.time", return_value=2000), patch.object(provider, "_request_credentials", return_value=[{"urls": ["turn:example.test"]}]):
            self.assertTrue(provider.get_ice_servers())
        self.assertEqual(provider.last_error, "")
        self.assertEqual(provider._valid_until, 2600)
