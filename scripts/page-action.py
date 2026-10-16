#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""页面动作真机探针(开发用):经 CDP 把一件页面动作发给 DeepSeek 标签页的内容脚本名册.

外部动作口随 ADR-0011 废掉后,没有外露探针面;这个脚本补上开发期的那只手:
动作走扩展自己的名册(内容脚本 `ACTION_ROSTER`),绕开 `runAction` 的三道闸(总开关 /
替人开口 / 退避)--那是给产品路径用的,探针要能直接验执行器.只读页面 DOM 与驱动扩展
自身,不 hook 站点,不碰令牌(issue #31 的硬边界).

前置:ds-browser 带调试口起(`--remote-debugging-port=9222`).缺了它会打印怎么起.

用法:
  uv run scripts/page-action.py list
  uv run scripts/page-action.py read
  uv run scripts/page-action.py send button.get
  uv run scripts/page-action.py send composer.type --params '{"text": "你好"}'
  uv run scripts/page-action.py storage get --keys '["backoffUntil","toggle","speak"]'
  uv run scripts/page-action.py toggles-off   # 测试环境:把深度思考,智能搜索都关掉
  uv run scripts/page-action.py evidence      # 存证对账:留档原件 vs 站点当前那一颗(ADR-0018)

`send` / `storage` 遇瞬时失败(`read-failed` / `page-changed` / `no-site-tab` / CDP 超时)
不直接回错误:脚本自己排队,等限速时间到重发,`--attempts` 定总次数(默认 5).

两件只有探针知道的事(原先记在 AGENTS.md, 搬进来自带):

1. `target: null` 只有 `tabs.list` / `toggle.*` / `storage.*` 答得出. `page.state` /
   `composer.*` / `messages.*` / `chat.new` 要先 `tabs.list` 拿标签页 id 再带上,
   其余一律落 `ACTION_ERROR_UNKNOWN` -- **那是探针错了, 不是链子坏了**,
   别照着它去修扩展.

2. **本地工具**(`send.page` 等)不在 `ACTION_ROSTER` 里, `send` 调不到. 唯一触发
   办法是用 `js` 往页面里注入一条 chain 信封, 让它走 `content.ts` → background:

     uv run scripts/page-action.py js 'window.postMessage({source:"ds-/chain",kind:"call",
       id:"probe-1",calls:[JSON.stringify({tool:"send.page",arguments:{question:"..."}})]},"*")'

   要页面模型**自己**排围栏的路径(如本地工具)只能这么验; 不要为了验一个动作去
   诱导模型排围栏.

环境:
  DSB_CDP_PORT   调试口端口,默认 9222
  DSB_EXT_DIR    扩展构建目录,默认 <repo>/.output/chrome-mv3(扩展 id 由它推出)
  DSB_SITE_MATCH 目标标签页 url 前缀,默认 https://chat.deepseek.com/
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import websockets

PORT = int(os.environ.get("DSB_CDP_PORT", "9222"))
CDP = f"http://127.0.0.1:{PORT}"
REPO = Path(__file__).resolve().parent.parent
EXT_DIR = Path(os.environ.get("DSB_EXT_DIR", str(REPO / ".output" / "chrome-mv3")))
SITE_MATCH = os.environ.get("DSB_SITE_MATCH", "https://chat.deepseek.com/")

#: 站点上的动作信封(与 `src/lib/channel.ts` 的 `ACTION_MESSAGE_TYPE` 同一份).
ACTION_MESSAGE_TYPE = "ds-/action"

#: 页面世界 → 内容脚本的 chain 信封标记(与 `src/lib/channel.ts` 的 `CHAIN_MESSAGE_SOURCE` 同一份).
CHAIN_MESSAGE_SOURCE = "ds-/chain"

#: 失败痕与现场帧那两个键(与 `src/lib/failurelog.ts` / `failureframe.ts` 同一份).
FAILURE_LOG_KEY = "ds-/failures"
FAILURE_FRAME_KEY = "ds-/failure-frames"

#: 负路探针投的那条失败由因:与真痕同形,一眼看得出是探针造的(#106).
FRAME_FAIL_CAUSE = "探针造的失败:验抓帧负路(#106)"

#: 负路探针等那笔痕落地的时间上限:痕是 background 收到上报后当场落的,几秒足够.
FRAME_FAIL_WAIT = 5.0

#: 总开关键(与 `src/lib/toggle.ts` 的 `TOGGLE_STORAGE_KEY` 同一份):background 只在这个
#: 键变时把它手里那份留痕/帧从 storage 重读一遍,所以探针拿它当"重读一次"的扳手.
TOGGLE_KEY = "toggle"

#: "代你发言"闸(与 `src/lib/registry.ts` 的三道闸同一份真源).探针**只读**它:
#: 闸只能人勾,agent 不代勾也不代关--哪条腿跑得动由当前这把闸决定.
SPEAK_KEY = "speak"

#: 总开关关一下再开之后,等两边各自就位(background 重读留痕,content script 重挂名册).
BACKGROUND_SETTLE = 1.2

#: 本地工具 `send.page` 的探针问题(ADR-0013):一眼看得出是探针发的.判据按**整条**比,
#: 所以正文后面挂一个每次跑都不一样的号--不挂的话,重跑时上一轮那条会冒充这一轮.
SEND_PAGE_QUESTION = "真机探针:收到就只回两个字--收到"

#: 投完链信封,等"问题进对话"的秒数上限:第一步 `composer.type` 是当场写,第二步
#: `send.enter` 还要过扩展自己那条唯一限速(ADR-0029,最长 15 秒)才发得出去.
SEND_PAGE_WAIT = 45.0

#: 站点把发出那条消息搬进对话列表有先后:紧跟判据读到的写作框还带着上一拍的残影,
#: 报告里那个数要等落了地再读一次(判据只用"进没进对话",不靠这个读).
SEND_PAGE_SETTLE = 1.0

#: 续聊那条短标记(与 `src/lib/continuation.ts` 的 `CONTINUATION_MARKER` 同一份):
#: `send.page` 的载荷按回灌口径回页面,闸开着时工具结果就顺这条标记自动续一轮.
CONTINUATION_MARKER = "agent:\n继续"

#: 等"自动续的那一轮也发出去"的秒数上限:工具结果从进队列到发出去要过唯一限速(最长 15 秒).
SEND_PAGE_CONTINUE_WAIT = 20.0

#: `target: null` 的动作:由 background 的 `runAction` 就地执行(内容脚本名册里没有
#: 它们),所以发法不同--`runtime.sendMessage` 直送 background.名单与文件头那句
#: 知识,注册表里 `target` 恒为 null 的行逐字对应(`registry.test.ts` 守卫对拍).
TARGET_NULL_ACTIONS = frozenset(
    {
        "tabs.list",
        "toggle.get",
        "toggle.set",
        "storage.get",
        "storage.set",
        "storage.remove",
    }
)

#: 唯一限速(ADR-0029):动手前的等待与扩展的发送限速是**同一条**--Beta(2,4),
#: 3~15s,峰在 6s.规格住在共享 fixture 里,TS 与 Python 共读,漂移会被两边的测试抓住;
#: `--pace MIN,MAX` 只剩人工排障的口子,默认路径永远走这一条.
SEND_PACE_SPEC_FILE = REPO / "protocol" / "fixtures" / "send-pace.json"


def load_send_pace_spec() -> dict:
    return json.loads(SEND_PACE_SPEC_FILE.read_text(encoding="utf-8"))


def draw_window_interval(spec: dict, rng=None) -> float:
    """抽一个间隔(毫秒):sampleSize 个均匀数里第 sampleRank 小的那个,映射进 [minMs, maxMs].

    与 `src/lib/outbound.ts` 的 drawWindowInterval 同一个算法(次序统计量采样,天然有界);
    非有限的随机数按 0 处理,两半同语义.
    """
    if rng is None:
        rng = random.random
    draws = []
    for _ in range(spec["sampleSize"]):
        raw = rng()
        draws.append(min(max(raw, 0.0), 1.0) if math.isfinite(raw) else 0.0)
    draws.sort()
    ratio = draws[spec["sampleRank"] - 1]
    return spec["minMs"] + ratio * (spec["maxMs"] - spec["minMs"])


#: 页面控件存证(ADR-0018):真机按钮原件.CI 对拍管"存证 ↔ 回归用例",这里管"站点 ↔ 存证".
EVIDENCE_FILE = REPO / "protocol" / "evidence" / "controls.json"


def pace(spec: str | None, *, no_pace: bool = False) -> None:
    """动手前随机等一下(默认开,`--no-pace` 关,`--pace MIN,MAX` 自定义).

    默认与扩展的发送限速**同一条**(唯一限速,ADR-0029):Beta(2,4),3~15s,峰在 6s.
    为什么固化进工具而不是每次手敲:这条纪律靠记性一定会漏,而漏了就是连打站点.
    随机而非固定时长,免得打出机器人的节奏.打印等待时长,方便复盘时对齐时间线.
    """
    if no_pace:
        return
    if spec:
        parts = spec.split(",")
        try:
            low = float(parts[0])
            high = float(parts[1]) if len(parts) > 1 else low
        except (ValueError, IndexError):
            print(f'[page-action] --pace 要"MIN,MAX"两个数:{spec}', file=sys.stderr)
            raise SystemExit(2) from None
        low, high = min(low, high), max(low, high)
        if high <= 0:
            return
        delay = random.uniform(low, high)
    else:
        delay = draw_window_interval(load_send_pace_spec()) / 1000.0
    print(f"[page-action] 等 {delay:.1f}s 再动手(限速)", file=sys.stderr)
    time.sleep(delay)


READ_EXPR = """(() => {
  const SEL =
    'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle';
  const circle = document.querySelector(SEL);
  const composer = document.querySelector("textarea, [contenteditable='true']");
  const alert = document.querySelector(".ds-alert__content");
  const icon = circle ? circle.querySelector("svg path")?.getAttribute("d") || null : null;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    composer: !!composer,
    circleIcon: icon ? icon.slice(0, 24) : null,
    circleDisabled: circle ? circle.classList.contains("ds-button--disabled") : null,
    stopDetect: {
      found: !!circle,
      visible: circle ? circle.getClientRects().length > 0 : null,
      pathStart: icon ? icon.slice(0, 24) : null,
      isStop: icon ? icon.startsWith("M2 4.88C2 3.68009") : null,
      isSend: icon ? icon.startsWith("M8.3125 0.980206") : null,
    },
    alert: alert ? alert.textContent.slice(0, 120) : null,
  });
})()"""


