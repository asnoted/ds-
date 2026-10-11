/**
 * 中继的调用契约(MCP 版,ADR-0011):`POST /mcp`,JSON-RPC 2.0,无会话,无流.
 *
 * dsb 被动到底:探活是 `ping`,干活是 `tools/call`,别的方法一概没有--`/send`
 * `/health` `/status` 那批 HTTP 路随问答后端一起废了.端点与请求体在这儿定死
 * (扩展没有输入面,端口只认 dsb 的默认值);响应 → 载荷的映射是纯函数,网络层
 * 的失败由调用方折成同样的载荷形状,解析只有一条路径.
 *
 * 载荷的口径分两半:**中继有回话就是 ok**--JSON-RPC 的 error 也是给模型看的正文
 * (它得知道自己哪一步没成);只有连不上,响应认不出才是 `error` 载荷,那种不进
 * 对话流(`isInjectableReply` 挡着),图标翻红,留痕补一笔.
 */

import { errorPayload, okPayload, type ReplyPayload } from "./reply";

/** 中继是本机服务,端口走 dsb 的默认值 `DSB_PORT`(扩展无输入面,改不了). */
export const RELAY_ORIGIN = "http://127.0.0.1:8787";
/** 唯一端点:JSON-RPC 从这儿进,别处一律 404(一条 CORS 头都没有). */
export const MCP_PATH = "/mcp";

export function relayMcpUrl(): string {
  return `${RELAY_ORIGIN}${MCP_PATH}`;
}

/**
 * 一次 `tools/call` 的扩展侧兜底超时:dsb 侧等子进程的上限是 `DSB_TOOL_TIMEOUT`
 * (默认 120s,见 `dsb/gateway.py`),这里宽一个 HTTP 往返的量级--先到的必须是
 * 中继:扩展先 abort 报出来的只有没信息量的"中继不可达",还会白扔一次正在跑的
 * 调用.dsb 没挂时它自己会回 `tool-timeout`,那是有信息量的码.
 */
export const MCP_CALL_TIMEOUT_MS = 130_000;
/** 探活(`ping`)只问在不在,快点回来. */
export const MCP_PING_TIMEOUT_MS = 5_000;
/** `tools/list`(工具表,喂给协议说明)同样只要个"在不在 + 表在不在". */
export const MCP_LIST_TIMEOUT_MS = 10_000;

/** 网络层失败(没起,被拦,超时)折成的载荷:中继没有响应. */
export const FAILURE_RELAY_UNREACHABLE = "relay-unreachable";
/** 非 2xx,认不出的响应体:中继响应异常. */
export const FAILURE_UNEXPECTED_RESPONSE = "unexpected-response";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* 请求体                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 一条 JSON-RPC 请求体.`id` 必须与响应对上(对不上按认不出处理)--
 * 多条请求各排各的号,靠它把回话领回自己手上.
 */
export function mcpBody(id: string, method: string, params?: Record<string, unknown>): string {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message["params"] = params;
  return JSON.stringify(message);
}

export function pingBody(id: string): string {
  return mcpBody(id, "ping");
}

export function listToolsBody(id: string): string {
  return mcpBody(id, "tools/list");
}

export function callToolBody(id: string, name: string, args: Record<string, unknown>): string {
  return mcpBody(id, "tools/call", { name, arguments: args });
}

/* -------------------------------------------------------------------------- */
/* 围栏里的工具调用                                                           */
/* -------------------------------------------------------------------------- */

// 工具调用的形状解析住在围栏域(`./fence`,读 DOM 的那半边也要用);这里转出去,
// 中继这条线的调用方照旧从 `./relay` 取.
export { MALFORMED_CALL_HINT, parseToolCall, type ToolCall } from "./fence";

/* -------------------------------------------------------------------------- */
/* 一轮多块:上限与结果拼装                                                    */
/* -------------------------------------------------------------------------- */

/** 一轮里最多执行几块围栏:排再多也不一轮做完,剩下的下一轮再排. */
export const MAX_CALLS_PER_ROUND = 8;

/** 一轮里某一块的结果:哪件工具,正文是什么. */
export type ToolAnswer = {
  readonly tool: string;
  readonly text: string;
};

/**
 * 一轮里各块围栏的结果 → 一段给模型的正文.
 *
 * 一块就一个工具时**原样交**(工具的正文不该被我们加的头尾污染);多块才给每块
 * 加上"工具 <名字>:"这一行--不然模型分不出哪段是谁说的.
 */
