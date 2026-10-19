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
