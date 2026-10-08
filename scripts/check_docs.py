#!/usr/bin/env python3
"""Check only documentation affected by a Git push, or audit long-lived drift."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
CATEGORIES = ("程序", "硬件", "概述", "开发日志")
LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def git(*args: str) -> bytes:
    return subprocess.check_output(("git", *args), cwd=ROOT, stderr=subprocess.PIPE)


def changed_paths(base: str, head: str) -> list[tuple[str, str]]:
    if base and set(base) == {"0"}:
        output = git("diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", head)
    else:
        output = git("diff", "--no-ext-diff", "--name-status", "--find-renames", "-z", base, head)
    fields = [item.decode("utf-8") for item in output.split(b"\0") if item]
    changes = []
    index = 0
    while index < len(fields):
        status = fields[index]
        index += 1
        if status.startswith(("R", "C")):
            old_path, new_path = fields[index:index + 2]
            index += 2
            changes.extend((("D", old_path), ("A", new_path)))
        else:
            changes.append((status[:1], fields[index]))
            index += 1
    return changes


def required_categories(changes: list[tuple[str, str]]) -> set[str]:
    required = set()
    for status, path in changes:
        if path.startswith("docs/") or path in {"README.md", "config/README.md"}:
            continue
        required.add("开发日志")
        if path.startswith("controller/") or path.startswith("vision/") or path.startswith("scripts/") or path == "environment-build.ps1":
            required.add("程序")
        if path.startswith("firmware/") or path == "config/firmware.json" or path.startswith("protocol/"):
            required.update(("程序", "硬件"))
        if path in {"config/program.json", "config/tunnel.json"}:
            required.add("程序")
        if path.startswith("vision/camera") or path.startswith("vision/video_transform"):
            required.add("硬件")
        if status in {"A", "D"} or path.startswith(".github/") or path == "scripts/check_docs.py":
            required.add("概述")
    return required


def markdown_links(paths: list[Path]) -> list[str]:
    errors = []
    for document in paths:
        if not document.is_file():
            continue
        for target in LINK.findall(document.read_text(encoding="utf-8-sig")):
            target = target.strip().split("#", 1)[0]
            if not target or target.startswith(("http:", "https:", "mailto:", "data:", "/")):
                continue
            target = unquote(target.strip("<>"))
            if not (document.parent / target).exists():
                errors.append(f"{document.relative_to(ROOT)}: broken link {target}")
    return errors


def check_push(base: str, head: str) -> list[str]:
    changes = changed_paths(base, head)
    required = required_categories(changes)
    touched = {
        path.split("/", 2)[1]
        for status, path in changes
        if status != "D" and path.startswith("docs/") and len(path.split("/")) >= 3
    }
    errors = [f"{category} 文档需要随关联源码更新：docs/{category}/"
              for category in sorted(required - touched)]
    changed_markdown = [ROOT / path for status, path in changes
                        if status != "D" and path.endswith(".md")]
    errors.extend(markdown_links(changed_markdown))
    print("关联分类：", ", ".join(sorted(required)) or "无源码变化")
    print("已更新分类：", ", ".join(sorted(touched)) or "无")
    return errors


def last_commit_time(paths: tuple[str, ...]) -> int:
    try:
        value = git("log", "-1", "--format=%ct", "--", *paths).strip()
    except subprocess.CalledProcessError:
        return 0
    return int(value) if value else 0


def check_stale(days: int) -> list[str]:
    sources = {
        "程序": ("controller", "vision", "scripts", "config/program.json", "config/tunnel.json", "protocol"),
        "硬件": ("firmware", "config/firmware.json", "vision/camera_stream.py", "vision/camera_policy.py"),
        "概述": ("controller", "vision", "firmware", "config", "scripts", "protocol"),
        "开发日志": ("controller", "vision", "firmware", "config", "scripts", "protocol", ".github"),
    }
    now = int(time.time())
    errors = []
    for category, source_paths in sources.items():
        doc_time = last_commit_time((f"docs/{category}",))
        code_time = last_commit_time(source_paths)
        if not doc_time:
            errors.append(f"docs/{category}/ 尚无提交记录")
        elif now - doc_time >= days * 86400 and code_time > doc_time:
            errors.append(f"docs/{category}/ 已超过 {days} 天未更新，相关代码后来发生变化")
    errors.extend(markdown_links(list(DOCS.rglob("*.md")) + [ROOT / "README.md", ROOT / "config/README.md"]))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("push", "stale", "links"), required=True)
    parser.add_argument("--base", default="")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--days", type=int, default=45)
    args = parser.parse_args()
    if args.mode == "push" and not args.base:
        parser.error("push mode requires --base")
    if args.days < 1:
        parser.error("--days must be positive")
    try:
        if args.mode == "push":
            errors = check_push(args.base, args.head)
        elif args.mode == "stale":
            errors = check_stale(args.days)
        else:
            errors = markdown_links(list(DOCS.rglob("*.md")) + [ROOT / "README.md", ROOT / "config/README.md"])
    except (subprocess.CalledProcessError, UnicodeError) as error:
        print(f"文档检查无法运行：{error}", file=sys.stderr)
        return 2
    for error in errors:
        print("ERROR:", error, file=sys.stderr)
    if not errors:
        print("文档检查通过")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
