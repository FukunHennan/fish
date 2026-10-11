import io

import json
import unittest

from cloudflare_turn import CloudflareTurnCredentials, CloudflareTurnError


class CloudflareTurnTests(unittest.TestCase):
    def test_generates_short_lived_ice_servers_without_exposing_api_token(self):
        requests = []
        response = {
            "iceServers": [
                {"urls": ["stun:stun.cloudflare.com:3478"]},
                {
                    "urls": ["turn:turn.cloudflare.com:443?transport=udp"],
                    "username": "temporary-user",
                    "credential": "temporary-password",
                },
            ],
        }

        def open_request(request, timeout):
            requests.append((request, timeout))
            return io.BytesIO(json.dumps(response).encode("utf-8"))

        issuer = CloudflareTurnCredentials("key-id", "private-api-token", opener=open_request)
        self.assertEqual(issuer.generate(), response["iceServers"])
        request, timeout = requests[0]
        self.assertEqual(request.full_url, "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"ttl": 86400})
        self.assertEqual(request.get_header("Authorization"), "Bearer private-api-token")
        self.assertEqual(request.get_header("User-agent"), "FishVision/1.0")
        self.assertEqual(timeout, 4)

    def test_rejects_missing_turn_credentials(self):
        response = {"iceServers": [{"urls": ["turn:turn.cloudflare.com:3478?transport=udp"]}]}
        issuer = CloudflareTurnCredentials(
            "key-id", "private-api-token",
            opener=lambda request, timeout: io.BytesIO(json.dumps(response).encode("utf-8")),
        )
        with self.assertRaises(CloudflareTurnError):
            issuer.generate()

    def test_filters_port_53_before_non_trickle_ice(self):
        response = {"iceServers": [{
            "urls": [
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:443?transport=udp",
            ],
            "username": "temporary-user",
            "credential": "temporary-password",
        }]}
        issuer = CloudflareTurnCredentials(
            "key-id", "private-api-token",
            opener=lambda request, timeout: io.BytesIO(json.dumps(response).encode("utf-8")),
        )
        self.assertEqual(
            issuer.generate()[0]["urls"],
            ["turn:turn.cloudflare.com:443?transport=udp"],
        )

    def test_network_error_does_not_include_api_token(self):
        def fail(request, timeout):
            raise OSError("network unavailable")

        issuer = CloudflareTurnCredentials("key-id", "private-api-token", opener=fail)
        with self.assertRaises(CloudflareTurnError) as raised:
            issuer.generate()
        self.assertNotIn("private-api-token", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