def capture_visible_js(quality: int) -> str:
    """抓可见标签页的表达式,在**扩展页上下文**里跑.

    与扩展自己在 background 里抓是**同一个权限检查**:只验扩展拿不拿得到这一帧,
    一条都不动扩展的权限(#106).
    """
    return (
        "(async () => {"
        "  const tabs = await chrome.tabs.query({});"
        f"  const t = tabs.find((x) => x.url && x.url.startsWith({json.dumps(SITE_MATCH)}));"
        '  if (!t) return JSON.stringify({ ok: false, error: "no-site-tab" });'
        '  if (!t.active) return JSON.stringify({ ok: false, error: "site-tab-not-active" });'
        "  try {"
        "    const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId,"
        f" {{ format: 'jpeg', quality: {quality} }});"
        "    return JSON.stringify({ ok: true, url: t.url, chars: dataUrl.length, dataUrl });"
        "  } catch (e) {"
        "    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });"
        "  }"
        "})()"
    )


#: 站点自己的"继续生成"按钮(#105):助手消息停在 INCOMPLETE 相,不在生成中,且是叶子时,
#: 它长在最后一条消息底部(`/api/v0/chat/continue` 的入口).这里只**认**它,不点.
CONTINUE_LOCATE_JS = """(() => {
  const hit = Array.from(document.querySelectorAll('[role="button"]')).find(
    (e) => (e.textContent || "").trim() === "继续生成" && e.getClientRects().length > 0,
  );
  if (!hit) return JSON.stringify({ found: false });
  const r = hit.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  return JSON.stringify({
    found: true,
    x,
    y,
    inView: y >= 0 && y <= innerHeight - 1 && x >= 0 && x <= innerWidth - 1,
    viewport: { w: innerWidth, h: innerHeight,
      cx: Math.round(innerWidth / 2), cy: Math.round(innerHeight / 2) },
    cls: String(hit.className),
    rect: { w: Math.round(r.width), h: Math.round(r.height) },
  });
})()"""

#: 点下去发没发出去,另一个观测点是**行为**:按钮消失,圆键进生成相(与 `read` 同一判据).


def extension_id() -> str:
    """未打包扩展的 id:取扩展目录绝对路径 SHA-256 前 16 字节,每半字节映到 a~p."""
    digest = hashlib.sha256(str(EXT_DIR).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


def http_json(path: str) -> object:
    with urllib.request.urlopen(f"{CDP}{path}", timeout=3) as resp:
        return json.load(resp)


def open_tab(url: str, *, background: bool = False) -> dict:
    """开一个标签页.`background=True` 走 CDP `Target.createTarget` 且不抢前台.

    为什么需要后台开:探针开的扩展入口页(options)若抢了前台,DeepSeek 标签页就退到后台,
    浏览器会节流后台页--虚拟列表不挂行,历史不加载,`messages.*` 与按位置点控件全读成空.
    那是探针造成的假象,不是站点或动作的问题.
    """
    if background:
        version = http_json("/json/version")
        ws_url = version["webSocketDebuggerUrl"] if isinstance(version, dict) else ""
        reply = asyncio.run(
            call_cdp(ws_url, "Target.createTarget", {"url": url, "background": True})
        )
        target_id = reply.get("result", {}).get("targetId") if isinstance(reply, dict) else None
        if target_id:
            for target in targets():
                if target.get("id") == target_id:
                    return target
        return {}
    query = urllib.parse.quote(url, safe="")
    req = urllib.request.Request(f"{CDP}/json/new?{query}", method="PUT")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)


def targets() -> list[dict]:
    return http_json("/json/list")  # type: ignore[return-value]


def find_target(kind: str, needle: str, timeout: float = 0.0) -> dict | None:
    deadline = time.monotonic() + timeout
    while True:
        for target in targets():
            if target.get("type") == kind and needle in target.get("url", ""):
                return target
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.3)


# 站点把 SSE 收在 **XHR** 里(fetch / EventSource 抓不到,2026-10-09 实测).
# 这段钩子把它逐帧拆成 JSON 存进 window.__sse;命令末尾再读,**读的是本轮**--
# 判据自污染就出在"读到上一轮",所以 sse 子命令把装钩/填/发/读闭在一次调用里.
SSE_HOOK_JS = """(() => {
  // 清空本轮:不清的话读到的是上一轮的帧,那是判据自污染最隐蔽的一种
  window.__sse = {frames: [], reqBytes: 0, startedAt: Date.now()};
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__dsUrl = String(u);
    return oo.call(this, m, u, ...r);
  };
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (b) {
    if ((this.__dsUrl || "").includes("/chat/")) {
      if (this.__dsUrl.includes("/completion")) window.__sse.reqBytes =
        typeof b === "string" ? b.length : 0;
      const grab = () => (this.responseText || "").split("\\n").forEach(line => {
        if (!line.startsWith("data: ")) return;
        try { window.__sse.frames.push(JSON.parse(line.slice(6))); } catch (e) {}
      });
      // progress 拿流式增量,loadend 兜最后一包
      this.addEventListener("progress", grab);
      this.addEventListener("loadend", grab);
    }
    return os.apply(this, arguments);
  };
  return "sse-hook-on";
})()"""

SSE_READ_JS = """(() => {
  const s = window.__sse || {frames: [], reqBytes: 0, startedAt: 0};
  const frames = s.frames;
  // 拒收的硬判据:服务端下发独立 error 帧,**不走** v.response.status(实测那条路
  // 压根不下发 status,见 dsweb/FINDINGS.md §6.2).
  const errs = frames.filter(f => f.finish_reason || f.type === "error" || f.type === "warning");
  const reasons = [...new Set(frames.map(f => f.finish_reason).filter(Boolean))];
  const statuses = [...new Set(frames.map(f => f.v && f.v.response && f.v.response.status)
    .filter(Boolean))];
  return {
    frames: frames.length,
    reqBytes: s.reqBytes,
    rejected: reasons.includes("context_length_exceeded"),
    reasons: reasons,
    statuses: statuses,
    // 只留判据字段,不回吐 content 原文(可能几十万字)
    errorCount: errs.length,
    firstError: errs.length ? {type: errs[0].type, reason: errs[0].finish_reason,
                               content: (errs[0].content || "").slice(0, 60)} : null,
  };
})()"""


def install_sse_hook(tab: dict) -> None:
    """在页面里装 SSE 钩子(幂等:每次调用都**清空**上一轮的帧)."""
    run(tab["webSocketDebuggerUrl"], SSE_HOOK_JS)


def read_sse(tab: dict) -> dict:
    """读本轮录到的帧并给出拒收判定."""
    return unwrap(run(tab["webSocketDebuggerUrl"], SSE_READ_JS))


def wait_composer(tab: dict, timeout: float = 20.0) -> bool:
    """等写作框真的挂上再返回.

    `chat.new` 会重挂 textarea,`sleep 2` 不够--等不及就填进空页,那一轮的
    结论全是假的(2026-10-09 踩过).返回是否等到了.
    """
    ws = tab["webSocketDebuggerUrl"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        if unwrap(run(ws, "!!document.querySelector('textarea')")) is True:
            return True
        time.sleep(0.5)
    return False


def fill_composer(tab: dict, text: str) -> str:
    """把 text 灌进写作框并返回入框字数.

    走原生 setter + input 事件,与扩展自己的 `writeComposer` 同手法--直接
    `ta.value = ...` 不触发框架的状态更新.
    """
    expr = (
        "(() => { const ta = document.querySelector('textarea');"
        " const s = Object.getOwnPropertyDescriptor("
        "HTMLTextAreaElement.prototype, 'value').set;"
        f"s.call(ta, {json.dumps(text, ensure_ascii=False)});"
        " ta.dispatchEvent(new Event('input', {bubbles: true}));"
        " return String(ta.value.length); })()"
    )
    return str(unwrap(run(tab["webSocketDebuggerUrl"], expr)))


async def evaluate(ws_url: str, expression: str, timeout: float = 60.0) -> object:
    """在目标上下文里跑表达式取回值.

    **必须有超时**:对端(扩展页 / 页面 SW)不答时 `recv()` 会永远挂着,
    探针就变成一个没输出的死进程--排查时看不出是'慢'还是'卡'.
    超时抛 `TimeoutError`,由 `run()` 折成一句人话.
    """
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "awaitPromise": True,
                        "returnByValue": True,
                    },
                }
            )
        )
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except TimeoutError as error:
                raise TimeoutError(
                    f"CDP Runtime.evaluate 等回包超过 {timeout:.0f}s"
                    "(对端没答:扩展没醒 / 页面正忙 / 动作在途)"
                ) from error
            message = json.loads(raw)
            if message.get("id") == 1:
                return message


def run(ws_url: str, expression: str, timeout: float = 60.0) -> object:
    try:
        return asyncio.run(evaluate(ws_url, expression, timeout))
    except TimeoutError as error:
        print(f"[page-action] {error}", file=sys.stderr)
        raise SystemExit(4) from error


async def sample(
    ws_url: str, expression: str, times: int, every: float, timeout: float = 60.0
) -> list[tuple[float, object]]:
    """一次连接里连读同一表达式 `times` 拍,两拍之间隔 `every` 秒;回(距开拍秒, 读数).

    为什么不开 N 次连接:抓瞬态(生成中,思考期那种几秒窗口)要"必须连读",以前靠 shell
    循环 -- 一拍一个进程加一次握手,55 拍就是 55 次;这里一条连上读完,拍与拍之间的
    间隔也才是真的.
    """
    start = time.monotonic()
    samples: list[tuple[float, object]] = []
    async with websockets.connect(ws_url, max_size=None) as ws:
        for index in range(times):
            await ws.send(
                json.dumps(
                    {
                        "id": index + 1,
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": expression,
                            "awaitPromise": True,
                            "returnByValue": True,
                        },
                    }
                )
            )
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
                except TimeoutError as error:
                    raise TimeoutError(
                        f"CDP Runtime.evaluate 等回包超过 {timeout:.0f}s(第 {index + 1} 拍)"
                        "(对端没答:扩展没醒 / 页面正忙 / 动作在途)"
                    ) from error
                message = json.loads(raw)
                if message.get("id") == index + 1:
                    samples.append((time.monotonic() - start, unwrap(message)))
                    break
            if index + 1 < times:
                await asyncio.sleep(every)
    return samples


