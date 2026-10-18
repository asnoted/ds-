"""`uv run dsb` 起手现读的那几件(`dsb/server.py`):`.env` 正文, 监听端口与地址.

端口与地址是**两半的暗号**: 扩展那边写死 `RELAY_ORIGIN`(`src/lib/relay.ts`), 中继这边有
`DEFAULT_PORT` / `DEFAULT_HOST`. 两边漂了不会红任何一条既有测试 -- 扩展连不上, 两端日志
都干净. 所以这里把三个落点(中继默认, 扩展常量, `.env.example` 模板)对在一起.

`socket` 那层(路由与响应头)归 `tests/test_mcp_server.py`, 这里只管起手前读的那几个纯函数.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from dsb.config import PORT_ENV_KEY
from dsb.server import DEFAULT_HOST, DEFAULT_PORT, read_env_text, resolve_port

ROOT = Path(__file__).resolve().parents[1]
RELAY_TS = ROOT / "src" / "lib" / "relay.ts"
ENV_EXAMPLE = ROOT / ".env.example"


def relay_origin() -> str:
    """扩展那边写死的落点(`RELAY_ORIGIN`).找不到定义就让用例红在断言上, 不是 import 上."""
    match = re.search(
        r'^export const RELAY_ORIGIN = "([^"]+)";$',
        RELAY_TS.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None, "src/lib/relay.ts 里没找到 RELAY_ORIGIN"
    return match.group(1)


def test_read_env_text_reads_the_dotenv_in_the_current_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / ".env").write_text(f"{PORT_ENV_KEY}=9100\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert read_env_text() == f"{PORT_ENV_KEY}=9100\n"


def test_read_env_text_is_empty_when_there_is_no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """一份 `.env` 都没有: 空正文, 不起错--后面每一档各自认默认值."""
    monkeypatch.setattr("dsb.server.find_dotenv", lambda: None)
    assert read_env_text() == ""


def test_resolve_port_prefers_the_process_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(PORT_ENV_KEY, "9000")
    assert resolve_port(f"{PORT_ENV_KEY}=9100\n") == 9000


def test_resolve_port_reads_the_dotenv_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(PORT_ENV_KEY, raising=False)
    assert resolve_port(f"{PORT_ENV_KEY}=9100\n") == 9100


def test_resolve_port_defaults_when_nothing_says_otherwise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(PORT_ENV_KEY, raising=False)
    assert resolve_port("") == DEFAULT_PORT


def test_resolve_port_refuses_a_nonsense_value_out_loud(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """不是数字就回默认值, 但**要说一声**: 静默换个端口等于给人一个连不上的中继."""
    monkeypatch.delenv(PORT_ENV_KEY, raising=False)
    assert resolve_port(f"{PORT_ENV_KEY}=不是数\n") == DEFAULT_PORT
    assert "不是数" in capsys.readouterr().err


@pytest.mark.parametrize("raw", ["0", "-1", "65536", "70000"])
def test_resolve_port_rejects_a_port_outside_the_range(
    raw: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(PORT_ENV_KEY, raising=False)
    assert resolve_port(f"{PORT_ENV_KEY}={raw}\n") == DEFAULT_PORT
    assert raw in capsys.readouterr().err


@pytest.mark.parametrize("raw", ["1", "65535"])
def test_resolve_port_accepts_the_boundaries(raw: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(PORT_ENV_KEY, raising=False)
    assert resolve_port(f"{PORT_ENV_KEY}={raw}\n") == int(raw)


def test_the_relay_endpoint_matches_on_both_halves() -> None:
    """扩展按 `http://127.0.0.1:8787` 连, 中继按 `DEFAULT_HOST`:`DEFAULT_PORT` 听.

    改任意一边都是**一半的改动**: 扩展发出去的请求没人听, 中继那头也看不出有什么不对.
    """
    parts = urlsplit(relay_origin())
    assert parts.hostname == DEFAULT_HOST
    assert parts.port == DEFAULT_PORT


def test_the_dotenv_template_shows_the_default_port() -> None:
    assert f"{PORT_ENV_KEY}={DEFAULT_PORT}" in ENV_EXAMPLE.read_text(encoding="utf-8")
