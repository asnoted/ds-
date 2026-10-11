/**
 * 回灌链的信封:工具调用与结果在页面世界,隔离世界,background 三处之间怎么走.
 *
 * 页面世界看得到模型的回答但碰不到 `storage` 与扩展 API,background 打中继却看不到页面,
 * 中间隔着隔离世界那一层;三段路各认各的信封,形状不对的一律不猜(返回 null).
 *
 * - `call` / `result` / `ask` / `ask-cleared` / `said` / `stop`:页面世界 ↔ 隔离世界,走
 *   `window.postMessage`(`said` 是页面世界报给协调者的话,`tools` 是隔离世界
 *   广播下来的工具目录,`stop` 是页面世界报"自动续聊到顶,停手了");
 * - `call` 带的是**一轮各块围栏**(一次回答可以排多块);
 * - `send` 请求 / 响应,`said` 上报,`tools` 请求 / 响应:隔离世界 ↔ background,
 *   走 `browser.runtime`;
 * - `action` 请求与执行结果:background ↔ 内容脚本,走 `browser.tabs.sendMessage`,
 *   认不出的信封一声不吭(`actionListener` 返回 undefined),不抢 send 那条路的消息.
 */

import {
  ACTION_ERROR_TAB_GONE,
  ACTION_ERROR_UNKNOWN,
  PageError,
  type ActionFrame,
  type ActionOutcome,
} from "./action";
import { isAccountState, type AccountState } from "./page";
import { actionErrorCodes } from "./fixtures";
import { FAILURE_RELAY_UNREACHABLE, isToolInfo, type ToolInfo } from "./relay";
import { errorPayload, isReplyPayload, type ReplyPayload } from "./reply";

// 载荷校验的真源在 reply.ts(与载荷类型,buildReply 同处);这里转出去,
// 旧调用方(channel 的收信层,测试)照旧从本模块取.
export { isReplyPayload };

/** 页面世界与隔离世界共用的信封标记;认不出这个标记的一概不收. */
export const CHAIN_MESSAGE_SOURCE = "ds-/chain";
/** background 那条路的信封标记. */
export const SEND_MESSAGE_TYPE = "ds-/send";
/** background → 内容脚本的动作信封标记(照 send 的套路,各认各的 type). */
export const ACTION_MESSAGE_TYPE = "ds-/action";
/** 隔离世界 → background 的 said 上报信封标记. */
export const SAID_MESSAGE_TYPE = "ds-/said";
/** 隔离世界 → background 的工具目录请求信封标记. */
export const TOOLS_REQUEST_MESSAGE_TYPE = "ds-/tools";

export type CallMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "call";
  readonly id: string;
  /**
   * 这一轮各块围栏的正文(一段工具调用 JSON 一条),按页面上的顺序.
   * 一次回答可以排多块,所以这里是**数组**;解析归上一层,这里只管运送.
   */
  readonly calls: readonly string[];
};

export type ResultMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "result";
  readonly id: string;
  readonly payload: ReplyPayload;
};

/** 页面世界认出 ```ask 围栏:网页在等人回(#26),不进中继. */
export type AskMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "ask";
  readonly id: string;
  readonly question: string;
};

/** 页面世界看见对话继续了:此前挂着的"等人回"作废(#26). */
export type AskClearedMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "ask-cleared";
  readonly id: string;
};

/**
 * 页面世界报"自动续聊到顶,停手了"(刹车见 `rounds.ts`):报给 background 留一笔
 * (ADR-0004 失败留痕).通知式--不等回话,也不进对话流.
 */
export type StopMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "stop";
  readonly id: string;
  /** 停手原因的码(`continuation.ts` 的 `STOP_*`). */
  readonly cause: string;
};

/**
 * 页面世界报"续聊这一跳失败了"(#51):发不出去,正文换不进去,钥匙不符...
 * 报给 background 落一笔失败痕,悬停时回看得到.通知式,不等回话,不进对话流.
 *
 * `cause` 是**原因短句**(`continuationfail.ts` 产出),不是错误对象:短句里不含
 * 任何正文(ADR-0004),抛错时只含错误类型名.
 */