def read_timeline(ws_url: str, expression: str, times: int, every: float) -> int:
    """连读 `times` 拍,时间线**只打相变**:1s 一拍打全量是噪音,相变才说得出窗口从哪到哪.

    与 `watchdog-probe.py` 的时间线同一口径(它那边的教训就是"打全量看不出空档").
    """
    try:
        samples = asyncio.run(sample(ws_url, expression, times, every))
    except TimeoutError as error:
        print(f"[page-action] {error}", file=sys.stderr)
        return 4
    print(f"[page-action] 连读 {times} 拍,每 {every:g}s 一拍", flush=True)
    previous: str | None = None
    changes = 0
    for offset, value in samples:
        text = json.dumps(value, ensure_ascii=False)
        if text == previous:
            continue
        previous = text
        changes += 1
        print(f"    +{offset:6.1f}s {text}", flush=True)
    print(f"[page-action] 共 {len(samples)} 拍,相变 {changes} 次")
    return 0


async def call_cdp(ws_url: str, method: str, params: dict | None = None) -> object:
    """发一条 CDP 命令,取它的回包(不带 id 的事件直接跳过)."""
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await ws.recv())
            if message.get("id") == 1:
                return message


def ax_nodes(tab: dict) -> list[dict]:
    """取整棵**无障碍树**(role + 可访问名,浏览器算出来的).先 enable 再要全量."""
    ws_url = tab["webSocketDebuggerUrl"]
    asyncio.run(call_cdp(ws_url, "Accessibility.enable"))
    reply = asyncio.run(call_cdp(ws_url, "Accessibility.getFullAXTree"))
    result = reply.get("result") if isinstance(reply, dict) else None
    nodes = result.get("nodes") if isinstance(result, dict) else None
    return nodes if isinstance(nodes, list) else []


def ax_line(node: dict) -> str:
    """一行的紧凑视图:role + 可访问名(+ value / 几个关键属性)."""
    role = (node.get("role") or {}).get("value", "?")
    name = (node.get("name") or {}).get("value", "")
    extras: list[str] = []
    value = (node.get("value") or {}).get("value")
    if value not in (None, ""):
        extras.append(f"value={value!r}")
    for prop in node.get("properties") or []:
        key = prop.get("name")
        if key in ("editable", "disabled", "focused", "placeholder"):
            extras.append(f"{key}={prop.get('value', {}).get('value')!r}")
    tail = ("  " + " ".join(extras)) if extras else ""
    return f"{role:<18} {name[:70]}{tail}"


# --------------------------------------------------------------------------- #
# 全量捕获(capture):站点一换版,先抓"完整的它"再下判断--别再靠零散探针
# --------------------------------------------------------------------------- #

CAPTURE_HTML_JS = "document.documentElement.outerHTML"

CAPTURE_CSS_JS = r"""
(() => {
  const out = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText);
    } catch (e) {
      out.push("/* 读不到(跨源?):" + (sheet.href || "inline") + " */");
    }
  }
  return out.join("\n");
})()
"""

CAPTURE_ASSETS_JS = r"""
(() => {
  const scripts = Array.from(document.querySelectorAll("script[src]")).map((s) => s.src);
  const links = Array.from(document.querySelectorAll("link[rel=stylesheet]")).map((l) => l.href);
  return JSON.stringify({ scripts, links }, null, 2);
})()
"""

CAPTURE_DIGEST_JS = r"""
(() => {
  const rectOf = (el) => {
    const b = el.getBoundingClientRect();
    return {
      l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right),
      b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height),
    };
  };
  const styled = (el) => {
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor, radius: cs.borderRadius,
      display: cs.display, overflowY: cs.overflowY,
    };
  };
  const painted = (row) => {
    const out = [];
    row.querySelectorAll("*").forEach((d) => {
      const s = styled(d);
      const has = s.bg && s.bg !== "rgba(0, 0, 0, 0)" && s.bg !== "transparent";
      if (!has) return;
      out.push({
        tag: d.tagName, cls: String(d.className).slice(0, 44),
        bg: s.bg, radius: s.radius, rect: rectOf(d),
      });
    });
    return out.slice(0, 8);
  };
  const rowDigest = (r) => ({
    key: r.getAttribute("data-virtual-list-item-key"),
    markerRole: r.querySelector(".ds-assistant-message-main-content")
      ? "assistant"
      : r.querySelector(".ds-collapsible-text")
        ? "user"
        : null,
    hasMessage: r.querySelector(".ds-message") !== null,
    hasPre: r.querySelectorAll("pre").length,
    rect: rectOf(r),
    text: (r.textContent || "").replace(/\s+/g, " ").slice(0, 60),
    painted: painted(r),
  });
  const lists = Array.from(document.querySelectorAll(".ds-virtual-list")).map((l) => {
    const box = l.querySelector(".ds-virtual-list-items");
    const vis = box ? box.querySelector(".ds-virtual-list-visible-items") : null;
    return {
      cls: String(l.className),
      style: styled(l),
      rect: rectOf(l),
      scrollHeight: l.scrollHeight,
      clientHeight: l.clientHeight,
      nRows: vis ? vis.children.length : 0,
      rows: vis ? Array.from(vis.children).map(rowDigest) : [],
    };
  });
  const CIRCLE = 'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle';
  const circle = document.querySelector(CIRCLE);
  const composer = document.querySelector("textarea, [contenteditable='true']");
  const path = circle ? circle.querySelector("svg path") : null;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    commitId: (document.querySelector('meta[name="commit-id"]') || {}).content || null,
    historyStateKeys: Object.keys(history.state || {}),
    lists,
    composer: composer ? {
      tag: composer.tagName,
      editable: composer.getAttribute("contenteditable"),
      placeholder: composer.getAttribute("placeholder"),
      rect: rectOf(composer),
    } : null,
    sendCircle: circle ? {
      cls: String(circle.className).slice(0, 90),
      pathStart: path ? path.getAttribute("d").slice(0, 28) : null,
      rect: rectOf(circle),
    } : null,
  });
})()
"""


async def script_sources(ws_url: str, match: str) -> list[tuple[str, str]]:
    """收集已加载脚本的正文.

    站点 JS 在跨源 CDN(`fe-static.deepseek.com`)上--页面里 `fetch` 会被 CORS 挡,
    所以走 CDP:`Debugger.enable` 之后浏览器会把**已加载**的脚本成批 `scriptParsed` 补发,
    再对命中 `match` 的取 `Debugger.getScriptSource`.
    """
    found: dict[str, str] = {}
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Debugger.enable"}))
        idle_until = time.monotonic() + 4.0
        while time.monotonic() < idle_until:
            try:
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=1.2))
            except TimeoutError:
                break
            if message.get("method") == "Debugger.scriptParsed":
                params = message.get("params") or {}
                url = str(params.get("url", ""))
                if match in url:
                    found[str(params.get("scriptId"))] = url
        pending: dict[int, str] = {}
        for index, (script_id, url) in enumerate(found.items()):
            request_id = 100 + index
            pending[request_id] = url
            await ws.send(
                json.dumps(
                    {
                        "id": request_id,
                        "method": "Debugger.getScriptSource",
                        "params": {"scriptId": script_id},
                    }
                )
            )
        sources: list[tuple[str, str]] = []
        while pending:
            message = json.loads(await ws.recv())
            request_id = message.get("id")
            if not isinstance(request_id, int) or request_id not in pending:
                continue
            url = pending.pop(request_id)
            result = message.get("result") or {}
            sources.append((url, str(result.get("scriptSource", ""))))
        return sources


