import { defineContentScript } from "wxt/utils/define-content-script";

import { detectAskQuestion, detectToolCalls, extractAssistantAnswer } from "../src/lib/answer";
import {
  askClearedMessage,
  askMessage,
  callMessage,
  pageSessionIdOf,
  parseChainMessage,
  saidMessage,
  stopMessage,
  type ResultMessage,
} from "../src/lib/channel";
import {
  buildContinuation,
  CONTINUATION_MARKER,
  isArmedFresh,
  STOP_CONTINUATION_LIMIT,
} from "../src/lib/continuation";
import { enqueue, newGate, nextOpenAt, release, type Gate } from "../src/lib/gate";
import {
  isOutgoingChatRequest,
  rewriteContinuationBody,
  rewriteOutgoingBody,
} from "../src/lib/inject";
import { findButton, readPressed } from "../src/lib/page";
import { nextMessageId } from "../src/lib/id";
import { hasReplyAnchor, isInjectableReply } from "../src/lib/reply";
import type { ToolInfo } from "../src/lib/relay";
import {
  beginRound,
  INITIAL_ROUNDS,
  MAX_CONTINUATION_ROUNDS,
  resetRounds,
  type RoundState,
} from "../src/lib/rounds";
import { outsideFences } from "../src/lib/said";
import { parseToggleMessage, wantStateMessage } from "../src/lib/toggle";

type XhrTarget = { readonly method: string; readonly url: string };

/**
 * 页面世界这一侧有两件事(总开关关着时一件都不做:不接管,不注入,不检测,不回灌):
 *
 * 1. **协议说明注入**:把 `fetch` 与 `XMLHttpRequest` 包一层,在请求体离开页面之前改写它,
 *    说明里那份工具目录是隔离世界广播下来的(`tools` 信封).
 * 2. **回灌链**:同一次包下来的**响应体**就是检测点(模型回答的唯一来源)→ 认出 ```send 围栏 →
 *    围栏正文交给隔离世界去打本机网关 → 结果进**唯一出站口**排队,出站窗口到点放行(ADR-0002)→
 *    **续聊**:对话里只发一个短标记(`agent:` 首行锚 + 一行字),工具结果由同一次出站的
 *    **请求体替换**交给模型(`rewriteContinuationBody`)--结果不进可见消息(ADR-0014).
 *    一条任务里自动续多少轮有上限(`rounds.ts`),到顶停手并在扩展侧留痕.
 *
 * 失败一律不进对话流:中继没问成时这里只留一行日志,页面里不出现任何新消息.
 */
