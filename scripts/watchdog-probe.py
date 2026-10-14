#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""看门狗腿探针:连 MV3 service worker 的 CDP,造动静刷上时刻,等静默,录控制台判定.

看门狗的 `watches` 是 SW 内存 Map,不落盘:重启即清空,`lastActivityAt=null` 时静默
分支永不触发(只在"武装期内"盯梢). 所以催办只能发生在同一 SW 存活期内--先造一条动静
(投一条 chain 信封走 `fenceround`,它的 `watchdog` 效果会调 `watchdogSeen` 刷时刻),
再趁 SW 活着等 `silenceMs` 到点.

触发配置用 `src/lib/watchdog.ts` 明写的 `silenceMs` 旋钮(storage.local 覆写),不是造入口:
存一个很短的窗口,让静默在探针等待期内就到点.

观测路(踩过,别改回去):CDP 的 console 事件得靠 **等回包的 `call()`** 顺路吃--
fire-and-forget 的 evaluate 后再单独 pump,一条都收不到(纯监听也 0 行). 所以所有
SW 侧操作都走 `call()`,它在等自己回包时把途经的 `Runtime.consoleAPICalled` 一并记下.

判定(看控制台 `[ds-] 看门狗` 行):
  - 出现 `催办已发`        → 完成(speak 闸开着,写+发两步都过)
  - 出现 `催办整个跳过`    → 未完成(speak 闸关着)
  - 出现 `催办没送出去`    → 未完成(闸拦着或标签页答不上)
  - 出现 `连催 ... 停手`   → 未完成(计数到顶)
  - 到时无催办行           → 未完成(静默没到点 / 没动静)

用法:
  uv run scripts/watchdog-probe.py
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.request
from contextlib import AsyncExitStack

import websockets

PORT = 9222
CDP = f"http://127.0.0.1:{PORT}"
SITE_PREFIX = "https://chat.deepseek.com/"
SILENCE_MS = 1000
WAIT_SECS = 40

#: 一条无害的 chain 信封:本地工具 `composer.read` 只读写作框,不发送,不留痕.
#: 投它走 `content.ts` → `background` → `fenceround.handle` → `watchdog` 效果 →
#: `watchdogSeen` 刷动静时刻. 用本地工具而非中继工具:中继那腿要真网关在跑.
ACTIVITY_EXPR = (
    "window.postMessage({source:'ds-/chain',kind:'call',id:'probe-wd-activity',"
    "calls:[JSON.stringify({tool:'composer.read',arguments:{}})]},'*');'sent'"
)


def ws_url_of(kind: str, match) -> str:
    with urllib.request.urlopen(f"{CDP}/json", timeout=5) as response:
        targets = json.load(response)
    for target in targets:
        if target.get("type") == kind and match(target.get("url", "")):
            return target["webSocketDebuggerUrl"]
    raise SystemExit(f"没找到 {kind} 目标")


class Recorder:
    """一条 CDP 连接上的 `call()`:等自己的回包,顺路记下途经的 console 事件."""

    def __init__(self, ws: websockets.ClientConnection) -> None:
        self.ws = ws
        self.lines: list[str] = []
        self._seq = 0

    async def call(self, expr: str, timeout: float = 8.0) -> object:
        self._seq += 1
        my_id = self._seq
        await self.ws.send(
            json.dumps(
                {
                    "id": my_id,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
                }
            )
        )
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"timeout": True}
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            except TimeoutError:
                return {"timeout": True}
            message = json.loads(raw)
            if message.get("id") == my_id:
                return message
            method = message.get("method", "")
            params = message.get("params", {})
            if method == "Runtime.consoleAPICalled":
                args = params.get("args", [])
                value = args[0].get("value") if args else None
                if isinstance(value, str) and value:
                    self.lines.append(value)
            elif method == "Log.entryAdded":
                text = params.get("entry", {}).get("text")
                if isinstance(text, str) and text:
                    self.lines.append(text)

    async def pump(self, seconds: float) -> None:
        """不发命令,只在超时内吃事件(等静默那一段用)."""
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            except TimeoutError:
                return
            message = json.loads(raw)
            method = message.get("method", "")
            params = message.get("params", {})
            if method == "Runtime.consoleAPICalled":
                args = params.get("args", [])
                value = args[0].get("value") if args else None
                if isinstance(value, str) and value:
                    self.lines.append(value)
            elif method == "Log.entryAdded":
                text = params.get("entry", {}).get("text")
                if isinstance(text, str) and text:
                    self.lines.append(text)


async def main() -> int:
    sw_url = ws_url_of("service_worker", lambda u: "background.js" in u)
    site_url = ws_url_of("page", lambda u: u.startswith(SITE_PREFIX))
    async with AsyncExitStack() as stack:
        sw_ws = await stack.enter_async_context(websockets.connect(sw_url, max_size=None))
        site_ws = await stack.enter_async_context(websockets.connect(site_url, max_size=None))
        sw, site = Recorder(sw_ws), Recorder(site_ws)
        await sw_ws.send(json.dumps({"id": 900, "method": "Runtime.enable"}))
        await sw_ws.send(json.dumps({"id": 901, "method": "Log.enable"}))
        await asyncio.sleep(0.5)

        baseline = await sw.call("'warmup'")
        value = baseline.get("result", {}).get("result", {}).get("value") if baseline else None
        print(f"[watchdog-probe] SW evaluate 基线: {value!r} (期望 'warmup')", flush=True)

        await sw.call(f"chrome.storage.local.set({{'ds-/watchdog':{{'silenceMs':{SILENCE_MS}}}}})")
        await site.call(ACTIVITY_EXPR)
        print(
            f"[watchdog-probe] 存 silenceMs={SILENCE_MS},造动静,等催办({WAIT_SECS}s)...",
            flush=True,
        )
        # 静默窗口内不打 SW(免得 evaluate 的回包把事件吃掉却没记),只 pump.
        await sw.pump(WAIT_SECS)

    lines = sw.lines
    print(f"\n[watchdog-probe] 共录到 {len(lines)} 行 console/log", flush=True)
    hits = [line for line in lines if "看门狗" in line]
    print("=== 判定 ===")
    if lines and not hits:
        print("(录到的行里没有看门狗相关的,前几行:)")
        for line in lines[:8]:
            print(f"  全部| {line}")
    for line in hits:
        print(f"  {line}")
    if any("催办已发" in line for line in hits):
        print("结论: 看门狗催办完成(speak 闸开着,写+发两步都过)")
        return 0
    if any("跳过" in line for line in hits):
        print("结论: 看门狗腿未完成(speak 闸关着,催办被跳过)")
        return 2
    if any("没送出去" in line for line in hits):
        print("结论: 看门狗腿未完成(闸拦着或标签页答不上)")
        return 2
    if any("停手" in line for line in hits):
        print("结论: 看门狗腿未完成(连催到顶停手)")
        return 2
    print("结论: 看门狗腿未完成(静默没到点 / 动静没刷上,控制台无催办行)")
    return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