def visible_capture(out_path: str, quality: int) -> int:
    """验扩展抓可见标签页:打得开回帧的字数,打不开回它的原话.

    先把站点标签页置前台(`captureVisibleTab` 抓的是**窗口的活动标签页**),再从扩展页
    上下文发一次.`--out` 落盘成 JPEG,方便直接眼看现场(#106).
    """
    tab = ensure_site_tab()
    asyncio.run(call_cdp(tab["webSocketDebuggerUrl"], "Page.bringToFront"))
    ext = ensure_extension_page()
    raw = unwrap(run(ext["webSocketDebuggerUrl"], capture_visible_js(quality), timeout=75.0))
    try:
        result = json.loads(raw) if isinstance(raw, str) else {"ok": False, "error": str(raw)}
    except json.JSONDecodeError:
        result = {"ok": False, "error": f"回包解不开:{raw!r}"}
    if not isinstance(result, dict):
        result = {"ok": False, "error": str(result)}
    data_url = result.pop("dataUrl", "")
    if result.get("ok") and out_path and isinstance(data_url, str) and "," in data_url:
        payload = base64.b64decode(data_url.split(",", 1)[1])
        path = Path(out_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        result["out"] = str(path)
        result["bytes"] = len(payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


def stored_list(stored: object, key: str) -> list:
    """`storage.get` 回包里某个键 → 数组;不是数组就当空(与各读取器同一条口径)."""
    if not isinstance(stored, dict):
        return []
    value = stored.get(key)
    return value if isinstance(value, list) else []


def read_probe_stores() -> dict:
    """读探针要看的几个键(失败痕 / 现场帧 / 总开关 / 发言闸),回 `result.stored` 那层.

    **发言闸要在这一份里**:`send-page` 哪条腿跑得动由它决定;少读一个键,
    `stores.get("speak") is True` 会静默变成"闸关着",拿真话当假话(踩过).
    """
    raw = storage_op(
        "get",
        json.dumps([FAILURE_LOG_KEY, FAILURE_FRAME_KEY, TOGGLE_KEY, SPEAK_KEY]),
        "{}",
        attempts=3,
        pace_spec=None,
        no_pace=True,
    )
    result = parse_outcome(raw).get("result")
    stored = result.get("stored") if isinstance(result, dict) else None
    return stored if isinstance(stored, dict) else {}


def write_failure_log(log: list) -> None:
    """把留痕原样写回(撤掉探针造的那一笔 / 上一次跑剩的那一笔)."""
    storage_op(
        "set",
        "{}",
        json.dumps({FAILURE_LOG_KEY: log}, ensure_ascii=False),
        attempts=3,
        pace_spec=None,
        no_pace=True,
    )


def reload_background_state() -> None:
    """让 background 把它手里那份留痕/帧从 storage 重新读一遍(它只在总开关变时读).

    总开关关一下再开:探针"造完再开回来"的老做法(watchdog-probe 同一手).少了这一步,
    background 内存里还压着一笔"还没恢复",新痕按 `rememberFailure` 的口径就落不下来--
    判据会假红,而错的是探针.副作用是 content script 重挂一遍,看门狗重新武装.
    """
    for on in (False, True):
        storage_op(
            "set",
            "{}",
            json.dumps({TOGGLE_KEY: on}),
            attempts=3,
            pace_spec=None,
            no_pace=True,
        )
    time.sleep(BACKGROUND_SETTLE)


def blocked_report(report: dict, why: str) -> int:
    """判据立不住时的出口(退 4:这一轮不算数,与 `sse` 同一条口径)."""
    print(json.dumps({**report, "blocked": why}, ensure_ascii=False, indent=2))
    return 4


def post_chain(envelope: dict, tab: dict) -> object:
    """把一条 chain 信封投进页面世界(页面世界 ↔ 内容脚本那条路,注法见文件头)."""
    return unwrap(
        run(
            tab["webSocketDebuggerUrl"],
            f"window.postMessage({json.dumps(envelope, ensure_ascii=False)},'*'),'sent'",
        )
    )


def frame_fail() -> int:
    """验抓帧失败的负路(#106):站点退后台时报一笔失败--**失败痕照落,帧不新增**.

    走产品自己那条路:页面世界投一条 `continuation-fail`(注 chain 信封那条,见文件头),
    background 照 `recordFailure` 落痕,随即 fire-and-forget 去抓帧;那一抓会被
    "报上来的标签页此刻不在前台"挡下(ADR-0030 决定 2),留纯文字因由,失败痕照旧.
    所以**必须**先把扩展页置前台(站点退后台):少了这一步,验的是正路,判据会假绿.

    探针造的那笔痕跑完撤掉,并让 background 重读一遍 storage;两件事都做完,这台机器
    才算回到原样,判据也才是可重复的.
    """
    site = ensure_site_tab()
    ext = ensure_extension_page()
    before = read_probe_stores()
    log_before = stored_list(before, FAILURE_LOG_KEY)
    frames_before = stored_list(before, FAILURE_FRAME_KEY)
    report: dict = {
        "toggleOn": before.get(TOGGLE_KEY) is True,
        "failuresBefore": len(log_before),
        "framesBefore": len(frames_before),
    }
    if not report["toggleOn"]:
        return blocked_report(report, "总开关关着:内容脚本没挂,上报这条路不走--先开开关再来")
    head = log_before[0] if log_before else None
    if isinstance(head, dict) and head.get("recoveredAt") is None:
        if head.get("cause") != FRAME_FAIL_CAUSE:
            # 真红着:再报一笔不会新起一条(`rememberFailure` 的口径),判据作废.
            return blocked_report(report, "最前面那笔失败还没恢复:这次上报不会新起一条,判据作废")
        # 上一次跑剩的(中途被打断):撤掉它,按原样重来.
        log_before = log_before[1:]
        report["failuresBefore"] = len(log_before)
        report["healed"] = True
        write_failure_log(log_before)
        reload_background_state()
    asyncio.run(call_cdp(ext["webSocketDebuggerUrl"], "Page.bringToFront"))
    active = unwrap(
        run(
            ext["webSocketDebuggerUrl"],
            "(async () => (await chrome.tabs.query({active: true}))[0]?.url ?? '')()",
        )
    )
    report["activeWhileReporting"] = active
    if isinstance(active, str) and active.startswith(SITE_MATCH):
        return blocked_report(report, "站点标签页还在前台:抓帧那一步不会失败,不往下走")
    envelope = {
        "source": CHAIN_MESSAGE_SOURCE,
        "kind": "continuation-fail",
        "id": f"probe-frame-fail-{int(time.time() * 1000)}",
        "cause": FRAME_FAIL_CAUSE,
    }
    report["injected"] = post_chain(envelope, site)
    deadline = time.monotonic() + FRAME_FAIL_WAIT
    after = before
    while time.monotonic() < deadline:
        after = read_probe_stores()
        log_now = stored_list(after, FAILURE_LOG_KEY)
        top_now = log_now[0] if log_now else None
        if isinstance(top_now, dict) and top_now.get("cause") == FRAME_FAIL_CAUSE:
            break
        time.sleep(0.3)
    log_after = stored_list(after, FAILURE_LOG_KEY)
    frames_after = stored_list(after, FAILURE_FRAME_KEY)
    top = log_after[0] if log_after else None
    report["recorded"] = (
        isinstance(top, dict)
        and top.get("cause") == FRAME_FAIL_CAUSE
        and top.get("where") == "continuation"
    )
    report["framesAfter"] = len(frames_after)
    # 探针造的那笔痕验完就撤:它带着"还没恢复"会一直挂在选项页的"上次故障"上(真探活
    # 只在由红转绿那一下补恢复时刻),而它本来只是一次验证.只在"我们的那笔在最前,
    # 总数正好 +1"时撤:中间落过真痕就原样留着,别拿它盖掉.
    ours = isinstance(top, dict) and top.get("cause") == FRAME_FAIL_CAUSE
    sole_new = ours and len(log_after) == len(log_before) + 1
    if sole_new:
        write_failure_log(log_before)
    # 撤了还不够:background 手里那份要重读一遍 storage,否则它压着的那笔"还没恢复"
    # 会让**下一笔**真痕落不下来--那就不再是可重复的探针了.
    reload_background_state()
    report["restored"] = sole_new
    report["failuresAfter"] = len(stored_list(read_probe_stores(), FAILURE_LOG_KEY))
    # 还原:站点标签页回前台--别的探针动作与抓帧正路都靠它.
    asyncio.run(call_cdp(site["webSocketDebuggerUrl"], "Page.bringToFront"))
    report["ok"] = bool(report["recorded"]) and len(frames_after) == len(frames_before)
    report["note"] = "抓帧失败不留单独的印(ADR-0030):判据只有两条--痕照落,帧数没变"
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


def composer_text() -> str:
    """读写作框现值(`composer.read`,只读动作:不走三道闸也不等限速)."""
    result = parse_outcome(send_action("composer.read", {})).get("result")
    text = result.get("text") if isinstance(result, dict) else None
    return text if isinstance(text, str) else ""


def clear_composer() -> None:
    """把写作框清空(`composer.clear`,只清不发送).探针只拿它收拾自己留下的草稿."""
    send_action("composer.clear", {})


def conversation() -> list:
    """读对话里认得出的行(`messages.list`,只读).

    空对话真是一行没有(#54 的早退口径),而**读漏**也长这样--所以判据只在"找到了那条
    问题"时算数:找不到只说不算数,不当成"闸把它拦下了"的反证.
    """
    result = parse_outcome(send_action("messages.list", {})).get("result")
    rows = result.get("messages") if isinstance(result, dict) else None
    return rows if isinstance(rows, list) else []


def send_page_question(tag: int) -> str:
    """探针问题:固定正文 + 这个 tag(判据按整条比,号变了才分得清新旧)."""
    return f"{SEND_PAGE_QUESTION}(#{tag})"


def landed_question(rows: list, question: str) -> bool:
    """对话里有没有**整条**等于这条问题的行(判据只认整条,别认"看到过某个词")."""
    body = question.strip()
    return any(
        isinstance(row, dict) and isinstance(row.get("text"), str) and row["text"].strip() == body
        for row in rows
    )


def wait_continuation() -> bool:
    """等工具结果顺 回灌 那条路自动续的那一轮(短标记进对话).

    `send.page` 回的是"发完即回确认",那条载荷按回灌口径回页面;闸开着时它进队列,
    武装,发出去(ADR-0014 / ADR-0023).**等它落地再收手**,机器才是安静的--
    别的探针最怕跑到一半撞上续聊(`frame-fail` 的文件头就写着别在续聊途中跑).

    只看最后三行:上一趟跑剩的同名标记不许冒充这一趟.等不到不当故障--这一条只说明
    "探针自己走干净了",两步的判据不看它.
    """
    deadline = time.monotonic() + SEND_PAGE_CONTINUE_WAIT
    while time.monotonic() < deadline:
        rows = conversation()
        if any(
            isinstance(row, dict)
            and row.get("role") == "user"
            and str(row.get("text", "")).strip() == CONTINUATION_MARKER
            for row in rows[-3:]
        ):
            return True
        time.sleep(0.5)
    return False


def send_page_verdict(
    *, speak: bool, question: str, landed: bool, composer: str
) -> tuple[bool, str]:
    """`send.page` 两步的判据(纯函数,拿 pytest 对拍,不碰 CDP).

    - **闸开着**:两步都该成--那条问题原样出现在对话里(第一步写进写作框,第二步发出去).
    - **闸关着**:第一步成,第二步被 `runAction` 拦下--问题**留在写作框**里当草稿,
      对话里没有(ADR-0023 的产品口径:等你自己按发送).
    - 两头各有一条反证:闸关着却进了对话 = 闸没拦住发送(ADR-0023 的红线);
      闸开着却查无此问题 = 两步里有一处没成.
    """
    body = question.strip()
    in_conversation = landed
    drafted = composer.strip() == body and body != ""
    if in_conversation and not speak:
        return (
            False,
            "闸关着,问题却进了对话:发送步没被拦下(ADR-0023 那条红线)."
            "要么 live 那份闸没跟上 storage,要么它真没拦住--两种都得查",
        )
    if in_conversation:
        return True, "问题以用户消息进了对话:composer.type 与 send.enter 两步都跑到了"
    if drafted:
        return True, "问题落在写作框里当草稿,对话里没有:发送步被闸拦下了(等你按发送)"
    if speak:
        return False, "闸开着,对话里却没有那条问题:两步里有一处没成"
    return False, f"闸关着,写作框里也不是那条问题:{composer!r}"


def send_page(question: str, *, allow_send: bool) -> int:
    """验本地工具 `send.page` 的两步(ADR-0013):`composer.type` → `send.enter`,全走三道闸.

    本地工具在 `ACTION_ROSTER` 之外,唯一触发法是往页面里投一条 chain `call` 信封
    (文件头第 2 条);**走的仍是产品那条路**,所以闸照拦--这正是要验的:

    - **闸开着**(`speak: true`):两步都该成,问题原样进对话.真发一条,所以要 `--send` 认下.
    - **闸关着**:第一步成,第二步回 `disabled`,问题留在写作框里当草稿.

    闸是真人的(agent 不代勾也不代关),所以哪条腿跑得动由**当前**那把闸决定:
    闸开着没给 `--send` 就打 `blocked` 退 4,别拿真话当假话.

    写作框里已经有字就不打:第一步会把人家的草稿覆盖掉(ADR-0023 如实写明的取舍),
    探针不替人做那个决定.闸关着那条腿验完把探针自己那笔草稿清掉(写作框回到空).

    判据一律把 `SEND_PAGE_WAIT` 等满:探针分不出"还没发"与"不会发",半路收手就把
    "观测漏了"读成了"闸拦下了".发出去的那条还会带回一条工具结果,闸开着时它自动续
    一轮--探针等它落地(`continued`)才收手,机器留成安静态.
    """
    site = ensure_site_tab()
    stores = read_probe_stores()
    speak = stores.get(SPEAK_KEY) is True
    report: dict = {
        "toggleOn": stores.get(TOGGLE_KEY) is True,
        "speak": speak,
        "question": question,
    }
    if not report["toggleOn"]:
        return blocked_report(report, "总开关关着:内容脚本没挂,围栏这条路不走--先开开关再来")
    if speak and not allow_send:
        return blocked_report(report, "闸开着:这一条会真发进当前对话;认了再加 --send")
    # 对话行是虚拟列表:站点标签页不在前台就一间都不挂(#54),判据会假红.
    asyncio.run(call_cdp(site["webSocketDebuggerUrl"], "Page.bringToFront"))
    before = composer_text()
    report["composerBefore"] = before
    if before.strip():
        return blocked_report(
            report, "写作框里有字:第一步会覆盖它(ADR-0023 那条取舍),探针不动别人的草稿"
        )
    call = json.dumps(
        {"tool": "send.page", "arguments": {"question": question}}, ensure_ascii=False
    )
    report["injected"] = post_chain(
        {
            "source": CHAIN_MESSAGE_SOURCE,
            "kind": "call",
            "id": f"probe-send-page-{int(time.time() * 1000)}",
            "calls": [call],
        },
        site,
    )
    deadline = time.monotonic() + SEND_PAGE_WAIT
    landed = False
    saw_draft = False
    rows: list = []
    # 一律等满:判据分不出"还没发"与"不会发",半路收手就会把"观测漏了"当成"闸拦下了"
    # (第一次跑就栽在这儿:一条真发出去的问题被当成了草稿).闸关着那条腿因此也等满 45 秒.
    while True:
        saw_draft = saw_draft or composer_text().strip() == question.strip()
        rows = conversation()
        landed = landed_question(rows, question)
        if landed or time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    time.sleep(SEND_PAGE_SETTLE)
    composer_after = composer_text()
    report["landed"] = landed
    report["sawDraft"] = saw_draft
    report["composerAfter"] = composer_after
    report["rowsSeen"] = len(rows)
    report["tail"] = [
        {"role": row.get("role"), "text": str(row.get("text", ""))[:40]}
        for row in rows[-3:]
        if isinstance(row, dict)
    ]
    ok, why = send_page_verdict(
        speak=speak, question=question, landed=landed, composer=composer_after
    )
    report["ok"] = ok
    report["verdict"] = why
    if not speak:
        # 探针那笔草稿只是验证物:清掉,写作框回到交给它时的样子(空).
        clear_composer()
        report["composerRestored"] = composer_text().strip() == ""
    else:
        report["continued"] = wait_continuation() if landed else False
        report["note"] = (
            "这一条是真发出去的:对话里留着它当证据,探针不代你删."
            "工具结果随后自动续的那一轮要等它落地(`continued`);续完模型那一句可能还在写"
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


async def reload_and_wait(ws_url: str, timeout: float = 10.0) -> bool:
    """重载这一页, 等 `Page.loadEventFired` 到了才回(拿事件当准, 不等固定秒数)."""
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
        while True:
            if json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout)).get("id") == 1:
                break
        await ws.send(json.dumps({"id": 2, "method": "Page.reload", "params": {}}))
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except TimeoutError:
                return False
            if json.loads(raw).get("method") == "Page.loadEventFired":
                return True


def ext_js(
    expression: str, *, reload_page: bool = False, times: int = 1, every: float = 1.0
) -> int:
    """在**扩展页上下文**里跑一段只读 JS(`chrome.*` 只在这一层有).

    `--reload` 先把这一页重载再跑: 选项页那种**照 storage 渲染**的页, 不重载读到的
    是上一轮的 DOM -- 那是判据自污染里最像"验过了"的一种. 页面自己要等的部分(比如
    storage 读要等 load 之后才回来)在**表达式里**等: 表达式回的 promise 会被等到有值,
    工具不猜该睡几秒.

    `--times` 连读(与 `js` 同一口径): 重载后连读, 正好看得到异步渲染**什么时候**落.
    """
    ext = ensure_extension_page()
    ws_url = ext["webSocketDebuggerUrl"]
    if reload_page and not asyncio.run(reload_and_wait(ws_url)):
        print("[page-action] 扩展页重载没等到 loadEventFired", file=sys.stderr)
        raise SystemExit(5)
    if times > 1:
        return read_timeline(ws_url, expression, times, every)
    print(json.dumps(unwrap(run(ws_url, expression)), ensure_ascii=False, indent=2))
    return 0


async def collect_requests(
    ws_url: str, actions: list[tuple[str, dict]], seconds: float
) -> list[str]:
    """一条连接上发一串 CDP 命令,同时把期间的出站请求 URL 收下来.

    `Network` 域在真机上**漏抓过**(见 `docs/probe.md` 的判据纪律),所以它只是一个观测点:
    它说有就是有;它说没有,不能据此说"没发",还得看行为读数.
    """
    urls: list[str] = []
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.enable", "params": {}}))
        while True:
            message = json.loads(await ws.recv())
            if message.get("id") == 1:
                break
        for index, (method, params) in enumerate(actions, start=2):
            await ws.send(json.dumps({"id": index, "method": method, "params": params}))
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except TimeoutError:
                break
            message = json.loads(raw)
            if message.get("method") != "Network.requestWillBeSent":
                continue
            url = str((message.get("params") or {}).get("request", {}).get("url", ""))
            if url and url not in urls:
                urls.append(url)
    return urls


def continue_click(wait_seconds: float) -> int:
    """点站点自己的'继续生成'(#105),验 `/api/v0/chat/continue` 真被发出去.

    两处都和用户手点一样:**真鼠标事件**(CDP `Input.dispatchMouseEvent`,不是 DOM
    `.click()`),以及把它滚进视口的**真滚轮**.判据用**两个观测点**:出站请求 URL
    (`Network` 域)与页面行为(按钮消失 / 圆键进生成相).一边有一边没有,就照实报不一致,
    不当成"没发生"(docs/probe.md 的判据纪律).
    """
    tab = ensure_site_tab()
    ws = tab["webSocketDebuggerUrl"]
    asyncio.run(call_cdp(ws, "Page.bringToFront"))
    located = parse_outcome(unwrap(run(ws, CONTINUE_LOCATE_JS)))
    if located.get("found") is not True:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": '没找到"继续生成":那条消息不在 INCOMPLETE 相(见票 #105 的触发面)',
                },
                ensure_ascii=False,
            )
        )
        return 1
    # 按钮常长得比屏幕低(最后一条消息尾部).滚也要用真事件(滚轮),滚到它进视口再点.
    viewport = located.get("viewport") or {}
    wheeled = 0
    while located.get("inView") is not True and wheeled < 12:
        asyncio.run(
            call_cdp(
                ws,
                "Input.dispatchMouseEvent",
                {
                    "type": "mouseWheel",
                    "x": int(viewport.get("cx", 400)),
                    "y": int(viewport.get("cy", 400)),
                    "deltaX": 0,
                    "deltaY": 800,
                },
            )
        )
        time.sleep(0.4)
        located = parse_outcome(unwrap(run(ws, CONTINUE_LOCATE_JS)))
        wheeled += 1
    if located.get("found") is not True or located.get("inView") is not True:
        print(
            json.dumps(
                {"ok": False, "error": "按钮没能滚进视口,没点", "wheeled": wheeled},
                ensure_ascii=False,
            )
        )
        return 1
    before = read_state()
    x, y = int(located["x"]), int(located["y"])
    urls = asyncio.run(
        collect_requests(
            ws,
            [
                ("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y}),
                (
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mousePressed",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "buttons": 1,
                        "clickCount": 1,
                    },
                ),
                (
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mouseReleased",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "buttons": 0,
                        "clickCount": 1,
                    },
                ),
            ],
            wait_seconds,
        )
    )
    after = read_state()
    again = parse_outcome(unwrap(run(ws, CONTINUE_LOCATE_JS)))
    continued = [url for url in urls if "/chat/continue" in url]
    generating = (after.get("stopDetect") or {}).get("isStop") is True
    button_gone = again.get("found") is not True
    went_out = bool(continued) or (button_gone and generating)
    result: dict = {
        "ok": went_out,
        "clicked": {"x": x, "y": y, "cls": located["cls"]},
        "wheeled": wheeled,
        "requests": [url.split("?")[0] for url in urls],
        "continueRequests": [url.split("?")[0] for url in continued],
        "buttonGoneAfterClick": button_gone,
        "generatingAfterClick": generating,
        "circleBefore": (before.get("stopDetect") or {}).get("isStop"),
        "circleAfter": (after.get("stopDetect") or {}).get("isStop"),
    }
    if not continued and went_out:
        result["note"] = "网络那个观测点没看到 /chat/continue,但行为侧已进生成相(Network 域漏抓)"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if went_out else 1


