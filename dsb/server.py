"""`uv run dsb` 起的本机 MCP 网关(ADR-0011:被动式接受命令).

唯一端点是 ``POST /mcp``:JSON-RPC 一行一条(``initialize`` / ``ping`` /
``tools/list`` / ``tools/call``).原来那批 HTTP 路--``/send`` ``/health`` ``/status``
``/action`` ``/actions`` ``/action/result`` ``/said``--全废了:探活就是 ``ping``,现场
就是工具自己的结果,其余无话可说.dsb 从不发起任何事:不推送,不轮询,没有 SSE.

- ``POST /mcp`` → 200(协议错也是 200 + JSON-RPC error,同构一处解析);通知回 202;
- ``DELETE /mcp`` → 205(无会话可收;客户端收摊的礼貌动作,不该撞 405);
- ``/mcp`` 上别的方法 → 405,别的路径 → 404(都在册的 ``{"status": "error", ...}`` 载荷).

**一条 CORS 头都不下发**:网页的跨域预检拿不到允许头,撞死;扩展(host_permissions)
与本机进程不受预检约束,照旧放行.

失败与慢另外留痕(:mod:`dsb.log`):``bad-request`` / ``mcp-broke``;工具层的
``tool-fail`` / ``tool-slow`` 在 :mod:`dsb.mcp` 里记.入参与结果正文都进不来--签名里就
没有那个位置.访问日志照旧整个关掉.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from dsb import config
from dsb.config import PORT_ENV_KEY, env_value, find_dotenv
from dsb.gateway import (
    CONNECT_TIMEOUT_ENV_KEY,
    DISCOVERY_TIMEOUT,
    DISCOVERY_TIMEOUT_ENV_KEY,
    MAX_RESULT_CHARS,
    MAX_TOOLS_PER_SERVER,
    START_TIMEOUT,
    Gateway,
    load_config,
    resolve_seconds,
    resolve_timeout,
)
from dsb.log import log_event, setup_logging
from dsb.mcp import MCP_PATH, McpService, Tool
from dsb.said import SaidLog
from dsb.work import WORK_ROOT_ENV_KEY, resolve_work_root, work_tools

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
MAX_BODY_BYTES = 256 * 1024

Payload = dict[str, Any]
#: 认不出的东西一律回这个在册形状(错误码不在这儿编,归 :mod:`dsb.mcp` 与 :mod:`dsb.gateway`).
ERROR_PAYLOAD: Payload = {"status": "error", "error": "unexpected-response"}


def said_tools(said: SaidLog) -> list[Tool]:
    """自家那两件小事:记下网页说给人听的话,读回来."""
    return [
        Tool(
            name="said_add",
            description="把网页没排围栏,说给人听的一段话记下来(扩展在报,不进对话).",
            input_schema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            handler=said.tool_add,
        ),
        Tool(
            name="said_read",
            description='读回最近记下的"说给人听"的话.',
            input_schema={"type": "object", "properties": {}},
            handler=said.tool_read,
        ),
    ]


def build_tools(gateway: Gateway, said: SaidLog, root: Path) -> list[Tool]:
    """注册给 :class:`dsb.mcp.McpService` 的全表:网关汇总的 + 自家工作工具 + 说给人听的两件.

    顺序即话语权:``said_*`` 在后,撞名时自家说了算(网关内部的撞名在
    :meth:`dsb.gateway.Gateway.tools` 里已经记过一笔 ``tool-clash``).五件工作工具是裸名
    (``ls`` / ``read`` / ...),第三方工具名恒带 ``<server>_`` 前缀,正常不会相撞.
    """
    return [*gateway.tools(), *work_tools(root), *said_tools(said)]


def route(
    method: str, path: str, body: bytes, service: McpService
) -> tuple[int, bytes | None, dict[str, str]]:
    """一次请求 → (HTTP 状态码, 响应体, 附加头);纯接缝,不碰 socket,不碰日志."""
    path = urlsplit(path).path
    if path == MCP_PATH:
        if method == "POST":
            return service.post(body)
        if method == "DELETE":
            return 205, None, {}
        return 405, json.dumps(ERROR_PAYLOAD, ensure_ascii=False).encode("utf-8"), {}
    if method in {"GET", "POST"}:
        return 404, json.dumps(ERROR_PAYLOAD, ensure_ascii=False).encode("utf-8"), {}
    return 405, json.dumps(ERROR_PAYLOAD, ensure_ascii=False).encode("utf-8"), {}


def make_handler(service: McpService) -> type[BaseHTTPRequestHandler]:
    """造请求处理类(每次请求一个实例;socket 细节只在这层)."""

    class McpHandler(BaseHTTPRequestHandler):
        server_version = "dsb"
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            self._respond("GET")

        def do_POST(self) -> None:
            self._respond("POST")

        def do_DELETE(self) -> None:
            self._respond("DELETE")

        def do_PUT(self) -> None:
            self._respond("PUT")

        def do_OPTIONS(self) -> None:
            # 跨域预检:不下发任何 CORS 头(连 204 都不给),让网页那头撞死.
            self._respond("OPTIONS")

        def _respond(self, method: str) -> None:
            started = time.monotonic()
            try:
                status, data, extra = route(method, self.path, self._body(), service)
            except Exception as exc:  # route 该兜的都兜了:漏到这儿的是真故障
                took_ms = (time.monotonic() - started) * 1000
                # 接住而不是放着断连:裸断连对扩展来说长得像"网关死了",日志里却一个字没有.
                log_event("mcp-broke", path=urlsplit(self.path).path, exc=exc, took_ms=took_ms)
                self._send(500, json.dumps(ERROR_PAYLOAD, ensure_ascii=False).encode("utf-8"))
                return
            took_ms = (time.monotonic() - started) * 1000
            if status >= 400:
                log_event(
                    "bad-request",
                    path=urlsplit(self.path).path,
                    http=status,
                    took_ms=took_ms,
                )
            self._send(status, data, extra)

        def _body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return b""
            if length > MAX_BODY_BYTES:
                self.close_connection = True  # 不读剩下的字节,直接断开,免得连接错位
                return b""
            return self.rfile.read(length)

        def _send(
            self, status: int, data: bytes | None, extra: dict[str, str] | None = None
        ) -> None:
            body = data or b""
            self.send_response(status)
            if body or status < 300:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            # 注意:这里**没有** CORS 头,一条都没有(ADR-0011).
            self.end_headers()
            if body:
                self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass  # 入参与结果正文不进访问日志

    return McpHandler


def make_server(
    service: McpService, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT
) -> ThreadingHTTPServer:
    """起网关的 HTTP 服务(测试用 port=0 拿随机端口)."""
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    return server


def read_env_text() -> str:
    path = find_dotenv()
    return path.read_text(encoding="utf-8") if path is not None else ""


def resolve_port(env_text: str) -> int:
    """监听端口:进程环境变量优先,其次 `.env` 里的 DSB_PORT,最后默认值."""
    raw = os.environ.get(PORT_ENV_KEY) or env_value(env_text, PORT_ENV_KEY)
    if raw is None:
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        print(f"[dsb] {PORT_ENV_KEY}={raw!r} 不是端口号,改用默认 {DEFAULT_PORT}", file=sys.stderr)
        return DEFAULT_PORT
    if not 0 < port < 65536:
        print(f"[dsb] {PORT_ENV_KEY}={port} 越界,改用默认 {DEFAULT_PORT}", file=sys.stderr)
        return DEFAULT_PORT
    return port


def resolve_config_path(env_text: str) -> Path:
    """``mcp.json`` 的落点.实现已挪到 :mod:`dsb.config`(工作工具的护栏也要用它,#89).

    这里留着这个薄壳:调用方(:func:`main` 与既有测试)照旧从本模块取.
    """
    return config.resolve_config_path(env_text)


def main() -> None:
    """`uv run dsb` 的入口:现读端口与配置,拉起配好的 MCP servers,然后被动等着."""
    setup_logging()
    # pkill / 系统收摊发的是 SIGTERM,Python 默认直接退出,finally 不跑,配好的子进程
    # 就成了没人收的孤儿.让它走跟 Ctrl-C 同一条路.
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    env_text = read_env_text()
    port = resolve_port(env_text)
    config_path = resolve_config_path(env_text)
    root = resolve_work_root(env_text)
    gateway = Gateway.from_config(
        load_config(config_path),
        timeout=resolve_timeout(env_text),
        # 三档超时各现读一份:握手(npx 首次下载慢)/ 发现(一次就够)/ 调用.
        start_timeout=resolve_seconds(env_text, CONNECT_TIMEOUT_ENV_KEY, START_TIMEOUT),
        discovery_timeout=resolve_seconds(env_text, DISCOVERY_TIMEOUT_ENV_KEY, DISCOVERY_TIMEOUT),
    )
    service = McpService(build_tools(gateway, SaidLog(), root))
    names = ", ".join(service.tool_names) or "(空)"
    print(
        f"[dsb] MCP 网关已启动:http://{DEFAULT_HOST}:{port}{MCP_PATH}"
        f"(工具:{names};工作目录:{root})",
        flush=True,
    )
    if not root.is_dir():
        print(
            f"[dsb] 工作目录不存在(看 {WORK_ROOT_ENV_KEY} 或 .env):{root};"
            "工作工具调用时会回 bad-path.",
            file=sys.stderr,
        )
    print(
        f"[dsb] 限额:单次结果 {MAX_RESULT_CHARS} 字,单服务工具 {MAX_TOOLS_PER_SERVER} 件,"
        f"工具调用 {resolve_timeout(env_text):g}s",
        flush=True,
    )
    if not gateway.servers:
        print(
            f"[dsb] 没配 MCP server(看 {config_path}):tools/list 只剩工作工具与自家的 said_*.",
            file=sys.stderr,
        )
    with make_server(service, port=port) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n[dsb] 已停止")
        finally:
            gateway.stop()  # 收摊:配好的子进程一起退


if __name__ == "__main__":
    main()