export default defineContentScript({
  world: "MAIN",
  matches: ["https://chat.deepseek.com/*"],
  runAt: "document_start",
  main() {
    // 现取不预存:要包的是"包的那一刻页面正在用的那一版",还原的也是它.
    let originalFetch!: typeof window.fetch;
    let originalOpen!: typeof XMLHttpRequest.prototype.open;
    let originalSend!: typeof XMLHttpRequest.prototype.send;
    let installed = false;
    let enabled = false;

    /** 唯一出站口:回灌内容在这里排队,出站窗口到点才放行. */
    let gate: Gate = newGate();
    let flushTimer: number | null = null;

    /** 网页排了 ask 围栏问人(#26):挂着等"对话继续"来清. */
    let pendingAsk = false;

    /** 隔离世界广播下来的工具目录(`tools/list`);null = 还没取到,说明里会写明. */
    let catalog: readonly ToolInfo[] | null = null;

    /** 自动续聊的轮数(`rounds.ts`):一条任务里最多自动续这么多轮. */
    let rounds: RoundState = INITIAL_ROUNDS;

    /** 排着队,还没到出站窗口的续聊正文;放行那一刻才武装(见 `flush`). */
    let queuedContinuation: string | null = null;

    /** 已武装:下一条出站聊天请求的正文会被换成它(一次即作废). */
    let armedContinuation: string | null = null;

    /** 武装的时刻:过期(`ARMED_TTL_MS`)一样作废,见下. */
    let armedAt = 0;

    /** 上一次见过的页面会话 id:换了会话 = 换了条任务,轮数归零. */
    let sessionKey: string | null = null;

    const xhrTargets = new WeakMap<XMLHttpRequest, XhrTarget>();
    const watchingXhrs = new WeakSet<XMLHttpRequest>();

    /**
     * 出站改写:挂着的续聊优先(这一趟就是自动续聊那一趟),否则照旧拼协议说明.
     *
     * 续聊**一次即作废**:替换没成也作废--留着它,下一条出站就是用户自己发的消息,
     * 会被当成续聊那趟,正文被工具结果顶掉(把人说的话吃了,比少一轮严重得多).
     */
    const rewriteOutgoing = (body: string): string | null => {
      if (armedContinuation !== null && !isArmedFresh(armedAt, Date.now())) {
        // 挂太久了:多半是那一趟没真发出去.作废--不能让它顶掉用户下一条消息.
        console.log("[ds-] 挂着的续聊已过期,作废(不拿它顶用户的下一句话)");
        armedContinuation = null;
      }
      if (armedContinuation === null) {
        const next = rewriteOutgoingBody(body, catalog);
        if (next !== null) console.log("[ds-] 已把协议说明拼到这条消息开头");
        return next;
      }
      const pending = armedContinuation;
      armedContinuation = null;
      armedAt = 0;
      const next = rewriteContinuationBody(body, pending);
      console.log(
        next === null
          ? "[ds-] 续聊正文没能替换进出站请求,这一轮作废(结果没送到模型手上)"
          : "[ds-] 续聊正文已替换进这次出站请求(工具结果不走可见消息)",
      );
      return next;
    };

    /** 判断逻辑在 src/lib/inject.ts,这里只认它那句"null 就原样放行". */
    const rewriteBody = (body: string, method: string, url: string): string | null => {
      if (!isOutgoingChatRequest(method, url)) return null;
      return rewriteOutgoing(body);
    };

    /** 排下一次开窗:队列空着就不排. */
    function scheduleFlush(): void {
      const at = nextOpenAt(gate);
      if (at === null) return;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(flush, Math.max(0, at - Date.now()));
    }

    /** 出站窗口开一次,把队列一次性放行;每条都走同一条发送路径. */
    function flush(): void {
      flushTimer = null;
      const step = release(gate, Date.now(), Math.random);
      gate = step.gate;
      for (const message of step.released) {
        // 武装放在放行这一刻:从入队到开窗有几秒,期间用户可能自己在发消息--
        // 早武装就会把他的真消息换成工具结果.
        const isContinuation = queuedContinuation !== null && message === CONTINUATION_MARKER;
        if (isContinuation) {
          armedContinuation = queuedContinuation;
          armedAt = Date.now();
          queuedContinuation = null;
        }
        void sendToPage(message)
          .then((sent) => {
            // 没发出去就把武装撤掉(发出去的已经被替换那一步消费掉了):
            // 留着它,下一个出站就是用户自己发的消息,正文会被工具结果顶掉.
            if (!sent && isContinuation) {
              armedContinuation = null;
              armedAt = 0;
            }
            console.log(
              sent ? "[ds-] 续聊已作为一条短标记发出" : "[ds-] 续聊没有发出去,页面里没有新消息",
            );
          })
          .catch((error) => {
            if (isContinuation) {
              armedContinuation = null;
              armedAt = 0;
            }
            console.log("[ds-] 续聊发送出岔,页面里没有新消息", error);
          });
      }
      if (gate.queue.length > 0) scheduleFlush();
    }

    /** 中继给了 status: ok 的载荷才排进队列;单来回,不重试,无兜底. */
    function handleResult(result: ResultMessage): void {
      if (!enabled) return;
      if (!isInjectableReply(result.payload)) {
        const error = result.payload.status === "error" ? result.payload.error : "unknown";
        console.log(`[ds-] 中继没问成(${error}),失败不进对话流`);
        return;
      }
      // 刹车(`rounds.ts`):到顶就不发这一轮,只在扩展侧留一笔,等用户开口.
      const verdict = beginRound(rounds);
      rounds = verdict.next;
      if (!verdict.proceed) {
        const id = nextMessageId("rounds");
        console.log(`[ds-] 自动续聊已连到 ${MAX_CONTINUATION_ROUNDS} 轮上限,停手等用户开口`);
        window.postMessage(stopMessage(id, STOP_CONTINUATION_LIMIT), "*");
        return;
      }
      queuedContinuation = buildContinuation(result.payload);
      gate = enqueue(gate, CONTINUATION_MARKER, Date.now(), Math.random);
      scheduleFlush();
    }

    /**
     * 检测:只从"发消息那条出站的响应体"里认围栏,认出就把围栏正文交出去.
     *
     * send 围栏(一段工具调用 JSON)照旧转给网关;ask 围栏(#26)**不转**--它是网页向人
     * 举手,交给隔离世界上报 background 挂"等人回".同一回答里两种
     * 围栏都排了以 send 为准(一次最多一块的口径);本轮没有任何围栏,
     * 而此前挂着 ask,说明对话继续了(人答了或模型自己往下走了),
     * "等人回"自己清掉.
     */
    function detect(raw: string): void {
      if (!enabled) return;
      // 换了页面会话 = 换了条任务:轮数归零,别把上一条的刹车额度带过来.
      const key = pageSessionIdOf(location.href);
      if (key !== sessionKey) {
        sessionKey = key;
        rounds = resetRounds();
      }
      const calls = detectToolCalls(raw);
      // **围栏之外的话**一律报给协调者:有围栏时围栏转网关,围栏以外那些别的话不能被吞掉.
      // 回灌自己(首行是 `agent:`)不算:那是桥送回去的,再报就成了回声.
      const said = outsideFences(extractAssistantAnswer(raw));
      if (said !== "" && !hasReplyAnchor(said)) {
        window.postMessage(saidMessage(nextMessageId("said"), said), "*");
      }
      if (calls.length > 0) {
        const id = nextMessageId("send");
        console.log(`[ds-] 认出 ${calls.length} 块 send 围栏(${id}),交给中继`);
        window.postMessage(callMessage(id, calls), "*");
        pendingAsk = false;
        return;
      }
      // 这一轮答复里没有围栏 = 任务收尾:轮数归零,下一次任务重新有满额.
      rounds = resetRounds();
      const ask = detectAskQuestion(raw);
      if (ask !== null) {
        pendingAsk = true;
        const id = nextMessageId("ask");
        console.log(`[ds-] 认出 ask 围栏(${id}),网页在等人回`);
        window.postMessage(askMessage(id, ask), "*");
        return;
      }
      if (pendingAsk) {
        pendingAsk = false;
        const id = nextMessageId("ask");
        console.log(`[ds-] 对话继续了,ask(${id})作废`);
        window.postMessage(askClearedMessage(id), "*");
      }
      // 静默分支曾让"围栏在,但形状认不出"无法定位,这里只在真有 send 字样时吭声.
      if (raw.includes("```send")) {
        console.log(`[ds-] 响应里有 \`\`\`send 字样却没认出围栏(${raw.length} 字)`);
      }
    }

    /** 读响应体;读不出来就这轮不检测,不猜. */
    async function watchResponse(response: Response): Promise<void> {
      try {
        const raw = await response.text();
        // 与"检测没跑"区分:跑没跑先有个数.
        console.log(`[ds-] 读到出站响应(${raw.length} 字)`);
        detect(raw);
      } catch (error) {
        console.log("[ds-] 响应读不出来,这轮不检测", error);
      }
    }

    /** XHR 的响应体:文本直接读,别的类型认得出结构就还原成原文. */
    function readXhrResponse(xhr: XMLHttpRequest): string | null {
      try {
        if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
        const response = xhr.response;
        if (typeof response === "string") return response;
        if (response !== null && typeof response === "object") return JSON.stringify(response);
      } catch {
        return null;
      }
      return null;
    }

    function install(): void {
      if (installed) return;
      installed = true;
      originalFetch = window.fetch;
      originalOpen = XMLHttpRequest.prototype.open;
      originalSend = XMLHttpRequest.prototype.send;

      window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const outgoing = isOutgoingChatRequest(method, url);

        const bodyText = init !== undefined && typeof init.body === "string" ? init.body : null;
        const nextBody = outgoing && bodyText !== null ? rewriteOutgoing(bodyText) : null;
        const requestInit =
          nextBody !== null && init !== undefined ? { ...init, body: nextBody } : init;

        const request = originalFetch.call(window, input, requestInit);
        if (!outgoing) return request;
        return request.then((response) => {
          // 模型的回答只走这条路回来:克隆一份自己读,页面那一份照常流走.
          void watchResponse(response.clone());
          return response;
        });
      };

      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null,
      ): void {
        xhrTargets.set(this, { method, url: String(url) });
        // 三参形式与两参形式等价(async 缺省即 true),一个出口够了.
        originalOpen.call(this, method, url, async ?? true, username, password);
      };

      XMLHttpRequest.prototype.send = function (
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        const target = xhrTargets.get(this);
        if (target !== undefined && !watchingXhrs.has(this)) {
          watchingXhrs.add(this);
          this.addEventListener("loadend", () => {
            if (!isOutgoingChatRequest(target.method, target.url)) return;
            const raw = readXhrResponse(this);
            if (raw !== null) detect(raw);
          });
        }
        if (target !== undefined && typeof body === "string") {
          const nextBody = rewriteBody(body, target.method, target.url);
          if (nextBody !== null) {
            originalSend.call(this, nextBody);
            return;
          }
        }
        originalSend.call(this, body);
      };
    }

    function uninstall(): void {
      if (!installed) return;
      installed = false;
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    }

    function apply(next: boolean): void {
      if (next === enabled) return;
      enabled = next;
      if (next) install();
      else uninstall();
      if (!next) {
        // 关掉时整条链一起作废:队列清空,定时器撤掉;检测随包装一起卸掉.
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        gate = newGate();
        // 续聊这两笔与轮数也一样作废:关着时挂着的正文不该在下一次开闸时冒出来.
        queuedContinuation = null;
        armedContinuation = null;
        armedAt = 0;
        rounds = resetRounds();
        sessionKey = null;
      }
      console.log(
        `[ds-] 总开关${next ? "打开" : "关闭"},协议说明${next ? "开始注入" : "不再注入"},回灌链${next ? "开始工作" : "整条不再工作"}`,
      );
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const chain = parseChainMessage(event.data);
      if (chain?.kind === "result") {
        handleResult(chain);
        return;
      }
      if (chain?.kind === "tools") {
        // 没取到时隔离世界不吭声(content.ts 只广播拿得到的目录),这里因此只进不退.
        catalog = chain.tools;
        return;
      }

      const toggle = parseToggleMessage(event.data);
      if (toggle?.kind === "state") apply(toggle.enabled);
    });

    // 两个内容脚本谁先谁后都可能:这边开口要一次,那边自己也会报一次.
    window.postMessage(wantStateMessage(), "*");
  },
});

