"""浏览器管理:起 / 停 / 查独立 profile 的 Chromium,带扩展与会话页.

与 ``scripts/env-up.sh`` 的浏览器段同源(那是几轮真机验证过的稳定逻辑),
这一版用 Python 重写,让 ``dsb env`` 成为统一入口.两套并行到
``env-up.sh`` 的浏览器段废弃为止.
"""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
import time
from datetime import datetime
from pathlib import Path

from dsb.config import repo_root

PROFILE_ENV_KEY = "DSB_PROFILE"
CHROME_ENV_KEY = "CHROME"
DEFAULT_DEBUG_PORT = 9222
STARTUP_WAIT = 2.0
KILL_GRACE = 5.0


def chrome_path() -> Path | None:
    explicit = os.environ.get(CHROME_ENV_KEY)
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.is_file() and os.access(p, os.X_OK) else None
    if platform.system() == "Darwin":
        for name in ("Chromium", "Google Chrome"):
            candidate = Path(f"/Applications/{name}.app/Contents/MacOS/{name.replace(' ', '')}")
            if candidate.is_file():
                return candidate
        return None
    for name in (
        "chromium", "chromium-browser", "google-chrome",
        "google-chrome-stable", "brave-browser", "microsoft-edge",
    ):
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def profile_path() -> Path:
    explicit = os.environ.get(PROFILE_ENV_KEY)
    if explicit:
        return Path(explicit).expanduser()
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "ds-browser"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg) / "ds-browser"


def mv3_dir() -> Path:
    return repo_root() / ".output" / "chrome-mv3"


def _clear_state(profile: Path) -> None:
    """清 SW 脚本缓存与会话恢复状态."""
    for rel in (
        "Default/Service Worker/ScriptCache",
        "Default/Service Worker/Database",
        "Default/Sessions",
        "Default/Last Session",
        "Default/Last Tabs",
    ):
        path = profile / rel
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.is_file():
            path.unlink(missing_ok=True)


def _browser_pids(profile: Path) -> list[int]:
    if platform.system() == "Darwin":
        out = subprocess.run(
            ["ps", "ax", "-o", "pid=,command="],
            capture_output=True, text=True, check=False,
        ).stdout
        pids: list[int] = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            pid_str, _, command = line.partition(" ")
            if f"--user-data-dir={profile}" not in command:
                continue
            if "--type=" in command:
                continue
            try:
                pids.append(int(pid_str))
            except ValueError:
                continue
        return pids
    out = subprocess.run(
        ["pgrep", "-f", f"--user-data-dir={profile}"],
        capture_output=True, text=True, check=False,
    ).stdout
    pids = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pid = int(line)
        except ValueError:
            continue
        cmdline = Path(f"/proc/{pid}/cmdline")
        if not cmdline.is_file():
            continue
        try:
            content = cmdline.read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        if "--type=" in content:
            continue
        pids.append(pid)
    return pids


def _command_of(pid: int) -> str:
    if platform.system() == "Darwin":
        return subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, check=False,
        ).stdout
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\x00", b" ").decode(
            "utf-8", "replace"
        )
    except OSError:
        return ""


def _loaded_extension(pid: int) -> bool:
    return "--load-extension=" in _command_of(pid)


def _started_at(pid: int) -> float | None:
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(
                ["ps", "-p", str(pid), "-o", "lstart="],
                capture_output=True, text=True, check=False,
                env={**os.environ, "LC_ALL": "C"},
            ).stdout.strip()
            if not out:
                return None
            return datetime.strptime(" ".join(out.split()), "%a %b %d %H:%M:%S %Y").timestamp()
        stat = Path(f"/proc/{pid}/stat").read_text().split()
        ticks = int(stat[21])
        boot = time.time() - float(Path("/proc/uptime").read_text().split()[0])
        return boot + ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError):
        return None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
    deadline = time.monotonic() + KILL_GRACE
    while time.monotonic() < deadline:
        if not any(_alive(pid) for pid in pids):
            return
        time.sleep(0.2)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def browser_up(debug: bool = False, debug_port: int = DEFAULT_DEBUG_PORT) -> int:
    exe = chrome_path()
    if exe is None:
        print("  浏览器   找不到 Chromium 系浏览器(设 CHROME 指向可执行文件)")
        return 1
    build = mv3_dir() / "background.js"
    if not build.is_file():
        print(f"  浏览器   扩展产物缺失:{build}(先跑 pnpm build)")
        return 1
    profile = profile_path()
    profile.mkdir(parents=True, exist_ok=True)

    pids = _browser_pids(profile)
    if pids:
        pid = pids[0]
        started = _started_at(pid)
        stale = started is not None and build.stat().st_mtime > started
        has_ext = _loaded_extension(pid)
        has_debug = (not debug) or f"--remote-debugging-port={debug_port}" in _command_of(pid)
        if has_ext and not stale and has_debug:
            print(f"  浏览器   已在跑(PID {pid}),扩展是新的")
            return 0
        why = []
        if not has_ext:
            why.append("没带 --load-extension")
        if stale:
            why.append("扩展比构建旧")
        if not has_debug:
            why.append("没带调试口")
        print(f"  浏览器   重启(PID {pid},{','.join(why)})")
        _kill(pids)

    _clear_state(profile)
    argv = [
        str(exe),
        f"--user-data-dir={profile}",
        f"--load-extension={mv3_dir()}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if debug:
        argv.insert(3, f"--remote-debugging-port={debug_port}")
    argv.append("https://chat.deepseek.com/")
    subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(STARTUP_WAIT)
    pids = _browser_pids(profile)
    if not pids:
        print("  浏览器   没起来")
        return 1
    print(f"  浏览器   已起(PID {pids[0]},profile {profile},调试口 {'开' if debug else '关'})")
    return 0


def browser_stop() -> int:
    profile = profile_path()
    pids = _browser_pids(profile)
    if not pids:
        print("  浏览器   没在跑")
        return 0
    _kill(pids)
    print(f"  浏览器   已停({len(pids)} 个进程)")
    return 0


def browser_status() -> int:
    profile = profile_path()
    build = mv3_dir() / "background.js"
    pids = _browser_pids(profile)
    if not pids:
        print("  浏览器   没在跑")
        return 0
    pid = pids[0]
    started = _started_at(pid)
    stale = started is not None and build.is_file() and build.stat().st_mtime > started
    has_ext = _loaded_extension(pid)
    parts = [f"PID {pid}"]
    if not has_ext:
        parts.append("没带 --load-extension(扩展没装进来)")
    elif stale:
        parts.append("扩展比构建旧(跑旧代码)")
    else:
        parts.append("扩展是新的")
    print(f"  浏览器   {';'.join(parts)}")
    return 0
