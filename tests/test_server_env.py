"""`uv run dsb` 起手现读的那几件(`dsb/server.py`):`.env` 正文与监听端口.

端口/端点/超时那一组跨语言的暗号归 `tests/test_relay_contract.py`; 这里只管中继这一半:
`.env` 怎么读, 端口怎么认, 以及 `.env.example` 给用户看的默认值跟代码是否一致.

`socket` 那层(路由与响应头)归 `tests/test_mcp_server.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dsb.config import PORT_ENV_KEY
from dsb.server import DEFAULT_PORT, read_env_text, resolve_port

ENV_EXAMPLE = Path(__file__).resolve().parents[1] / ".env.example"


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


def test_the_dotenv_template_shows_the_default_port() -> None:
    assert f"{PORT_ENV_KEY}={DEFAULT_PORT}" in ENV_EXAMPLE.read_text(encoding="utf-8")
