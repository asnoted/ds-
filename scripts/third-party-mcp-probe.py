#!/usr/bin/env python3
"""第三方 MCP server 的真机腿: 自起一份中继, 量启动, 真卡死, 重起, 与"收摊后有没有留下孤儿".

**为什么要有它**: ADR-0003 那三道闸里, "超时即换孩子"的现场在真机上 -- 替身 server 量不出
`npx` 那三层形状(中继 → `npm exec` 壳 → `node` 真身). 2026-10-18 这条腿上揪出过"只杀壳,
孙子留着"的洞(读数见 `docs/evidence/gateway-timeouts.md`), 摊开一次要能重来一遍.

**它不动你的环境**: 自己写一份临时 `mcp.json`, 中继起在 `--port`(起之前先看端口空不空),
工作根是临时目录; 收摊把中继与它整棵树一起收, 再按"命令行带着这个临时根"兜一遍. env-up
那份(8787)在另一个端口, 不会被认成自家的.

**它量四件**:
  1. 启动: 拉起中继到"限额:"那行落地的秒数(第一次要 npx 下包, 慢就慢在这);
  2. 卡死: 用那个 server 的读工具读 `<根>/hang.fifo`(一根没人写的 FIFO, 读它就卡住), 看
     是不是 `--timeout` 秒那一刻回 `tool-timeout`;
  3. 孤儿: 卡死掐掉那一刻, 进程表里还有没有"命令行带着这个临时根,却不是中继后代"的 --
     这就是 2026-10-18 那个洞的判据;
  4. 重起: 掐掉之后读一件正常文件, 报它多久拿到答复(包在 npx 缓存里, 不该重下).

**不进 `pnpm quality`**: npx 第一次要联网下包. 用法与判定纪律见 `docs/probe.md`.

**用法**:
    uv run scripts/third-party-mcp-probe.py
    uv run scripts/third-party-mcp-probe.py --timeout 8 --port 8799
    uv run scripts/third-party-mcp-probe.py --command '["npx", "-y", "some-other-server"]' --keep

`--command` 是 JSON 数组; 里面写 `<根>` 的位置会换成临时工作根, 不写且没给 `--append-root`
就不补(有的 server 不吃路径参数).

退出码: 0 = 四件都照预期(卡死按 `--timeout` 到点, 没有孤儿, 重起拿到答复); 1 = 有一件不是;
2 = 环境不对(端口被占, 中继起不来).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

TAG = "[third-party-mcp]"

#: 默认拿官方那个文件 server: 它工具面宽, 读一根 FIFO 就够造一次真卡死.
DEFAULT_COMMAND = ["npx", "-y", "@modelcontextprotocol/server-filesystem"]

#: 临时工作根在命令里的占位.
ROOT_MARK = "<根>"

#: "到点"与"重起"的容差: 进程启动与信道开销.
HANG_SLACK = 3.0


def config_text(command: list[str]) -> str:
    """一份只配一件 server 的 `mcp.json` 文本(形状见 `dsb/gateway.py` 的模块说明)."""
    body = {"mcpServers": {"probe": {"command": command}}}
    return json.dumps(body, ensure_ascii=False, indent=2) + "\n"


def command_of(args: argparse.Namespace, root: Path) -> list[str]:
    """命令行: 默认那件补上临时根; 自带的按 `<根>` 占位(或 `--append-root`)补."""
    parts = json.loads(args.command) if args.command else list(DEFAULT_COMMAND)
    if ROOT_MARK not in parts and (args.command is None or args.append_root):
        parts = [*parts, ROOT_MARK]
    return [str(root) if part == ROOT_MARK else part for part in parts]


def parse_ps(text: str) -> dict[int, tuple[int, str]]:
    """`ps -ax -o pid=,ppid=,command=` 的输出 → {pid: (父 pid, 命令行)}; 认不出的行丢掉."""
    table: dict[int, tuple[int, str]] = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        table[pid] = (ppid, parts[2])
    return table


def ps_table() -> dict[int, tuple[int, str]]:
    done = subprocess.run(  # noqa: S603 - 就是为了看进程表
        ["ps", "-ax", "-o", "pid=,ppid=,command="],
        capture_output=True,
        text=True,
        check=True,
    )
    return parse_ps(done.stdout)


def descendants(table: dict[int, tuple[int, str]], root: int) -> set[int]:
    """按父指针从 root 收下所有后代(表里查不到的当叶子)."""
    kids: dict[int, list[int]] = {}
    for pid, (ppid, _cmd) in table.items():
        kids.setdefault(ppid, []).append(pid)
    seen: set[int] = set()
    stack = [root]
    while stack:
        for kid in kids.get(stack.pop(), []):
            if kid not in seen:
                seen.add(kid)
                stack.append(kid)
    return seen


def strays(table: dict[int, tuple[int, str]], needle: str, root: int) -> list[tuple[int, str]]:
    """命令行带着 `needle`,却不是 `root` 后代的那些 -- 换了爹的"还在转的孩子"(ADR-0003)."""
    mine = descendants(table, root) | {root}
    return [
        (pid, cmd)
        for pid, (_ppid, cmd) in sorted(table.items())
        if needle in cmd and pid not in mine
    ]


def port_busy(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.2)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def rpc(port: int, payload: dict[str, Any], wait: float) -> tuple[Any, float]:
    """打一件 JSON-RPC 到中继, 回 (结果, 秒数)."""
    request = urllib.request.Request(  # noqa: S310 - 就是打本机
        f"http://127.0.0.1:{port}/mcp",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=wait) as reply:  # noqa: S310
        body = json.loads(reply.read().decode())
    return body, time.monotonic() - started


def call(port: int, name: str, arguments: dict[str, Any], wait: float) -> tuple[str, bool, float]:
    """一次 `tools/call` → (那句话, 是不是错, 秒数)."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    body, seconds = rpc(port, payload, wait)
    result = (body or {}).get("result") or {}
    said = ""
    for chunk in result.get("content") or []:
        if isinstance(chunk, dict) and chunk.get("type") == "text":
            said = str(chunk.get("text", ""))
            break
    return said, bool(result.get("isError")), seconds


