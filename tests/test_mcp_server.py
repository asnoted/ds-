"""MCP 服务面:协议分发(POST /mcp)与 HTTP 接缝(唯一端点,一条 CORS 头都没有)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from dsb.gateway import Gateway
from dsb.mcp import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    MCP_PATH,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    McpService,
    Tool,
    rpc_request,
)
from dsb.said import SaidLog
from dsb.server import ERROR_PAYLOAD, build_tools, make_server, route
from dsb.work import work_tools


def _echo(arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    return {"text": f"echo:{arguments.get('text', '')}"}, False


def _fail(arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    return {"text": f"tool-not-running(工具 {arguments.get('name')})"}, True


def _boom(_arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    raise RuntimeError("处理器炸了:正文不该进日志")


TOOLS = [
    Tool("echo", "回声", {"type": "object", "properties": {"text": {"type": "string"}}}, _echo),
    Tool("fail", "必失败", {"type": "object", "properties": {}}, _fail),
    Tool("boom", "必炸", {"type": "object", "properties": {}}, _boom),
]


@pytest.fixture()
def service() -> McpService:
    return McpService(TOOLS)


def call(service: McpService, request_id: Any, method: str, params: Any = None) -> Any:
    """发一条 JSON-RPC → result 或 error(缺哪个抛哪条,别让用例自己剥壳)."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    status, body, _headers = service.post(json.dumps(message).encode())
    assert status == 200 and body is not None
    payload = json.loads(body)
    assert payload["id"] == request_id
    return payload


def result_of(payload: Any) -> Any:
    assert "error" not in payload, payload
    return payload["result"]


def error_of(payload: Any) -> dict[str, Any]:
    assert "result" not in payload, payload
    return payload["error"]


# ---- 协议 ----


def test_initialize_echoes_the_requested_protocol_version(service: McpService) -> None:
    result = result_of(call(service, 1, "initialize", {"protocolVersion": "2024-11-05"}))
    assert result["protocolVersion"] == "2024-11-05"
    assert result["capabilities"] == {"tools": {}}
    assert result["serverInfo"] == {"name": "dsb", "version": "0.1.0"}


def test_initialize_without_params_falls_back_to_the_default_version(service: McpService) -> None:
    result = result_of(call(service, 1, "initialize"))
    assert result["protocolVersion"] == "2025-06-18"


def test_ping_answers_empty(service: McpService) -> None:
    assert result_of(call(service, "p", "ping")) == {}


def test_ping_leaves_a_trace(service: McpService, caplog: pytest.LogCaptureFixture) -> None:
    """探活留一行--env-up 的'扩展最后探活'判据就读它."""
    assert result_of(call(service, "p", "ping")) == {}
    assert [record.message for record in caplog.records if record.message == "ping"] == ["ping"]


def test_tools_list_describes_every_registered_tool(service: McpService) -> None:
    result = result_of(call(service, 1, "tools/list"))
    assert [tool["name"] for tool in result["tools"]] == ["echo", "fail", "boom"]
    echo = result["tools"][0]
    assert echo["description"] == "回声"
    assert echo["inputSchema"]["type"] == "object"


def test_tools_call_wraps_the_payload_as_text(service: McpService) -> None:
    call_payload = {"name": "echo", "arguments": {"text": "你好"}}
    result = result_of(call(service, 1, "tools/call", call_payload))
    assert result == {"content": [{"type": "text", "text": "echo:你好"}], "isError": False}


def test_a_failed_payload_is_marked_is_error(service: McpService) -> None:
    result = result_of(call(service, 1, "tools/call", {"name": "fail", "arguments": {"name": "x"}}))
    assert result["isError"] is True
    assert "tool-not-running" in result["content"][0]["text"]


def test_missing_arguments_are_an_empty_object(service: McpService) -> None:
    result = result_of(call(service, 1, "tools/call", {"name": "echo"}))
    assert result["isError"] is False


def test_an_unknown_tool_is_invalid_params(service: McpService) -> None:
    error = error_of(call(service, 1, "tools/call", {"name": "nope"}))
    assert error["code"] == INVALID_PARAMS


def test_arguments_must_be_an_object(service: McpService) -> None:
    error = error_of(call(service, 1, "tools/call", {"name": "echo", "arguments": "坏的"}))
    assert error["code"] == INVALID_PARAMS


def test_a_handler_that_blows_up_is_internal_error(service: McpService) -> None:
    error = error_of(call(service, 1, "tools/call", {"name": "boom"}))
    assert error["code"] == INTERNAL_ERROR
    assert "处理器炸了" not in error["message"]


def test_an_unknown_method_is_method_not_found(service: McpService) -> None:
    error = error_of(call(service, 1, "resources/list"))
    assert error["code"] == METHOD_NOT_FOUND


def test_a_parse_error_answers_its_own_code(service: McpService) -> None:
    status, body, _ = service.post(b"\xff not json")
    assert status == 200 and body is not None
    payload = json.loads(body)
    assert payload["error"]["code"] == PARSE_ERROR


def test_a_notification_gets_no_answer(service: McpService) -> None:
    message = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    assert service.post(json.dumps(message).encode()) == (202, None, {})


def test_an_unknown_notification_stays_silent(service: McpService) -> None:
    message = {"jsonrpc": "2.0", "method": "notifications/whatever"}
    assert service.post(json.dumps(message).encode()) == (202, None, {})


