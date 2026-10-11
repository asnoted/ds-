"""MCP 网关:把配好的 MCP servers 接进来,汇总成一张工具表,替扩展转调用(ADR-0011).

浏览器 spawn 不了 MCP 进程--这正是 dsb 存在的那半条命:真 MCP servers 跑在本机(stdio 子
进程),扩展只认 dsb 一个地址;工具表由 dsb 汇总,调用由 dsb 转发,**dsb 自己一条工具都不
编**(除却 ``said_*`` 那两件自家小事).

配置在仓库根的 ``mcp.json``(不进版本库),形状跟 Claude Desktop / MCP-SuperAssistant 一路:

.. code-block:: json

    {"mcpServers": {"fs": {"command": ["npx", "-y", "server-filesystem", "/tmp"]}}}

对外的名字带服务器前缀 ``<server>_<tool>``(与 opencode 同一套归一化:字母数字 ``_`` ``-``
以外一律折成 ``_``),撞名的后到者让位并留一笔.子进程**启动时一次性拉起**(工具表因此是
静态的:加,换 server 要重启 dsb),死了下次调用再试一次;起不来,答不上,等到超时,分别
折成册子里的三个码:

- ``tool-not-running``:子进程没起或起崩了(stdio 断了);
- ``tool-timeout``:子进程在时限内没答上来;
- ``unexpected-response``:答了,但答得不成样.

底层 server 自己报的错**不算这三个**--那是它对模型说的话,原样当工具结果交出去(``isError``
照它的来),让模型看得见,接得着往下答.
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import subprocess
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from dsb.config import env_value
from dsb.log import log_event
from dsb.mcp import Tool

#: 配置落点:仓库根(与 ``.env`` 同一处),不进版本库.
MCP_CONFIG_FILENAME = "mcp.json"
MCP_CONFIG_ENV_KEY = "DSB_MCP_CONFIG"
#: 一次 ``tools/call`` 等子进程的上限;过线判 ``tool-timeout``(env 可改,单位秒).
TOOL_TIMEOUT_ENV_KEY = "DSB_TOOL_TIMEOUT"
DEFAULT_TOOL_TIMEOUT = 120.0
#: 起子进程 + 握手(initialize)的上限:npx 首次下载可能拖,给足但别无限.
START_TIMEOUT = 30.0
CONNECT_TIMEOUT_ENV_KEY = "DSB_CONNECT_TIMEOUT"
#: ``tools/list`` 的上限:发现一次就够,比握手紧,比调用宽.
DISCOVERY_TIMEOUT = 20.0
DISCOVERY_TIMEOUT_ENV_KEY = "DSB_DISCOVERY_TIMEOUT"
#: 单次结果的字符上限:一条失控结果(整份日志,一棵目录树)能同时灌满对话,扩展的
#: 内存与存储;超了截断并写明原长(见 :func:`cap_result`).
MAX_RESULT_CHARS = 64 * 1024
#: 单个 server 最多注册多少件工具:一张撑爆协议说明的表对谁都没好处.
MAX_TOOLS_PER_SERVER = 128
#: 对外的协议版本:与本仓 ``dsb.mcp`` 讲的一致,子进程按它开场.
PROTOCOL_VERSION = "2025-06-18"

ERROR_NOT_RUNNING = "tool-not-running"
ERROR_TIMEOUT = "tool-timeout"
ERROR_UNEXPECTED = "unexpected-response"

Payload = dict[str, Any]


class GatewayError(Exception):
    """网关自己的三个码(子进程没起 / 超时 / 答不成样);``code`` 直接是册子里的字面量."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def normalize(name: str) -> str:
    """对外工具名的归一化:字母数字与 ``_`` ``-`` 以外一律折成 ``_``(opencode 同款)."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


def load_config(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """``mcp.json`` → ``{服务器名: 条目}``;文件不在就是空表(没配 server 不是错).

    条目两种写法都认:``{"command": ["npx", "-y", "x"]}`` 与 Claude 的
    ``{"command": "npx", "args": ["-y", "x"]}``;``env`` / ``cwd`` 可选.
    """
    target = Path(MCP_CONFIG_FILENAME) if path is None else path
    if not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log_event("config-broke", path=str(target), exc=exc)
        return {}
    if not isinstance(data, Mapping):
        return {}
    servers = data.get("mcpServers")
    if not isinstance(servers, Mapping):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, entry in servers.items():
        if isinstance(name, str) and isinstance(entry, Mapping):
            out[name] = dict(entry)
    return out


def resolve_seconds(env_text: str, key: str, default: float) -> float:
    """一段秒数:进程环境变量优先,其次 ``.env`` 的同名键,最后默认值(非正数落默认)."""
    raw = os.environ.get(key) or env_value(env_text, key)
    if raw is None:
        return default
    try:
        seconds = float(raw)
    except ValueError:
        return default
    return seconds if seconds > 0 else default


def resolve_timeout(env_text: str) -> float:
    """一次调用的时限--三档超时里的那一档(另两档是握手与发现,见 :mod:`dsb.server`)."""
    return resolve_seconds(env_text, TOOL_TIMEOUT_ENV_KEY, DEFAULT_TOOL_TIMEOUT)


def command_of(entry: Mapping[str, Any]) -> list[str] | None:
    """配置条目 → argv;两种写法都认,认不出回 None."""
    command = entry.get("command")
    if isinstance(command, str) and command.strip():
        args = entry.get("args")
        tail = [str(a) for a in args] if isinstance(args, list) else []
        return [command, *tail]
    if isinstance(command, list) and command and all(isinstance(part, str) for part in command):
        return list(command)
    return None


def text_of_result(result: Any) -> tuple[str, bool]:
    """子进程的 ``tools/call`` 结果 → (给模型看的一段文本, isError).

    文本块依次拼上;一个文本块都没有就把整个结果交成 JSON--**不猜,不丢**:结果是要送进
    对话里的,模型看得到全貌比看着半截强.
    """
    failed = bool(isinstance(result, Mapping) and result.get("isError"))
    content = result.get("content") if isinstance(result, Mapping) else None
    if isinstance(content, list):
        texts = [
            block.get("text", "")
            for block in content
            if isinstance(block, Mapping) and block.get("type") == "text"
        ]
        text = "\n\n".join(part for part in texts if isinstance(part, str) and part)
        if text:
            return text, failed
    if isinstance(result, Mapping):
        return json.dumps(result, ensure_ascii=False), failed
    return str(result), failed


def cap_result(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    """给模型看的结果 → 截到上限;截了就在尾巴上写明原长.

    :func:`text_of_result` 的口径是'不猜,不丢'--结果要送进对话,模型看全貌比看半截
    强.上限是给这句话留的唯一例外:一条失控结果(几十兆的目录树,整份日志)会同时灌满
    对话,扩展的内存与存储,而截断处写着原长,模型知道自己看的是前多少字,可以改问法.
    """
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n\n...(结果已截断:原文 {len(text)} 字,这里是前 {limit} 字)"


class StdioServer:
    """一个配好的 MCP server:stdio 上一行一条 JSON-RPC,按 id 认领回应."""

    def __init__(
        self,
        name: str,
        argv: list[str],
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        start_timeout: float = START_TIMEOUT,
        discovery_timeout: float = DISCOVERY_TIMEOUT,
    ) -> None:
        self.name = name
        self._argv = argv
        self._env = dict(env or {})
        self._cwd = cwd
        self._start_timeout = start_timeout
        self._discovery_timeout = discovery_timeout
        self._proc: subprocess.Popen[str] | None = None
        self._pending: dict[str, queue.Queue[Any]] = {}
        self._guard = threading.Lock()
        self._write_guard = threading.Lock()
        self._issued = 0
        self._tools: list[Payload] = []

    # ---- 生命周期 ----

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, timeout: float | None = None) -> None:
        """拉起来并过 initialize 握手;已经活着就直接回."""
        if self.alive:
            return
        try:
            proc = subprocess.Popen(  # noqa: S603 - 命令来自本仓的 mcp.json
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
                env={**os.environ, **self._env},
                cwd=self._cwd,
            )
        except OSError as exc:
            log_event("server-start-broke", tool=self.name, exc=exc)
            raise GatewayError(ERROR_NOT_RUNNING) from None
        with self._guard:
            self._proc = proc
            self._pending.clear()
        reader = threading.Thread(
            target=self._read_loop, args=(proc,), name=f"mcp-{self.name}", daemon=True
        )
        reader.start()
        try:
            self._request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "dsb", "version": "0.1.0"},
                },
                timeout if timeout is not None else self._start_timeout,
            )
            self._notify("notifications/initialized")
        except GatewayError:
            self.stop()
            raise

    def stop(self) -> None:
        """收摊:断 stdin 让它自己退,给一点时间,仍不走就杀."""
        proc, self._proc = self._proc, None
        self._fail_all()
        if proc is None:
            return
        with contextlib.suppress(OSError, ValueError):
            if proc.stdin is not None:
                proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ---- 读口 ----

    def _read_loop(self, proc: subprocess.Popen[str]) -> None:
        """读口 → 按 id 认领;EOF 只收自己的场:**重启后旧线程不许碰新挂账**."""
        assert proc.stdout is not None
        for line in proc.stdout:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            self._dispatch(message)
        # EOF:读口退了,把挂着的人全叫醒(没答上来一律按"不在了"收场).
        # 别在这儿先拿锁:_fail_all 自己拿锁,非可重入的 Lock 会自锁.
        self._fail_all(proc)

    def _dispatch(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if "method" in message:
            if request_id is None:
                return  # 子进程的 notification(tools/list_changed 之类):静态表,不接
            # server → client 的请求:我们声明了空 capabilities,按理不该来;按协议回绝.
            self._write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": "method not found"},
                }
            )
            return
        if request_id is None:
            return
        with self._guard:
            box = self._pending.pop(str(request_id), None)
        if box is None:
            return
        box.put(message)

    def _fail_all(self, proc: subprocess.Popen[str] | None = None) -> None:
        """叫醒所有挂着的请求;带 ``proc`` 时只收自己的场(重启后的旧线程不碰新挂账)."""
        with self._guard:
            if proc is not None and self._proc is not proc:
                return
            waiting = list(self._pending.values())
            self._pending.clear()
        for box in waiting:
            box.put(None)

    # ---- 写口 ----

    def _write(self, message: Mapping[str, Any]) -> GatewayError | None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            return GatewayError(ERROR_NOT_RUNNING)
        line = json.dumps(message, ensure_ascii=False)
        try:
            with self._write_guard:
                proc.stdin.write(line + "\n")
                proc.stdin.flush()
        except (OSError, ValueError):
            return GatewayError(ERROR_NOT_RUNNING)
        return None

    def _notify(self, method: str) -> None:
        self._write({"jsonrpc": "2.0", "method": method})

    def _request(self, method: str, params: Mapping[str, Any], timeout: float) -> Any:
        """发一个请求等回应;超时 / 断口 / 答不成样各归各的码."""
        if not self.alive:
            raise GatewayError(ERROR_NOT_RUNNING)
        with self._guard:
            self._issued += 1
            request_id = f"{self.name}-{self._issued}"
            box: queue.Queue[Any] = queue.Queue(1)
            self._pending[request_id] = box
        error = self._write(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
        )
        if error is not None:
            with self._guard:
                self._pending.pop(request_id, None)
            raise error
        try:
            message = box.get(timeout=timeout)
        except queue.Empty as exc:
            with self._guard:
                self._pending.pop(request_id, None)
            raise GatewayError(ERROR_TIMEOUT) from exc
        if message is None:
            raise GatewayError(ERROR_NOT_RUNNING)
        if "error" in message:
            raise GatewayError(ERROR_UNEXPECTED)
        if "result" not in message:
            raise GatewayError(ERROR_UNEXPECTED)
        return message["result"]

    # ---- 对外 ----

    def list_tools(self) -> list[Payload]:
        """``tools/list`` 的结果(起一次,留一份;工具表因此是静态的)."""
        if not self._tools:
            result = self._request("tools/list", {}, self._discovery_timeout)
            if not isinstance(result, Mapping) or not isinstance(result.get("tools"), list):
                raise GatewayError(ERROR_UNEXPECTED)
            self._tools = [dict(tool) for tool in result["tools"] if isinstance(tool, Mapping)]
        return self._tools

    def call_tool(self, name: str, arguments: Mapping[str, Any], timeout: float) -> Any:
        """转一次 ``tools/call``;死了先试着重起一次(子进程重启是常态,别一崩就废)."""
        if not self.alive:
            self.start()
        result = self._request("tools/call", {"name": name, "arguments": dict(arguments)}, timeout)
        return result


class Gateway:
    """汇总的工具表 + 路由:对外 ``<server>_<tool>``,对内认服务器再转给它."""

    def __init__(
        self,
        servers: Mapping[str, StdioServer],
        *,
        timeout: float = DEFAULT_TOOL_TIMEOUT,
    ) -> None:
        self._servers = dict(servers)
        self._timeout = timeout
        #: 归一化后的前缀 → 服务器名(撞名归先到,后到的留一笔 tool-clash).
        self._prefixes: dict[str, str] = {}
        for name in self._servers:
            prefix = normalize(name)
            if prefix in self._prefixes:
                log_event("tool-clash", tool=prefix)
                continue
            self._prefixes[prefix] = name
        self._tool_names: dict[str, str] = {}  # 对外名 → 底层工具名(原样)

    @classmethod
    def from_config(
        cls,
        config: Mapping[str, Mapping[str, Any]],
        *,
        timeout: float = DEFAULT_TOOL_TIMEOUT,
        start_timeout: float = START_TIMEOUT,
        discovery_timeout: float = DISCOVERY_TIMEOUT,
    ) -> Gateway:
        """配置 → 起好子进程的网关;起不来的 server 记一笔,跳过(别的照常)."""
        servers: dict[str, StdioServer] = {}
        for name, entry in config.items():
            argv = command_of(entry)
            if argv is None:
                log_event("config-broke", path=name, missing="command")
                continue
            env = entry.get("env")
            cwd = entry.get("cwd")
            server = StdioServer(
                name,
                argv,
                env={str(k): str(v) for k, v in env.items()} if isinstance(env, Mapping) else None,
                cwd=cwd if isinstance(cwd, str) else None,
                start_timeout=start_timeout,
                discovery_timeout=discovery_timeout,
            )
            try:
                server.start()
            except GatewayError:
                log_event("server-down", tool=name, error=ERROR_NOT_RUNNING)
                continue
            servers[name] = server
        return cls(servers, timeout=timeout)

    @property
    def servers(self) -> tuple[str, ...]:
        return tuple(self._servers)

    def tools(self) -> list[Tool]:
        """汇总成注册给 ``McpService`` 的工具表;撞名的后到者让位并留一笔."""
        tools: list[Tool] = []
        seen: set[str] = set()
        for prefix, server_name in self._prefixes.items():
            server = self._servers[server_name]
            try:
                described = server.list_tools()
            except GatewayError:
                log_event("server-down", tool=server_name, error=ERROR_UNEXPECTED)
                continue
            if len(described) > MAX_TOOLS_PER_SERVER:
                log_event("tools-capped", tool=server_name, count=len(described))
            for descriptor in described[:MAX_TOOLS_PER_SERVER]:
                raw_name = descriptor.get("name")
                if not isinstance(raw_name, str) or not raw_name:
                    continue
                external = normalize(f"{prefix}_{raw_name}")
                if external in seen:
                    log_event("tool-clash", tool=external)
                    continue
                seen.add(external)
                self._tool_names[external] = raw_name
                tools.append(
                    Tool(
                        name=external,
                        description=_described_text(server_name, descriptor),
                        input_schema=descriptor.get("inputSchema")
                        if isinstance(descriptor.get("inputSchema"), Mapping)
                        else {"type": "object", "properties": {}},
                        handler=self._handler(external),
                    )
                )
        return tools

    def _handler(self, external: str) -> Callable[[Mapping[str, Any]], tuple[Payload, bool]]:
        def handle(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
            try:
                server, child_name = self._route(external)
                result = server.call_tool(child_name, arguments, self._timeout)
            except GatewayError as error:
                # 网关自己的三个码:失败提示在扩展侧折,这里给一段能进对话的说明.
                return {"text": f"{error.code}(工具 {external})"}, True
            text, failed = text_of_result(result)
            if len(text) > MAX_RESULT_CHARS:
                log_event("result-capped", tool=external, chars=len(text))
            return {"text": cap_result(text)}, failed

        return handle

    def _route(self, external: str) -> tuple[StdioServer, str]:
        for prefix, server_name in self._prefixes.items():
            head = f"{prefix}_"
            if external.startswith(head):
                child = self._tool_names.get(external)
                if child is None:
                    # 表是 tools() 一边建一边填的,走到这儿说明表自己不自洽--按意外收场.
                    raise GatewayError(ERROR_UNEXPECTED)
                return self._servers[server_name], child
        raise GatewayError(ERROR_UNEXPECTED)

    def stop(self) -> None:
        """收摊:所有子进程退掉."""
        for server in self._servers.values():
            server.stop()


def _described_text(server_name: str, descriptor: Mapping[str, Any]) -> str:
    """给模型看的描述:带上出处(``[server]``),免得两张同名表看混."""
    description = descriptor.get("description")
    suffix = description if isinstance(description, str) else ""
    return f"[{server_name}] {suffix}".rstrip()


__all__ = [
    "ERROR_NOT_RUNNING",
    "ERROR_TIMEOUT",
    "ERROR_UNEXPECTED",
    "Gateway",
    "GatewayError",
    "StdioServer",
    "command_of",
    "load_config",
    "normalize",
    "resolve_timeout",
    "text_of_result",
]
