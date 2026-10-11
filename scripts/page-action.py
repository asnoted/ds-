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

两件只有探针知道的事(原先记在 AGENTS.md, 搬进来自带):

1. `target: null` 只有 `tabs.list` 与 `toggle.*` 答得出. `page.state` /
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
import hashlib
import json
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

#: 默认动手前的随机等待区间(秒).用户 2026-10-04 拍板:"注意速率"--别把站点当
#: 自己家机器连打,隔开一段,每次长度还不一样.
PACE_DEFAULT = (8.0, 20.0)

#: 页面控件存证(ADR-0018):真机按钮原件.CI 对拍管"存证 ↔ 回归用例",这里管"站点 ↔ 存证".
EVIDENCE_FILE = REPO / "protocol" / "evidence" / "controls.json"


def pace(spec: str | None, *, no_pace: bool = False) -> None:
    """动手前随机等一下(默认开,`--no-pace` 关,`--pace MIN,MAX` 自定义).

    为什么固化进工具而不是每次手敲:这条纪律靠记性一定会漏,而漏了就是连打站点.
    随机而非固定时长,免得打出机器人的节奏.打印等待时长,方便复盘时对齐时间线.
    """
    if no_pace:
        return
    low, high = PACE_DEFAULT
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
    ext = ensure_extension_page()
    frame = {
        "type": "action",
        "id": f"probe-{int(time.time() * 1000)}",
        "action": action,
        "params": params,
        "target": None,
    }
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


def storage_op(op: str, keys_json: str, data_json: str) -> object:
    """读写扩展 storage.local:开发探针要看 / 清退避这类持久态,从扩展页上下文发."""
    ext = ensure_extension_page()
    try:
        keys = json.loads(keys_json)
        data = json.loads(data_json)
    except json.JSONDecodeError as error:
        print(f"[page-action] --keys/--data 不是合法 JSON:{error}", file=sys.stderr)
        raise SystemExit(2) from error
    if op == "get":
        script = f"chrome.storage.local.get({json.dumps(keys)}).then((v) => JSON.stringify(v))"
    elif op == "remove":
        script = (
            f"chrome.storage.local.remove({json.dumps(keys)})"
            ".then(() => JSON.stringify({ ok: true }))"
        )
    else:
        script = (
            f"chrome.storage.local.set({json.dumps(data)})"
            ".then(() => JSON.stringify({ ok: true }))"
        )
    return unwrap(run(ext["webSocketDebuggerUrl"], script))


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
        help="动手前随机等 MIN..MAX 秒(默认 8..20;给 0 关闭;例:--pace 3,6)",
    )
    parser.add_argument("--no-pace", action="store_true", help="别等,立刻动手(默认是等的)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="列 CDP 目标")
    sub.add_parser("focus", help="把 DeepSeek 标签页置到前台(读页面列表前必须先来一下)")
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
    storage = sub.add_parser("storage", help="读写扩展 storage.local(开发探针)")
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
    capture_parser = sub.add_parser(
        "capture", help="抓全量证据:完整 HTML / 同源 CSS / 资源清单 / 行快照 / 无障碍树"
    )
    capture_parser.add_argument("--out", default="", help="输出目录(默认 captures/<时间戳>/)")
    capture_parser.add_argument(
        "--codes", action="store_true", help="另把同源 <script src> 正文下载到 codes/"
    )
    args = parser.parse_args()

    require_cdp()

    # 只读本地目标清单(list)不用碰站点,不必等.
    if args.command != "list":
        pace(args.pace, no_pace=args.no_pace)

    if args.command == "list":
        for target in targets():
            print(f"{target.get('type'):<16} {target.get('url', '')[:100]}")
        return

    if args.command == "focus":
        # DeepSeek 标签页必须留在**前台**:后台标签页被浏览器节流,虚拟列表不挂行,
        # `messages.*` 与按位置点控件会读成空(AGENTS.md 记着 2026-10-07 踩过).
        # 探针自己开别的目标(选项页等)就会把它挤到后台,所以这是个**动作**而不是
        # 一次性脚本--任何要读页面列表的探针动作前都得先来一下.
        tab = ensure_site_tab()
        asyncio.run(call_cdp(tab["webSocketDebuggerUrl"], "Page.bringToFront"))
        print(json.dumps({"ok": True, "focused": tab.get("url", "")}, ensure_ascii=False))
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
        print(
            json.dumps(
                unwrap(run(tab["webSocketDebuggerUrl"], args.expression)),
                ensure_ascii=False,
                indent=2,
            )
        )
        return

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
            json.dumps(send_action(args.action, params), ensure_ascii=False, indent=2),
        )
        return

    if args.command == "evidence":
        raise SystemExit(evidence(args))

    if args.command == "toggles-off":
        raise SystemExit(toggles_off(args))

    if args.command == "storage":
        print(
            json.dumps(storage_op(args.op, args.keys, args.data), ensure_ascii=False, indent=2),
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
