"""网页说给人听的话:两件工具的收与取(原来那条 `/said` 路随 HTTP 面一起废了)."""

from __future__ import annotations

from dsb.said import SaidLog


def test_add_only_accepts_a_real_string() -> None:
    log = SaidLog()
    assert log.tool_add({"text": "你好"}) == ({"status": "ok"}, False)
    assert log.tool_add({"text": "   "})[1] is True
    assert log.tool_add({"text": 42})[1] is True
    assert log.tool_add({"nope": "字段名反了"})[1] is True
    assert log.tool_add({})[1] is True


def test_add_then_read_roundtrip() -> None:
    log = SaidLog()
    assert log.tool_add({"text": "第一条"}) == ({"status": "ok"}, False)

    payload, failed = log.tool_read({})
    assert failed is False
    assert [item["text"] for item in payload["said"]] == ["第一条"]


def test_keeps_only_the_last_ones() -> None:
    log = SaidLog(limit=2)
    for i in range(3):
        log.tool_add({"text": f"第{i}条"})

    payload, _ = log.tool_read({})
    assert [item["text"] for item in payload["said"]] == ["第1条", "第2条"]


def test_a_bad_add_is_marked_failed_with_the_codebook_payload() -> None:
    payload, failed = SaidLog().tool_add({"text": 42})
    assert failed is True
    assert payload == {"status": "error", "error": "unexpected-response"}
