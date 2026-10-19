"""载荷 → 模型看到的信封: `text` 有就照给, 没有就整块 JSON(`dsb.mcp.text_result`).

**为什么值得单独钉**: 走到 JSON 那条路的正是自家 `said_*` 两件 -- `{"status": "ok", "said": [...]}`
没有 `text` 键, 模型看到的是一整块 JSON. 换成"没有 text 就当空正文"那种写法, 任何一条现有
测试都不会红: 模型收到的是**空正文**, 而工具明明答了话.

服务面那条路(HTTP 状态, 唯一端点 `POST /mcp`, 批量与协议错)在 `tests/test_mcp_server.py`;
这里只管这个纯函数. 正文是两半共同的契约, `isError` 只是给模型看的第二意见(ADR-0005).
"""

from __future__ import annotations

import json

from dsb.mcp import text_result


def test_a_text_payload_is_passed_through_verbatim() -> None:
    assert text_result({"text": "你好"}) == {
        "content": [{"type": "text", "text": "你好"}],
        "isError": False,
    }


def test_a_payload_without_text_goes_whole_as_json() -> None:
    """`said_*` 的载荷就长这样: 整块交出去, 别当它没说话."""
    said = {"status": "ok", "said": [{"text": "第一条", "at": 1.0}]}
    envelope = text_result(said)
    assert json.loads(envelope["content"][0]["text"]) == said
    assert envelope["isError"] is False


def test_the_json_fallback_keeps_the_text_human_readable() -> None:
    """`ensure_ascii=True` 会把中文写成 `\\uXXXX`--模型读得到字, 人要费劲, 也对不了账."""
    text = text_result({"status": "error", "error": "看不清正文"})["content"][0]["text"]
    assert "看不清正文" in text
    assert "\\u" not in text
    assert json.loads(text) == {"status": "error", "error": "看不清正文"}


def test_a_non_string_text_is_not_a_text() -> None:
    """数字不是正文: 整块 JSON 交出去, 别 `str()` 一下当成话."""
    text = text_result({"text": 42, "status": "ok"})["content"][0]["text"]
    assert json.loads(text) == {"text": 42, "status": "ok"}


def test_only_the_failed_flag_sets_is_error() -> None:
    assert text_result({"text": "没事"})["isError"] is False
    assert text_result({"text": "有事"}, failed=True)["isError"] is True
