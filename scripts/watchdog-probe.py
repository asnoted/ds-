#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""看门狗腿探针:连 MV3 service worker 的 CDP,造动静刷上时刻,等静默,录控制台判定.

看门狗的 `watches` 是 SW 内存 Map,不落盘:重启即清空,`lastActivityAt=null` 时静默
分支永不触发(只在"武装期内"盯梢). 所以催办只能发生在同一 SW 存活期内--先造一条动静,
再趁 SW 活着等 `silenceMs` 到点.

动静 = **开一笔活**(#104 任务门:催办资格挂在"活开着"上).造法两步,顺序不能反:
投一条**排坏的** chain 信封走 `fenceround`(`watchdog` 效果 phase=land,开活),但总开关
得**先关着**--开着的话回灌的答案可注入,自动续聊会把它替用户发出去,模型一回话就收尾,
活只活几秒(真机实测 +4.2s 就收尾,抢在第一扫前面,默认腿就这么踩空的);关着则
`run.enabled=false`,续聊不发消息,模型没话回,活一直开着.造完动静再把开关开回:
`watches` 只在关的那一下清(开活在清场之后),闹钟重排,第一扫落在开活之后,催办才有戏.

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
  - 到时无催办行           → 未完成(开活没成 / 开关没开回 / 静默没到点)

`--generating`(生成相那条腿,#104):不投 `composer.read` 那条动静,改投 `send.page`
要一篇长文 -- 页面进生成相,静默也到点,看门狗临催前读圆键应当改口 `本轮不催,静默窗口
顺延`.这一腿的 `silenceMs` 给 1s(取舍在下面那行):任务门下开活在**落地**那一刻
(发送已进账),开写紧随其后,1s 一过必在生成相里;扫定在投递后 18s,最慢的 pace
(15s,ADR-0004)+ 开销也赶得上,窗口给 10s 就会在扫前差一口气没到点.

扫的相位是探活闹钟排死的(30s 一响,相位跟投递无关):干等实测两轮扫都落在 +40s,而生成只
20s 出头,永远差一截,判据只能得出"没扫到生成相".所以投递前先读闹钟对表
(`wait_for_sweep`),把投递摆在"下次响铃 - 18s";对表睡觉那段时间窗口先停长到 15 分钟,
免得上一轮的静默尾巴被一次扫抢着催,白留催办.

生成相采样 1s 一拍(`SAMPLE_SECS`),时间线只打相变.单拍采样踩过空档:流式输出里页面会在
停止/发送两相之间抖出 2~3s 的空档,采样正好落在空档就得出"现在没在生成",催办打进跑着的
会话(真机实测) -- 所以临催侧改成 `watchdog.observedOutput` 连看三拍(隔 2s,读到一次
"停止"就不出手),这一腿的判据也按时间线说话,不只看谁对谁错.

判定(--generating) -- #104 之后"扫落在生成里不插嘴"有两道独立的闸,两条都算完成:
  - 生成判读那道:`本轮不催` ≥1 且没有催办前 5s 内还在读停止相(活开着,临催前读圆键改口)
  - 任务门那道:链子的活在扫前已干净收尾(模型回话快,`end-task` 先到),扫点确落在
    生成相内(圆键采样覆盖探活行)且全程零催办 -- 静默是任务门拦的,同样没插嘴
  - 有催办前 5s 内还在读停止相   → 未完成(催办正落进生成空档,观察窗没兜住)
  - 两条闸都没沾边               → 未完成(没造出生成 / 没等到扫)

`--gate`(任务门那条腿,#104 第二半):先照默认腿造动静把催办催出来(基线:这一轮
扫得动,催得出),催办会把模型惹来回话;回话没有围栏 = 页面世界报 `end-task`,SW 打
`本笔活收尾`. 收尾后干等一个扫周期再多(POST_CLOSE_SECS):窗口还是那 1s,静默早过了,
若任务门没拦住就一定再催 -- 判据只看收尾线**之后**还有没有催办行.

判定(--gate):
  - 有收尾线,收尾前有催办,收尾后 0 催办 → 完成(任务门生效:没活不开口)
  - 收尾线等不到                → 未完成(模型回话还带着围栏,活没收到尾)
  - 收尾前没有催办              → 未完成(基线不成立:开活那侧没催出来)
  - 收尾后仍有催办              → 未完成(收了活还在催,任务门没拦住)

用法:
  uv run scripts/watchdog-probe.py
  uv run scripts/watchdog-probe.py --generating   # 验完删 ds-/watchdog 键
  uv run scripts/watchdog-probe.py --gate         # 验完删 ds-/watchdog 键
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
#: 生成相采样间隔(秒):1s 一拍才看得清"停止/发送"之间那 2~3s 的空档,
#: 3s 一拍会把空档拍没,判不出催办是不是正落在空档里.
SAMPLE_SECS = 1.0
#: 对表提前量(秒):把投递摆到"下一次扫"之前这么多秒 -- 扫早于静默到点是白扫,
#: 扫晚于生成结束就只剩催办落空.扫的相位是固定死的(真机实测两轮都落在 40s,
#: 而生成只 20s 出头,干等只能得出"没扫到生成相"),所以要读闹钟对表,别赌相位.
SWEEP_LEAD_S = 18.0
#: 看门狗搭的那趟探活闹钟的周期(`background.ts` 里写死 30s,是 alarms 的下限),
#: 对表读不到时算"下下一次扫"用.
ALARM_PERIOD_S = 30.0
#: 探活闹钟名,与 `background.ts` 的 HEALTH_ALARM_NAME 保持一致.
ALARM_EXPR = (
    "(async()=>{const all=await chrome.alarms.getAll();"
    "const h=all.find((x)=>x.name==='relay-health');"
    "return h ? h.scheduledTime : 0;})()"
)

#: 生成相那条腿(`--generating`)的窗口:任务门下开活在 land(发送已落地),模型开写
#: 紧随其后;扫定在投递后 18s,pace 最长 15s(ADR-0004)+ 开销,窗口给 1s 才保证扫前
#: 到点,而开写早在 land 前后,1s 内必在生成相里,不会在开写前误触发.
GENERATE_SILENCE_MS = 1000

#: 任务门那条腿(`--gate`)的三段时限(秒):开活后催出基线催办;催办后等模型
#: 回话报收尾;收尾后干等的那段必须**大于闹钟周期**(ALARM_PERIOD_S),否则证
#: 不明"收尾后至少扫过一次还被拦下".
GATE_NUDGE_SECS = 70.0
GATE_CLOSE_SECS = 75.0
GATE_POST_CLOSE_SECS = 50.0

#: 长任务正文:生成要**盖得住投递后那次扫**(对表留 18s,见 SWEEP_LEAD_S),
#: 留薄了就白等 -- 3000 字那档实测只写 17~24s,撞上开写延迟就没余量了.
#: 比 `page-action.py stop-test` 的默认消息更长,原因就在这,别顺手改短.
GENERATE_TEXT = "请写一篇 8000 字的散文,主题是海边的灯塔,分段,慢慢写,一定要写满."

#: 造动静 + 造生成的那条 chain 信封:本地工具 `send.page` 两步走动作流,
#: 发完即回确认,页面随即进入生成相;它经 `fenceround` 的 `watchdog` 效果
#: 刷动静时刻,所以这一腿不用再单独投 `composer.read`.
GENERATE_EXPR = (
    "window.postMessage({source:'ds-/chain',kind:'call',id:'probe-wd-generating',"
    "calls:[JSON.stringify({tool:'send.page',arguments:{question:"
    + json.dumps(GENERATE_TEXT)
    + "}})]},'*');'sent'"
)

#: 造动静(=开活)的那条 chain 信封:排坏的围栏(`parseToolCall` 认不出)当场回提示,
#: 不打中继;提示可注入 → `fenceround` 落地(land)开一笔活.
#: **必须在总开关关着时投**(见文件头):开着的话自动续聊会把提示替用户发出去,
#: 模型一回话任务就收尾,活抢在第一扫之前就没了.
ACTIVITY_EXPR = (
    "window.postMessage({source:'ds-/chain',kind:'call',id:'probe-wd-activity',"
    "calls:['probe-not-a-tool-call']},'*');'sent'"
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
        """不发命令,只在超时内吃事件(等静默那一段用).

        每 10s 点一下 SW(MV3 闲置 30s 就收人,长睡没人替它续命;点的那一下
        只求回包不求结果,顺路把途经的 console 记下).
        """
        deadline = time.monotonic() + seconds
        next_beat = time.monotonic() + 10.0
        while True:
            now = time.monotonic()
            if now >= deadline:
                return
            if now >= next_beat:
                await self.call("'beat'", timeout=3.0)
                next_beat = now + 10.0
                continue
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=min(deadline, next_beat) - now)
            except TimeoutError:
                continue
            self._record(json.loads(raw))


async def wait_for_sweep(sw: Recorder) -> float:
    """读探活闹钟的下次响铃时刻,算出投递前该先睡多久;读不到(0 / 已过期)回 0.

    算法:投递摆在 `下次响铃 - SWEEP_LEAD_S`;差得太近(不到 2s)就再等一个周期.
    返回秒数,由调用方 `pump` 睡 -- 睡觉期间照样录 console.
    """
    res = await sw.call(ALARM_EXPR, timeout=8.0)
    value = res.get("result", {}).get("result", {}).get("value") if res else 0
    now = time.time() * 1000
    if not isinstance(value, (int, float)) or value <= now:
        return 0.0
    send_at = value - SWEEP_LEAD_S * 1000
    if send_at <= now + 2_000:
        send_at += ALARM_PERIOD_S * 1000
    return max(0.0, (send_at - now) / 1000)


def stop_spans(samples: list[tuple[float, str]]) -> list[tuple[float, float]]:
    """圆键采样里 stop 相的起止区间(边界取相邻采样时刻,粒度 = 采样间隔)."""
    spans: list[tuple[float, float]] = []
    start: float | None = None
    previous: float | None = None
    for ts, text in samples:
        if '"stop"' in text:
            if start is None:
                start = ts
        elif start is not None:
            spans.append((start, previous if previous is not None else ts))
            start = None
        previous = ts
    if start is not None and previous is not None:
        spans.append((start, previous))
    return spans


async def main(leg: str) -> int:
    generating = leg == "generating"
    gate = leg == "gate"
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
        if generating:
            # 对表先把窗口停长:睡的这一段里上一轮的静默尾巴还记着账,窗口短的话
            # 这期间的一次扫就会抢着催,白留一条催办.睡够了再拧短,投递,
            # 让那次扫正落在生成相里(见 SWEEP_LEAD_S).
            await sw.call("chrome.storage.local.set({'ds-/watchdog':{'silenceMs':900000}})")
            lead = await wait_for_sweep(sw)
            if lead > 0:
                print(
                    f"[watchdog-probe] 对表:先睡 {lead:.0f}s,"
                    f"让下一次扫落在投递后 {SWEEP_LEAD_S:.0f}s 处",
                    flush=True,
                )
                await sw.pump(lead)
            await sw.call(f"chrome.storage.local.set({{'ds-/watchdog':{{'silenceMs':{silence}}}}})")
            await site.call(GENERATE_EXPR)
        else:
            # 开活的两步,顺序不能反(见文件头):先关总开关(清场 + 续聊闭嘴),
            # 再投动静(land 开活)--开着开关投的话模型几秒内就回话收尾了.
            await sw.call("chrome.storage.local.set({'toggle':false})")
            await sw.pump(1.0)
            await sw.call(f"chrome.storage.local.set({{'ds-/watchdog':{{'silenceMs':{silence}}}}})")
            await site.call(ACTIVITY_EXPR)
        # 从这一刻起的 console 才算这一轮的证据(enable 瞬间的整批回放是历史,见 realtime_lines).
        armed_at = time.time() * 1000
        if generating:
            plan = f"等判定({WAIT_SECS}s)"
        elif gate:
            total = GATE_NUDGE_SECS + GATE_CLOSE_SECS + GATE_POST_CLOSE_SECS
            plan = f"开回开关等判定(约 {total:.0f}s)"
        else:
            plan = f"开回开关等判定(≤{GATE_NUDGE_SECS:.0f}s)"
        print(
            f"[watchdog-probe] 存 silenceMs={silence},"
            + ("投 send.page 造生成" if generating else "关开关投排坏围栏开活")
            + f",{plan}...",
            flush=True,
        )
        # 先确认闹钟真排上了:排不上,后面等多久都是白等,失败得在这一步就说出口.
        # 初值必须在这之前 -- 放在判定后头会被重置掉,结论就永远说不清闹钟的事.
        schedule_ok = True
        if not generating:
            await sw.pump(1.5)  # 等回灌落地(land)把活开起来
            await sw.call("chrome.storage.local.set({'toggle':true})")
            alarm_at = 0.0
            for _ in range(6):
                res = await sw.call(ALARM_EXPR, timeout=8.0)
                val = res.get("result", {}).get("result", {}).get("value") if res else 0
                if isinstance(val, (int, float)) and val > time.time() * 1000:
                    alarm_at = val
                    break
                await sw.pump(1)
            if alarm_at > 0:
                print(
                    f"[watchdog-probe] 开活落地,开关开回,闹钟已排"
                    f"(下次响铃 {(alarm_at - time.time() * 1000) / 1000:.0f}s 后)",
                    flush=True,
                )
            else:
                schedule_ok = False
                alive = await sw.call("'alive'", timeout=4.0)
                alive_val = (
                    alive.get("result", {}).get("result", {}).get("value") if alive else None
                )
                if alive_val == "alive":
                    print(
                        "[watchdog-probe] **闹钟没排上**:SW 活着,但开回开关后台没重排探活,"
                        "白等也没用",
                        flush=True,
                    )
                else:
                    print(
                        "[watchdog-probe] **SW 掉线**:评估无回包,闹钟也读不到--"
                        "先用 page-action 任意命令唤醒后台再跑探针",
                        flush=True,
                    )
        # 静默窗口内别乱打 SW:走 `call()` 是安全的(它等自己回包时顺路记 console,
        # 见文件头).默认腿只 pump;生成相那条腿每 SAMPLE_SECS 采一次圆键读数,留成时间线 --
        # "扫的那一刻页面在不在生成"要拿当时的读数说话,不能只看最后谁对谁错.
        # 任务门那条腿分三段等:催出基线 → 等模型回话报收尾 → 收尾后干等一个扫周期.
        samples: list[tuple[float, str]] = []
        if generating:
            deadline = time.monotonic() + WAIT_SECS
            while time.monotonic() < deadline:
                await sw.pump(SAMPLE_SECS)
                phase = await sw.call(PHASE_EXPR, timeout=8.0)
                got = phase.get("result", {}).get("result", {}).get("value")
                samples.append((time.time() * 1000, str(got)))
        elif gate:

            async def has_line(needle: str) -> bool:
                return any(needle in text for text in sw.realtime_lines(armed_at))

            # A:开活后等基线催办(证明这一轮扫得动,催得出,后面的"没再催"才站得住).
            deadline = time.monotonic() + GATE_NUDGE_SECS
            while time.monotonic() < deadline and not await has_line("催办已发"):
                await sw.pump(5)
            # B:催办惹来回话,回话没有围栏 → end-task 收尾上报 → `本笔活收尾`.
            deadline = time.monotonic() + GATE_CLOSE_SECS
            while time.monotonic() < deadline and not await has_line("本笔活收尾"):
                await sw.pump(5)
            # C:收尾后干等 -- 窗口还是短的,静默早过,任务门是唯一拦得住催办的东西.
            await sw.pump(GATE_POST_CLOSE_SECS)
        else:
            # 默认腿:等基线催办(开活后的第一扫,闹钟周期 30s,多等一点兜住首响相位).
            deadline = time.monotonic() + GATE_NUDGE_SECS
            while time.monotonic() < deadline and not any(
                "催办已发" in text for text in sw.realtime_lines(armed_at)
            ):
                await sw.pump(5)

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
        + (f" / 实时不催 {skipped} 次" if generating or gate else "")
    )
    # 实时行通常就几条,全打出来带相对时刻:收尾,催办,扫的先后是判据的一部分,
    # 光看"有没有"看不出谁先谁后.
    for ts, line in sw.events:
        if ts >= armed_at:
            print(f"    +{(ts - armed_at) / 1000:6.1f}s {line}")
    if not schedule_ok:
        print("结论: 未完成(探活闹钟没排上或后台掉线,扫根本不会来)")
        return 2
    if generating:
        # 时间线只打相变:1s 一拍打全量是噪音,相变才说得出空档从哪到哪.
        prev = None
        marks: list[tuple[float, str]] = [(armed_at, "投 send.page")]
        for ts, text in samples:
            phase = "stop" if '"stop"' in text else ("send" if '"send"' in text else text)
            if phase != prev:
                marks.append((ts, f"圆键→{phase}"))
                prev = phase
        marks.extend((ts, text) for ts, text in sw.events if ts >= armed_at and "看门狗" in text)
        for ts, text in sorted(marks):
            print(f"    +{(ts - armed_at) / 1000:6.1f}s {text}")
        # 催办前 5s 内还读到过停止相 = 正往生成里插消息(观察窗没兜住这一档).
        stop_ts = [ts for ts, text in samples if '"stop"' in text]
        nudge_ts = [ts for ts, text in sw.events if ts >= armed_at and "催办已发" in text]
        bleeding = [n for n in nudge_ts if any(n - 5_000 <= s <= n for s in stop_ts)]
        if skipped >= 1 and not bleeding:
            print("结论: 生成相判读生效(扫到生成就顺延窗口不插嘴,没往生成里插催办,#104)")
            return 0
        if bleeding:
            print(f"结论: 未完成({len(bleeding)} 次催办前 5s 内还在生成,观察窗没兜住)")
            return 2
        # 任务门那道闸(#104):链子的活在扫前就干净收尾,扫的决策走任务门静默,生成判读
        # 那行日志出不来 -- 但扫点确在生成相里(圆键采样覆盖探活行),全程零催办,同样证明
        # "没往生成里插嘴".静默窗口 1s,扫点距投递 18s,静默必然已到点;封手/停手在
        # 零催办的前提下不成立,这次静默只能是任务门给的.
        closes = [ts for ts, text in sw.events if ts >= armed_at and "本笔活收尾" in text]
        sweeps = [ts for ts, text in sw.events if ts >= armed_at and "周期探活" in text]
        covered = [
            ts for ts in sweeps if any(start <= ts <= end for start, end in stop_spans(samples))
        ]
        attempts = sum(1 for line in live if "催办" in line)
        if closes and covered and attempts == 0:
            print(
                f"结论: 生成相未插嘴(收尾 {len(closes)} 次在前,{len(covered)} 次扫落在生成相内,"
                "任务门静默拦下,全程零催办;#104)"
            )
            return 0
        print("结论: 未完成(没扫到生成相,控制台无本轮不催行)")
        return 2
    if gate:
        closes = [ts for ts, text in sw.events if ts >= armed_at and "本笔活收尾" in text]
        nudge_ts = [ts for ts, text in sw.events if ts >= armed_at and "催办已发" in text]
        before = [ts for ts in nudge_ts if not closes or ts < closes[0]]
        after = [ts for ts in nudge_ts if closes and ts >= closes[0]]
        print(
            f"  任务门:收尾 {len(closes)} 次 / 收尾前催办 {len(before)} 次"
            f" / 收尾后催办 {len(after)} 次"
        )
        if not before:
            print("结论: 未完成(开活那侧没催出基线,证不了门)")
            return 2
        if not closes:
            print("结论: 未完成(没等到本笔活收尾:模型回话还带着围栏,换干净会话复跑)")
            return 2
        if after:
            print(f"结论: 未完成(收尾后仍催 {len(after)} 次,任务门没拦住)")
            return 2
        print("结论: 任务门生效(收活后静默再久也不开口,基线催办照发,#104)")
        return 0
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
    argv = sys.argv[1:]
    chosen = "generating" if "--generating" in argv else ("gate" if "--gate" in argv else "default")
    raise SystemExit(asyncio.run(main(chosen)))
