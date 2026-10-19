"""SW 诊断探针:等回包的路上要顺路记 console,回放的历史不算本轮证据.

[4] 那条判据(console 事件能不能到)原来只在最后排空连接时收事件,等回包期间
到的一条条直接丢掉;而 `Runtime.enable` 又会把 SW 缓冲的历史整批回放--于是
"事件流断"与"只有回放"两种错都能被判成绿/红反过来. 真机踩过的观测路教训在
`scripts/watchdog-probe.py` 的文件头,这里把它钉住.
"""

from __future__ import annotations

import asyncio
import json

from conftest import load_script


class _QueuedSocket:
    """按顺序吐消息;吐完就挂着不回(等超时的那一支)."""

    def __init__(self, messages: list[dict]) -> None:
        self.messages = messages

    async def send(self, _payload: str) -> None:
        return None

    async def recv(self) -> str:
        if self.messages:
            return json.dumps(self.messages.pop(0))
        await asyncio.sleep(60)
        return ""


def _event(timestamp: int, value: str) -> dict:
    return {
        "method": "Runtime.consoleAPICalled",
        "params": {"timestamp": timestamp, "args": [{"value": value}]},
    }


def test_console_events_are_recorded_while_waiting_for_the_reply() -> None:
    probe = load_script("sw-cdp-probe.py")
    reply = {"id": 1, "result": {"result": {"value": 42}}}
    events: list[str] = []
    seen = asyncio.run(
        probe.call(_QueuedSocket([_event(2_000, "sw-cdp-alive"), reply]), 1, "42", 5, events, 1_000)
    )
    assert seen == reply
    assert events == ["sw-cdp-alive"]


def test_replayed_history_is_not_counted_as_a_live_event() -> None:
    probe = load_script("sw-cdp-probe.py")
    events: list[str] = []
    probe.record_console(_event(500, "hours ago"), events, 1_000)
    assert events == []