def test_a_batch_is_answered_item_by_item(service: McpService) -> None:
    batch = [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    status, body, _ = service.post(json.dumps(batch).encode())
    assert status == 200 and body is not None
    payloads = json.loads(body)
    assert [payload["id"] for payload in payloads] == [1, 2]


def test_an_empty_batch_is_invalid_request(service: McpService) -> None:
    status, body, _ = service.post(b"[]")
    assert status == 200 and body is not None
    assert json.loads(body)["error"]["code"] == -32600


# ---- HTTP 接缝 ----


def test_route_sends_post_to_the_service_only(service: McpService) -> None:
    status, body, _ = route("POST", MCP_PATH + "?x=1", b"\xff not json", service)
    assert status == 200 and body is not None
    assert json.loads(body)["error"]["code"] == PARSE_ERROR

    status, body, _ = route("POST", "/send", b"{}", service)
    assert status == 404
    assert json.loads(body) == ERROR_PAYLOAD


def test_delete_is_accepted_without_a_session_to_collect(service: McpService) -> None:
    assert route("DELETE", MCP_PATH, b"", service)[:2] == (205, None)


def test_wrong_method_on_mcp_is_405(service: McpService) -> None:
    status, body, _ = route("GET", MCP_PATH, b"", service)
    assert status == 405
    assert json.loads(body) == ERROR_PAYLOAD


def test_no_cors_header_ever_leaves(service: McpService) -> None:
    """一条 CORS 头都不下发:网页预检撞死,扩展与本机进程不受预检约束."""
    with make_server(service, port=0) as server:
        import threading
        import urllib.error
        import urllib.request

        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            for path, method in (
                (MCP_PATH, "POST"),
                (MCP_PATH, "OPTIONS"),
                ("/nope", "GET"),
            ):
                body = rpc_request(1, "ping") if method == "POST" else None
                request = urllib.request.Request(base + path, data=body, method=method)
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        headers = response.headers
                except urllib.error.HTTPError as exc:
                    headers = exc.headers
                assert headers.get("Access-Control-Allow-Origin") is None, (path, method)
                assert headers.get("Access-Control-Allow-Methods") is None
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_post_over_the_wire_round_trips(service: McpService) -> None:
    """整链一条:HTTP POST 进来,JSON-RPC 答出去(字节级走一遭)."""
    import threading
    import urllib.request

    with make_server(service, port=0) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            request = urllib.request.Request(
                base + MCP_PATH,
                data=rpc_request(7, "tools/call", {"name": "echo", "arguments": {"text": "整链"}}),
                method="POST",
            )
            request.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(request, timeout=5) as response:
                assert response.status == 200
                payload = json.loads(response.read())
            assert payload["id"] == 7
            assert payload["result"]["content"][0]["text"] == "echo:整链"
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


# ---- 工作工具(ADR-0012) ----


def test_build_tools_lists_the_work_tools_and_said_tools(tmp_path: Path) -> None:
    """``build_tools`` 把五件工作工具挂上,``said_*`` 仍在最后(撞名时自家说了算)."""
    service = McpService(build_tools(Gateway({}), SaidLog(), tmp_path))
    names = service.tool_names
    for name in ("ls", "read", "grep", "write", "edit"):
        assert name in names, names
    assert names.index("said_add") > names.index("read")
    assert not {"shell", "bash", "sh", "exec", "run"} & set(names)


def test_work_tools_are_described_in_the_catalog(tmp_path: Path) -> None:
    service = McpService(build_tools(Gateway({}), SaidLog(), tmp_path))
    tools = result_of(call(service, 1, "tools/list"))["tools"]
    work = [tool for tool in tools if tool["name"] in {"ls", "read", "grep", "write", "edit"}]
    assert len(work) == 5
    assert all("[工作目录]" in tool["description"] for tool in work)


def test_a_work_tool_round_trips_over_the_service(tmp_path: Path) -> None:
    service = McpService(work_tools(tmp_path))

    result = result_of(
        call(
            service,
            1,
            "tools/call",
            {"name": "write", "arguments": {"path": "a/b.txt", "content": "你好"}},
        )
    )
    assert result["isError"] is False

    result = result_of(
        call(service, 2, "tools/call", {"name": "read", "arguments": {"path": "a/b.txt"}})
    )
    assert result["content"][0]["text"] == "你好"

    result = result_of(
        call(
            service,
            3,
            "tools/call",
            {
                "name": "edit",
                "arguments": {"path": "a/b.txt", "old_string": "你好", "new_string": "再见"},
            },
        )
    )
    assert result["isError"] is False

    result = result_of(
        call(
            service,
            4,
            "tools/call",
            {"name": "grep", "arguments": {"pattern": "再见", "path": "."}},
        )
    )
    assert result["content"][0]["text"] == "a/b.txt:1: 再见"


def test_a_work_tool_out_of_root_returns_a_failed_payload(tmp_path: Path) -> None:
    service = McpService(work_tools(tmp_path))
    result = result_of(
        call(service, 1, "tools/call", {"name": "read", "arguments": {"path": "../x"}})
    )
    assert result["isError"] is True
    assert result["content"][0]["text"].startswith("out-of-root")
