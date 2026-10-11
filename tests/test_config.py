"""`.env` 解析(对拍:`protocol/fixtures/config.json`):只解析,不发任何请求."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import load_fixture

from dsb.config import PORT_ENV_KEY, env_value

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


def test_missing_returns_none() -> None:
    assert env_value("OTHER=1\n", PORT_ENV_KEY) is None
    assert env_value("", PORT_ENV_KEY) is None
    assert env_value(f"{PORT_ENV_KEY}=\n", PORT_ENV_KEY) is None