/* -------------------------------------------------------------------------- */
/* 回灌发送点:把消息交给站点自己那条发消息的路径                                */
/* -------------------------------------------------------------------------- */

const COMPOSER_SELECTORS = ["textarea", '[contenteditable="true"]'];

/**
 * 回灌作为一条真实用户消息发进当前会话:把消息填进站点自己的输入框,触发它原生的发送,
 * 于是这条消息走的与 #12 注入同一条路(同一个 `CHAT_SEND_PATH` 闸门内的那次发送).
 * 返回有没有真的发出去;发不出去就把输入框还原,页面里不留半截东西.
 */
async function sendToPage(message: string): Promise<boolean> {
  const composer = pickComposer();
  if (composer === null) {
    console.log("[ds-] 没找到站点的输入框,这轮回灌作废");
    return false;
  }

  const before = readComposer(composer);
  if (!writeComposer(composer, message)) {
    console.log("[ds-] 输入框写不进去,这轮回灌作废");
    return false;
  }

  if (await triggerSend(composer)) return true;

  if (readComposer(composer).includes(message)) writeComposer(composer, before);
  return false;
}

/** 挑站点的输入框:看得见,能写的优先 textarea,其次可编辑区;同级里挑面积最大的. */
function pickComposer(): HTMLElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    let best: HTMLElement | null = null;
    let bestArea = -1;
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isWritable(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

function isWritable(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  return element.isContentEditable;
}

function readComposer(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement) return element.value;
  return element.textContent ?? "";
}

