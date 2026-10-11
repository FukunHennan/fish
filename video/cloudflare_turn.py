"""Issue short-lived Cloudflare Realtime TURN credentials server-side."""


from __future__ import annotations

import json
from urllib.request import Request, urlopen


class CloudflareTurnError(RuntimeError):
    """Cloudflare could not provide usable temporary ICE servers."""


class CloudflareTurnCredentials:
    def __init__(self, key_id, api_token, ttl=86400, opener=urlopen):
        self.key_id = key_id.strip()
        self.api_token = api_token.strip()
        self.ttl = ttl
        self.opener = opener

    @property
    def configured(self):
        return bool(self.key_id and self.api_token)

    def generate(self):
        if not self.configured:
            raise CloudflareTurnError("Cloudflare TURN 未配置完整")
        request = Request(
            f"https://rtc.live.cloudflare.com/v1/turn/keys/{self.key_id}/credentials/generate-ice-servers",
            data=json.dumps({"ttl": self.ttl}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json",
                "User-Agent": "FishVision/1.0",
            },
            method="POST",
        )
        try:
            with self.opener(request, timeout=4) as response:
                servers = json.load(response)["iceServers"]
        except Exception as error:
            raise CloudflareTurnError("Cloudflare TURN 临时凭据获取失败") from error
        if not isinstance(servers, list):
            raise CloudflareTurnError("Cloudflare TURN 返回了无效凭据")
        has_turn = False
        usable_servers = []
        for server in servers:
            if not isinstance(server, dict):
                raise CloudflareTurnError("Cloudflare TURN 返回了无效凭据")
            urls = server.get("urls")
            urls = urls if isinstance(urls, list) else [urls]
            if not urls or not all(
                isinstance(url, str) and url.startswith(("stun:", "turn:", "turns:"))
                for url in urls
            ):
                raise CloudflareTurnError("Cloudflare TURN 返回了无效凭据")
            urls = [url for url in urls if not url.split("?", 1)[0].endswith(":53")]
            if not urls:
                continue
            if any(url.startswith(("turn:", "turns:")) for url in urls):
                if (
                    not isinstance(server.get("username"), str) or not server["username"]
                    or not isinstance(server.get("credential"), str) or not server["credential"]
                ):
                    raise CloudflareTurnError("Cloudflare TURN 返回了无效凭据")
                has_turn = True
            usable_servers.append({**server, "urls": urls})
        if not has_turn:
            raise CloudflareTurnError("Cloudflare TURN 返回了无效凭据")
        return usable_servers
