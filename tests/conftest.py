"""共享线协议 fixture 的加载:`protocol/fixtures/*.json` 由 pytest 与 vitest 共读."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

PROTOCOL_FIXTURES = Path(__file__).resolve().parents[1] / "protocol" / "fixtures"
PAGE_ACTION = Path(__file__).resolve().parents[1] / "scripts" / "page-action.py"


def load_fixture(filename: str) -> dict[str, Any]:
    """读一个共享 fixture;缺文件直接抛,免得测试静默跳过."""
    path = PROTOCOL_FIXTURES / filename
    if not path.is_file():
        raise FileNotFoundError(f"共享 fixture 缺失:protocol/fixtures/{filename}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_fixture_filenames() -> list[str]:
    return sorted(path.name for path in PROTOCOL_FIXTURES.glob("*.json"))


@pytest.fixture(scope="session")
def protocol_fixtures() -> dict[str, dict[str, Any]]:
    """全部共享 fixture,按文件名索引."""
    return {name: load_fixture(name) for name in load_fixture_filenames()}


def _stub_websockets() -> None:
    """测试环境没装 websockets 时垫一个空模块,只保证 import 不炸,不提供任何行为."""
    if "websockets" not in sys.modules:
        try:
            import websockets  # noqa: F401
        except ModuleNotFoundError:
            sys.modules["websockets"] = types.ModuleType("websockets")


def load_script(filename: str) -> ModuleType:
    """加载 `scripts/` 下的探针脚本,只给纯函数与假对端用(CDP 那半不在测试范围)."""
    _stub_websockets()
    path = PAGE_ACTION.parent / filename
    spec = importlib.util.spec_from_file_location(f"{path.stem.replace('-', '_')}_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_page_action() -> ModuleType:
    """加载 `scripts/page-action.py`,只给纯函数的对拍用."""
    return load_script(PAGE_ACTION.name)
