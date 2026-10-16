"""`send.page` 两步那条真机探针的判据半边(ADR-0013 / ADR-0023).

探针本体要 CDP(真机才跑),能在这里对拍的是**判据本身**:闸开着与闸关着各认什么、
两头的反证长什么样. 判据写错了,真机跑出来的绿红就都是错的,所以它单拎出来测.
"""

from __future__ import annotations

from conftest import load_page_action


def verdict(*, speak: bool, landed: bool, composer: str, question: str = "问一下") -> tuple:
    page_action = load_page_action()
    return page_action.send_page_verdict(
        speak=speak, question=question, landed=landed, composer=composer
    )


def test_gate_open_message_lands() -> None:
    ok, why = verdict(speak=True, landed=True, composer="")
    assert ok, why
    assert "两步" in why


def test_gate_open_silence_is_red() -> None:
    ok, why = verdict(speak=True, landed=False, composer="")
    assert not ok
    assert "没成" in why


def test_gate_closed_leaves_a_draft() -> None:
    ok, why = verdict(speak=False, landed=False, composer="问一下")
    assert ok, why
    assert "草稿" in why


def test_gate_closed_but_landed_breaks_the_red_line() -> None:
    ok, why = verdict(speak=False, landed=True, composer="")
    assert not ok
    assert "红线" in why


def test_gate_closed_without_draft_is_red() -> None:
    ok, why = verdict(speak=False, landed=False, composer="别的东西")
    assert not ok
    assert "不是那条问题" in why


def test_whitespace_does_not_decide() -> None:
    ok, _ = verdict(speak=False, landed=False, composer="  问一下\n", question=" 问一下 ")
    assert ok


def test_empty_question_never_counts_as_a_draft() -> None:
    """空问题:写作框空着也能"字符串相等",那不是草稿--这条挡的就是这种假绿."""
    ok, why = verdict(speak=False, landed=False, composer="", question="")
    assert not ok
    assert "不是那条问题" in why


def test_probe_question_carries_its_tag() -> None:
    """判据按整条比:号变了才分得清"这一轮那条"与上一轮留下的同名消息."""
    page_action = load_page_action()
    one = page_action.send_page_question(1)
    two = page_action.send_page_question(2)
    assert "1" in one and "2" in two and one != two
    assert one.startswith(page_action.SEND_PAGE_QUESTION)


def test_landing_needs_the_whole_line() -> None:
    page_action = load_page_action()
    rows = [
        {"role": "user", "text": "别的问题"},
        {"role": "user", "text": "  问一下 "},
        {"role": "assistant", "text": "问一下"},
    ]
    assert page_action.landed_question(rows, "问一下")
    assert not page_action.landed_question(rows, "问两下")
    assert not page_action.landed_question([{"role": "user", "text": 42}], "42")