def capture(out_dir: str, want_codes: bool) -> None:
    """抓全量证据到 out_dir:page.html / styles.css / assets.json / digest.json / ax.json."""
    tab = ensure_site_tab()
    ws = tab["webSocketDebuggerUrl"]
    out = Path(out_dir) if out_dir else Path("captures") / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    (out / "page.html").write_text(str(unwrap(run(ws, CAPTURE_HTML_JS))), encoding="utf-8")
    (out / "styles.css").write_text(str(unwrap(run(ws, CAPTURE_CSS_JS))), encoding="utf-8")
    assets = str(unwrap(run(ws, CAPTURE_ASSETS_JS)))
    (out / "assets.json").write_text(assets, encoding="utf-8")
    (out / "digest.json").write_text(str(unwrap(run(ws, CAPTURE_DIGEST_JS))), encoding="utf-8")
    nodes = ax_nodes(tab)
    (out / "ax.json").write_text(json.dumps(nodes, ensure_ascii=False), encoding="utf-8")
    codes = 0
    if want_codes:
        (out / "codes").mkdir(exist_ok=True)
        for index, (url, source) in enumerate(asyncio.run(script_sources(ws, "deepseek.com"))):
            name = f"{index:02d}-" + url.rsplit("/", 1)[-1].replace("?", "_")[:64]
            (out / "codes" / name).write_text(source, encoding="utf-8")
            codes += 1
    files = {p.name: p.stat().st_size for p in sorted(out.glob("*")) if p.is_file()}
    print(
        json.dumps(
            {"out": str(out), "files": files, "codes": codes, "axNodes": len(nodes)},
            ensure_ascii=False,
            indent=2,
        )
    )


