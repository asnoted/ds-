"""MCP 网关:stdio 子进程的拉起,汇总,转发,限额,以及三个失败码的册子."""

from __future__ import annotations

import json
import logging
import os
import queue
import sys
import textwrap
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from dsb.gateway import (
    ERROR_NOT_RUNNING,
    ERROR_TIMEOUT,
    ERROR_UNEXPECTED,
    MAX_RESULT_CHARS,
    MAX_TOOLS_PER_SERVER,
    Gateway,
    StdioServer,
    cap_result,
    command_of,
    load_config,
    normalize,
    resolve_seconds,
    resolve_timeout,
    text_of_result,
)

#: 替身 MCP server:说标准 JSON-RPC over stdio.按 arguments.text 的暗号走几种岔路.
FAKE_SERVER = """
import json, os, signal, subprocess, sys, time

# 真正死锁那一种(旧 0003 未验证项里"永不回头"): 不答, 还无视 SIGTERM --
# 只有真的 kill 才收得动. pid 写文件, 好让测试看它到底死没死.
PID_FILE = os.environ.get("FAKE_PID_FILE")

# 起一次就往这儿追一行自己的 pid: "已经活着就别再起一个"那条判据得数得起过几回.
START_FILE = os.environ.get("FAKE_START_FILE")
if START_FILE:
    with open(START_FILE, "a", encoding="utf-8") as handle:
        print(os.getpid(), file=handle)

# 孙子: 一样睡, 一样无视 SIGTERM. `npx` 形状里直接孩子是壳, 真在跑的是它 --
# 壳一死孙子就没了爹, 于是"收摊"必须够得着整间会话(2026-10-18 真机上量到过).
CHILD = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"

# 工具件数可配:单服务工具数上限那条判据要拿一张超长的表来试(第一件恒叫 echo).
# 名字也可配(FAKE_TOOL_NAMES):归一后撞名那条判据要拿一张刻意撞上的表.
NAMES = os.environ.get("FAKE_TOOL_NAMES")
GENERATED = [
    "echo" if index == 0 else "echo%d" % index
    for index in range(int(os.environ.get("FAKE_TOOL_COUNT", "1")))
]
TOOLS = [
    {
        "name": name,
        "description": "回声",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
    }
    for name in (NAMES.split(",") if NAMES else GENERATED)
]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    method, rid = msg.get("method"), msg.get("id")
    if method is None or rid is None:
        continue  # 我们的 notifications/initialized:收下不答
    if method == "initialize":
        reply = {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "0"},
        }}
    elif method == "tools/list":
        reply = {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    elif method == "tools/call":
        text = str(msg.get("params", {}).get("arguments", {}).get("text", ""))
        # 转发进来的工具名可以回显: "对外归一、对内原样"那条判据要看它走的到底是哪个名字.
        shown = (
            "%s:%s" % (msg.get("params", {}).get("name", ""), text)
            if os.environ.get("FAKE_ECHO_NAME")
            else text
        )
        if text == "hang":
            time.sleep(60)
            continue
        if text == "stuck":
            # 不答, 也不肯体面退: 只有 kill 收得动.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if PID_FILE:
                with open(PID_FILE, "w", encoding="utf-8") as handle:
                    handle.write(str(os.getpid()))
                kid = subprocess.Popen([sys.executable, "-c", CHILD])  # noqa: S603
                with open(PID_FILE + ".child", "w", encoding="utf-8") as handle:
                    handle.write(str(kid.pid))
            while True:
                time.sleep(3600)
        if text == "die":
            sys.exit(1)
        if text == "huge":
            reply = {"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "x" * (64 * 1024 + 1024)}], "isError": False,
            }}
        elif text == "boom":
            reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "boom"}}
        elif text == "iserr":
            reply = {"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "底层说不行"}], "isError": True,
            }}
        else:
            reply = {"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": shown}], "isError": False,
            }}
    else:
        reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}}
    sys.stdout.write(json.dumps(reply) + "\\n")
    sys.stdout.flush()
"""


@pytest.fixture()
def fake_script(tmp_path: Path) -> Path:
    path = tmp_path / "fake_mcp_server.py"
    path.write_text(textwrap.dedent(FAKE_SERVER), encoding="utf-8")
    return path


