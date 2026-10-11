"""MCP 服务面:JSON-RPC over Streamable HTTP 的最小实现--dsb 被动等命令(ADR-0011).

**只有一条 ``POST /mcp``**:没有 GET 流,没有 SSE,没有 ``Mcp-Session-Id``,dsb 从不发起
任何事--不推送,不轮询,不连出站.客户端(扩展,或任何本机进程)发 JSON-RPC 过来,
它照单办事,答完就忘.这就是'被动式接受命令'的全部:连会话都不留.

线上形状(能简则简,只实现基础方法):

- ``initialize`` → 回 ``protocolVersion``(客户端要什么版本就回什么版本),``capabilities.tools``,
  ``serverInfo``;
- ``ping`` → ``{}``(探活用它,够了);
- ``tools/list`` / ``tools/call`` → 工具表与调用;工具从哪儿来不归这儿管--注册进来什么
  就答什么(网关把配好的 MCP servers 汇总进来,见 :mod:`dsb.gateway`);
- ``notifications/*`` → 收下不答(202);别的方法 → ``-32601``.

失败码两套别混:JSON-RPC 自己的五个码在这儿;工具载荷里的错误归各处的册子
(网关的 ``tool-not-running`` 等在 :mod:`dsb.gateway`),``tools/call`` 把载荷原样交出去.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from dsb.log import SLOW_MS, log_event

#: 唯一端点.别处一律 404 + 在册载荷--不存在第二条路.
MCP_PATH = "/mcp"
SERVER_NAME = "dsb"
SERVER_VERSION = "0.1.0"
#: 客户端开口要什么版本就回什么版本--这里只讲基础方法,版本是双方的事.
DEFAULT_PROTOCOL_VERSION = "2025-06-18"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

Payload = dict[str, Any]
#: 工具处理器:参数 → (载荷, 这算不算一次失败).
ToolHandler = Callable[[Mapping[str, Any]], tuple[Mapping[str, Any], bool]]


@dataclass(frozen=True)
class Tool:
    """一件工具:名字,给模型看的话,入参 schema,以及真正的处理器."""

    name: str
    description: str
    input_schema: Mapping[str, Any]
    handler: ToolHandler


class RpcError(Exception):
    """JSON-RPC 层的错:回给客户端,不落日志(协议错不是业务故障)."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def rpc_request(request_id: Any, method: str, params: Mapping[str, Any] | None = None) -> bytes:
    """一条请求 → 一行 JSON(客户端侧与测试共用,别各拼各的)."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = dict(params)
    return json.dumps(message, ensure_ascii=False).encode("utf-8")


def _error(request_id: Any, code: int, message: str) -> Payload:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _result(request_id: Any, value: Any) -> Payload:
    return {"jsonrpc": "2.0", "id": request_id, "result": value}


def _dump(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def text_result(payload: Mapping[str, Any], *, failed: bool = False) -> Payload:
    """载荷 → ``tools/call`` 的结果信封:正文是一段文本,成败在 ``isError`` 上.

    载荷本身是两半共同的契约,``isError`` 只是给模型看的第二意见--解析永远只走文本那一条路.
    """
    text = payload.get("text")
    return {
        "content": [
            {
                "type": "text",
                "text": text if isinstance(text, str) else json.dumps(payload, ensure_ascii=False),
            }
        ],
        "isError": bool(failed),
    }


class McpService:
    """JSON-RPC 的分发:协议在这儿,业务在各处注册进来的工具里."""

    def __init__(self, tools: Iterable[Tool] = ()) -> None:
        self._tools: dict[str, Tool] = {}
        self.register(tools)

    def register(self, tools: Iterable[Tool]) -> None:
        """注册工具;同名覆盖(后注册的说了算)."""
        for tool in tools:
            self._tools[tool.name] = tool

    @property
    def tool_names(self) -> tuple[str, ...]:
        """当前工具表的名字(按注册序,日志与断言用)."""
        return tuple(self._tools)

    def post(self, body: bytes) -> tuple[int, bytes | None, dict[str, str]]:
        """一次 ``POST /mcp`` → (HTTP 状态码, 响应体, 附加头).

        纯接缝,不碰 socket:解析在这儿,分发在这儿.通知-only 回 202(没有回话).
        """
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return 200, _dump(_error(None, PARSE_ERROR, "parse error")), {}

        if isinstance(data, list):
            if not data:
                return 200, _dump(_error(None, INVALID_REQUEST, "empty batch")), {}
            responses = [response for response in map(self._handle, data) if response is not None]
            if not responses:
                return 202, None, {}
            return 200, _dump(responses), {}

        response = self._handle(data)
        if response is None:
            return 202, None, {}
        return 200, _dump(response), {}

    def _handle(self, message: Any) -> Payload | None:
        """一条消息 → 回话;通知回 None."""
        if not isinstance(message, Mapping):
            return _error(None, INVALID_REQUEST, "invalid request")

        request_id = message.get("id")
        method = message.get("method")
        if not isinstance(method, str):
            return _error(request_id, INVALID_REQUEST, "invalid request")

        notification = "id" not in message
        try:
            if method == "initialize":
                result = self._initialize(message.get("params"))
            elif method.startswith("notifications/"):
                return None
            elif method == "ping":
                # 探活留痕:扩展每 30s 探一次(总开关开着才排班),记下来
                # env-up 才能读"扩展最后探活距今多久".脚本自检走
                # initialize(不记),ping 日志即纯扩展信号.
                log_event("ping")
                result = {}
            elif method == "tools/list":
                result = {"tools": [self._descriptor(tool) for tool in self._tools.values()]}
            elif method == "tools/call":
                result = self._call_tool(message.get("params"))
            else:
                if notification:
                    return None
                return _error(request_id, METHOD_NOT_FOUND, f"Method not found: {method}")
        except RpcError as error:
            return _error(request_id, error.code, error.message)

        if notification:
            return None
        return _result(request_id, result)

    def _initialize(self, params: Any) -> Payload:
        requested = params.get("protocolVersion") if isinstance(params, Mapping) else None
        version = (
            requested if isinstance(requested, str) and requested else DEFAULT_PROTOCOL_VERSION
        )
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }

    def _descriptor(self, tool: Tool) -> Payload:
        return {
            "name": tool.name,
            "description": tool.description,
            "inputSchema": dict(tool.input_schema),
        }

    def _call_tool(self, params: Any) -> Payload:
        """``tools/call`` → 结果信封.载荷原样交出去,错误码归各处的册子."""
        if not isinstance(params, Mapping):
            raise RpcError(INVALID_PARAMS, "invalid params")
        name = params.get("name")
        tool = self._tools.get(name) if isinstance(name, str) else None
        if tool is None:
            raise RpcError(INVALID_PARAMS, f"Unknown tool: {name!r}")
        arguments = params.get("arguments")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, Mapping):
            raise RpcError(INVALID_PARAMS, "arguments must be an object")

        started = time.monotonic()
        try:
            payload, failed = tool.handler(arguments)
        except RpcError:
            raise
        except Exception as exc:  # 处理器炸了:报内部错,留一笔(只留类型名)
            log_event("tool-broke", tool=tool.name, exc=exc)
            raise RpcError(INTERNAL_ERROR, "internal error") from None
        took_ms = (time.monotonic() - started) * 1000
        # 失败与慢才留痕:探活式的快调用(ping 不经这儿)刷屏只会把真事淹掉.
        if failed or took_ms >= SLOW_MS:
            log_event("tool-fail" if failed else "tool-slow", tool=tool.name, took_ms=took_ms)
        return text_result(payload, failed=failed)


__all__ = [
    "DEFAULT_PROTOCOL_VERSION",
    "INTERNAL_ERROR",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "MCP_PATH",
    "McpService",
    "PARSE_ERROR",
    "RpcError",
    "SERVER_NAME",
    "Tool",
    "rpc_request",
    "text_result",
]
