import { defineContentScript } from "wxt/utils/define-content-script";

import { detectAskQuestion, detectToolCalls, extractAssistantAnswer } from "../src/lib/answer";
import {
  askClearedMessage,
  askMessage,
  callMessage,
  continuationFailMessage,
  pageSessionIdOf,
  parseChainMessage,
  parseSendNote,
  saidMessage,
  sendNoteMessage,
  stopMessage,
} from "../src/lib/channel";
import { CONTINUATION_MARKER } from "../src/lib/continuation";
import { type ContinuationFailure } from "../src/lib/continuationfail";
import { matchesMarker } from "../src/lib/armed";
import { enqueue, newGate, nextOpenAt, release, type Gate } from "../src/lib/gate";
import {
  mergeSendPace,
  newSendPace,
  realSleep,
  runPaced,
  type SendPace,
} from "../src/lib/sendpace";
import {
  isOutgoingChatRequest,
  recognizeOutgoingShape,
  rewriteOutgoingBody,
} from "../src/lib/inject";
import { findButton, readPressed } from "../src/lib/page";
import { nextMessageId } from "../src/lib/id";
import { hasReplyAnchor } from "../src/lib/reply";
import type { ToolInfo } from "../src/lib/relay";
import {
  decide,
  endTask,
  newRun,
  type RunDecision,
  type RunEffect,
  type RunEvent,
  type RunState,
} from "../src/lib/run";
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

    /**
     * 一趟续聊的全部状态与次序:次序的裁决在 `run.ts`(事件进、裁决出的纯函数),
     * 这里只剩取事件 → 调裁决 → 执行效果,不持有任何"什么时候武装 / 只落草稿 /
     * 发送 / 作废"的判断(CODING_STANDARDS 第 1 条).
     */
    let run: RunState = newRun();

    /** 唯一出站口:回灌内容在这里排队,出站窗口到点才放行. */
    let gate: Gate = newGate();
    let flushTimer: number | null = null;

    /** 网页排了 ask 围栏问人(#26):挂着等"对话继续"来清. */
    let pendingAsk = false;

    /** 隔离世界广播下来的工具目录(`tools/list`);null = 还没取到,说明里会写明. */
    let catalog: readonly ToolInfo[] | null = null;

    /**
     * 发送限速(#61):自动续聊这一路的发送也归同一条 3~5 秒的线,与隔离世界那三条
     * (`send.enter` / 圆键 / `message.retry`)**合成一条**--靠 `send-note` 通报并时刻,
     * 不迁状态,不写 DOM 属性.
     */
    let sendPace: SendPace = newSendPace();

    const xhrTargets = new WeakMap<XMLHttpRequest, XhrTarget>();
    const watchingXhrs = new WeakSet<XMLHttpRequest>();

    /** 取事件 → 调裁决(纯)→ 状态写回 → 照效果清单执行(副作用全在 perform 里). */
    function dispatch(event: RunEvent): RunDecision {
      const decision = decide(run, event);
      run = decision.state;
      for (const effect of decision.effects) perform(effect);
      return decision;
    }

    /** 执行一条裁决效果:入队、发送、落草稿、留痕、停手、总开关生效——全是副作用. */
    function perform(effect: RunEffect): void {
      switch (effect.kind) {
        case "enqueue":
          gate = enqueue(gate, CONTINUATION_MARKER, Date.now(), Math.random);
          scheduleFlush();
          break;
        case "send":
          void paceSend(
            () => sendToPage(effect.message),
            (outcome) => outcome.sent,
          )
            .then((outcome) => {
              dispatch({
                type: "settled",
                continuation: effect.continuation,
                outcome: { sent: outcome.sent, failure: outcome.failure },
              });
              console.log(
                outcome.sent
                  ? "[ds-] 续聊已作为一条短标记发出"
                  : "[ds-] 续聊没有发出去,页面里没有新消息",
              );
            })
            .catch((error) => {
              dispatch({
                type: "settled",
                continuation: effect.continuation,
                outcome: { thrown: error },
              });
              console.log("[ds-] 续聊发送出岔,页面里没有新消息", error);
            });
          break;
        case "stage":
          dispatch({ type: "settled", continuation: true, outcome: stagePendingMarker() });
          break;
        case "trace": {
          const id = nextMessageId("cont-fail");
          window.postMessage(continuationFailMessage(id, effect.cause), "*");
          console.log(`[ds-] 续聊失败:${effect.cause}(已留痕)`);
          break;
        }
        case "stop":
          window.postMessage(stopMessage(nextMessageId("rounds"), effect.cause), "*");
          console.log(`[ds-] ${effect.note}`);
          break;
        case "apply":
          if (effect.enabled) install();
          else {
            uninstall();
            // 关掉时整条链一起作废:定时器撤掉,出站队列清空(检测随包装一起卸掉).
            if (flushTimer !== null) {
              window.clearTimeout(flushTimer);
              flushTimer = null;
            }
            gate = newGate();
          }
          console.log(
            `[ds-] 总开关${effect.enabled ? "打开" : "关闭"},协议说明${effect.enabled ? "开始注入" : "不再注入"},回灌链${effect.enabled ? "开始工作" : "整条不再工作"}`,
          );
          break;
        case "log":
          console.log(`[ds-] ${effect.note}`);
          break;
      }
    }

    /**
     * 发送限速检查点(#61):与隔离世界**共用 `sendpace.runPaced` 这一份时序**
     * (此前两个世界各写一遍,同一条规则两份实现).这一侧恒是发送(续聊只按短标记
     * 那一键),所以意图固定 `send`;记账看这次有没有真发出去.
     *
     * 等够再发,不拒绝,不新增失败码--agent 侧看不出差别.发出去后向隔离世界通报
     * 时刻,两边的节奏合成一条线.
     */
    async function paceSend<T>(send: () => Promise<T>, sent: (result: T) => boolean): Promise<T> {
      const run = await runPaced({
        pace: sendPace,
        readIntent: () => "send",
        execute: send,
        shouldRecord: sent,
        now: () => Date.now(),
        random: () => Math.random(),
        sleep: realSleep,
      });
      if (run.waitedMs > 0) {
        console.log(`[ds-] 发送限速:上一条刚发过,等 ${run.waitedMs}ms 再发`);
      }
      if (run.pace !== sendPace) {
        sendPace = run.pace;
        window.postMessage(sendNoteMessage("main", sendPace.lastSentAt ?? 0), "*");
      }
      return run.result;
    }

    /**
     * 出站改写:挂着的续聊优先(这一趟就是自动续聊那一趟),否则照旧拼协议说明.
     *
     * 出站载荷**只认一次**(`recognizeOutgoingShape`):钥匙比对、正文替换、协议说明
     * 拼接三种用途共用这一次识别,谁该被认领、正文换不换、留哪条痕全在 `run.ts` 的
     * `claimed` 裁决里;这里只照 `ClaimOutcome` 返回:换成的正文 / 照旧拼协议说明.
     * 续聊**一次即作废**:替换没成也作废--留着它,下一条出站就是用户自己发的消息,
     * 会被当成续聊那趟,正文被工具结果顶掉(把人说的话吃了,比少一轮严重得多).
     */
    const rewriteOutgoing = (body: string): string | null => {
      const shape = recognizeOutgoingShape(body);
      const decision = dispatch({ type: "claimed", shape, now: Date.now() });
      switch (decision.claim?.kind) {
        case "substituted":
          console.log("[ds-] 续聊正文已替换进这次出站请求(工具结果不走可见消息)");
          return decision.claim.body;
        default: {
          const next = rewriteOutgoingBody(body, catalog);
          if (next !== null) console.log("[ds-] 已把协议说明拼到这条消息开头");
          return next;
        }
      }
    };

    /** 判断逻辑在 src/lib/inject.ts,这里只认它那句"null 就原样放行". */
    const rewriteBody = (body: string, method: string, url: string): string | null => {
      if (!isOutgoingChatRequest(method, url)) return null;
      return rewriteOutgoing(body);
    };

    /**
     * 半自动那一跳(#52):"代你发言"闸关着时,把短标记**写进输入框**,**不按发送**,
     * 等用户自己按.
     *
     * 三个结果分得清清楚楚(失败留痕由 `run.ts` 的 settled 裁决发):
     * 找不到输入框 `composer-absent`;**输入框里有你的草稿** → **不覆盖**
     * `draft-in-composer`(宁可少一轮,也不吃人正在打的东西);写不进去
     * `composer-unwritable`.
     *
     * `sent: true` 表示标记已经落在输入框里(pending 态可以挂着等用户按)——
     * 这里只有写入,**没有发送步**.
     */
    function stagePendingMarker(): SendOutcome {
      const composer = pickComposer();
      if (composer === null) return { sent: false, failure: "composer-absent" };
      const draft = readComposer(composer);
      if (draft.trim() !== "" && !matchesMarker(draft)) {
        console.log("[ds-] 输入框里还有你正在打的字,这一轮不覆盖");
        return { sent: false, failure: "draft-in-composer" };
      }
      if (!writeComposer(composer, CONTINUATION_MARKER)) {
        return { sent: false, failure: "composer-unwritable" };
      }
      console.log('[ds-] "代你发言"闸关着:短标记已写进输入框,等你按发送');
      return { sent: true, failure: null };
    }

    /** 排下一次开窗:队列空着就不排. */
    function scheduleFlush(): void {
      const at = nextOpenAt(gate);
      if (at === null) return;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(flush, Math.max(0, at - Date.now()));
    }

    /**
     * 出站窗口开一次,把队列一次性放行;每条都走同一条发送路径.
     * 放行那一刻才武装 / 只落草稿,由 `run.ts` 的 `released` 裁决定.
     */
    function flush(): void {
      flushTimer = null;
      const step = release(gate, Date.now(), Math.random);
      gate = step.gate;
      for (const message of step.released) {
        dispatch({ type: "released", message, now: Date.now() });
      }
      if (gate.queue.length > 0) scheduleFlush();
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
      if (!run.enabled) return;
      // 换了页面会话 = 换了条任务:轮数归零、待发的那条作废,判据在 `run.ts` 的
      // `session` 裁决里(同 key 它自己不动).
      dispatch({ type: "session", key: pageSessionIdOf(location.href) });
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
      run = endTask(run);
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

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const chain = parseChainMessage(event.data);
      if (chain?.kind === "result") {
        // 中继给了 status: ok 的载荷才排进队列;单来回,不重试,无兜底.
        dispatch({ type: "result", payload: chain.payload });
        return;
      }
      if (chain?.kind === "tools") {
        // 没取到时隔离世界不吭声(content.ts 只广播拿得到的目录),这里因此只进不退.
        catalog = chain.tools;
        return;
      }

      const toggle = parseToggleMessage(event.data);
      if (toggle?.kind === "state") {
        // 闸与总开关的次序(闸关时挂着的作废、关时整条链作废)在 `run.ts` 的 `toggle` 裁决里.
        dispatch({ type: "toggle", speak: toggle.speak, enabled: toggle.enabled });
      }

      // 隔离世界那边(催办 / send.page / message.retry)也发过消息:并进它的时刻,
      // 两边的发送节奏合成一条线(#61).不认自己发的通报.
      const note = parseSendNote(event.data);
      if (note !== null && note.world !== "main") {
        sendPace = mergeSendPace(sendPace, note.at);
      }
    });

    // 两个内容脚本谁先谁后都可能:这边开口要一次,那边自己也会报一次.
    window.postMessage(wantStateMessage(), "*");
  },
});