export function joinCallAnswers(answers: readonly ToolAnswer[]): string {
  if (answers.length <= 1) return answers[0]?.text ?? "";
  return answers.map(({ tool, text }) => `工具 ${tool}:\n${text}`).join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* 响应 → 载荷                                                                */
/* -------------------------------------------------------------------------- */

/** 回话对没对上号:id 必须与发出的请求一致,否则这条回话不认. */
function isMatchingReply(parsed: Record<string, unknown>, id: string): boolean {
  return parsed["jsonrpc"] === "2.0" && parsed["id"] === id;
}

/** JSON-RPC 的 error → 一句进对话的正文:码在前(好 grep),消息在后(模型读). */
function rpcErrorText(error: Record<string, unknown>): string | null {
  const message = error["message"];
  if (typeof message !== "string" || message.trim() === "") return null;
  const code = error["code"];
  return typeof code === "number" ? `${code}: ${message}` : message;
}

/**
 * `tools/call` 的结果 → 给模型看的一段正文:文本块依次拼上;一个文本块都没有
 * 就把整个结果交成 JSON--**不猜,不丢**(与 `dsb/gateway.py` 的 `text_of_result`
 * 同一口径).`isError` 不改判载荷:失败也是正文,模型看得到才接得着往下答.
 */
function resultText(result: unknown): string {
  if (isPlainObject(result)) {
    const content = result["content"];
    if (Array.isArray(content)) {
      const texts = content
        .filter((block): block is Record<string, unknown> => isPlainObject(block))
        .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
        .map((block) => block["text"] as string)
        .filter((text) => text !== "");
      if (texts.length > 0) return texts.join("\n\n");
    }
    return JSON.stringify(result);
  }
  return String(result);
}

/**
 * 中继的响应 → 回灌载荷:2xx + 对得上号的 JSON-RPC 回话(result 或 error)都算
 * "有回话"= ok;非 2xx,认不出的响应体落 `unexpected-response`(不进对话流).
 */
export function parseMcpResponse(status: number, bodyText: string, id: string): ReplyPayload {
  if (status < 200 || status >= 300) return errorPayload(FAILURE_UNEXPECTED_RESPONSE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorPayload(FAILURE_UNEXPECTED_RESPONSE);
  }
  if (!isPlainObject(parsed) || !isMatchingReply(parsed, id)) {
    return errorPayload(FAILURE_UNEXPECTED_RESPONSE);
  }

  const error = parsed["error"];
  if (isPlainObject(error)) {
    const text = rpcErrorText(error);
    return text === null ? errorPayload(FAILURE_UNEXPECTED_RESPONSE) : okPayload(text);
  }
  if ("result" in parsed) return okPayload(resultText(parsed["result"]));
  return errorPayload(FAILURE_UNEXPECTED_RESPONSE);
}

/** 探活:2xx 且回话对得上号就算可达;其余一律不可达(答不上来就不信). */
export function parseMcpPing(status: number, bodyText: string, id: string): boolean {
  if (status < 200 || status >= 300) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return isPlainObject(parsed) && isMatchingReply(parsed, id) && "result" in parsed;
}

/* -------------------------------------------------------------------------- */
/* 工具表(协议说明里的目录)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 一件工具的目录行:给协议说明拼进去的紧凑形态.
 *
 * `params` 是**格式化好**的参数名串(必带原名,可选带 `?` 后缀)--目录是拼给
 * 模型读的文本,schema 全文塞进每条用户消息太贵,这里就地压成一行.
 */
export type ToolInfo = {
  readonly name: string;
  readonly description: string;
  readonly params: readonly string[];
};

/** 入参 schema → "参数名 / 参数名? ..."那几样;认不出就当没有参数. */
function paramsOf(schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const properties = schema["properties"];
  if (!isPlainObject(properties)) return [];
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  return Object.keys(properties).map((name) => (required.includes(name) ? name : `${name}?`));
}

export function isToolInfo(value: unknown): value is ToolInfo {
  if (!isPlainObject(value)) return false;
  const { name, description, params } = value;
  return (
    typeof name === "string" &&
    name !== "" &&
    typeof description === "string" &&
    Array.isArray(params) &&
    params.every((param) => typeof param === "string")
  );
}

/** `tools/list` 的响应 → 目录;认不出返回 null(调用方继续用上一份,不拿坏数据换). */
export function parseToolsList(status: number, bodyText: string, id: string): ToolInfo[] | null {
  if (status < 200 || status >= 300) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isMatchingReply(parsed, id)) return null;
  const tools = parsed["result"];
  if (!isPlainObject(tools) || !Array.isArray(tools["tools"])) return null;

  const out: ToolInfo[] = [];
  for (const entry of tools["tools"]) {
    if (!isPlainObject(entry)) return null;
    const name = entry["name"];
    if (typeof name !== "string" || name === "") return null;
    const description = typeof entry["description"] === "string" ? entry["description"] : "";
    out.push({ name, description, params: paramsOf(entry["inputSchema"]) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 失败的措辞(进悬停与日志,不进对话流)                                     */
/* -------------------------------------------------------------------------- */

/**
 * 网络层的异常 → 一句能进日志,能上悬停的话.
 *
 * `fetch` 抛出来的东西分两种:自己掐表的 `AbortError`("5 秒没回"是**有信息量**的,
 * 中继活着但卡住了)和 `TypeError`(连都没连上).两者排查方向相反,别都折成一个
 * "失败"了事--之前就是这么吞掉的,结果翻红之后没人说得出为什么.
 */
export function describeFetchFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `超时(${timeoutMs}ms 没回)`;
  }
  return "连接失败";
}

/**
 * 响应到了,但读不出体面的回话 → 一句话.
 *
 * 状态码能报就报码;2xx 却解析不出来,说明中继答了个看不懂的东西,这时正文规模是
 * 唯一有用的事实(几十个字和空响应不是一回事),**不记正文本身**.
 */
export function describeBadResponse(status: number, bodyText: string): string {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  return `响应读不出来(${bodyText.length} 字)`;
}