export type ContinuationFailMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "continuation-fail";
  readonly id: string;
  readonly cause: string;
};

/**
 * 页面世界认出围栏之外的话:报给 background 记进 said(`said_add`).
 * 报不上不碍事--这条只是"让人看见",不是问答回路.
 */
export type SaidMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "said";
  readonly id: string;
  readonly text: string;
};

/** 隔离世界广播下来的工具目录(`tools/list`,喂协议说明用). */
export type ToolsMessage = {
  readonly source: typeof CHAIN_MESSAGE_SOURCE;
  readonly kind: "tools";
  readonly id: string;
  readonly tools: readonly ToolInfo[];
};

export type ChainMessage =
  | CallMessage
  | ResultMessage
  | AskMessage
  | AskClearedMessage
  | SaidMessage
  | ToolsMessage
  | StopMessage
  | ContinuationFailMessage;

export type SendRequest = {
  readonly type: typeof SEND_MESSAGE_TYPE;
  readonly id: string;
  /** 这一轮各块围栏的正文(一段工具调用 JSON 一条),按页面上的顺序. */
  readonly calls: readonly string[];
};

export type SendResponse = {
  readonly id: string;
  readonly payload: ReplyPayload;
};

/** 隔离世界 → background 的 ask 上报信封标记(照 send 的套路,各认各的 type). */
export const ASK_MESSAGE_TYPE = "ds-/ask";
/** 隔离世界 → background 的 ask 清除信封标记. */
export const ASK_CLEARED_MESSAGE_TYPE = "ds-/ask-cleared";

/** 隔离世界 → background 的"续聊到顶停手"上报信封标记. */
export const STOP_MESSAGE_TYPE = "ds-/stop";

/** 隔离世界 → background 的"续聊这一跳失败了"上报信封标记(#51). */
export const CONTINUATION_FAIL_MESSAGE_TYPE = "ds-/continuation-fail";

/**
 * 发送限速的跨世界通报(#61):任一世界替用户发出去一条消息,就通报一声时刻,
 * 另一个世界并进自己的"最近一次发送时刻".
 *
 * 走既有的 `window.postMessage` 通道--**不迁状态,不写 DOM 属性**.带 `world` 是为了
 * 让自己不认自己的通报(`postMessage` 也投递给发送方自己).
 */
export const SEND_NOTE_MESSAGE_SOURCE = "ds-/send-note";

export type SendNoteMessage = {
  readonly source: typeof SEND_NOTE_MESSAGE_SOURCE;
  readonly world: "main" | "isolated";
  /** 那一刻(epoch 毫秒). */
  readonly at: number;
};

/** 认通报:形状不对,时刻不是有限数的一律不收,不猜. */
export function parseSendNote(data: unknown): SendNoteMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { source?: unknown; world?: unknown; at?: unknown };
  if (message.source !== SEND_NOTE_MESSAGE_SOURCE) return null;
  if (message.world !== "main" && message.world !== "isolated") return null;
  if (typeof message.at !== "number" || !Number.isFinite(message.at)) return null;
  return { source: SEND_NOTE_MESSAGE_SOURCE, world: message.world, at: message.at };
}

/** 通报构造(两个世界共用一条构造点). */
export function sendNoteMessage(world: "main" | "isolated", at: number): SendNoteMessage {
  return { source: SEND_NOTE_MESSAGE_SOURCE, world, at };
}

/** 网页排了 ask 围栏问人:记下来,扩展侧露出"在等人回". */
export type AskReport = {
  readonly type: typeof ASK_MESSAGE_TYPE;
  readonly id: string;
  readonly question: string;
  /** 页面会话 id;认不出是 null. */
  readonly page: string | null;
};