/** 写值走原生 setter:站点的受控组件才认得这次改动(只 dispatch 事件不算改过). */
function writeComposer(element: HTMLElement, text: string): boolean {
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) return false;
    setter.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (element.isContentEditable) {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

async function triggerSend(composer: HTMLElement): Promise<boolean> {
  dispatchEnter(composer);
  if (await waitForSend(composer, 600)) return true;

  // 兜底才去点圆键,而**只在它此刻真是"发送"时点**(`button.get` 那套读面).
  // 生成期那个圆键是停止(真机 2026-10-05:class 一个不换,只有图标在箭头与方块之间换),
  // 点下去就是替用户中断一次生成--比这条回灌发不出去坏得多.认不出(思考期环形
  // spinner,报 unknown)同样不点:宁可作废,也不赌那一下是发送.
  const button = findButton();
  if (button === null || readPressed(button) !== "send") return false;
  button.click();
  return waitForSend(composer, 1200);
}

/** Enter 是站点的发送键;keyCode / which 自己补上,页面里的老判断也认. */
function dispatchEnter(composer: HTMLElement): void {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "keyCode", { value: 13 });
  Object.defineProperty(event, "which", { value: 13 });
  composer.dispatchEvent(event);
}

/** 发出去的标志:输入框被站点清空. */
function waitForSend(composer: HTMLElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (readComposer(composer).trim() === "") {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 100);
    };
    tick();
  });
}
