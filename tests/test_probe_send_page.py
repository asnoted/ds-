"""`send.page` 两步那条真机探针的判据半边(ADR-0007 / ADR-0006).

探针本体要 CDP(真机才跑),能在这里对拍的是**判据本身**:闸开着与闸关着各认什么、
两头的反证长什么样. 判据写错了,真机跑出来的绿红就都是错的,所以它单拎出来测.

另有一条:重试判据认的**瞬时代码**与页面码册子的对拍(页面改名了,探针会静默地不再重试).
"""

from __future__ import annotations

from collections.abc import Iterable

from conftest import load_fixture, load_page_action

#: 闸关着那条腿的末行前后对拍:默认"这一行没动".
TAIL = ("assistant", "上一句")


def verdict(
    *,
    speak: bool,
    landed: bool,
    composer: str,
    question: str = "问一下",
    tail_before: tuple | None = TAIL,
    tail_after: tuple | None = TAIL,
) -> tuple:
    page_action = load_page_action()
    return page_action.send_page_verdict(
        speak=speak,
        question=question,
        landed=landed,
        composer=composer,
        tail_before=tail_before,
        tail_after=tail_after,
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


def test_gate_closed_without_a_readable_tail_is_not_green() -> None:
    """末行读不出来就判不了--"对话里没有"不能当证据(`list` 读漏了也长这样)."""
    ok, why = verdict(speak=False, landed=False, composer="问一下", tail_before=None)
    assert not ok
    assert "判不了" in why
    ok, why = verdict(speak=False, landed=False, composer="问一下", tail_after=None)
    assert not ok
    assert "判不了" in why


def test_gate_closed_notices_anything_else_going_out() -> None:
    """末行动了 = 有东西发出去了:哪怕草稿也在,这一轮别的账也算不清了."""
    ok, why = verdict(
        speak=False,
        landed=False,
        composer="问一下",
        tail_before=("assistant", "上一句"),
        tail_after=("user", "agent:\\n继续"),
    )
    assert not ok
    assert "末行却变了" in why


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


def test_ledger_clean_wants_the_same_at_sequence() -> None:
    """账本成环:条数不变而内容换了也得算"动了"--第一版比条数,真机上漏过一笔."""
    page_action = load_page_action()
    before = {"ds-/failures": [{"at": 2}, {"at": 1}], "ds-/failure-frames": []}
    assert page_action.ledger_clean(before, before)[0]
    # 环满员时新笔挤掉最老那笔:条数一样多,内容换了.
    rolled = {"ds-/failures": [{"at": 3}, {"at": 2}], "ds-/failure-frames": []}
    assert not page_action.ledger_clean(before, rolled)[0]
    assert "失败痕" in page_action.ledger_clean(before, rolled)[1]
    # 原地补个恢复时刻不算账本动了.
    recovered = {
        "ds-/failures": [{"at": 2, "recoveredAt": 9}, {"at": 1}],
        "ds-/failure-frames": [],
    }
    assert page_action.ledger_clean(before, recovered)[0]
    # 现场帧那份照同一条判据.
    framed = {"ds-/failures": [{"at": 2}, {"at": 1}], "ds-/failure-frames": [{"at": 5}]}
    assert not page_action.ledger_clean(before, framed)[0]
    # 键缺了当空(与各读取器同一条口径):两边都缺就是"没动".
    assert page_action.ledger_clean({}, {})[0]


def test_sole_new_trace_survives_a_full_ring() -> None:
    """环满员时新笔挤掉最老那笔:比条数会永远判"不是只有我们这一笔"."""
    page_action = load_page_action()
    before = [{"at": 3, "cause": "别的"}, {"at": 2, "cause": "别的"}, {"at": 1, "cause": "别的"}]
    ours = [{"at": 4, "cause": "探针造的"}, {"at": 3, "cause": "别的"}, {"at": 2, "cause": "别的"}]
    assert page_action.sole_new_trace(before, ours, "探针造的")
    # 我们那笔上头又落了真痕:撤哪笔都搅乱来历,不动.
    mixed = [
        {"at": 5, "cause": "别的"},
        {"at": 4, "cause": "探针造的"},
        {"at": 3, "cause": "别的"},
    ]
    assert not page_action.sole_new_trace(before, mixed, "探针造的")
    # 最前面不是我们的:别撤别人的.
    assert not page_action.sole_new_trace(before, before, "探针造的")


#: 页面**不产**、探针自己造的瞬时代码 -- 页面那本册子里没有它们的位置.
#: `no-site-tab` 是找不到站点标签页; `cdp-timeout` 是探针自己那 20s 墙钟到点(ADR-0010).
PROBE_LOCAL_TRANSIENT = frozenset({"no-site-tab", "cdp-timeout"})


def action_error_codes() -> set[str]:
    """页面码的唯一册子:fixture 里的 `errorCodes`(执行器那半在 vitest 独立对拍)."""
    return {entry["code"] for entry in load_fixture("action.json")["errorCodes"]}


def transient_code_problems(
    codes: Iterable[str] | None = None,
    book: Iterable[str] | None = None,
    local: Iterable[str] | None = None,
) -> list[str]:
    """探针认的瞬时代码得落在"页面码 ∪ 探针本地白名单"里;白名单也不许留下已经收掉的.

    页面侧改个码名, 代码与 fixture 那两向对拍会红; 探针这份 `TRANSIENT_ERRORS` 却**没人管**
    -- 它旧着也不报, 只在真机上悄悄**不再重试**(偶发失败变常客, 从哪来的没人知道). 所以把
    探针这一份也跟册子对一次.
    """
    codes = set(load_page_action().TRANSIENT_ERRORS if codes is None else codes)
    known = set(action_error_codes() if book is None else book)
    local = set(PROBE_LOCAL_TRANSIENT if local is None else local)
    out = [
        f"瞬时代码 {code} 既不在 action.json 的 errorCodes 里, 也不在探针本地白名单里"
        for code in sorted(codes - known - local)
    ]
    out.extend(
        f"白名单里的 {name} 已经不在 TRANSIENT_ERRORS 里了(白名单要跟着收)"
        for name in sorted(local - codes)
    )
    return out


def test_transient_codes_come_from_the_page_book_or_the_probe_local_whitelist() -> None:
    problems = transient_code_problems()
    assert not problems, (
        "探针的瞬时代码与页面码册子对不上(页面那本改了名, 探针会静默地不再重试):\n"
        + "\n".join(problems)
    )


def test_transient_error_only_recognizes_our_own_codes() -> None:
    """重试判据只认白名单里的码; 别的码(哪怕长得像)一律不重试."""
    page_action = load_page_action()
    assert page_action.transient_error('{"ok":false,"error":"read-failed"}') == "read-failed"
    assert page_action.transient_error({"ok": False, "error": "tab-gone"}) is None
    assert page_action.transient_error({"ok": False, "error": "read-failed-v2"}) is None


def test_transient_error_wants_a_failure_not_wrapped_in_ok() -> None:
    """`ok: true` 就是成了, 即便回包里还挂着个瞬时代码 -- 别把成了的当失败重发一遍."""
    page_action = load_page_action()
    assert page_action.transient_error({"ok": True, "error": "read-failed"}) is None
    # 没写 `ok` 的按"没成"算: 拿不准就往安全那边倒.
    assert page_action.transient_error({"error": "read-failed"}) == "read-failed"


def test_transient_error_of_junk_is_none_not_an_exception() -> None:
    page_action = load_page_action()
    for raw in ("解不开的一段", 7, None, ["read-failed"], {"ok": False, "error": 7}):
        assert page_action.transient_error(raw) is None, raw


def test_transient_code_check_fires() -> None:
    """页面码改名 -> 红; 白名单里留一个已经收掉的 -> 红; 真码加本地码 -> 绿."""
    ghost = "read-" + "failed-v2"
    renamed = transient_code_problems(
        codes=["read-failed", ghost, "no-site-tab"], book=["read-failed"], local=["no-site-tab"]
    )
    assert len(renamed) == 1, renamed
    assert ghost in renamed[0]

    stale = transient_code_problems(
        codes=["read-failed"], book=["read-failed"], local=["no-site-tab"]
    )
    assert len(stale) == 1, stale
    assert "no-site-tab" in stale[0]

    ok = transient_code_problems(
        codes=["read-failed", "no-site-tab"], book=["read-failed"], local=["no-site-tab"]
    )
    assert ok == [], ok