/** 对话继续了(人答了或模型自己往下走了):挂着的问题作废. */
export type AskClearedReport = {
  readonly type: typeof ASK_CLEARED_MESSAGE_TYPE;
  readonly id: string;
  readonly page: string | null;
};

/**
 * 续聊到顶停手:页面世界报的,报给 background 留一笔(那一跳只有 background 碰得到
 * 失败留痕).跟 ask 一样带页面会话 id--留痕里说得出是哪条会话停的手.
 */
export type StopReport = {
  readonly type: typeof STOP_MESSAGE_TYPE;
  readonly id: string;
  readonly cause: string;
  readonly page: string | null;
};

/** 隔离世界 → background 的 said 上报:一段说给人听的话. */
export type SaidReport = {
  readonly type: typeof SAID_MESSAGE_TYPE;
  readonly text: string;
};

/**
 * 续聊这一跳失败:页面世界报的,报给 background 落一笔失败痕(#51).
 *
 * 这些失败点都在 MAIN 世界(那里写不了 `storage.local`),沿用与 ask / stop 同款
 * 的上报通道.通知式--不等回话,也不进对话流.
 *
 * **只带原因短句,不带任何正文**(ADR-0004):`cause` 是 `continuationfail.ts` 里
 * 那些常量拼出的话,`sendToPage` 抛错时只含错误类型名.
 */
export type ContinuationFailReport = {
  readonly type: typeof CONTINUATION_FAIL_MESSAGE_TYPE;
  readonly id: string;
  readonly cause: string;
  readonly page: string | null;
};

/** 隔离世界 → background 的工具目录请求(空请求,回话带目录). */
export type ToolsRequest = {
  readonly type: typeof TOOLS_REQUEST_MESSAGE_TYPE;
};

/** background → 隔离世界的工具目录回话;`null` = 这次没取到(沿用上一份). */
export type ToolsResponse = {
  readonly tools: readonly ToolInfo[] | null;
};

/** 隔离世界 → background 的账号处境上报信封标记. */
export const ACCOUNT_REPORT_MESSAGE_TYPE = "ds-/account";

/**
 * 账号处境上报(#2):总开关开着时周期上报.禁言期写路径全断,
 * 悬停得把这层说清("禁言至何时")--上报是通知,不等回话.
 */
export type AccountReport = {
  readonly type: typeof ACCOUNT_REPORT_MESSAGE_TYPE;
  readonly account: AccountState;
};

/** background → 内容脚本的一件动作:动作帧裹一层 `ds-/action`. */
export type ActionRequest = {
  readonly type: typeof ACTION_MESSAGE_TYPE;
  readonly frame: ActionFrame;
};

/**
 * 内容脚本的本地名册:动作名 → 执行器.实现的就往这里加一项--
 * 认不出的动作由收信那层当场回 `unknown-action`.
 */
export type ActionRoster = Readonly<Record<string, (frame: ActionFrame) => unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function callMessage(id: string, calls: readonly string[]): CallMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "call", id, calls };
}

export function resultMessage(id: string, payload: ReplyPayload): ResultMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "result", id, payload };
}

/** 页面世界认出 ask 围栏 → 隔离世界 → background. */
export function askMessage(id: string, question: string): AskMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "ask", id, question };
}

/** 页面世界看见对话继续 → 此前挂着的"等人回"作废. */
export function askClearedMessage(id: string): AskClearedMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "ask-cleared", id };
}

/** 页面世界报"续聊到顶,停手"→ 隔离世界 → background 留痕. */
export function stopMessage(id: string, cause: string): StopMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "stop", id, cause };
}

/** 页面世界报"续聊这一跳失败"→ 隔离世界 → background 落失败痕(#51). */
export function continuationFailMessage(id: string, cause: string): ContinuationFailMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "continuation-fail", id, cause };
}

/** 页面世界认出围栏之外的话 → 隔离世界 → background 记进 said. */
export function saidMessage(id: string, text: string): SaidMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "said", id, text };
}