def read_state() -> dict:
    tab = ensure_site_tab()
    value = unwrap(run(tab["webSocketDebuggerUrl"], READ_EXPR))
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {"raw": value}
    return value if isinstance(value, dict) else {"raw": value}


def poll_state(predicate, timeout: float, interval: float = 0.25) -> dict:
    deadline = time.monotonic() + timeout
    state = read_state()
    while not predicate(state):
        if time.monotonic() >= deadline:
            break
        time.sleep(interval)
        state = read_state()
    return state


def require_cdp() -> None:
    try:
        http_json("/json/version")
    except Exception:  # noqa: BLE001 - 连不上就是没带调试口,给出人话
        print(
            f"[page-action] CDP 连不上({CDP}).ds-browser 要带调试口起:\n"
            f"  scripts/env-up.sh --debug   # 或手动:\n"
            f'  "$CHROME" --user-data-dir="$HOME/Library/Application Support/ds-browser" \\\n'
            f'    --load-extension="{EXT_DIR}" --remote-debugging-port={PORT} \\\n'
            f"    --no-first-run --no-default-browser-check",
            file=sys.stderr,
        )
        raise SystemExit(2) from None


def ensure_site_tab() -> dict:
    tab = find_target("page", SITE_MATCH)
    if tab is None:
        print(f"[page-action] 没有 {SITE_MATCH} 标签页,开一个")
        tab = open_tab(SITE_MATCH)
        opened = find_target("page", SITE_MATCH, timeout=10)
        tab = opened or tab
    return tab


def ensure_extension_page() -> dict:
    """扩展页上下文(options):拿得到 `chrome.tabs.sendMessage`,且不像 SW 那样会睡."""
    tab = find_target("page", "chrome-extension://")
    if tab is not None:
        return tab
    print("[page-action] 没有扩展页,开 options.html 当消息入口")
    open_tab(f"chrome-extension://{extension_id()}/options.html", background=True)
    tab = find_target("page", "chrome-extension://", timeout=10)
    if tab is None:
        print("[page-action] 扩展页没起来", file=sys.stderr)
        raise SystemExit(3)
    return tab


def send_action(action: str, params: dict) -> object:
    """发一帧动作,回 `parse_outcome` 之前的原始回包(多半是一段 JSON 字符串).

    `TARGET_NULL_ACTIONS` 那族由 background 的 `runAction` 就地执行,内容脚本名册里
    没有它们--走 `runtime.sendMessage` 从扩展页直送;其余仍 `tabs.sendMessage` 投进
    站点标签页,在内容脚本的名册上就地跑(绕开三道闸,探针要能直接验执行器).
    """
    ext = ensure_extension_page()
    frame = {
        "type": "action",
        "id": f"probe-{int(time.time() * 1000)}",
        "action": action,
        "params": params,
        "target": None,
    }
    if action in TARGET_NULL_ACTIONS:
        script = (
            "(async () => {"
            f"  const frame = {json.dumps(frame)};"
            f"  const r = await chrome.runtime.sendMessage("
            f"{{ type: {json.dumps(ACTION_MESSAGE_TYPE)}, frame }});"
            "  if (r === undefined) return JSON.stringify({ error: 'no-reply' });"
            "  return JSON.stringify(r);"
            "})()"
        )
        return unwrap(run(ext["webSocketDebuggerUrl"], script, timeout=75.0))
    script = (
        "(async () => {"
        "  const tabs = await chrome.tabs.query({});"
        f"  const t = tabs.find((x) => x.url && x.url.startsWith({json.dumps(SITE_MATCH)}));"
        "  if (!t) return JSON.stringify({ error: 'no-site-tab' });"
        f"  const frame = {json.dumps(frame)};"
        "  frame.target = String(t.id);"
        f"  const envelope = {{ type: {json.dumps(ACTION_MESSAGE_TYPE)}, frame }};"
        "  const r = await chrome.tabs.sendMessage(t.id, envelope);"
        "  return JSON.stringify(r);"
        "})()"
    )
    # 动作本身有 30s 的中继锁,超时给得比默认宽一点;再宽就是真卡住了,该报错而不是挂着.
    result = run(ext["webSocketDebuggerUrl"], script, timeout=75.0)
    return unwrap(result)


#: 页面侧的瞬时失败码:排队等限速后重发. 闸类(`disabled` / `backing-off`)不在里面--
#: 那是人在管,重发多少次都一样;`unknown-action` 是探针写错了动作名,重发只会原样再错.
#: `cdp-timeout` 是探针自己折的(扩展页 75s 没答):多半是 SW 刚睡 / 页面正忙,下一拍通常就好.
TRANSIENT_ERRORS = {"read-failed", "page-changed", "no-site-tab", "cdp-timeout"}


def transient_error(result: object) -> str | None:
    """是瞬时失败就回失败码,否则 None.

    `unwrap` 拿到的是页面里 `JSON.stringify` 过的字符串,先解开再认.
    """
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return None
    if not isinstance(result, dict):
        return None
    error = result.get("error")
    if isinstance(error, str) and error in TRANSIENT_ERRORS and result.get("ok") is not True:
        return error
    return None


def wake_service_worker(ext: dict) -> None:
    """MV3 的 SW 空闲即睡,睡着时 `tabs.sendMessage` 会 reject(内容脚本的回程要过 SW).

    重发前先叫醒它:`runtime.sendMessage` 一条 ping 就够,没人回话也照样把 SW 拉起来.
    没有监听器会 reject,那是常态,吞掉.
    """
    run(ext["webSocketDebuggerUrl"], "chrome.runtime.sendMessage({dsWake:1}).catch(() => 0)", 10.0)


def send_action_queued(
    action: str,
    params: dict,
    *,
    attempts: int,
    pace_spec: str | None,
    no_pace: bool,
) -> object:
    """瞬时失败不把错误直接抛回给调用人:脚本自己排队,等限速时间到再发.

    页面忙 / DOM 刚重挂(`read-failed` / `page-changed`)这类失败下一拍通常就好,
    挨过去比返回一个半途错误有用. 每次重发照走 `pace()`--排队本身就是限速的一部分.
    `cdp-timeout` 这一支多半是 SW 睡了,重发前顺手 `wake_service_worker()` 叫醒它.
    """
    result: object = None
    for attempt in range(1, attempts + 1):
        try:
            result = send_action(action, params)
        except SystemExit as error:  # run() 把 CDP 超时折成 SystemExit(4)
            if error.code != 4:
                raise
            result = {"ok": False, "error": "cdp-timeout"}
        failure = transient_error(result)
        if failure is None or attempt == attempts:
            return result
        print(
            f"[page-action] {failure}:排队,等限速后重发({attempt}/{attempts - 1})",
            file=sys.stderr,
        )
        if failure == "cdp-timeout":
            wake_service_worker(ensure_extension_page())
        pace(pace_spec, no_pace=no_pace)
    return result  # 循环至少走一轮,到不了这里(类型兜底)


def storage_op(
    op: str,
    keys_json: str,
    data_json: str,
    *,
    attempts: int,
    pace_spec: str | None,
    no_pace: bool,
) -> object:
    """读写扩展 storage.local:走消息流的 `storage.*` 动作,不在扩展页上下文直接捅 API.

    红线'应当走消息流'对探针同样算数;瞬时失败的排队重发与 `send` 同一条路.
    """
    try:
        keys = json.loads(keys_json)
        data = json.loads(data_json)
    except json.JSONDecodeError as error:
        print(f"[page-action] --keys/--data 不是合法 JSON:{error}", file=sys.stderr)
        raise SystemExit(2) from error
    if op == "set":
        if not isinstance(data, dict):
            print("[page-action] --data 必须是对象", file=sys.stderr)
            raise SystemExit(2)
        action, params = "storage.set", {"data": data}
    else:
        if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
            print("[page-action] --keys 必须是字符串数组", file=sys.stderr)
            raise SystemExit(2)
        action = "storage.get" if op == "get" else "storage.remove"
        params = {"keys": keys}
    return send_action_queued(
        action,
        params,
        attempts=attempts,
        pace_spec=pace_spec,
        no_pace=no_pace,
    )


