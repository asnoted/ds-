"""工作工具经 sidecar 的端到端对拍:五件都能用,越界与受保护仍由 dsb 拦."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from dsb import work


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("alpha\nbeta\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("hello\n", encoding="utf-8")
    (tmp_path / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("[core]\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def tools(root: Path):
    items = {tool.name: tool for tool in work.work_tools(root)}
    assert set(items) == {"glob", "read", "grep", "write", "edit"}, items.keys()
    yield items
    work.stop_work_tools()


def call(tools: Mapping[str, Any], name: str, arguments: Mapping[str, Any]) -> str:
    payload, failed = tools[name].handler(arguments)
    assert not failed, payload
    return payload["text"]


def failure(tools: Mapping[str, Any], name: str, arguments: Mapping[str, Any]) -> str:
    payload, failed = tools[name].handler(arguments)
    assert failed, payload
    return payload["text"]


def test_glob_lists_files_only(tools: Mapping[str, Any]) -> None:
    text = call(tools, "glob", {"pattern": "**/*"})
    assert "src/app.py" in text
    assert "notes.txt" in text
    assert ".git/config" not in text
    assert not any(line.endswith("/") for line in text.splitlines())


def test_glob_rejects_escape(tools: Mapping[str, Any]) -> None:
    assert "bad-path" in failure(tools, "glob", {"pattern": "../*"})
    assert "out-of-root" in failure(tools, "glob", {"pattern": "*", "path": ".."})


def test_read_returns_page(tools: Mapping[str, Any]) -> None:
    text = call(tools, "read", {"path": "src/app.py"})
    assert "alpha" in text and "beta" in text


def test_read_offset_and_limit(tools: Mapping[str, Any]) -> None:
    text = call(tools, "read", {"path": "src/app.py", "offset": 2, "limit": 1})
    assert text.startswith("beta")
    assert "offset=3" in text
    assert "空" in call(tools, "read", {"path": "notes.txt", "offset": 99})


def test_read_boundary(tools: Mapping[str, Any]) -> None:
    assert "out-of-root" in failure(tools, "read", {"path": "../outside.txt"})
    assert "protected-path" in failure(tools, "read", {"path": ".env"})
    assert "not-found" in failure(tools, "read", {"path": "missing.txt"})
    assert "bad-range" in failure(tools, "read", {"path": "notes.txt", "offset": 0})


def test_grep_finds_and_filters(tools: Mapping[str, Any]) -> None:
    text = call(tools, "grep", {"pattern": "alpha"})
    assert "src/app.py:1:" in text
    assert "alpha" in text

    text = call(tools, "grep", {"pattern": "TOKEN"})
    assert "secret" not in text
    assert "已略过受保护文件" in text


def test_write_and_edit(tools: Mapping[str, Any], root: Path) -> None:
    call(tools, "write", {"path": "src/new.py", "content": "one\n"})
    assert (root / "src" / "new.py").read_text(encoding="utf-8") == "one\n"

    assert "file-exists" in failure(tools, "write", {"path": "src/new.py", "content": "two\n"})
    call(tools, "write", {"path": "src/new.py", "content": "two\n", "overwrite": True})
    assert (root / "src" / "new.py").read_text(encoding="utf-8") == "two\n"

    call(
        tools,
        "edit",
        {"path": "src/new.py", "edits": [{"oldText": "two", "newText": "three"}]},
    )
    assert (root / "src" / "new.py").read_text(encoding="utf-8") == "three\n"

    assert "edit-no-match" in failure(
        tools, "edit", {"path": "src/new.py", "edits": [{"oldText": "zzz", "newText": "x"}]}
    )
    (root / "twice.txt").write_text("aa\naa\n", encoding="utf-8")
    assert "edit-not-unique" in failure(
        tools, "edit", {"path": "twice.txt", "edits": [{"oldText": "aa", "newText": "b"}]}
    )


def test_write_boundary(tools: Mapping[str, Any], root: Path) -> None:
    assert "protected-path" in failure(
        tools, "write", {"path": ".env", "content": "TOKEN=changed\n", "overwrite": True}
    )
    assert (root / ".env").read_text(encoding="utf-8") == "TOKEN=secret\n"
    assert "protected-path" in failure(
        tools, "edit", {"path": ".env", "edits": [{"oldText": "secret", "newText": "x"}]}
    )
    assert "out-of-root" in failure(tools, "write", {"path": "../outside.txt", "content": "x"})
