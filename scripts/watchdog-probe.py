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

`--generating`(生成相那条腿,#104):不投 `composer.read` 那条动静,改投 `send.page`
要一篇长文 -- 页面进生成相,静默也到点,看门狗临催前读圆键应当改口 `本轮不催,静默窗口
顺延`.这一腿的 `silenceMs` 给 10s(取舍在下面那行):投完到真正开写约 5s(pace 的 3~5s),
窗口短于它就会在开写前到点,抢先催一条;窗口又必须短于闹钟周期(30s),否则等不到扫.

判定(--generating):
  - `本轮不催` ≥1 且 `催办已发` = 0 → 完成(生成相判读生效)
  - 出现 `催办已发`                  → 未完成(开写前被抢先催,或判读没生效)
  - 两者都没有                       → 未完成(没造出动静 / 没等到扫)

用法:
  uv run scripts/watchdog-probe.py
  uv run scripts/watchdog-probe.py --generating   # 验完删 ds-/watchdog 键
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.request
from contextlib import AsyncExitStack

import websockets

PORT = 9222
CDP = f"http://127.0.0.1:{PORT}"
SITE_PREFIX = "https://chat.deepseek.com/"
SILENCE_MS = 1000
WAIT_SECS = 40

#: 生成相那条腿(`--generating`)的窗口:开写要等 pace 的 3~5s,窗口短于它就会
#: 在开写前到点抢先催;又必须短于健康闹钟的 30s 周期,否则等不到扫.
GENERATE_SILENCE_MS = 10_000

#: 长任务正文(同 `page-action.py stop-test` 的默认消息):写几十秒,盖得住一次扫描.
GENERATE_TEXT = "请写一篇 3000 字的散文,主题是海边的灯塔,分段,慢慢写,一定要写满."

#: 造动静 + 造生成的那条 chain 信封:本地工具 `send.page` 两步走动作流,
#: 发完即回确认,页面随即进入生成相;它经 `fenceround` 的 `watchdog` 效果
#: 刷动静时刻,所以这一腿不用再单独投 `composer.read`.
GENERATE_EXPR = (
    "window.postMessage({source:'ds-/chain',kind:'call',id:'probe-wd-generating',"
    "calls:[JSON.stringify({tool:'send.page',arguments:{question:"
    + json.dumps(GENERATE_TEXT)
    + "}})]},'*');'sent'"
)

#: 一条无害的 chain 信封:本地工具 `composer.read` 只读写作框,不发送,不留痕.
#: 投它走 `content.ts` → `background` → `fenceround.handle` → `watchdog` 效果 →
#: `watchdogSeen` 刷动静时刻. 用本地工具而非中继工具:中继那腿要真网关在跑.
ACTIVITY_EXPR = (
    "window.postMessage({source:'ds-/chain',kind:'call',id:'probe-wd-activity',"
    "calls:[JSON.stringify({tool:'composer.read',arguments:{}})]},'*');'sent'"
)

#: 生成相那条腿的采样:从 SW 问一次 `button.get`,把圆键读数留在时间线上 --
#: 判"扫的那一刻页面在不在生成"要有当时的读数,不能只看最后谁对谁错.
PHASE_EXPR = (
    "(async()=>{const tabs=await chrome.tabs.query({});"
    f"const t=tabs.find((x)=>x.url&&x.url.startsWith({json.dumps(SITE_PREFIX)}));"
    "if(!t)return 'no-site-tab';"
    "const frame={type:'action',id:'probe-wd-phase',action:'button.get',params:{},"
    "target:String(t.id)};"
    "const r=await chrome.tabs.sendMessage(t.id,{type:'ds-/action',frame});"
    "return JSON.stringify(r);})()"
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
        self.events: list[tuple[float, str]] = []
        self._seq = 0

    @property
    def lines(self) -> list[str]:
        return [text for _ts, text in self.events]

    def realtime_lines(self, since_ms: float) -> list[str]:
        """只要 `since_ms` 之后的行.

        **必须过滤**:enable 的瞬间 CDP 会把 SW 缓冲的历史 console 整批回放
        (实测一次能回放上千行,跨数小时),不过滤就会把上一轮探针的催办行
        当成这一轮的判定(踩过:证据链被污染).
        """
        return [text for ts, text in self.events if ts >= since_ms]

    def _record(self, message: dict) -> None:
        method = message.get("method", "")
        params = message.get("params", {})
        if method == "Runtime.consoleAPICalled":
            args = params.get("args", [])
            value = args[0].get("value") if args else None
            ts = float(params.get("timestamp", 0))
            if isinstance(value, str) and value:
                self.events.append((ts, value))
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            text = entry.get("text")
            ts = float(entry.get("timestamp", 0))
            if isinstance(text, str) and text:
                self.events.append((ts, text))

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
            self._record(message)

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
            self._record(json.loads(raw))


async def main(generating: bool) -> int:
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

        silence = GENERATE_SILENCE_MS if generating else SILENCE_MS
        await sw.call(f"chrome.storage.local.set({{'ds-/watchdog':{{'silenceMs':{silence}}}}})")
        await site.call(GENERATE_EXPR if generating else ACTIVITY_EXPR)
        # 从这一刻起的 console 才算这一轮的证据(enable 瞬间的整批回放是历史,见 realtime_lines).
        armed_at = time.time() * 1000
        print(
            f"[watchdog-probe] 存 silenceMs={silence},"
            + ("投 send.page 造生成" if generating else "造动静")
            + f",等判定({WAIT_SECS}s)...",
            flush=True,
        )
        # 静默窗口内别乱打 SW:走 `call()` 是安全的(它等自己回包时顺路记 console,
        # 见文件头).默认腿只 pump;生成相那条腿每 3s 采一次圆键读数,留成时间线 --
        # "扫的那一刻页面在不在生成"要拿当时的读数说话,不能只看最后谁对谁错.
        samples: list[tuple[float, str]] = []
        if generating:
            deadline = time.monotonic() + WAIT_SECS
            while time.monotonic() < deadline:
                await sw.pump(3.0)
                phase = await sw.call(PHASE_EXPR, timeout=8.0)
                got = phase.get("result", {}).get("result", {}).get("value")
                samples.append((time.time() * 1000, str(got)))
        else:
            await sw.pump(WAIT_SECS)

    lines = sw.lines
    live = sw.realtime_lines(armed_at)
    print(
        f"\n[watchdog-probe] 共录到 {len(lines)} 行,其中 {len(live)} 行是本轮实时"
        "(其余为 enable 回放)",
        flush=True,
    )
    if lines:
        # 摘要:动静从哪来. 看门狗催办后页面若有回话/围栏,SW 会连带刷屏--
        # 这正是"停手之后又开始催"的常见来源(真动静,不是催办自己刷窗).
        tally: dict[str, int] = {}
        for line in lines:
            key = line[:40]
            tally[key] = tally.get(key, 0) + 1
        print("  高频前缀(含回放):", flush=True)
        for key, count in sorted(tally.items(), key=lambda kv: -kv[1])[:5]:
            print(f"    {count:4d}x {key}", flush=True)
    hits = [line for line in live if "看门狗" in line]
    nudges = sum(1 for line in live if "催办已发" in line)
    stands = sum(1 for line in live if "停手" in line)
    skipped = sum(1 for line in live if "本轮不催" in line)
    print("=== 判定(只认本轮实时行)===")
    print(
        f"  实时催办 {nudges} 次 / 实时停手 {stands} 次"
        + (f" / 实时不催 {skipped} 次" if generating else "")
    )
    if live and not hits:
        print("(实时行里没有看门狗相关的,实时前几行:)")
        for line in live[:8]:
            print(f"  实时| {line}")
    for line in hits:
        print(f"  {line}")
    if generating:
        print("  时间线(相对投 send.page 那一刻,采样=圆键读数):")
        marks: list[tuple[float, str]] = [
            (armed_at, "投 send.page"),
            *((ts, f"圆键 {text}") for ts, text in samples),
            *((ts, text) for ts, text in sw.events if ts >= armed_at and "看门狗" in text),
        ]
        for ts, text in sorted(marks):
            print(f"    +{(ts - armed_at) / 1000:6.1f}s {text}")
        if skipped >= 1 and nudges == 0:
            print("结论: 生成相判读生效(临催读到停止相,顺延窗口不插嘴,#104)")
            return 0
        if nudges >= 1:
            print("结论: 未完成(生成相里仍发了催办,或开写前被抢先催)")
            return 2
        print("结论: 未完成(没造出动静 / 没等到扫,控制台无判定行)")
        return 2
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
    raise SystemExit(asyncio.run(main("--generating" in sys.argv[1:])))