def unwrap(message: object) -> object:
    """从 CDP Runtime.evaluate 的回包取 value,顺带把异常说清楚."""
    if not isinstance(message, dict):
        return message
    result = message.get("result", {})
    if "exceptionDetails" in result:
        return {"cdp-error": result["exceptionDetails"].get("text"), "raw": result}
    return result.get("result", {}).get("value")


def parse_outcome(raw: object) -> dict:
    """动作回包是一段 JSON 字符串(`{"ok":...,"result"|"error":...}`);解不开就原样放进 `raw`."""
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return value if isinstance(value, dict) else {"raw": value}
    return raw if isinstance(raw, dict) else {"raw": raw}


#: 测试环境要关着的两个写作框开关:动作前缀 → 页面上的名字.
TEST_TOGGLES = (("think", "深度思考"), ("search", "智能搜索"))


def toggles_off(args: argparse.Namespace) -> int:
    """把深度思考与智能搜索都拨到关(测试环境的已知起点).

    幂等:先读,已关的不动;开着的才点,**点之前照常限速**;
    `.set` 自己等站点稳定再回达成态(#81),据此核实.
    写作框不在(没登录 / 被禁言 / 页面没加载完)时报明原因并返回 1,不硬点.
    """
    state = poll_state(lambda one: bool(one.get("composer")), timeout=args.wait)
    if not state.get("composer"):
        print(f"[toggles-off] 写作框不在(url={state.get('url')},alert={state.get('alert')}):没动")
        return 1
    code = 0
    for action, label in TEST_TOGGLES:
        got = parse_outcome(send_action(f"{action}.get", {}))
        if not got.get("ok"):
            print(f"[toggles-off] {label}:读不到 {json.dumps(got, ensure_ascii=False)}")
            code = 1
            continue
        if got["result"].get("enabled") is False:
            print(f"[toggles-off] {label}:已是关")
            continue
        pace(args.pace, no_pace=args.no_pace)
        # `.set` 点完会等站点稳定再回达成态(#81),所以直接信它的返回;不再自己轮询 `.get`--
        # 那样执行器哪天又坏了,这里照样绿,把回归藏起来.
        done = parse_outcome(send_action(f"{action}.set", {"enabled": False}))
        achieved = done.get("result", {}).get("enabled") if done.get("ok") else None
        if achieved is False:
            print(f"[toggles-off] {label}:开→关")
        else:
            print(f"[toggles-off] {label}:没关上 {json.dumps(done, ensure_ascii=False)}")
            code = 1
    return code


def first_difference(saved: str, live: str, context: int = 60) -> str:
    """两段 HTML 第一处不同的位置与前后片段(够人眼定位,不倾倒整段)."""
    at = next((i for i, (a, b) in enumerate(zip(saved, live, strict=False)) if a != b), None)
    if at is None:
        at = min(len(saved), len(live))
    low = max(0, at - context)
    return (
        f"第 {at} 个字符起不同(存证长 {len(saved)},站点长 {len(live)})\n"
        f"      存证:...{saved[low : at + context]}...\n"
        f"      站点:...{live[low : at + context]}..."
    )


def reconcile_entry(entry: dict, live: object) -> tuple[str, str]:
    """一条存证对一次站点读数的结论:(状态, 说明).状态:一致 / 过时 / 未比.

    `live` 条目**读到了那一颗**而不逐字相等,才是'站点改版,存证过时'.
    `state-bound` 条目只在某个态出现,不等只能说'当前态不符,未比'--不算过时.
    **读不到那一颗(probe 返回 null)一律'未比'**:页面可能根本不在对应的地方(首页没有消息行,
    没有代码块),把它报成'过时'会让每次换页都满屏误报;站点真把控件删了,也会表现为
    换到有该控件的页面后仍读不到,由人看'未比'数是否异常.
    """
    saved = entry["outerHTML"]
    if live == saved:
        return "一致", ""
    if not isinstance(live, str):
        return "未比", "当前页面找不到这一颗(probe 返回 null):换到有这个控件的页面再比"
    detail = first_difference(saved, live)
    if entry.get("reconcile") == "state-bound":
        return "未比", f"当前态不符,未比:{detail}"
    return "过时", f"站点改版,存证过时:{detail}"


def evidence(args: argparse.Namespace) -> int:
    """真机对账:存证里每条的 probe 在页面上读一遍,与留档 `outerHTML` 逐字比.

    只读渲染 DOM(`js` 同款),不 dispatch 事件,不点任何按钮.有'过时'退出码 1.
    """
    if not EVIDENCE_FILE.is_file():
        print(f"[evidence] 存证文件缺失:{EVIDENCE_FILE.relative_to(REPO)}", file=sys.stderr)
        return 2
    entries = json.loads(EVIDENCE_FILE.read_text(encoding="utf-8"))["entries"]
    if args.id:
        entries = [entry for entry in entries if entry["id"] in args.id]
        missing = set(args.id) - {entry["id"] for entry in entries}
        if missing:
            print(f"[evidence] 存证里没有:{', '.join(sorted(missing))}", file=sys.stderr)
            return 2
    tab = ensure_site_tab()
    tally = {"一致": 0, "过时": 0, "未比": 0}
    for entry in entries:
        live = unwrap(run(tab["webSocketDebuggerUrl"], entry["probe"]))
        verdict, detail = reconcile_entry(entry, live)
        tally[verdict] += 1
        print(f"[evidence] {entry['id']:<18} {verdict}({entry['capturedOn']} 留档)")
        if detail:
            print(f"    {detail}")
    print(f"[evidence] 一致 {tally['一致']} / 未比 {tally['未比']} / 过时 {tally['过时']}")
    return 1 if tally["过时"] else 0


class _Parser(argparse.ArgumentParser):
    """让"全局 flag 放错位置"的报错自己说明该放哪.

    原来这条规矩写在 AGENTS.md 里. 但 argparse 本来就会拒绝放错的写法
    (`read --no-pace` -> `unrecognized arguments`), 所以那条指令防不住任何
    错误用法, 只是教人怎么读报错. 与其在 steering 文件里占三行, 不如让报错
    自己说 -- steering 文件该留给导航指针.
    """

    def error(self, message: str) -> None:
        bad = {"--no-pace", "--pace"}
        if "unrecognized arguments" in message and bad & set(message.split()):
            self.print_usage(sys.stderr)
            print(
                f"\npage-action.py: error: {message}\n"
                "--pace / --no-pace 是**全局** flag, 要放在子命令**前面**:\n"
                "  page-action.py --no-pace read     对\n"
                "  page-action.py read --no-pace     错",
                file=sys.stderr,
            )
            raise SystemExit(2)
        super().error(message)


