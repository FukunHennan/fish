from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

Import("env")


def _find_toolchain() -> Path | None:
    candidates = []
    configured = os.environ.get("FISH_MINGW_BIN")
    if configured:
        candidates.append(Path(configured))
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        candidates.append(
            Path(localappdata) / "Programs" / "WinLibs" / "mingw64" / "bin"
        )
    for candidate in candidates:
        if (candidate / "gcc.exe").is_file() and (candidate / "g++.exe").is_file():
            return candidate
    return None


def _find_windows_sdk_user32() -> Path | None:
    program_files_x86 = os.environ.get("ProgramFiles(x86)")
    if not program_files_x86:
        return None
    root = Path(program_files_x86) / "Windows Kits" / "10" / "Lib"
    candidates = sorted(root.glob("*/um/x64/User32.Lib"))
    return candidates[-1] if candidates else None


def _ensure_user32_import_lib(tool_bin: Path, support_dir: Path) -> None:
    support_dir.mkdir(parents=True, exist_ok=True)
    archive = support_dir / "libuser32.a"
    if archive.exists():
        return
    sdk_user32 = _find_windows_sdk_user32()
    if sdk_user32 is not None:
        shutil.copy2(sdk_user32, archive)
        return
    gcc = tool_bin / "gcc.exe"
    ar = tool_bin / "ar.exe"
    if not gcc.is_file() or not ar.is_file():
        return
    with tempfile.TemporaryDirectory(dir=support_dir) as temp_dir:
        temp_path = Path(temp_dir)
        source = temp_path / "user32_stub.c"
        object_file = temp_path / "user32_stub.o"
        source.write_text("void codex_user32_stub(void) {}\n", encoding="ascii")
        subprocess.run([str(gcc), "-c", str(source), "-o", str(object_file)], check=True)
        subprocess.run([str(ar), "rcs", str(archive), str(object_file)], check=True)


if env.get("PIOENV") == "native" and os.name == "nt":
    tool_bin = _find_toolchain()
    if tool_bin is None:
        raise RuntimeError(
            "native tests require MinGW; install WinLibs or set FISH_MINGW_BIN"
        )
    tool_path = str(tool_bin)
    env.PrependENVPath("PATH", tool_path)
    current_path = os.environ.get("PATH", "")
    if tool_path.lower() not in {
        entry.lower() for entry in current_path.split(os.pathsep) if entry
    }:
        os.environ["PATH"] = tool_path + os.pathsep + current_path
    env["ENV"]["PATH"] = os.environ["PATH"]
    support_dir = Path(env.subst("$PROJECT_WORKSPACE_DIR")) / "native-support"
    _ensure_user32_import_lib(tool_bin, support_dir)
    env.AppendUnique(LIBPATH=[str(support_dir)])
    env.AppendUnique(LINKFLAGS=["-static", "-static-libgcc", "-static-libstdc++"])