/** 隔离世界问 background 要来工具目录 → 广播给页面世界. */
export function toolsMessage(id: string, tools: readonly ToolInfo[]): ToolsMessage {
  return { source: CHAIN_MESSAGE_SOURCE, kind: "tools", id, tools };
}

/**
 * 从页面地址里抠出页面会话 id(/a/chat/s/<id> 里那段);认不出返回 null.
 * 只服务于 ask 的分表(每条页面会话各自挂着"等人回").
 */
export function pageSessionIdOf(url: string): string | null {
  const match = /\/a\/chat\/s\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

export function sendRequestMessage(id: string, calls: readonly string[]): SendRequest {
  return { type: SEND_MESSAGE_TYPE, id, calls };
}

export function sendResponseMessage(id: string, payload: ReplyPayload): SendResponse {
  return { id, payload };
}

export function askReportMessage(
  id: string,
  question: string,
  page: string | null = null,
): AskReport {
  return { type: ASK_MESSAGE_TYPE, id, question, page };
}

export function askClearedReportMessage(id: string, page: string | null = null): AskClearedReport {
  return { type: ASK_CLEARED_MESSAGE_TYPE, id, page };
}

export function saidReportMessage(text: string): SaidReport {
  return { type: SAID_MESSAGE_TYPE, text };
}

export function stopReportMessage(
  id: string,
  cause: string,
  page: string | null = null,
): StopReport {
  return { type: STOP_MESSAGE_TYPE, id, cause, page };
}

/** 页面世界报"续聊这一跳失败"→ 隔离世界 → background 落失败痕(#51). */
export function continuationFailReportMessage(
  id: string,
  cause: string,
  page: string | null = null,
): ContinuationFailReport {
  return { type: CONTINUATION_FAIL_MESSAGE_TYPE, id, cause, page };
}

export function toolsRequestMessage(): ToolsRequest {
  return { type: TOOLS_REQUEST_MESSAGE_TYPE };
}

export function toolsResponseMessage(tools: readonly ToolInfo[] | null): ToolsResponse {
  return { tools };
}

export function accountReportMessage(account: AccountState): AccountReport {
  return { type: ACCOUNT_REPORT_MESSAGE_TYPE, account };
}

function isValidId(id: unknown): id is string {
  return typeof id === "string" && id !== "";
}

function isValidText(text: unknown): text is string {
  return typeof text === "string" && text.trim() !== "";
}

/** 一轮各块围栏的正文:非空数组,每一条都是非空文本(形都不对就整个作废). */
function isValidCalls(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidText);
}

/**
 * 信封里的页面会话 id:缺省是 null;非空字符串以外的一律作废
 *(空串,数值都不收)--ask 两条上报共用的判据.
 */
function pageSessionOf(data: Record<string, unknown>): string | null | undefined {
  const raw = data["page"];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && raw !== "") return raw;
  return undefined;
}

/** 认页面世界 ↔ 隔离世界的信封:标记,字段,载荷都对上才收. */
export function parseChainMessage(data: unknown): ChainMessage | null {
  if (!isPlainObject(data)) return null;
  if (data["source"] !== CHAIN_MESSAGE_SOURCE) return null;
  const id = data["id"];
  if (!isValidId(id)) return null;

  if (data["kind"] === "call") {
    const calls = data["calls"];
    if (!isValidCalls(calls)) return null;
    return callMessage(id, calls);
  }
  if (data["kind"] === "result") {
    const payload = data["payload"];
    if (!isReplyPayload(payload)) return null;
    return resultMessage(id, payload);
  }
  if (data["kind"] === "ask") {
    const question = data["question"];
    if (!isValidText(question)) return null;
    return askMessage(id, question);
  }
  if (data["kind"] === "ask-cleared") {
    return askClearedMessage(id);
  }
  if (data["kind"] === "stop") {
    const cause = data["cause"];
    if (!isValidText(cause)) return null;
    return stopMessage(id, cause);
  }
  if (data["kind"] === "continuation-fail") {
    const cause = data["cause"];
    if (!isValidText(cause)) return null;
    return continuationFailMessage(id, cause);
  }
  if (data["kind"] === "said") {
    const text = data["text"];
    if (!isValidText(text)) return null;
    return saidMessage(id, text);
  }
  if (data["kind"] === "tools") {
    const tools = data["tools"];
    if (!Array.isArray(tools) || !tools.every(isToolInfo)) return null;
    return toolsMessage(id, tools);
  }
  return null;
}

