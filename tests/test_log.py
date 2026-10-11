"""业务日志:失败留得下,留得干净--正文进不来是**签名**保证的,不是自觉."""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator, Mapping
from typing import Any

import pytest

from dsb.log import SLOW_MS, log_event
from dsb.mcp import MCP_PATH, McpService, Tool
from dsb.server import make_server


def _echo(arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    return {"text": f"echo:{arguments.get('text', '')}"}, False


def _fail(_arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    return {"text": "tool-not-running(工具 x)"}, True


def _slow(_arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    time.sleep((SLOW_MS + 50) / 1000)
    return {"text": "慢,但成了"}, False


def _boom(_arguments: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    raise RuntimeError("处理器炸了:正文不该进日志")


TOOLS = [
    Tool("echo", "回声", {"type": "object"}, _echo),
    Tool("fail", "必失败", {"type": "object"}, _fail),
    Tool("slow", "慢", {"type": "object"}, _slow),
    Tool("boom", "必炸", {"type": "object"}, _boom),
]


class RaisingService:
    """post 当场炸的替身:模拟 route 漏接的真故障(既回响应又留名)."""

    def post(self, _body: bytes) -> Any:
        raise RuntimeError("服务层炸了")


@pytest.fixture()
def serve() -> Iterator[Any]:
    """随机端口起网关的 HTTP 面;收摊时一起关."""
    running: list[tuple[Any, threading.Thread]] = []

    def factory(service: Any) -> str:
        server = make_server(service, host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        running.append((server, thread))
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield factory

    for server, thread in running:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def events(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    """每个用例都从干净的捕获开始,免得上一条的尾巴被当成本条的证据."""
    caplog.set_level(logging.INFO, logger="dsb")
    caplog.clear()
    yield caplog


def call_tool(base: str, name: str, arguments: dict[str, Any] | None = None) -> tuple[int, dict]:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments or {}},
    }
    request = urllib.request.Request(base + MCP_PATH, data=json.dumps(body).encode(), method="POST")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_body_text_cannot_be_logged_because_it_is_not_in_the_signature() -> None:
    """结构性保证:调用点想记正文都写不出参数来."""
    with pytest.raises(TypeError):
        log_event("tool-fail", question="问题正文")  # pyright: ignore[reportCallIssue]
    with pytest.raises(TypeError):
        log_event("tool-fail", text="结果正文")  # pyright: ignore[reportCallIssue]
    with pytest.raises(TypeError):
        log_event("tool-fail", arguments={"path": "x"})  # pyright: ignore[reportCallIssue]


def test_event_line_names_the_event_and_its_fields(events: pytest.LogCaptureFixture) -> None:
    log_event("tool-fail", tool="fs_echo", error="tool-timeout", took_ms=1234.4)
    assert "tool-fail tool=fs_echo error=tool-timeout took_ms=1234" in events.text


def test_an_exception_keeps_only_its_type_name(events: pytest.LogCaptureFixture) -> None:
    """异常消息里可能嵌着用户的东西,只留类型名."""
    log_event("mcp-broke", path=MCP_PATH, exc=RuntimeError("正文在异常消息里"))
    assert f"mcp-broke path={MCP_PATH}" in events.text
    assert "RuntimeError" in events.text
    assert "正文在异常消息里" not in events.text


def test_a_failed_tool_call_leaves_its_code_and_duration(
    serve: Any, events: pytest.LogCaptureFixture
) -> None:
    base = serve(McpService(TOOLS))
    status, payload = call_tool(base, "fail")

    assert status == 200
    assert payload["result"]["isError"] is True
    assert "tool-fail tool=fail" in events.text
    assert "took_ms=" in events.text
    assert "tool-not-running(工具 x)" not in events.text


def test_a_fast_successful_call_is_not_logged(serve: Any, events: pytest.LogCaptureFixture) -> None:
    """成功且快的调用刷屏只会把真事淹掉--只有失败与慢留痕."""
    base = serve(McpService(TOOLS))
    assert call_tool(base, "echo", {"text": "正文在这"})[0] == 200
    assert "tool-fail" not in events.text
    assert "tool-slow" not in events.text


def test_a_slow_call_is_recorded(serve: Any, events: pytest.LogCaptureFixture) -> None:
    base = serve(McpService(TOOLS))
    assert call_tool(base, "slow")[0] == 200
    assert "tool-slow tool=slow" in events.text
    assert "took_ms=" in events.text


def test_a_handler_that_blows_up_answers_json_and_keeps_its_name(
    serve: Any, events: pytest.LogCaptureFixture
) -> None:
    base = serve(McpService(TOOLS))
    status, payload = call_tool(base, "boom")

    assert status == 200 and payload["error"]["code"] == -32603
    assert "tool-broke tool=boom" in events.text
    assert "RuntimeError" in events.text
    assert "正文不该进日志" not in events.text


def test_a_service_that_breaks_the_wire_answers_json_and_keeps_the_path(
    serve: Any, events: pytest.LogCaptureFixture
) -> None:
    """服务层漏接的异常以前是裸断连(扩展眼里长得像'网关死了'),现在既回响应又留名."""
    base = serve(RaisingService())
    status, payload = call_tool(base, "echo")

    assert status == 500 and payload == {"status": "error", "error": "unexpected-response"}
    assert f"mcp-broke path={MCP_PATH}" in events.text
    assert "RuntimeError" in events.text
    assert "服务层炸了" not in events.text


def test_a_request_that_breaks_the_wire_shape_is_recorded(
    serve: Any, events: pytest.LogCaptureFixture
) -> None:
    base = serve(McpService(TOOLS))
    request = urllib.request.Request(base + "/nope", data=b"{}", method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            assert response.status == 404
    except urllib.error.HTTPError as exc:
        assert exc.code == 404
    assert "bad-request path=/nope http=404" in events.text
