"""`uv run dsb` 起手那几件里**只有 main() 与 make_server() 管**的三处:`dsb/log.py` 的接线,
收摊那条路, 以及启动时那几句给人看的话.

`.env` 怎么读、端口怎么认归 `tests/test_server_env.py`. 这里管的是 main() 把服务拉起来
前后那几处现场:

- **日志接到 stderr**:`nohup uv run dsb > /tmp/dsb.log 2>&1` 靠它.断掉的话业务日志
  **静默**没了 -- 既有测试照样绿,因为 caplog 是挂在根 logger 上捞记录的.
- **SIGTERM 走 Ctrl-C 那条路**:`env-up` 收拾中继发的就是 SIGTERM;走默认那条路,`finally`
  不跑,配好的 MCP 子进程成了没人收的孤儿(这就是那行注释在说的事).
- **启动时那几句要说出口**:工作目录不在、一个 server 都没配 -- 这两个事后都会变成
  调用失败, 当场说一声能省一轮排查. 还有一条同属"收摊真的退得掉":请求线程得是后台的.
"""

from __future__ import annotations

import io
import logging
import re
import signal
import sys
from pathlib import Path

import pytest

from dsb import server
from dsb.log import LOGGER_NAME, log_event, setup_logging
from dsb.mcp import McpService
from dsb.work import WORK_ROOT_ENV_KEY


def test_setup_logging_wires_stderr_once() -> None:
    logger = logging.getLogger(LOGGER_NAME)
    saved = list(logger.handlers)
    logger.handlers.clear()
    try:
        setup_logging()
        assert len(logger.handlers) == 1
        handler = logger.handlers[0]
        assert isinstance(handler, logging.StreamHandler)
        assert handler.stream is sys.stderr

        buffer = io.StringIO()
        handler.setStream(buffer)
        log_event("tool-fail", tool="fs_echo", error="tool-timeout")
        assert re.fullmatch(
            r"\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] tool-fail tool=fs_echo error=tool-timeout\n",
            buffer.getvalue(),
        )

        setup_logging()  # 再来一次不叠 handler
        assert len(logger.handlers) == 1
    finally:
        logger.handlers[:] = saved


def test_sigterm_takes_the_same_door_as_ctrl_c(monkeypatch: pytest.MonkeyPatch) -> None:
    """按 SIGTERM:抬 SystemExit 走到 `finally`,配好的子进程才收得掉(退出码 0)."""
    previous = signal.getsignal(signal.SIGTERM)
    stopped: list[str] = []

    class FakeGateway:
        servers: dict[str, object] = {}

        @staticmethod
        def from_config(*_args: object, **_kwargs: object) -> FakeGateway:
            return FakeGateway()

        def stop(self) -> None:
            stopped.append("stop")

    class FakeServer:
        def __enter__(self) -> FakeServer:
            return self

        def __exit__(self, *_exc: object) -> bool:
            return False

        def serve_forever(self) -> None:
            handler = signal.getsignal(signal.SIGTERM)
            assert callable(handler), "main() 没把 SIGTERM 接到自己手上"
            handler(signal.SIGTERM, None)  # 就当 env-up 这会儿发了 SIGTERM

    monkeypatch.setattr(server, "Gateway", FakeGateway)
    monkeypatch.setattr(server, "load_config", lambda _path: {})
    monkeypatch.setattr(server, "build_tools", lambda _gateway, _said, _root: [])
    monkeypatch.setattr(server, "SaidLog", lambda: object())
    monkeypatch.setattr(server, "make_server", lambda *_args, **_kwargs: FakeServer())
    try:
        with pytest.raises(SystemExit) as raised:
            server.main()
    finally:
        signal.signal(signal.SIGTERM, previous)

    assert raised.value.code == 0
    assert stopped == ["stop"]


def test_main_says_out_loud_what_will_bite_later(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """工作目录不在 / 一个 server 都没配: 两句当场说出口.

    不说的话, 这两件事都要等一次调用失败才看得见。
    """
    missing = tmp_path / "nope"

    class FakeGateway:
        servers: dict[str, object] = {}

        @staticmethod
        def from_config(*_args: object, **_kwargs: object) -> FakeGateway:
            return FakeGateway()

        def stop(self) -> None:
            pass

    class FakeServer:
        def __enter__(self) -> FakeServer:
            return self

        def __exit__(self, *_exc: object) -> bool:
            return False

        def serve_forever(self) -> None:
            raise KeyboardInterrupt  # 用户按了 Ctrl-C, 走 main 那条收摊路

    monkeypatch.setattr(server, "Gateway", FakeGateway)
    monkeypatch.setattr(server, "load_config", lambda _path: {})
    monkeypatch.setattr(server, "build_tools", lambda _gateway, _said, _root: [])
    monkeypatch.setattr(server, "SaidLog", lambda: object())
    monkeypatch.setattr(server, "make_server", lambda *_args, **_kwargs: FakeServer())
    monkeypatch.setenv(WORK_ROOT_ENV_KEY, str(missing))

    server.main()

    out, err = capsys.readouterr()
    assert f"(工具:(空);工作目录:{missing})" in out
    assert f"工作目录不存在(看 {WORK_ROOT_ENV_KEY} 或 .env):{missing}" in err
    assert "没配 MCP server" in err


def test_the_request_threads_are_daemons() -> None:
    """收摊真的退得掉: 请求线程若不是后台的, 一件卡住的请求就能把进程按住不放."""
    with server.make_server(McpService(), port=0) as http:
        assert http.daemon_threads is True