/** 认隔离世界 → background 的请求. */
export function parseSendRequest(data: unknown): SendRequest | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== SEND_MESSAGE_TYPE) return null;
  const id = data["id"];
  const calls = data["calls"];
  if (!isValidId(id) || !isValidCalls(calls)) return null;
  return sendRequestMessage(id, calls);
}

/** 认隔离世界 → background 的 ask 上报(#26). */
export function parseAskReport(data: unknown): AskReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== ASK_MESSAGE_TYPE) return null;
  const id = data["id"];
  const question = data["question"];
  if (!isValidId(id) || !isValidText(question)) return null;
  const page = pageSessionOf(data);
  if (page === undefined) return null;
  return askReportMessage(id, question, page);
}

/** 认隔离世界 → background 的 ask 清除(#26). */
export function parseAskClearedReport(data: unknown): AskClearedReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== ASK_CLEARED_MESSAGE_TYPE) return null;
  const id = data["id"];
  if (!isValidId(id)) return null;
  const page = pageSessionOf(data);
  if (page === undefined) return null;
  return askClearedReportMessage(id, page);
}

/** 认隔离世界 → background 的"续聊停手"上报(#26 同款:通知式,带页面会话 id). */
export function parseStopReport(data: unknown): StopReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== STOP_MESSAGE_TYPE) return null;
  const id = data["id"];
  const cause = data["cause"];
  if (!isValidId(id) || !isValidText(cause)) return null;
  const page = pageSessionOf(data);
  if (page === undefined) return null;
  return stopReportMessage(id, cause, page);
}

/** 认隔离世界 → background 的"续聊失败"上报(#51,同款). */
export function parseContinuationFailReport(data: unknown): ContinuationFailReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== CONTINUATION_FAIL_MESSAGE_TYPE) return null;
  const id = data["id"];
  const cause = data["cause"];
  if (!isValidId(id) || !isValidText(cause)) return null;
  const page = pageSessionOf(data);
  if (page === undefined) return null;
  return continuationFailReportMessage(id, cause, page);
}

/** 认隔离世界 → background 的 said 上报:一段非空文本. */
export function parseSaidReport(data: unknown): SaidReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== SAID_MESSAGE_TYPE) return null;
  const text = data["text"];
  if (!isValidText(text)) return null;
  return saidReportMessage(text);
}

/** 认隔离世界 → background 的工具目录请求(空请求,只认标记). */
export function parseToolsRequest(data: unknown): ToolsRequest | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== TOOLS_REQUEST_MESSAGE_TYPE) return null;
  return toolsRequestMessage();
}

/** 认 background → 隔离世界的工具目录回话;`tools` 是数组或 null. */
export function parseToolsResponse(data: unknown): ToolsResponse | null {
  if (!isPlainObject(data)) return null;
  const tools = data["tools"];
  if (tools === null) return toolsResponseMessage(null);
  if (!Array.isArray(tools) || !tools.every(isToolInfo)) return null;
  return toolsResponseMessage(tools);
}

/** 认账号处境上报:account 过一遍 `isAccountState` 再收,认不出就 null. */
export function parseAccountReport(data: unknown): AccountReport | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== ACCOUNT_REPORT_MESSAGE_TYPE) return null;
  const account = data["account"];
  if (!isAccountState(account)) return null;
  return accountReportMessage(account);
}