def make_gateway(
    fake_script: Path,
    *,
    timeout: float = 3.0,
    env: dict[str, str] | None = None,
) -> Gateway:
    entry: dict[str, Any] = {"command": [sys.executable, str(fake_script)]}
    if env is not None:
        entry["env"] = env
    return Gateway.from_config({"fake": entry}, timeout=timeout)


@pytest.fixture()
def gateway(fake_script: Path):
    gate = make_gateway(fake_script)
    yield gate
    gate.stop()


# ---- 配置与名字 ----


def test_command_accepts_both_shapes() -> None:
    assert command_of({"command": ["npx", "-y", "srv"]}) == ["npx", "-y", "srv"]
    assert command_of({"command": "npx", "args": ["-y", "srv"]}) == ["npx", "-y", "srv"]
    assert command_of({"command": ""}) is None
    assert command_of({"args": ["-y"]}) is None
    assert command_of({"command": [1, 2]}) is None


def test_load_config_reads_mcp_servers_and_tolerates_the_missing(tmp_path: Path) -> None:
    assert load_config(tmp_path / "nope.json") == {}
    target = tmp_path / "mcp.json"
    target.write_text(
        json.dumps({"mcpServers": {"fs": {"command": ["x"]}, "bad": "不是对象"}}),
        encoding="utf-8",
    )
    assert load_config(target) == {"fs": {"command": ["x"]}}
    broken = tmp_path / "broken.json"
    broken.write_text("坏掉的 json", encoding="utf-8")
    assert load_config(broken) == {}


def test_normalize_folds_everything_odd() -> None:
    assert normalize("文件系统") == "____"
    assert normalize("fs_read-file") == "fs_read-file"


def test_resolve_timeout_prefers_the_process_then_the_env_file_then_default() -> None:
    from dsb.gateway import DEFAULT_TOOL_TIMEOUT, TOOL_TIMEOUT_ENV_KEY

    assert resolve_timeout("") == DEFAULT_TOOL_TIMEOUT
    assert resolve_timeout(f"{TOOL_TIMEOUT_ENV_KEY}=7.5\n") == 7.5
    assert resolve_timeout(f"{TOOL_TIMEOUT_ENV_KEY}=不是数\n") == DEFAULT_TOOL_TIMEOUT
    assert resolve_timeout(f"{TOOL_TIMEOUT_ENV_KEY}=-1\n") == DEFAULT_TOOL_TIMEOUT


def test_resolve_timeout_process_env_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    from dsb.gateway import TOOL_TIMEOUT_ENV_KEY

    monkeypatch.setenv(TOOL_TIMEOUT_ENV_KEY, "11")
    assert resolve_timeout("DSB_TOOL_TIMEOUT=22\n") == 11.0


# ---- 结果形状 ----


def test_text_of_result_joins_text_blocks() -> None:
    result = {"content": [{"type": "text", "text": "一"}, {"type": "text", "text": "二"}]}
    assert text_of_result(result) == ("一\n\n二", False)


def test_text_of_result_keeps_the_is_error_flag() -> None:
    result = {"content": [{"type": "text", "text": "不行"}], "isError": True}
    assert text_of_result(result) == ("不行", True)


def test_text_of_result_dumps_whole_when_there_is_no_text_block() -> None:
    result = {"content": [{"type": "resource", "uri": "file:///x"}]}
    text, failed = text_of_result(result)
    assert json.loads(text) == result
    assert failed is False


# ---- 整链:起,列,转 ----


def test_gateway_starts_the_server_and_lists_prefixed_tools(gateway: Gateway) -> None:
    assert gateway.servers == ("fake",)
    tools = gateway.tools()
    assert [tool.name for tool in tools] == ["fake_echo"]
    assert tools[0].description == "[fake] 回声"
    assert tools[0].input_schema["type"] == "object"