def pick_tool(port: int, wanted: str) -> str:
    """挑一件读工具: 名字各版本不同(`read_file` / `read_text_file`), 跟着目录走而不是写死."""
    body, _ = rpc(port, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}, 20)
    names = [str(item.get("name", "")) for item in (body.get("result") or {}).get("tools") or []]
    for suffix in (wanted, "read_file", "read_text_file"):
        for name in names:
            if name.endswith(suffix):
                return name
    raise SystemExit(f"{TAG} 目录里没有读工具: {names}")


class Relay:
    """临时那份中继: 起, 等自己那行"限额", 收摊连整棵树一起收."""

    def __init__(self, port: int, config: Path, root: Path, tool_timeout: float, log: Path) -> None:
        self.port = port
        self.config = config
        self.root = root
        self.tool_timeout = tool_timeout
        self.log = log
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self) -> float:
        """起中继, 回"到'限额:'那行"的秒数."""
        env = {
            **os.environ,
            "DSB_MCP_CONFIG": str(self.config),
            "DSB_PORT": str(self.port),
            "DSB_TOOL_TIMEOUT": f"{self.tool_timeout:g}",
            "DSB_WORK_ROOT": str(self.root),
        }
        started = time.monotonic()
        with self.log.open("wb") as handle:
            self.proc = subprocess.Popen(  # noqa: S603 - 就是起本仓的中继
                [sys.executable, "-m", "dsb.server"],
                stdout=handle,
                stderr=subprocess.STDOUT,
                cwd=str(Path(__file__).resolve().parent.parent),
                env=env,
                start_new_session=True,
            )
        while time.monotonic() - started < 120:
            if "限额:" in self.log.read_text(encoding="utf-8", errors="replace"):
                return time.monotonic() - started
            if self.proc.poll() is not None:
                raise SystemExit(f"{TAG} 中继自己退了, 看 {self.log}")
            time.sleep(0.2)
        raise SystemExit(f"{TAG} 两分钟没等到'限额:'那行, 看 {self.log}")

    def pid(self) -> int:
        assert self.proc is not None
        return self.proc.pid

    def stop(self) -> None:
        if self.proc is None:
            return
        proc, self.proc = self.proc, None
        with contextlib.suppress(OSError, ValueError):
            os.killpg(proc.pid, signal.SIGTERM)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=6)
        with contextlib.suppress(OSError, ValueError):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(OSError, ValueError):
            proc.wait()