/** 认隔离世界 → background 的响应;响应丢了按中继没响应兜底交给调用方. */
export function parseSendResponse(data: unknown): SendResponse | null {
  if (!isPlainObject(data)) return null;
  const id = data["id"];
  const payload = data["payload"];
  if (!isValidId(id) || !isReplyPayload(payload)) return null;
  return sendResponseMessage(id, payload);
}

/** background → 内容脚本:一件动作裹一层信封(照 send 的套路,各认各的 type). */
export function actionRequestMessage(frame: ActionFrame): ActionRequest {
  return { type: ACTION_MESSAGE_TYPE, frame };
}

/**
 * 认动作信封:type 对得上,帧的字段都合线协议才收.
 * id / action 必须非空字符串,target 是字符串或 null,params 是对象(缺省当空,
 * 与 dsb 的 `parse_action_request` 一个脾气)--认不出就 null,收信那层因此不响应.
 */
export function parseActionRequest(data: unknown): ActionRequest | null {
  if (!isPlainObject(data)) return null;
  if (data["type"] !== ACTION_MESSAGE_TYPE) return null;
  const value = data["frame"];
  if (!isPlainObject(value)) return null;
  if (value["type"] !== "action") return null;
  const id = value["id"];
  const action = value["action"];
  if (!isValidId(id) || !isValidId(action)) return null;
  const target = value["target"];
  if (target !== null && typeof target !== "string") return null;
  const params = value["params"] ?? {};
  if (!isPlainObject(params)) return null;
  return actionRequestMessage({ type: "action", id, action, params, target });
}

/**
 * 内容脚本收动作:认得出的动作帧当场回一个 `ActionOutcome`(同步返回 `true` 保住
 * sendResponse 的通道,结果异步交回),认不出的消息返回 `undefined` 一声不吭--
 * send 那条路的信封也在这条 runtime 通道上,不能抢.
 *
 * 执行器在本地名册里查:没有就当场回 `unknown-action`.
 */
export function actionListener(
  roster: ActionRoster,
): (
  message: unknown,
  sender: unknown,
  sendResponse: (outcome: ActionOutcome) => void,
) => true | undefined {
  return (message, _sender, sendResponse) => {
    const request = parseActionRequest(message);
    if (request === null) return undefined;
    // 执行器抛错也要回话:只挂 onFulfilled,一旦 handler reject,sendResponse 永不调用,
    // port 一直挂着直到被 GC,background 那边又变回等满 timeout.
    void executeRoster(request.frame, roster).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: failureCode(error) }),
    );
    return true;
  };
}

/**
 * 执行器抛的错 → 一个在册失败码.`PageError` 自带码;其余一律折成 `tab-gone`
 * (含没接执行口,载荷不合形状那些"这一跳走不通"的情形).
 * 抛错的原文只留在扩展侧日志里,不回页面,不进对话流.
 */
function failureCode(error: unknown): string {
  // 码得在册里才认:执行器自己编一个码出来照样折成 tab-gone,别让册子外的词漏到线上.
  if (error instanceof PageError && actionErrorCodes().includes(error.code)) {
    console.warn("[ds] 动作做不到:", error.code, error.message);
    return error.code;
  }
  console.warn("[ds] 动作这一跳走不通:", error);
  return ACTION_ERROR_TAB_GONE;
}

async function executeRoster(frame: ActionFrame, roster: ActionRoster): Promise<ActionOutcome> {
  // hasOwn 而不是下标直取:名册是普通对象,`"toString"` 这种键会捞到原型上的东西.
  const handler = Object.prototype.hasOwnProperty.call(roster, frame.action)
    ? roster[frame.action]
    : undefined;
  if (handler === undefined) return { ok: false, error: ACTION_ERROR_UNKNOWN };
  return { ok: true, result: await handler(frame) };
}

/** background 没答上来时的兜底载荷:中继没有响应(同样不进对话流). */
export function unreachableResult(id: string): ResultMessage {
  return resultMessage(id, errorPayload(FAILURE_RELAY_UNREACHABLE));
}
