#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""诊断 MV3 service worker 的 CDP:Runtime.evaluate 的返回值与 console 事件能不能到.

分开报三个判据,定位是 evaluate 断,事件流断,还是 SW 被 MV3 收走:
  - evaluate 返回值: 在 SW 里 return 42,看回包里的 value 是不是 42.
  - evaluate 后的 console 事件: 打一条 console.log,看 consoleAPICalled 到不到.
  - Storage.set 后的回读: set 一个键再 get,看 SW 的 storage API 通不通.

用法:
  uv run scripts/sw-cdp-probe.py
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.request

import websockets

PORT = 9222
CDP = f"http://127.0.0.1:{PORT}"


def sw_ws_url() -> str:
    with urllib.request.urlopen(f"{CDP}/json", timeout=5) as response:
        targets = json.load(response)
    for target in targets:
        if target.get("type") == "service_worker" and "background.js" in target.get("url", ""):
            return target["webSocketDebuggerUrl"]
    raise SystemExit("没找到扩展 service worker 目标")


def record_console(message: dict, events: list[str], since_ms: float) -> None:
    """把这条消息里的 console 行记下来;`Runtime.enable` 回放的历史(时间戳旧)不算.

    回放能到只说明连接通,证不了"此刻还到";不滤时间戳,[4] 会把历史回放判成绿的
    (`watchdog-probe.py` 的文件头写着同一条教训).
    """
    if message.get("method") != "Runtime.consoleAPICalled":
        return
    params = message.get("params", {})
    ts = params.get("timestamp", 0)
    if not isinstance(ts, (int, float)) or ts < since_ms:
        return
    args = params.get("args", [])
    events.append(str(args[0].get("value")) if args else "?")
    print(f"  consoleAPICalled| {events[-1]}", flush=True)


async def call(
    ws: websockets.ClientConnection,
    id_: int,
    expr: str,
    timeout: float,
    events: list[str],
    since_ms: float,
) -> object:
    await ws.send(
        json.dumps(
            {
                "id": id_,
                "method": "Runtime.evaluate",
                "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
            }
        )
    )
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return {"timeout": True, "id": id_}
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except TimeoutError:
            return {"timeout": True, "id": id_}
        message = json.loads(raw)
        if message.get("id") == id_:
            return message
        # 等回包时途经的 console 事件也顺路记下(纯监听那一路实测收不到).
        record_console(message, events, since_ms)


async def main() -> int:
    sw_url = sw_ws_url()
    events: list[str] = []
    # 这一刻之前的 console 都是 `Runtime.enable` 的回放(历史),不算本轮证据.
    since_ms = time.time() * 1000
    async with websockets.connect(sw_url, max_size=None) as sw:
        await sw.send(json.dumps({"id": 900, "method": "Runtime.enable"}))
        await asyncio.sleep(0.5)

        r1 = await call(sw, 1, "42", 5, events, since_ms)
        v1 = r1.get("result", {}).get("result", {}).get("value") if isinstance(r1, dict) else None
        print(f"[1] evaluate 返回值: {v1!r} (期望 42)  raw_ok={'result' in (r1 or {})}")

        r2 = await call(
            sw, 2, "console.log('[dsb-probe] sw-cdp-alive');'logged'", 5, events, since_ms
        )
        v2 = r2.get("result", {}).get("result", {}).get("value") if isinstance(r2, dict) else None
        print(f"[2] console.log 后 evaluate 返回值: {v2!r} (期望 'logged')")

        storage_expr = (
            "chrome.storage.local.set({'dsb/probe':1})"
            ".then(() => chrome.storage.local.get('dsb/probe'))"
            ".then((v) => JSON.stringify(v))"
        )
        r4 = await call(sw, 3, storage_expr, 8, events, since_ms)
        v4 = r4.get("result", {}).get("result", {}).get("value") if isinstance(r4, dict) else None
        print(f"[3] storage set+get: {v4!r}")

        await call(sw, 4, "console.log('[dsb-probe] second-mark');'logged'", 5, events, since_ms)
        await asyncio.sleep(1)

        while True:
            try:
                raw = await asyncio.wait_for(sw.recv(), timeout=1)
            except TimeoutError:
                break
            record_console(json.loads(raw), events, since_ms)

        last = f";末条 {events[-1]!r}" if events else ":无"
        print(f"[4] 本轮 console 事件录到 {len(events)} 条{last}")

    print("\n=== 判据 ===")
    print(f"  SW 活着且 evaluate 通: {v1 == 42}")
    print(f"  storage API 通: {v4 is not None}")
    print(f"  console 事件能到: {bool(events)}")
    if v1 != 42:
        print("  → SW 被 MV3 收走 / evaluate 断:看门狗腿跑不了,需先让 SW 醒着")
    elif not events:
        print("  → evaluate 通但 console 事件流断:探针得换观测路(别依赖 consoleAPICalled)")
    return 0 if v1 == 42 and events else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
