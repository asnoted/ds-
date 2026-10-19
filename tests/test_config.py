"""`.env` 解析(对拍:`protocol/fixtures/config.json`):只解析,不发任何请求.

纯函数铺在两条路上: `env_value` 读一行, `resolve_config_path` / `find_dotenv` 定"哪一份文件
才算生效的那份". 后者读错一档的代价最大 -- 网关据此拉 server, 工作工具的护栏也据此守文件
(ADR-0009 决定 9), 两份读者一起错.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from conftest import load_fixture

from dsb.config import (
    MCP_CONFIG_ENV_KEY,
    PORT_ENV_KEY,
    env_value,
    find_dotenv,
    repo_root,
    resolve_config_path,
)

CONFIG_CASES = load_fixture("config.json")["cases"]


@pytest.mark.parametrize("case", CONFIG_CASES, ids=[case["name"] for case in CONFIG_CASES])
def test_parses_config_fixture_case(case: dict[str, Any]) -> None:
    assert case["kind"] == "value", case["name"]
    actual = {"value": env_value(case["input"], case["key"])}
    assert actual == case["expected"]


def test_ignores_comments_and_other_keys() -> None:
    env = "# 注释\nOTHER=1\nDSB_PORT=1234\nTRAILING=2\n"
    assert env_value(env, PORT_ENV_KEY) == "1234"


def test_strips_quotes() -> None:
    assert env_value(f'{PORT_ENV_KEY}="1234"\n', PORT_ENV_KEY) == "1234"


def test_strips_single_quotes_too() -> None:
    assert env_value(f"{PORT_ENV_KEY}='1234'\n", PORT_ENV_KEY) == "1234"


def test_only_matching_quotes_are_stripped() -> None:
    assert env_value(f"{PORT_ENV_KEY}=\"1234'\n", PORT_ENV_KEY) == "\"1234'"


def test_a_quoted_empty_value_is_still_missing() -> None:
    assert env_value(f'{PORT_ENV_KEY}=""\n', PORT_ENV_KEY) is None


def test_missing_returns_none() -> None:
    assert env_value("OTHER=1\n", PORT_ENV_KEY) is None
    assert env_value("", PORT_ENV_KEY) is None
    assert env_value(f"{PORT_ENV_KEY}=\n", PORT_ENV_KEY) is None


def test_the_config_env_key_is_the_documented_spelling() -> None:
    """`.env.example` 与文档都按这个写法给用户看; 改名就是换一个用户看不见的契约."""
    assert MCP_CONFIG_ENV_KEY == "DSB_MCP_CONFIG"


def test_config_path_puts_the_process_env_var_first(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MCP_CONFIG_ENV_KEY, "/from-env/mcp.json")
    assert resolve_config_path(f"{MCP_CONFIG_ENV_KEY}=/from-dotenv/mcp.json\n") == Path(
        "/from-env/mcp.json"
    )


def test_config_path_ignores_an_empty_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    """值是空的等于没有: 与 `env_value` 同一条口径, 别让空串把后面那档挡住."""
    monkeypatch.setenv(MCP_CONFIG_ENV_KEY, "")
    assert resolve_config_path(f"{MCP_CONFIG_ENV_KEY}=/from-dotenv/mcp.json\n") == Path(
        "/from-dotenv/mcp.json"
    )


def test_config_path_expands_the_home_shorthand(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MCP_CONFIG_ENV_KEY, "~/somewhere/mcp.json")
    assert resolve_config_path("") == Path("~/somewhere/mcp.json").expanduser()


def test_config_path_puts_dotenv_text_over_a_present_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv(MCP_CONFIG_ENV_KEY, raising=False)
    (tmp_path / "mcp.json").write_text("{}", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert resolve_config_path(f"{MCP_CONFIG_ENV_KEY}=/from-dotenv/mcp.json\n") == Path(
        "/from-dotenv/mcp.json"
    )


def test_config_path_prefers_the_current_directory_over_the_repo(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`.env` 里没写: 先看当前目录, 再看仓库根 -- 顺序反了就是读错那份."""
    monkeypatch.delenv(MCP_CONFIG_ENV_KEY, raising=False)
    (tmp_path / "mcp.json").write_text("{}", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert resolve_config_path("") == tmp_path / "mcp.json"


def test_config_path_falls_back_to_the_repo_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """哪儿都没有: 落仓库根那个落点(文件不在就是空表, 不起错)."""
    monkeypatch.delenv(MCP_CONFIG_ENV_KEY, raising=False)
    monkeypatch.chdir(tmp_path)
    assert resolve_config_path("") == repo_root() / "mcp.json"


def test_config_path_does_not_take_a_directory_named_like_the_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """同名目录不是配置文件: 认成它, 网关会去读一个目录然后一堆 io 错."""
    monkeypatch.delenv(MCP_CONFIG_ENV_KEY, raising=False)
    (tmp_path / "mcp.json").mkdir()
    monkeypatch.chdir(tmp_path)
    assert resolve_config_path("") == repo_root() / "mcp.json"


def test_dotenv_lookup_starts_in_the_current_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / ".env").write_text(f"{PORT_ENV_KEY}=1234\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert find_dotenv() == tmp_path / ".env"


def test_dotenv_lookup_only_falls_back_to_the_repo_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """当前目录没有 `.env`: 只可能是仓库根那份, 或者干脆没有 -- 不许回头认当前目录."""
    monkeypatch.chdir(tmp_path)
    found = find_dotenv()
    assert found is None or found == repo_root() / ".env"
