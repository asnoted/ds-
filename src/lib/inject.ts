/**
 * 协议说明注入:改写"即将发送"的那条请求体,把协议说明拼在每条用户消息开头
 *(扩展改写你发出的消息来实现注入,工具目录随说明现拼).
 *
 * 判断全在这儿,接线(把 `fetch` / `XHR` 包一层)只负责把请求体原文交进来,
 * 把返回值塞回去.返回 null 一律表示"原样放行":不是能认的载荷,
 * 或者这条载荷里没有需要拼的用户消息--拿不准就别改,页面照常发.
 *
 * 注意这里不是站点闸:站点范围由 manifest 权限钉死,总开关也不参与站点判定.
 */

import { INSTRUCTIONS_HEADER, prependInstructions } from "./instructions";
import { hasReplyAnchor } from "./reply";
import type { ToolInfo } from "./relay";

/** 只认"发消息"那条出站:chat 的 completion / completions / regenerate. */
const CHAT_SEND_PATH = /\/(?:api\/)?v\d+\/chat\/(?:completion|completions|regenerate)(?:[/?#]|$)/;

/** 注入点跑在站点页面上,相对地址按站点自己算;跨域一律只认 deepseek 自己的域名. */
const SITE_ORIGIN = "https://chat.deepseek.com";

function hostnameOf(url: string): string | null {
  try {
    return new URL(url, SITE_ORIGIN).hostname;
  } catch {
    return null;
  }
}

/**
 * 这条请求是不是"发消息"的出口:POST + chat 发送路径 + deepseek 自己的域名.
 * 三个条件缺一不可,其余请求(建会话,取历史,头像上传...)一概不碰.
 */
export function isOutgoingChatRequest(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  if (!CHAT_SEND_PATH.test(url)) return false;
  const hostname = hostnameOf(url);
  if (hostname === null) return false;
  return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 拼一次:空消息没东西可发,也不该替用户凭空造一条,原样放行;
 * 回灌消息(首行就是 `agent:` 首行锚)原样放行,协议说明不能插到首行锚前面;
 * 已经拼过的(历史里带回来的用户消息)不再拼第二遍--说明随工具目录会变,
 * 防重注只认稳定首行.
 */
function prependOnce(text: string, tools: readonly ToolInfo[] | null): string | null {
  if (text.trim() === "") return null;
  if (hasReplyAnchor(text)) return null;
  if (text.startsWith(INSTRUCTIONS_HEADER)) return null;
  return prependInstructions(text, tools);
}

/**
 * 改写一段即将发送的请求体.认得出的载荷有两条形状:
 * `prompt`(站点原生的发消息接口只带这一条新消息)与 `messages`(整段历史一起带的形状).
 * 两条形状里 `role: "user"` 的内容都会带上协议说明,其余角色不动.
 *
 * 工具目录(隔离世界广播下来的 `tools/list`)喂进协议说明;
 * null = 还没取到,说明里会写"先别排围栏".
 */
/**
 * 续聊那一趟的改写:把这条出站请求的正文**换成**工具结果
 * (组装见 `continuation.ts` 的 `buildContinuation`).
 *
 * 为什么替换而不是再发一条消息:对话里那条消息是扩展自己发的,正文还是整段 TOON,
 * 一轮一条--机器痕迹与"用户消息条数"都堆在这儿.替换之后可见的只有一个短标记.
 *
 * 认得出的形状两条:`prompt`(站点原生发消息只带这一条新消息)与 `messages`
 * (整段历史一起带的形状,换最后一条 user).**认不出返回 null**,调用方据此把
 * 挂起的续聊作废--宁可少一轮,也不要把用户下一条真消息吃掉.
 */
export function rewriteContinuationBody(bodyText: string, continuation: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(payload)) return null;

  if (typeof payload["prompt"] === "string" && payload["prompt"].trim() !== "") {
    payload["prompt"] = continuation;
    return JSON.stringify(payload);
  }

  const { messages } = payload;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (!isPlainObject(entry)) continue;
      if (entry["role"] !== "user" || typeof entry["content"] !== "string") continue;
      entry["content"] = continuation;
      return JSON.stringify(payload);
    }
  }

  return null;
}

export function rewriteOutgoingBody(
  bodyText: string,
  tools: readonly ToolInfo[] | null,
): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(payload)) return null;

  let changed = false;

  if (typeof payload.prompt === "string") {
    const next = prependOnce(payload.prompt, tools);
    if (next !== null) {
      payload.prompt = next;
      changed = true;
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const entry of payload.messages) {
      if (!isPlainObject(entry)) continue;
      if (entry.role !== "user" || typeof entry.content !== "string") continue;
      const next = prependOnce(entry.content, tools);
      if (next !== null) {
        entry.content = next;
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(payload) : null;
}