def main() -> None:
    parser = _Parser(description="页面动作真机探针(开发用)")
    # 全局:动手前先随机等一下(默认开).理由见 pace().
    parser.add_argument(
        "--pace",
        default=None,
        metavar="MIN,MAX",
        help="动手前随机等 MIN..MAX 秒(默认唯一限速 Beta(2,4) 3~15s;给 0 关闭;例:--pace 3,6)",
    )
    parser.add_argument("--no-pace", action="store_true", help="别等,立刻动手(默认是等的)")
    parser.add_argument(
        "--attempts",
        type=int,
        default=5,
        metavar="N",
        help="send 遇瞬时失败(read-failed 等)排队重发的总次数(默认 5;给 1 即不重发)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="列 CDP 目标")
    focus = sub.add_parser("focus", help="把 DeepSeek 标签页置到前台(读页面列表前必须先来一下)")
    focus.add_argument(
        "--ext",
        action="store_true",
        help="改把扩展页置前台:验'报上来的标签页不在前台就不抓帧'这类负路要它",
    )
    sse = sub.add_parser(
        "sse",
        help=('录一轮 SSE 并按 finish_reason 判拒收(判"服务端收没收"的可靠路)'),
    )
    sse.add_argument("--text", default="", help="要发的正文;不给就只录当前这轮")
    sse.add_argument("--file", default="", help="从文件读正文(大输入走它,别塞命令行)")
    sse.add_argument("--repeat", type=int, default=0, help="把正文重复这么多次(灌大输入用)")
    sse.add_argument("--wait", type=float, default=35.0, help="发完等多少秒再读帧(默认 35)")
    sse.add_argument(
        "--fresh", action="store_true", help="先开新会话(chat.new 会重挂写作框,命令内已等)"
    )
    sub.add_parser("read", help="读 DeepSeek 页面状态")
    js = sub.add_parser("js", help="在 DeepSeek 页面上下文里跑一段只读 JS,打印结果")
    js.add_argument("expression", help="要 evaluate 的 JS 表达式(建议用 IIFE 返回字符串)")
    js.add_argument("--times", type=int, default=1, help="连读几拍(默认 1 = 读一次);多拍只打相变")
    js.add_argument("--every", type=float, default=1.0, help="连读时两拍之间隔几秒(默认 1)")
    ext_js_parser = sub.add_parser(
        "ext-js", help="在扩展页(options)上下文里跑一段只读 JS;--reload 先重载这一页"
    )
    ext_js_parser.add_argument(
        "expression", help="要 evaluate 的 JS 表达式(建议用 IIFE 返回字符串)"
    )
    ext_js_parser.add_argument(
        "--reload",
        action="store_true",
        help="先重载扩展页再跑:读照 storage 渲染的 DOM 必须先来一下,否则读到上一轮",
    )
    ext_js_parser.add_argument(
        "--times", type=int, default=1, help="连读几拍(默认 1 = 读一次);多拍只打相变"
    )
    ext_js_parser.add_argument(
        "--every", type=float, default=1.0, help="连读时两拍之间隔几秒(默认 1)"
    )
    stop_test = sub.add_parser("stop-test", help="端到端验 button.click:起生成→等停止键→点→等复位")
    stop_test.add_argument(
        "--text",
        default="请写一篇 3000 字的散文,主题是海边的灯塔,分段,慢慢写,一定要写满.",
        help="用来起生成的长消息",
    )
    stop_test.add_argument("--timeout", type=float, default=40.0, help="等某一相的秒数上限")
    send = sub.add_parser("send", help="给 DeepSeek 标签页发一件页面动作")
    send.add_argument("action", help="动作名,如 button.get")
    send.add_argument("--params", default="{}", help="动作参数 JSON,默认 {}")
    storage = sub.add_parser("storage", help="读写扩展 storage.local(走消息流 storage.*)")
    storage.add_argument("op", choices=["get", "set", "remove"], help="get 读 / set 写 / remove 删")
    storage.add_argument("--keys", default="[]", help="get / remove 的键数组(JSON)")
    storage.add_argument("--data", default="{}", help="set 的对象(JSON)")
    off = sub.add_parser(
        "toggles-off", help='测试环境:把"深度思考""智能搜索"都关掉(幂等,开着的才点)'
    )
    off.add_argument("--wait", type=float, default=15.0, help="等写作框出现的秒数上限,默认 15")
    ev = sub.add_parser(
        "evidence", help="存证对账:留档按钮原件 vs 站点当前那一颗逐字比(只读,ADR-0018)"
    )
    ev.add_argument("--id", action="append", help="只比这一条(可重复);默认全比")
    ax = sub.add_parser("ax", help="dump 无障碍树(role + 可访问名;只读,开发探针)")
    ax.add_argument("--grep", default="", help="只打印 role/name/value 命中该串的节点")
    ax.add_argument("--max", type=int, default=80, help="最多打印多少行,默认 80")
    ax.add_argument("--all", action="store_true", help="连 ignored 的节点也打印")
    shot = sub.add_parser(
        "visible-capture", help="验扩展能否抓可见标签页(现场帧的权限/体积探针,#106)"
    )
    shot.add_argument("--out", default="", help="把这一帧写到该路径(JPEG;默认不落盘)")
    shot.add_argument("--quality", type=int, default=60, help="JPEG 质量 0-100,默认 60")
    sub.add_parser(
        "frame-fail",
        help=(
            "验抓帧失败的负路:站点退后台时投一笔失败,失败痕照落,帧不新增"
            "(#106;跑完扳一次总开关对齐内存,别在续聊途中跑)"
        ),
    )
    send_page_parser = sub.add_parser(
        "send-page",
        help=(
            "验本地工具 send.page 的两步(composer.type → send.enter,全走三道闸):"
            "闸开着真发一条(要 --send),闸关着只落草稿(ADR-0013/0023)"
        ),
    )
    send_page_parser.add_argument(
        "--send", action="store_true", help='闸开着时认下"这一条真发进当前对话"'
    )
    send_page_parser.add_argument(
        "--question", default="", help=f"换成别的问题(默认 {SEND_PAGE_QUESTION}(#<时刻>))"
    )
    cont = sub.add_parser(
        "continue-click",
        help='点站点自己的"继续生成"并验 /chat/continue 真发出去(真鼠标事件;票 #105)',
    )
    cont.add_argument("--wait", type=float, default=8.0, help="点完等多少秒再读资源时序,默认 8")
    capture_parser = sub.add_parser(
        "capture", help="抓全量证据:完整 HTML / 同源 CSS / 资源清单 / 行快照 / 无障碍树"
    )
    capture_parser.add_argument("--out", default="", help="输出目录(默认 captures/<时间戳>/)")
    capture_parser.add_argument(
        "--codes",
        action="store_true",
        help="另把站点脚本正文下载到 codes/(走 CDP Debugger,含跨源 CDN 上的 bundle)",
    )
    args = parser.parse_args()

    if args.attempts < 1:
        parser.error("--attempts 至少是 1(1 = 不重发)")

    if args.command in ("js", "ext-js") and (args.times < 1 or args.every <= 0):
        parser.error("--times 至少是 1(1 = 只读一次),--every 要是正数")

    require_cdp()

    # 只读本地目标清单(list)不用碰站点,不必等.
    if args.command != "list":
        pace(args.pace, no_pace=args.no_pace)

    if args.command == "list":
        for target in targets():
            print(f"{target.get('type'):<16} {target.get('url', '')[:100]}")
        return

    if args.command == "visible-capture":
        raise SystemExit(visible_capture(args.out, args.quality))

    if args.command == "frame-fail":
        raise SystemExit(frame_fail())

    if args.command == "send-page":
        question = args.question or send_page_question(int(time.time()))
        raise SystemExit(send_page(question, allow_send=args.send))

    if args.command == "continue-click":
        raise SystemExit(continue_click(args.wait))

    if args.command == "focus":
        # DeepSeek 标签页必须留在**前台**:后台标签页被浏览器节流,虚拟列表不挂行,
        # `messages.*` 与按位置点控件会读成空(AGENTS.md 记着 2026-10-07 踩过).
        # 探针自己开别的目标(选项页等)就会把它挤到后台,所以这是个**动作**而不是
        # 一次性脚本--任何要读页面列表的探针动作前都得先来一下.
        # `--ext` 是反向用法:把扩展页置前台,让站点标签页**退到后台**,验"报上来的
        # 标签页不在前台就不抓帧"这类只有后台相才触发得出的负路(#106).
        target = ensure_extension_page() if args.ext else ensure_site_tab()
        asyncio.run(call_cdp(target["webSocketDebuggerUrl"], "Page.bringToFront"))
        print(json.dumps({"ok": True, "focused": target.get("url", "")}, ensure_ascii=False))
        return

    if args.command == "sse":
        tab = ensure_site_tab()
        if args.fresh:
            asyncio.run(call_cdp(tab["webSocketDebuggerUrl"], "Page.bringToFront"))
            send_action("chat.new", {})
            if not wait_composer(tab):
                print(
                    json.dumps(
                        {"error": "写作框没挂上(chat.new 后 20s 内没出现)--这一轮不算数"},
                        ensure_ascii=False,
                    )
                )
                raise SystemExit(4)
        # 装钩 / 填 / 发 / 读在**同一次调用**里闭合:分几次跑就留了"读到上一轮
        # 残留"的窗口(2026-10-09 栽在这上面两次,见 dsweb/FINDINGS.md §6).
        install_sse_hook(tab)
        sent = 0
        body = args.text
        if args.file:
            # 大输入走文件:命令行参数有长度上限,而正文动辄百万字.
            body = Path(args.file).read_text(encoding="utf-8")
        if body:
            sent = int(fill_composer(tab, body * args.repeat if args.repeat else body) or 0)
            send_action("send.enter", {})
        time.sleep(args.wait)
        asyncio.run(call_cdp(tab["webSocketDebuggerUrl"], "Page.bringToFront"))
        result = read_sse(tab)
        if isinstance(result, dict):
            result["sentChars"] = sent
            # 0 帧 = 这一轮什么都没抓到.它可能是"真没发",也可能是观测漏了
            # --**别把它当成没发**:换 `--text` 明确发了却 0 帧才可疑.
            result["note"] = (
                "0 帧:请求可能没发出去,也可能观测漏了;两种都见过(net 域漏过)"
                if not result.get("frames")
                else ""
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.command == "read":
        tab = ensure_site_tab()
        value = unwrap(run(tab["webSocketDebuggerUrl"], READ_EXPR))
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return

    if args.command == "js":
        tab = ensure_site_tab()
        ws_url = tab["webSocketDebuggerUrl"]
        if args.times > 1:
            raise SystemExit(read_timeline(ws_url, args.expression, args.times, args.every))
        print(json.dumps(unwrap(run(ws_url, args.expression)), ensure_ascii=False, indent=2))
        return

    if args.command == "ext-js":
        raise SystemExit(
            ext_js(
                args.expression,
                reload_page=args.reload,
                times=args.times,
                every=args.every,
            )
        )

    if args.command == "stop-test":
        report: dict = {}

        def is_stop(state: dict) -> bool:
            return bool(state.get("stopDetect", {}).get("isStop"))

        def is_send(state: dict) -> bool:
            return bool(state.get("stopDetect", {}).get("isSend"))

        print(f"[stop-test] 起生成:{args.text[:40]}...")
        report["type"] = send_action("composer.type", {"text": args.text})
        report["enter"] = send_action("send.enter", {})
        state = poll_state(is_stop, args.timeout)
        report["started"] = is_stop(state)
        report["atStop"] = state.get("stopDetect")
        print(f"[stop-test] 进入停止相:{report['started']}  icon={state.get('circleIcon')}")
        if report["started"]:
            report["stop"] = send_action("button.click", {})
            print(f"[stop-test] button.click -> {json.dumps(report['stop'], ensure_ascii=False)}")
            state2 = poll_state(is_send, args.timeout)
            report["stopped"] = is_send(state2)
            report["afterStop"] = state2.get("stopDetect")
            print(
                f"[stop-test] 停后回到发送相:{report['stopped']}  icon={state2.get('circleIcon')}"
            )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    if args.command == "send":
        try:
            params = json.loads(args.params)
        except json.JSONDecodeError as error:
            print(f"[page-action] --params 不是合法 JSON:{error}", file=sys.stderr)
            raise SystemExit(2) from error
        if not isinstance(params, dict):
            print("[page-action] --params 必须是对象", file=sys.stderr)
            raise SystemExit(2)
        print(
            json.dumps(
                send_action_queued(
                    args.action,
                    params,
                    attempts=args.attempts,
                    pace_spec=args.pace,
                    no_pace=args.no_pace,
                ),
                ensure_ascii=False,
                indent=2,
            ),
        )
        return

    if args.command == "evidence":
        raise SystemExit(evidence(args))

    if args.command == "toggles-off":
        raise SystemExit(toggles_off(args))

    if args.command == "storage":
        print(
            json.dumps(
                storage_op(
                    args.op,
                    args.keys,
                    args.data,
                    attempts=args.attempts,
                    pace_spec=args.pace,
                    no_pace=args.no_pace,
                ),
                ensure_ascii=False,
                indent=2,
            ),
        )
        return

    if args.command == "ax":
        tab = ensure_site_tab()
        nodes = ax_nodes(tab)
        shown = 0
        for node in nodes:
            if node.get("ignored") and not args.all:
                continue
            line = ax_line(node)
            if args.grep and args.grep not in line:
                continue
            print(line)
            shown += 1
            if shown >= args.max:
                break
        if shown == 0:
            print(f"(没有命中;共 {len(nodes)} 个节点)")
        else:
            print(f"-- 打住:{shown} 行 / 共 {len(nodes)} 个节点(--max 调大 / --grep 收窄)")
        return

    if args.command == "capture":
        capture(args.out, args.codes)
        return


if __name__ == "__main__":
    main()
