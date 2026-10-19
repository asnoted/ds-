"""页面回包怎么读:那些**纯解释器**的判据半边(旧 0007 / ADR-0004 / ADR-0006).

真机每条腿都要先读三样东西:CDP 的回包(`unwrap`)、页面递回来的动作回包(`parse_outcome`)、
`storage.get` 里某个键(`stored_list` / `stamps`). 它们全是纯函数, 而解释错了的代价是
**腿照样跑, 结论是假的**: 抛错当成"读到了空"(错), 坏 JSON 当成结构化结果(错), 成环的账本
按条数比(漏掉刚写进去那笔, 踩过). 真机那半要 CDP, CI 够不着, 这里把读法钉住.

措辞层的"哪种差异说成哪句话"在 `tests/test_evidence_reconcile.py`; 这里只管读到的是什么.
"""

from __future__ import annotations

import inspect
from typing import Any

from conftest import load_page_action


def test_unwrap_takes_the_value_out_of_a_cdp_reply() -> None:
    page_action = load_page_action()
    reply = {"id": 1, "result": {"result": {"type": "string", "value": '{"ok":true}'}}}
    assert page_action.unwrap(reply) == '{"ok":true}'


def test_unwrap_keeps_a_thrown_expression_distinguishable_from_a_null_value() -> None:
    """页面里抛错与"读到空"必须是两种东西--混成一种, 对账就会指错方向."""
    page_action = load_page_action()
    thrown = {"result": {"exceptionDetails": {"text": "SyntaxError: Unexpected token"}}}
    read = {"result": {"result": {"type": "object", "subtype": "null", "value": None}}}
    assert page_action.unwrap(thrown) == {
        "cdp-error": "SyntaxError: Unexpected token",
        "raw": {"exceptionDetails": {"text": "SyntaxError: Unexpected token"}},
    }
    assert page_action.unwrap(read) is None


def test_unwrap_of_a_non_cdp_reply_is_the_reply_itself() -> None:
    page_action = load_page_action()
    assert page_action.unwrap("整件事不是回包") == "整件事不是回包"
    assert page_action.unwrap({"别的东西": 1}) is None


def test_parse_outcome_reads_a_json_string_back_into_a_dict() -> None:
    page_action = load_page_action()
    assert page_action.parse_outcome('{"ok":true,"result":{}}') == {"ok": True, "result": {}}
    assert page_action.parse_outcome('{"ok":false,"error":"read-failed"}') == {
        "ok": False,
        "error": "read-failed",
    }


def test_parse_outcome_never_invents_structure() -> None:
    """解不开的、解出来不是字典的, 一律原样收进 `raw`--不许在这里"猜"成某个形状."""
    page_action = load_page_action()
    assert page_action.parse_outcome("not json at all") == {"raw": "not json at all"}
    assert page_action.parse_outcome("[1,2]") == {"raw": [1, 2]}
    assert page_action.parse_outcome("42") == {"raw": 42}
    assert page_action.parse_outcome(7) == {"raw": 7}
    assert page_action.parse_outcome(None) == {"raw": None}


def test_parse_outcome_passes_an_already_parsed_reply_through() -> None:
    page_action = load_page_action()
    reply: dict[str, Any] = {"ok": True, "result": {"text": "x"}}
    assert page_action.parse_outcome(reply) == reply


def test_stored_list_only_believes_lists() -> None:
    page_action = load_page_action()
    assert page_action.stored_list({"k": [1, 2]}, "k") == [1, 2]
    assert page_action.stored_list({"k": "不是数组"}, "k") == []
    assert page_action.stored_list({"k": None}, "k") == []
    assert page_action.stored_list({}, "k") == []
    assert page_action.stored_list("not a store", "k") == []


def test_stamps_compare_the_at_sequence_not_the_row_count() -> None:
    """两个账本都是成环的: 条数不变而内容换了--按条数比会把刚写进去那笔漏掉."""
    page_action = load_page_action()
    before = [{"at": 3}, {"at": 2}, {"at": 1}]
    after = [{"at": 4}, {"at": 3}, {"at": 2}]
    assert page_action.stamps(before) == (3, 2, 1)
    assert page_action.stamps(after) != page_action.stamps(before)
    assert len(page_action.stamps(after)) == len(page_action.stamps(before))


def test_stamps_skip_what_is_not_a_row() -> None:
    page_action = load_page_action()
    assert page_action.stamps([{"at": 2}, "junk", {"note": "没有 at"}, {"at": 1}]) == (2, 1)
    assert page_action.stamps([]) == ()


def test_frame_ledger_is_compared_by_at_sequence_too() -> None:
    """现场帧账本只保 5 帧: 满着时新帧挤掉最老那帧, 条数一点没变.

    `frame-fail` 的"帧没新增"判据要是按条数比, 扩展退化的那一步正好报绿.
    """
    page_action = load_page_action()
    before = [{"at": 5}, {"at": 4}, {"at": 3}, {"at": 2}, {"at": 1}]
    after = [{"at": 6}, {"at": 5}, {"at": 4}, {"at": 3}, {"at": 2}]
    assert len(after) == len(before)
    assert not page_action.frames_unchanged(before, after)
    assert page_action.frames_unchanged(before, list(before))
    # 判据那半在 `frame_fail` 里,要 CDP 才跑得到;钉住它用的就是这条,不是 len 比条数.
    assert "frames_unchanged(" in inspect.getsource(page_action.frame_fail)


def test_first_difference_points_at_the_position_and_both_sides() -> None:
    """那句差异说明是"过时"唯一能用的线索: 位置、两侧长度、两侧片段都得在."""
    page_action = load_page_action()
    saved = "<div class='ds-button'>" + "x" * 200 + "</div>"
    live = "<div class='ds-button'>" + "x" * 200 + "</spam>"
    detail = page_action.first_difference(saved, live)
    assert "第 " in detail and " 个字符起不同" in detail
    assert f"存证长 {len(saved)}" in detail and f"站点长 {len(live)}" in detail
    assert "存证:..." in detail and "站点:..." in detail
    # 只给片段, 不倾倒整段: 两侧各截一段, 正文里的 x 不该全搬进来.
    assert detail.count("x") < saved.count("x")
