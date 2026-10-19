"""关掉之后那一趟探活得作废: 回话晚到不能把"关"记成"红".

`afterHealthProbe` 本身认"off"(纯函数, `icon.test.ts` 钉着), 但它只决定下一个状态;
记账(`recordFailure`)与收尾由 `background.ts` 的 `healthProbe` 在拿到回话之后做.
那一趟若不先认总开关, 关着时探活失败也会往留痕里落一笔"中继不可达": 探活的超时是 5 秒、
每 30 秒一拍, 关掉那一瞬有六分之一的机会正有一趟在途 -- 关了还会红, 历史里也带着这段
关着时的红. `applyOutcome` 与 `syncFromStorage` 的探活都先认总开关, 这一条是唯一漏的.

`healthProbe` 在 MV3 入口里, 单测拿不到 `browser`; 扫源码是这里唯一能碰到接线的办法
(与 `test_storage_migration_wiring.py` 同一条路).
"""

from __future__ import annotations

from pathlib import Path

BACKGROUND = Path(__file__).resolve().parents[1] / "entrypoints" / "background.ts"


def test_health_probe_drops_the_reply_if_switched_off_meanwhile() -> None:
    text = BACKGROUND.read_text(encoding="utf-8")
    start = text.find("async function healthProbe(")
    assert start >= 0, "background.ts 里找不到 healthProbe"
    end = text.find("browser.alarms.onAlarm", start)
    assert end > start, "healthProbe 收尾没找到"
    body = text[start:end]
    ping = body.find("await pingRelay()")
    guard = body.find('if (state === "off") return;', ping)
    record = body.find('recordFailure("health"', ping)
    assert 0 <= ping < guard < record, (
        "探活回话之后、记账之前要先认总开关: 关掉之后回话才到, 这趟得作废"
    )


def test_health_probe_drops_a_reply_from_before_the_switch_moved() -> None:
    """关掉又打开也是换了一代: 上一代的回话不许把刚探绿的图标按红(2026-10-20).

    只认 `state === "off"` 挡不住这一路: 回话落地时开关已经又开了, 状态看着正常,
    但这一趟探的是上一代的账. `syncFromStorage` 每跑一次就换代.
    """
    text = BACKGROUND.read_text(encoding="utf-8")
    start = text.find("async function healthProbe(")
    end = text.find("browser.alarms.onAlarm", start)
    body = text[start:end]
    epoch = body.find("const epoch = switchEpoch;")
    ping = body.find("await pingRelay()")
    guard = body.find("if (epoch !== switchEpoch) return;", ping)
    record = body.find('recordFailure("health"', ping)
    assert 0 <= epoch < ping < guard < record, "探活开跑要记下这一代, 回话之后对一代"
    sync = text.find("async function syncFromStorage(")
    assert sync >= 0, "background.ts 里找不到 syncFromStorage"
    assert text.find("switchEpoch += 1;", sync) > sync, "syncFromStorage 每跑一次要换代"


def test_a_sweep_that_outlives_the_alarm_does_not_nudge_twice() -> None:
    """闹钟 30s 一拍, 带催办的一扫可能更久: 上一扫没完就跳过这一拍(2026-10-20)."""
    text = BACKGROUND.read_text(encoding="utf-8")
    start = text.find("browser.alarms.onAlarm")
    body = text[start : text.find("});", start)]
    assert "if (!sweeping)" in body, "看门狗要有一扫在途就不再叠第二扫"
    assert ".finally(" in body, "一扫结束要放掉在途标记"
    assert "sweeping = false" in body


def test_a_sweep_rechecks_the_decision_after_the_observation() -> None:
    """判读那几秒里可能有新动静(回灌落地 / 围栏出门)或收了活: 按当下的账再判一次(2026-10-20).

    只看 `tracked.taskOpen` 挡不住这一路: 新动静只顺延窗口、不收活, 账看着还是"该催".
    往刚有动静的会话里插一句"继续"正是 #104 要避免的.
    """
    text = BACKGROUND.read_text(encoding="utf-8")
    start = text.find("async function watchdogSweep(")
    end = text.find("browser.storage.onChanged", start)
    assert start >= 0 and end > start, "background.ts 里找不到 watchdogSweep"
    body = text[start:end]
    observe = body.find("await observedOutput(")
    tracked = body.find("const tracked = watches.get(tabId);", observe)
    recheck = body.find("watchdogDecision(tracked", tracked)
    deliver = body.find("deliverNudge(", recheck)
    assert 0 <= observe < tracked < recheck < deliver, "判读之后、投递之前要按当下的账再判一次"


def test_a_sweep_drops_its_work_if_the_switch_cleared_the_watches() -> None:
    """判读/投递那几秒里总开关可能关过: 账已清, 不许再催, 也不许写回(2026-10-20).

    以前 `watches.get(tabId) ?? next` 会在清空之后把旧账写回去, 还拿旧 context
    (enabled: true)去发--关了之后仍可能替人开口.
    """
    text = BACKGROUND.read_text(encoding="utf-8")
    start = text.find("async function watchdogSweep(")
    end = text.find("browser.storage.onChanged", start)
    assert start >= 0 and end > start, "background.ts 里找不到 watchdogSweep"
    body = text[start:end]
    observe = body.find("await observedOutput(")
    tracked = body.find("const tracked = watches.get(tabId);", observe)
    cleared = body.find("if (tracked === undefined)", tracked)
    deliver = body.find("deliverNudge(", cleared)
    assert 0 <= observe < tracked < cleared < deliver, "判读之后先确认这笔账还在, 再决定催不催"
    assert "deliverNudge(tabId, act.text, await actionContext())" in body, (
        "投递前现读一次闸, 别拿判读前那份 context 替人开口"
    )
