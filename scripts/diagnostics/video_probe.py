"""Measure a real Chromium receiver without changing the active match or camera."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import statistics
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


def request_json(base, path, cookie, timeout, body=None):
    headers = {"Accept": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(base + path, data=data, headers=headers), timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"{path}: HTTP {error.code}") from None


def interval(previous, current):
    elapsed = (current["timestampMs"] - previous["timestampMs"]) / 1000
    if elapsed <= 0:
        return {}
    result = {}
    for counter, name, factor in [("framesDecoded", "fps", 1), ("renderedFrames", "renderedFps", 1),
                                  ("bytesReceived", "kbps", 0.008)]:
        before, after = previous.get(counter), current.get(counter)
        if before is not None and after is not None and after >= before:
            result[name] = round((after - before) * factor / elapsed, 2)
    lost = current.get("packetsLost")
    received = current.get("packetsReceived")
    if all(value is not None for value in [lost, received, previous.get("packetsLost"), previous.get("packetsReceived")]):
        lost_delta = max(0, lost - previous["packetsLost"])
        received_delta = received - previous["packetsReceived"]
        if received_delta >= 0 and lost_delta + received_delta > 0:
            result["lossPercent"] = round(100 * lost_delta / (lost_delta + received_delta), 3)
    return result


def select_turn_servers(servers, transport):
    if transport == "auto":
        return servers
    selected = []
    for server in servers:
        urls = server.get("urls", [])
        if isinstance(urls, str):
            urls = [urls]
        matching = []
        for url in urls:
            if not url.startswith(("turn:", "turns:")):
                continue
            protocol = "tcp" if url.startswith("turns:") or "transport=tcp" in url else "udp"
            if protocol == transport:
                matching.append(url)
        if matching:
            selected.append({**server, "urls": matching})
    if not selected:
        raise RuntimeError("No TURN URLs for requested transport")
    return selected


def summarize(samples, events, policy, min_fps, max_gap_ms, max_loss_percent=3):
    active = [sample for sample in samples if sample.get("framesDecoded", 0)]
    reasons = []
    totals = interval(active[0], active[-1]) if len(active) > 1 else {}
    if not active:
        reasons.append("no_video_frames")
    elif totals.get("fps", 0) < min_fps:
        reasons.append("low_decode_fps")
    if active and totals.get("renderedFps", 0) < min_fps:
        reasons.append("low_rendered_fps")
    if totals.get("lossPercent", 0) > max_loss_percent:
        reasons.append("high_packet_loss")
    max_gap = max((sample["maxFrameGapMs"] for sample in samples), default=0)
    if max_gap > max_gap_ms:
        reasons.append("video_freeze")
    if any(event["connection"] in ("failed", "disconnected") for event in events):
        reasons.append("connection_interrupted")
    paths = [sample["selectedPath"] for sample in samples if sample["selectedPath"]]
    if policy == "relay" and (not paths or any(path.get("local") != "relay" for path in paths)):
        reasons.append("relay_path_not_verified")
    rtts = [sample["rttMs"] for sample in samples if sample.get("rttMs") is not None]
    return {"passed": not reasons, "reasons": reasons, **totals, "maxFrameGapMs": round(max_gap),
            "medianRttMs": round(statistics.median(rtts), 1) if rtts else None,
            "selectedPath": paths[-1] if paths else None}


async def run(args, report):
    from playwright.async_api import async_playwright

    base = args.base.rstrip("/") + args.api_prefix.rstrip("/")
    cookie = os.environ.get(args.cookie_env, "") if args.cookie_env else ""
    report["phase"] = "read_session"
    payload = await asyncio.to_thread(request_json, base, "/sessions/current", cookie, args.timeout)
    session = payload.get("data", payload)
    if session.get("state") not in ("previewing", "processing", "tracking"):
        raise RuntimeError("No active camera session; start the project video first")
    report["phase"] = "turn_credentials"
    config = await asyncio.to_thread(request_json, base, "/webrtc/config", cookie, args.timeout)
    if not config.get("available"):
        raise RuntimeError("WebRTC or TURN is unavailable")
    report["sourceMetrics"] = {name: session.get("metrics", {}).get(name) for name in ("cameraFps", "fps", "processingMs")}
    async with async_playwright() as playwright:
        report["phase"] = "launch_browser"
        browser = await playwright.chromium.launch(channel=args.browser, headless=True,
            args=["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling"])
        try:
            page = await browser.new_page()
            await page.set_content('<video autoplay muted playsinline style="width:640px;height:480px"></video>')
            await page.add_script_tag(path=str(Path(__file__).with_suffix(".js")))
            report["phase"] = "gather_ice"
            offer = await page.evaluate("setupVideoProbe", {"iceServers": select_turn_servers(config.get("iceServers", []), args.turn_transport),
                "policy": args.policy, "bufferMs": args.buffer_ms, "timeoutMs": args.timeout * 1000})
            report["phase"] = "offer"
            answer = await asyncio.to_thread(request_json, base, "/webrtc/offer", cookie, args.timeout,
                {**offer, "sessionId": session["sessionId"], "quality": "smooth", "view": "cropped"})
            await page.evaluate("answer => window.videoProbe.peer.setRemoteDescription(answer)", answer)
            report["phase"] = "wait_first_frame"
            await page.wait_for_function("window.videoProbe.firstFrameMs !== null", timeout=args.timeout * 1000)
            report["phase"] = "sample_video"
            started = time.monotonic()
            last_view_slot = 0
            while True:
                elapsed = time.monotonic() - started
                view_slot = int(elapsed / 5)
                if args.switch_views and view_slot > last_view_slot:
                    view = "full" if view_slot % 2 else "cropped"
                    await asyncio.to_thread(request_json, base, "/webrtc/view", cookie, args.timeout,
                        {"peerId": answer["peerId"], "view": view})
                    last_view_slot = view_slot
                    report.setdefault("viewChanges", []).append({"atSeconds": round(elapsed, 2), "view": view})
                sample = await page.evaluate("sampleVideoProbe")
                samples = report["samples"]
                if samples:
                    sample.update(interval(samples[-1], sample))
                samples.append(sample)
                print(json.dumps({key: sample.get(key) for key in ("connection", "fps", "kbps", "lossPercent", "rttMs")}), flush=True)
                remaining = args.seconds - (time.monotonic() - started)
                if remaining <= 0:
                    break
                await asyncio.sleep(min(1, remaining))
        finally:
            if "page" in locals():
                try:
                    report["events"] = await page.evaluate("window.videoProbe?.events || []")
                    await page.evaluate("window.videoProbe?.peer.close()")
                except Exception:
                    pass
            await browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8091")
    parser.add_argument("--api-prefix", default="", help="Use /api/vision for controller URLs")
    parser.add_argument("--cookie-env", help="Environment variable holding an authorized controller session cookie")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--browser", default="msedge" if os.name == "nt" else "chromium", choices=("msedge", "chrome", "chromium"))
    parser.add_argument("--policy", default="relay", choices=("relay", "all"))
    parser.add_argument("--turn-transport", default="auto", choices=("auto", "udp", "tcp"))
    parser.add_argument("--switch-views", action="store_true", help="Switch full/cropped every five seconds on the same TURN connection")
    parser.add_argument("--buffer-ms", type=int, default=200)
    parser.add_argument("--min-fps", type=float, default=20)
    parser.add_argument("--max-gap-ms", type=int, default=3000)
    parser.add_argument("--max-loss-percent", type=float, default=3)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("base must be an HTTP(S) URL without embedded credentials, query or fragment")
    if args.seconds < 5 or args.timeout < 1 or not 0 <= args.buffer_ms <= 4000 or args.min_fps <= 0 or args.max_gap_ms <= 0 or not 0 <= args.max_loss_percent <= 100:
        parser.error("invalid duration, timeout, buffer or acceptance threshold")
    timestamp = datetime.now(timezone.utc)
    report_path = args.report or ROOT / "controller/diagnostics/runs" / f"video-{timestamp:%Y%m%dT%H%M%S}-{args.policy}.json"
    report = {"startedAt": timestamp.isoformat(), "base": args.base, "policy": args.policy, "turnTransport": args.turn_transport,
              "bufferMs": args.buffer_ms, "durationSeconds": args.seconds,
              "thresholds": {"minFps": args.min_fps, "maxFrameGapMs": args.max_gap_ms, "maxLossPercent": args.max_loss_percent},
              "scope": "Network path from the computer running this script; not proof of another viewer's network",
              "samples": [], "events": []}
    log_path = ROOT / "controller/.runtime/supervisor.out.log"
    log_offset = log_path.stat().st_size if log_path.exists() else None
    try:
        asyncio.run(run(args, report))
        report["phase"] = "complete"
    except KeyboardInterrupt:
        report["error"] = "interrupted"
    except Exception as error:
        report["error"] = type(error).__name__
        print(f"Probe failed during {report.get('phase')}: {type(error).__name__}", flush=True)
    report["summary"] = summarize(report["samples"], report["events"], args.policy, args.min_fps, args.max_gap_ms, args.max_loss_percent)
    if "error" in report:
        report["summary"]["passed"] = False
        report["summary"]["reasons"].append("probe_error")
    if log_offset is not None and log_path.exists():
        with log_path.open("rb") as log:
            log.seek(log_offset)
            content = log.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
        report["serverLog"] = {"channelBindErrorOccurrences": content.count("message_method=Method.CHANNEL_BIND, message_class=Class.ERROR"),
                               "scope": "All viewers during this run, not necessarily this probe"}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False), flush=True)
    print(f"Report: {report_path}", flush=True)
    return 0 if report["summary"]["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
