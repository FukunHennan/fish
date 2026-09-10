#!/usr/bin/env python3
"""Run a short physical tracking smoke test through the workspace vision path."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
AUTH_PATH = Path(os.environ.get("FISH_AUTH_USERS", Path.home() / ".config/fish-controller/users.json"))
REPORT_PATH = ROOT / "docs" / "2026-09-07循迹实测记录.md"


def request(method: str, url: str, headers: dict[str, str] | None = None, body=None, timeout=5):
    data = None
    all_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=all_headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        text = response.read().decode("utf-8")
        return json.loads(text) if text else None


def workspace_identity(device_id: str):
    path = Path(str(AUTH_PATH) + ".reservations.json")
    reservations = json.loads(path.read_text(encoding="utf-8"))
    lease = reservations.get(device_id)
    if not lease:
        raise SystemExit(f"没有找到 {device_id} 的控制权记录：{path}")
    owner = lease.get("ownerId", "")
    client = lease.get("clientId", "")
    if not owner or not client:
        raise SystemExit(f"{device_id} 的控制权记录缺少 ownerId/clientId")
    return owner, client


def first_detection(snapshot):
    yolo = snapshot["data"].get("metrics", {}).get("yolo", {})
    detections = yolo.get("detections") or []
    return detections[0] if detections else None


def workflow(snapshot):
    return snapshot["data"].get("metrics", {}).get("workflow", {})


def append_report(lines: list[str]):
    with REPORT_PATH.open("a", encoding="utf-8") as report:
        report.write("\n".join(lines))
        report.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="AC:27:6E:7E:FD:24")
    parser.add_argument("--base", default="http://127.0.0.1:8091")
    parser.add_argument("--seconds", type=int, default=8)
    parser.add_argument("--pixels", type=int, default=240)
    parser.add_argument("--direction", choices=("left", "right", "up", "down"), default="left")
    parser.add_argument("--mode", choices=("single_fish", "yolo"), default="single_fish")
    args = parser.parse_args()
    if args.pixels < 180:
        raise SystemExit("路径长度至少 180px；太短会落入停止半径，无法验证实物推进。")

    owner, client = workspace_identity(args.device)
    headers = {"X-Fish-Workspace-User": owner, "X-Fish-Workspace-Client": client}
    base = f"{args.base.rstrip('/')}/workspaces/{args.device}"
    timeline = []
    session_id = None

    try:
        current = request("GET", f"{base}/sessions/current", headers)
        session_id = current["data"]["sessionId"]
        request("POST", f"{base}/sessions/{session_id}/actions", headers, {"type": "tracking.mode", "mode": args.mode})
        time.sleep(1)

        current = request("GET", f"{base}/sessions/current", headers)
        session_id = current["data"]["sessionId"]
        detection = first_detection(current)
        if detection is None:
            raise SystemExit("没有检测到机器鱼，取消本轮实物循迹")
        cx, cy = [round(value) for value in detection["center"]]
        delta = {
            "left": (-args.pixels, 0),
            "right": (args.pixels, 0),
            "up": (0, -args.pixels),
            "down": (0, args.pixels),
        }[args.direction]
        points = [
            [cx, cy],
            [cx + round(delta[0] * 0.5), cy + round(delta[1] * 0.5)],
            [cx + delta[0], cy + delta[1]],
        ]
        if args.mode == "yolo":
            request(
                "POST",
                f"{base}/sessions/{session_id}/target",
                headers,
                {"targetDeviceId": args.device, "targetTrackId": detection.get("trackId")},
            )
        request("POST", f"{base}/sessions/{session_id}/actions", headers, {"type": "path.draw", "points": points})
        time.sleep(1)

        ready = request("GET", f"{base}/sessions/current", headers)
        if not workflow(ready).get("canStart"):
            raise SystemExit(f"循迹未就绪：{workflow(ready).get('blockers')}")

        request("POST", f"{base}/sessions/{session_id}/actions", headers, {"type": "tracking.start"})
        for index in range(args.seconds):
            time.sleep(1)
            sample = request("GET", f"{base}/sessions/current", headers)
            wf = workflow(sample)
            det = first_detection(sample) or {}
            timeline.append({
                "t": index + 1,
                "stage": wf.get("stage"),
                "status": wf.get("status"),
                "active": wf.get("trackingActive"),
                "positionReady": wf.get("positionReady"),
                "center": det.get("center"),
                "blockers": wf.get("blockers"),
            })
            print(json.dumps(timeline[-1], ensure_ascii=False))
            if wf.get("status") in ("ARRIVED", "TARGET LOST", "CONTROL OFFLINE", "PATH INVALID"):
                break
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8", errors="replace"))
        raise
    finally:
        if session_id:
            try:
                request("POST", f"{base}/sessions/{session_id}/actions", headers, {"type": "tracking.stop"}, timeout=3)
            except Exception as error:
                print(f"STOP failed: {error}")

    if timeline:
        final = timeline[-1]
        start = timeline[0].get("center") or [None, None]
        end = final.get("center") or [None, None]
        observed = None
        if start[0] is not None and end[0] is not None:
            observed = [round(end[0] - start[0], 1), round(end[1] - start[1], 1)]
        append_report([
            "",
            f"### 自动 smoke：{time.strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            f"- 模式：`{args.mode}`；方向：`{args.direction}`；路径长度：约 `{args.pixels}px`。",
            f"- 首帧：`{timeline[0]}`",
            f"- 末帧：`{final}`",
            f"- 观测位移：`{observed}`（仅作画面位移参考，不能单独证明主动循迹）。",
        ])


if __name__ == "__main__":
    main()
