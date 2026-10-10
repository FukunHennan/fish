"""Short-lived Cloudflare TURN credentials shared by browser and aiortc."""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from urllib import request

from config import WORK_DIR


TURN_KEY_FILE = Path(WORK_DIR).parent.parent / "Pro1-runtime" / "cloudflare-turn-key.json"
TURN_TTL_SECONDS = 86400
REFRESH_MARGIN_SECONDS = 3600


class TurnCredentialsError(RuntimeError):
    """Safe error message for a missing or unusable TURN configuration."""


class CloudflareTurnCredentials:
    def __init__(self, path=TURN_KEY_FILE, opener=None, clock=None):
        self.path = Path(path)
        self._opener = opener or request.urlopen
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._cached = None
        self._cached_key = None
        self._refresh_at = 0.0

    def configured(self):
        return self.path.is_file()

    def seconds_until_refresh(self):
        """Tell an existing browser when to reconnect for a fresh ICE pair."""
        with self._lock:
            return max(60, int(self._refresh_at - self._clock()))

    def ice_servers(self):
        if not self.configured():
            return None
        with self._lock:
            try:
                key = json.loads(self.path.read_text(encoding="utf-8-sig"))
                key_id = key["keyId"].strip()
                api_token = key["apiToken"].strip()
                if not api_token or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key_id):
                    raise ValueError("invalid TURN key")
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
                raise TurnCredentialsError("本机 Cloudflare TURN Key 文件无效") from error

            now = self._clock()
            if self._cached and self._cached_key == (key_id, api_token) and now < self._refresh_at:
                return [dict(item) for item in self._cached]

            url = (
                "https://rtc.live.cloudflare.com/v1/turn/keys/"
                f"{key_id}/credentials/generate-ice-servers"
            )
            payload = json.dumps({"ttl": TURN_TTL_SECONDS}).encode("ascii")
            turn_request = request.Request(
                url,
                data=payload,
                headers={
                    "Authorization": f"Bearer {api_token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            try:
                with self._opener(turn_request, timeout=5) as response:
                    received = json.load(response)
                servers = self._validate_servers(received)
            except Exception as error:
                # Keep a still-valid credential if a scheduled refresh fails.
                if self._cached and self._cached_key == (key_id, api_token) and now < self._refresh_at + REFRESH_MARGIN_SECONDS:
                    return [dict(item) for item in self._cached]
                raise TurnCredentialsError("Cloudflare TURN 临时凭据获取失败") from error

            self._cached = servers
            self._cached_key = (key_id, api_token)
            self._refresh_at = now + TURN_TTL_SECONDS - REFRESH_MARGIN_SECONDS
            return [dict(item) for item in servers]

    @staticmethod
    def _validate_servers(response):
        servers = response.get("iceServers") if isinstance(response, dict) else None
        if not isinstance(servers, list):
            raise ValueError("missing iceServers")
        cleaned = []
        has_turn = False
        for server in servers:
            if not isinstance(server, dict):
                continue
            urls = server.get("urls")
            urls = [urls] if isinstance(urls, str) else urls
            if not isinstance(urls, list):
                continue
            urls = [
                url for url in urls
                if isinstance(url, str)
                and url.startswith(("stun:", "turn:", "turns:"))
                and not re.search(r":53(?:\?|$)", url)
            ]
            if not urls:
                continue
            entry = {"urls": urls}
            if any(url.startswith(("turn:", "turns:")) for url in urls):
                username = server.get("username")
                credential = server.get("credential")
                if not isinstance(username, str) or not username or not isinstance(credential, str) or not credential:
                    continue
                entry.update(username=username, credential=credential)
                has_turn = True
            cleaned.append(entry)
        if not has_turn:
            raise ValueError("missing TURN server")
        return cleaned


cloudflare_turn = CloudflareTurnCredentials()
