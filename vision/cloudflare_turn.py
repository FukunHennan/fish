"""Cloudflare Realtime TURN credential provisioning."""

from __future__ import annotations

import json
import os
import threading
import time
from copy import deepcopy
from urllib.error import HTTPError
from urllib.request import Request, urlopen


TURN_CREDENTIALS_URL = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/"
    "{key_id}/credentials/generate-ice-servers"
)


class CloudflareTurnProvider:
    """Cache short-lived TURN credentials without exposing the API token."""

    def __init__(self, key_id=None, api_token=None, ttl=None):
        self.key_id = (key_id or os.environ.get("FISH_CLOUDFLARE_TURN_KEY_ID", "")).strip()
        self.api_token = (api_token or os.environ.get("FISH_CLOUDFLARE_TURN_API_TOKEN", "")).strip()
        try:
            self.ttl = max(600, int(ttl or os.environ.get("FISH_CLOUDFLARE_TURN_TTL", "86400")))
        except ValueError:
            self.ttl = 86400
        self._lock = threading.Lock()
        self._ice_servers = []
        self._expires_at = 0.0
        self._valid_until = 0.0
        self._retry_after = 0.0
        self._last_error = ""

    @property
    def configured(self):
        return bool(self.key_id and self.api_token)

    @property
    def last_error(self):
        return self._last_error

    def get_ice_servers(self):
        if not self.configured:
            return []
        with self._lock:
            now = time.time()
            if self._ice_servers and now < self._expires_at:
                return deepcopy(self._ice_servers)
            if now < self._retry_after:
                return deepcopy(self._ice_servers) if now < self._valid_until else []
            try:
                servers = self._request_credentials()
            except Exception as error:
                self._last_error = str(error)
                self._retry_after = time.time() + 30
                if self._ice_servers and time.time() < self._valid_until:
                    return deepcopy(self._ice_servers)
                return []
            self._ice_servers = servers
            self._expires_at = now + max(60, self.ttl - 300)
            self._valid_until = now + self.ttl
            self._retry_after = 0.0
            self._last_error = ""
            return deepcopy(servers)

    def _request_credentials(self):
        url = TURN_CREDENTIALS_URL.format(key_id=self.key_id)
        request = Request(
            url,
            data=json.dumps({"ttl": self.ttl}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "RoboFish-Pro1/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=8) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"Cloudflare TURN 凭据请求失败: HTTP {response.status}")
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace").strip()
            if len(detail) > 240:
                detail = detail[:240]
            suffix = f": {detail}" if detail else ""
            raise RuntimeError(
                f"Cloudflare TURN 凭据请求失败: HTTP {error.code}{suffix}"
            ) from error
        raw_servers = payload.get("iceServers")
        if not isinstance(raw_servers, list) or not raw_servers:
            raise RuntimeError("Cloudflare TURN 响应中没有 iceServers")
        servers = []
        for item in raw_servers:
            if not isinstance(item, dict):
                continue
            urls = item.get("urls")
            if isinstance(urls, str):
                urls = [urls]
            if not isinstance(urls, list):
                continue
            urls = [str(value).strip() for value in urls if str(value).strip()]
            username = str(item.get("username", "")).strip()
            credential = str(item.get("credential", "")).strip()
            if urls and username and credential:
                servers.append({
                    "urls": urls,
                    "username": username,
                    "credential": credential,
                })
        if not servers:
            raise RuntimeError("Cloudflare TURN 响应中的服务器配置无效")
        return servers
