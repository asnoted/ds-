"""共享线协议 fixture 的加载:`protocol/fixtures/*.json` 由 pytest 与 vitest 共读."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

PROTOCOL_FIXTURES = Path(__file__).resolve().parents[1] / "protocol" / "fixtures"


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