def test_tools_normalizes_the_outside_name_and_keeps_the_raw_one_inside(
    fake_script: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """对外归一(opencode 同款: 点、空格折 `_`), 对内转发**原名**;归一后撞名的后到者让位.

    两件都在这条里:名字带点的 server 照样能用,而转发出去的是它自己认的那个名字--
    归一后的名字只活在我们这一侧。
    """
    gate = make_gateway(
        fake_script, env={"FAKE_TOOL_NAMES": "echo.1,echo_1", "FAKE_ECHO_NAME": "1"}
    )
    try:
        tools = gate.tools()
        assert [tool.name for tool in tools] == ["fake_echo_1"]  # echo_1 与 echo.1 归一后撞上
        payload, failed = tools[0].handler({"text": "嗨"})
        assert (payload["text"], failed) == ("echo.1:嗨", False)  # 发出去的是原名
        assert "tool-clash" in caplog.text
    finally:
        gate.stop()


def test_routes_by_the_whole_external_name_not_by_prefix(fake_script: Path) -> None:
    """server 叫 ``a`` 与 ``a_b`` 时,``a_b_echo`` 该走 ``a_b``;按前缀扫会先撞上更短的 ``a_``."""
    command = [sys.executable, str(fake_script)]
    gate = Gateway.from_config(
        {
            "a": {"command": command, "env": {"FAKE_TOOL_NAMES": "echo"}},
            # 只有 a_b 那个进程设了 FAKE_ECHO_NAME:回显工具名就证明这条转发到了它.
            "a_b": {"command": command, "env": {"FAKE_TOOL_NAMES": "echo", "FAKE_ECHO_NAME": "1"}},
        }
    )
    try:
        tools = {tool.name: tool for tool in gate.tools()}
        assert set(tools) == {"a_echo", "a_b_echo"}
        payload, failed = tools["a_b_echo"].handler({"text": "嗨"})
        assert (payload["text"], failed) == ("echo:嗨", False)
    finally:
        gate.stop()


def test_call_is_forwarded_and_text_passes_through(gateway: Gateway) -> None:
    payload, failed = gateway.tools()[0].handler({"text": "你好"})
    assert payload == {"text": "你好"}
    assert failed is False


def test_a_child_is_error_flows_through_as_failed(gateway: Gateway) -> None:
    _payload, failed = gateway.tools()[0].handler({"text": "iserr"})
    assert failed is True


def test_the_three_codes_of_the_book(gateway: Gateway) -> None:
    handler = gateway.tools()[0].handler
    # 底层协议层报错 → unexpected-response(它对模型的"话"走 isError,不走这儿)
    payload, failed = handler({"text": "boom"})
    assert ERROR_UNEXPECTED in payload["text"] and failed
    # 子进程没起 / 中途没了 → tool-not-running
    payload, failed = handler({"text": "die"})
    assert ERROR_NOT_RUNNING in payload["text"] and failed


def test_a_dead_server_restarts_on_the_next_call(gateway: Gateway) -> None:
    handler = gateway.tools()[0].handler
    handler({"text": "die"})
    payload, failed = handler({"text": "又活了"})
    assert (payload["text"], failed) == ("又活了", False)


def test_a_hanging_server_hits_the_deadline(fake_script: Path) -> None:
    gate = make_gateway(fake_script, timeout=0.4)
    try:
        payload, failed = gate.tools()[0].handler({"text": "hang"})
        assert ERROR_TIMEOUT in payload["text"] and failed
    finally:
        gate.stop()


def test_a_hanging_server_is_dropped_so_a_retry_gets_a_fresh_one(fake_script: Path) -> None:
    """过线就把孩子断掉(旧 0003):留着它,重试会排在卡住那件后面一起超时."""
    gate = make_gateway(fake_script, timeout=0.4)
    try:
        handler = gate.tools()[0].handler
        payload, failed = handler({"text": "hang"})
        assert ERROR_TIMEOUT in payload["text"] and failed
        started = time.monotonic()
        payload, failed = handler({"text": "又活了"})
        assert (payload["text"], failed) == ("又活了", False)
        assert time.monotonic() - started < 3
    finally:
        gate.stop()


def test_a_deadlocked_child_is_killed_not_left_behind(fake_script: Path, tmp_path: Path) -> None:
    """真正"永不回头"的孩子(不答 + 无视 SIGTERM)也要真的死掉, 不是留着.

    替身 `hang` 那一种睡 60s 就会自己退, 所以"断掉"与"等它自己好"分不出来; 这一条的替身
    把 SIGTERM 设成忽略 -- 只有 `kill()`(SIGKILL)才收得动它(旧 0003 决定 5).
    """
    pid_file = tmp_path / "child.pid"
    gate = make_gateway(fake_script, timeout=0.4, env={"FAKE_PID_FILE": str(pid_file)})
    try:
        payload, failed = gate.tools()[0].handler({"text": "stuck"})
        assert ERROR_TIMEOUT in payload["text"] and failed
        pid = int(read_child_pid(pid_file))
        assert wait_until_gone(pid), f"孩子 {pid} 还活着(该被 kill 收尸)"
    finally:
        gate.stop()


def test_stop_reaps_the_grandchild_not_just_the_shim(fake_script: Path, tmp_path: Path) -> None:
    """真机那笔(2026-10-18)的回归: 直接孩子是壳时, 只 kill 壳会把孙子留在进程表上.

    配着 `npx -y <包>` 的 server 卡死, 收摊杀掉的是 `npm exec` 那层壳, 真在跑的
    `node <包>` 换了个爹继续转。替身现在也挂一个无视 SIGTERM 的孙子, 并把它的 pid 写进
    `<pid 文件>.child`; 超时收摊之后两个都该没了。
    """
    pid_file = tmp_path / "child.pid"
    gate = make_gateway(fake_script, timeout=0.4, env={"FAKE_PID_FILE": str(pid_file)})
    try:
        payload, failed = gate.tools()[0].handler({"text": "stuck"})
        assert ERROR_TIMEOUT in payload["text"] and failed
        kid = int(read_child_pid(Path(f"{pid_file}.child")))
        assert wait_until_gone(kid), f"孙子 {kid} 还活着(该跟着壳一起收)"
    finally:
        gate.stop()


def test_a_dead_thread_only_collects_its_own_life() -> None:
    """重启后旧线程的 EOF 不许碰新挂账(旧 0003): 碰了, 新一代正在跑的那件会被平白判成不在.

    收摊 / 重启都把 `_proc` 换了人, 而旧孩子的读口那头还要过一会儿才见 EOF--那一声
    `_fail_all(旧孩子)` 只该收旧孩子的场。
    """
    server = StdioServer("fake", ["true"])
    mine, theirs = object(), object()
    server._proc = mine
    box: queue.Queue[Any] = queue.Queue(1)
    server._pending["fake-1"] = box
    server._fail_all(theirs)
    assert server._pending == {"fake-1": box}  # 一个都不许动
    assert box.empty()
    server._fail_all(mine)
    assert box.get_nowait() is None
    assert server._pending == {}


def test_start_on_a_live_server_does_not_spawn_a_second_child(
    fake_script: Path, tmp_path: Path
) -> None:
    """已经活着就直接回: 再起一个会多留一个没人接手的孩子, 还把 `_proc` 指到新的那个.

    并发来的两件工具都用 `if not alive: start()` 叫它, 这一句就是那道闸。
    """
    starts = tmp_path / "starts.txt"
    server = StdioServer(
        "fake", [sys.executable, str(fake_script)], env={"FAKE_START_FILE": str(starts)}
    )
    try:
        server.start()
        server.start()
        assert server.alive
        assert len(starts.read_text(encoding="utf-8").split()) == 1
    finally:
        server.stop()


def test_stop_wakes_the_calls_still_in_flight(fake_script: Path) -> None:
    """收摊要把挂着的叫醒: 不然那件工具一路等到自己的超时, 用户白等两分钟(旧 0003).

    孩子被收掉时读口那头也会叫一声, 但收摊先清了 `_proc`, 那一声认不出自己的场--
    所以这里量的正是 `stop` 亲自叫的那一声。
    """
    gate = make_gateway(fake_script, timeout=2.0)
    handler = gate.tools()[0].handler
    result: list[tuple[dict[str, Any], bool]] = []
    thread = threading.Thread(target=lambda: result.append(handler({"text": "hang"})))
    try:
        thread.start()
        time.sleep(0.5)  # 等这一件真的挂上去
        gate.stop()
        thread.join(timeout=10)
        assert not thread.is_alive()
        payload, failed = result[0]
        assert ERROR_NOT_RUNNING in payload["text"] and failed
    finally:
        gate.stop()


def read_child_pid(pid_file: Path) -> str:
    """替身写下自己的 pid; 它是异步的, 等它写出来(最多 2 秒)."""
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if pid_file.exists() and pid_file.read_text(encoding="utf-8").strip():
            return pid_file.read_text(encoding="utf-8").strip()
        time.sleep(0.02)
    raise AssertionError("替身没写 pid 文件")


def wait_until_gone(pid: int) -> bool:
    """收了尸的 pid 会从进程表上消失(`os.kill(pid, 0)` 抛 ProcessLookupError)."""
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.02)
    return False


