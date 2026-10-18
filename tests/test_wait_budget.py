"""等待预算**一份算一次**: 就绪与扫描共用, 谁也别给自己的那一段另发一份.

`src/lib/messages.ts` 文件头写着这条口径(一次 `messages.list` / `messages.last` 的最坏
耗时恒等于 `params.timeout`, 就绪等待花掉的时间从扫描里扣), 但**没有测试看着接线**:
既有的预算用例都直接调 `readMessages` / `readyWithin` 并喂一个 deadline, 不碰
`listMessages` 怎么算那个 deadline. 把 `readMessages(view, nextFrame, deadline)` 换成
`readMessages(view, nextFrame, Date.now() + parseWaitSeconds(frame) * 1_000)`(等于"给
扫描再发一份"), 全量 TS 套件照绿, 现场是最坏耗时翻倍--正是文件头那段 2026-10-04 的现场
(就绪 5s + 扫描 25s, 真原因被吞成一句 `timeout`).

所以这里扫源码: 自己算 deadline 的动作里, `Date.now()` 只许出现一次.

`src/lib/messages.test.ts` 里那些行为用例管的是"一段里 budget 用超了怎样", 这两条管的是
"两段之间有没有多算一份", 各管各的.
"""

from __future__ import annotations

from pathlib import Path

MESSAGES_TS = Path(__file__).resolve().parents[1] / "src" / "lib" / "messages.ts"

#: 自己算 deadline 的两个动作: 一个扫全量, 一个只读最后一屏.
BUDGETED = ("listMessages", "lastMessage")


def body_of(name: str) -> str:
    """`export async function <name>(...)` 到它收尾那一行的 `}`."""
    text = MESSAGES_TS.read_text(encoding="utf-8")
    start = text.find(f"export async function {name}(")
    assert start >= 0, f"messages.ts 里找不到 {name}"
    end = text.find("\n}\n", start)
    assert end > start, f"{name} 的函数体收尾没找到"
    return text[start:end]


def test_each_action_computes_the_deadline_exactly_once() -> None:
    for name in BUDGETED:
        body = body_of(name)
        assert "readyWithin(" in body, f"{name} 里没看到就绪等待"
        assert "readMessages(" in body or "readLast(" in body, f"{name} 里没看到读取那一段"
        assert body.count("Date.now()") == 1, (
            f"{name} 里算 deadline 的地方只许有一处: 多一处就是给某一段另发了预算, "
            "最坏耗时就不再恒等于 params.timeout"
        )