/* -------------------------------------------------------------------------- */
/* 回灌发送点:把消息交给站点自己那条发消息的路径                                */
/* -------------------------------------------------------------------------- */

const COMPOSER_SELECTORS = ["textarea", '[contenteditable="true"]'];

/** 一次发送的结果:发没发出去,**以及没发出去时断在哪一步**(#51 要这个来留痕). */
export type SendOutcome = {
  readonly sent: boolean;
  /** 发的出去是 null;失败时是 `continuationfail.ts` 里的原因码,三种不合并. */
  readonly failure: ContinuationFailure | null;
};

/**
 * 回灌作为一条真实用户消息发进当前会话:把消息填进站点自己的输入框,触发它原生的发送,
 * 于是这条消息走的与 #12 注入同一条路(同一个 `CHAT_SEND_PATH` 闸门内的那次发送).
 * 返回有没有真的发出去,失败时带上原因码;发不出去就把输入框还原,页面里不留半截东西.
 */
async function sendToPage(message: string): Promise<SendOutcome> {
  const composer = pickComposer();
  if (composer === null) {
    console.log("[ds-] 没找到站点的输入框,这轮回灌作废");
    return { sent: false, failure: "composer-absent" };
  }

  const before = readComposer(composer);
  if (!writeComposer(composer, message)) {
    console.log("[ds-] 输入框写不进去,这轮回灌作废");
    return { sent: false, failure: "composer-unwritable" };
  }

  if (await triggerSend(composer)) return { sent: true, failure: null };

  if (readComposer(composer).includes(message)) writeComposer(composer, before);
  return { sent: false, failure: "send-failed" };
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