def test_cap_result_keeps_short_text_and_names_the_original_length_of_a_long_one() -> None:
    assert cap_result("短的") == "短的"
    text = "x" * (MAX_RESULT_CHARS + 5)
    capped = cap_result(text)
    assert capped.startswith("x" * MAX_RESULT_CHARS)
    assert "已截断" in capped
    assert f"原文 {MAX_RESULT_CHARS + 5} 字" in capped


def test_the_cap_keeps_the_head_not_the_tail() -> None:
    """脚注写的是"这里是前 N 字":留成尾巴, 这句话就是假的, 丢的还正是开头那几行."""
    head = "开头的第一行\n"
    tail = "\n结尾的最后一行"
    capped = cap_result(head + "x" * MAX_RESULT_CHARS + tail)
    assert head in capped
    assert tail not in capped
    assert f"这里是前 {MAX_RESULT_CHARS} 字" in capped


def test_a_text_exactly_at_the_limit_is_left_alone() -> None:
    """恰好等于上限不截: `<=` 写成 `<` 会啃掉尾巴一个字, 还附一句"前 N 字"的鬼话."""
    text = "y" * MAX_RESULT_CHARS
    assert cap_result(text) == text


def test_resolve_seconds_prefers_the_process_then_the_env_file_then_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DSB_CONNECT_TIMEOUT", raising=False)
    assert resolve_seconds("", "DSB_CONNECT_TIMEOUT", 30.0) == 30.0
    assert resolve_seconds("DSB_CONNECT_TIMEOUT=12.5\n", "DSB_CONNECT_TIMEOUT", 30.0) == 12.5
    monkeypatch.setenv("DSB_CONNECT_TIMEOUT", "7")
    assert resolve_seconds("DSB_CONNECT_TIMEOUT=12.5\n", "DSB_CONNECT_TIMEOUT", 30.0) == 7.0