def run(args: argparse.Namespace) -> int:
    if port_busy(args.port):
        print(f"{TAG} 端口 {args.port} 已经有人在听, 换一个再跑(--port)", file=sys.stderr)
        return 2
    work = Path(tempfile.mkdtemp(prefix="dsb-mcp-probe-"))
    root = work / "root"
    root.mkdir()
    (root / "hello.txt").write_text("探针留的: 读得到就是通的.\n", encoding="utf-8")
    os.mkfifo(root / "hang.fifo")
    parts = command_of(args, root)
    config = work / "mcp.json"
    config.write_text(config_text(parts), encoding="utf-8")
    print(f"{TAG} 临时工作根: {root}")
    print(f"{TAG} 命令: {shutil.which(parts[0]) or parts[0]} {' '.join(parts[1:])}")

    relay = Relay(args.port, config, root, args.timeout, work / "relay.log")
    verdict = 0
    relay_pid = 0
    try:
        boot = relay.start()
        relay_pid = relay.pid()
        print(f"{TAG} 1 启动: {boot:.1f}s 到'限额:'那行(中继 pid {relay_pid})")
        tool = pick_tool(args.port, args.tool)
        print(f"{TAG}   读工具: {tool}")

        said, failed, took = call(
            args.port, tool, {"path": str(root / "hang.fifo")}, args.timeout + 20
        )
        on_time = abs(took - relay.tool_timeout) <= HANG_SLACK
        print(f"{TAG} 2 卡死: {took:.2f}s 回 {said.strip()!r}(调用档 {relay.tool_timeout:g}s)")
        if not (failed and "tool-timeout" in said and on_time):
            print(
                f"{TAG}   ^ 不是预期: 该在 {relay.tool_timeout:g}s 上下回 tool-timeout",
                file=sys.stderr,
            )
            verdict = 1

        left = strays(ps_table(), str(root), relay_pid)
        print(f"{TAG} 3 孤儿: 命令行带着临时根,却不是中继后代的: {len(left)} 个")
        for pid, cmd in left:
            print(f"{TAG}   {pid} {cmd[:110]}")
        if left:
            verdict = 1

        said, failed, took = call(args.port, tool, {"path": str(root / "hello.txt")}, 60)
        print(f"{TAG} 4 重起: {took:.2f}s 回 {said.strip()!r}")
        if failed:
            print(f"{TAG}   ^ 不是预期: 掐掉之后那件该读得到", file=sys.stderr)
            verdict = 1
    finally:
        relay.stop()
        time.sleep(0.5)
        left = strays(ps_table(), str(root), relay_pid)
        print(f"{TAG} 收摊后还剩(该 0): {len(left)} 个")
        for pid, cmd in left:
            print(f"{TAG}   {pid} {cmd[:110]}")
            with contextlib.suppress(OSError, ValueError):
                os.kill(pid, signal.SIGKILL)
        if left:
            verdict = 1
        if args.keep:
            print(f"{TAG} --keep: 临时目录留着 {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    return verdict


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--port", type=int, default=8799, help="中继起在哪个端口(默认 8799)")
    parser.add_argument("--timeout", type=float, default=8.0, help="调用档秒数(默认 8)")
    parser.add_argument("--command", default=None, help="要配的 server, JSON 数组")
    parser.add_argument(
        "--append-root",
        action="store_true",
        help=f"命令末尾补一个临时工作根({ROOT_MARK} 是占位)",
    )
    parser.add_argument("--tool", default="read_file", help="读工具名的后缀(默认 read_file)")
    parser.add_argument("--keep", action="store_true", help="跑完留着临时目录")
    sys.exit(run(parser.parse_args()))


if __name__ == "__main__":
    main()