def test_resolve_seconds_falls_back_on_junk_and_non_positive() -> None:
    assert resolve_seconds("DSB_DISCOVERY_TIMEOUT=abc\n", "DSB_DISCOVERY_TIMEOUT", 20.0) == 20.0
    assert resolve_seconds("DSB_DISCOVERY_TIMEOUT=0\n", "DSB_DISCOVERY_TIMEOUT", 20.0) == 20.0
    assert resolve_seconds("DSB_DISCOVERY_TIMEOUT=-1\n", "DSB_DISCOVERY_TIMEOUT", 20.0) == 20.0


def test_a_huge_result_is_capped_and_the_original_length_is_logged(
    fake_script: Path, caplog: pytest.LogCaptureFixture
) -> None:
    gate = make_gateway(fake_script)
    try:
        handler = gate.tools()[0].handler
        with caplog.at_level(logging.INFO, logger="dsb"):
            payload, failed = handler({"text": "huge"})
        assert failed is False
        assert "已截断" in payload["text"]
        assert f"原文 {MAX_RESULT_CHARS + 1024} 字" in payload["text"]
        assert "result-capped" in caplog.text
        assert f"chars={MAX_RESULT_CHARS + 1024}" in caplog.text
    finally:
        gate.stop()


def test_a_server_with_too_many_tools_is_capped_and_logged(
    fake_script: Path, caplog: pytest.LogCaptureFixture
) -> None:
    gate = make_gateway(fake_script, env={"FAKE_TOOL_COUNT": "130"})
    try:
        with caplog.at_level(logging.INFO, logger="dsb"):
            tools = gate.tools()
        assert len(tools) == MAX_TOOLS_PER_SERVER
        assert "tools-capped" in caplog.text
        assert "count=130" in caplog.text
    finally:
        gate.stop()


def test_stop_takes_the_children_down(fake_script: Path) -> None:
    gate = make_gateway(fake_script)
    gate.stop()
    # 再停一次是幂等的,不许炸
    gate.stop()
