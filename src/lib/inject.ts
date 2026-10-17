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
 * 认得出的出站请求体形状,一次识别给出四种用法:待发文本 / 替换正文 / 遍历所有
 * 用户文本 / 形状是否认得出(#4 的 adapter).
 *
 * 钥匙比对(`pendingText` → `armed.ts` 的 `matchesMarker`)、协议说明拼接
 * (`rewriteOutgoingBody` 的 `mapAllUserTexts`)、正文替换(`replacePending`)
 * 共用这一次解析与这一条形状规则--站点换出站载荷形状时只改这里,不会再出现
 * 「钥匙认得出、替换认不出」的半通状态.
 *
 * 形状两条(与 ADR-0005 的替换口径一致):`prompt` 是字符串(站点原生只带这一条
 * 新消息),或 `messages` 是数组(整段历史一起带).**两条都不在 → `shapeOk:false`,
 * 其余三种用法全部落空**.
 */
export type OutgoingShape = {
  /** 形状认不认得出;认不出时下面三用全部落空. */
  readonly shapeOk: boolean;
  /** 用法一:待发那条用户消息的正文(钥匙比对用);取不出 → null. */
  readonly pendingText: string | null;
  /** 用法二:把待发那条换成 `text`,返回新请求体;认不出或没有待发的槽位 → null. */
  readonly replacePending: (text: string) => string | null;
  /** 用法三:对每条用户文本各映一次;形状认不出或没有一处改动 → null. */
  readonly mapAllUserTexts: (map: (text: string) => string | null) => string | null;
};

/** 待发那条的槽位:`prompt` 非空白字符串,否则 `messages` 里最后一条 user 的 `content`. */
type PendingSlot =
  { readonly kind: "prompt" } | { readonly kind: "messages"; readonly index: number };

function locatePending(root: Record<string, unknown>): PendingSlot | null {
  const prompt = root["prompt"];
  if (typeof prompt === "string" && prompt.trim() !== "") return { kind: "prompt" };
  const { messages } = root;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (!isPlainObject(entry)) continue;
      if (entry["role"] !== "user" || typeof entry["content"] !== "string") continue;
      return { kind: "messages", index };
    }
  }
  return null;
}

export function recognizeOutgoingShape(bodyText: string): OutgoingShape {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = undefined;
  }
  const root = isPlainObject(payload) ? payload : null;
  const shapeOk =
    root !== null && (typeof root["prompt"] === "string" || Array.isArray(root["messages"]));
  const empty: OutgoingShape = {
    shapeOk,
    pendingText: null,
    replacePending: () => null,
    mapAllUserTexts: () => null,
  };
  if (root === null || !shapeOk) return empty;

  const slot = locatePending(root);
  const pendingText =
    slot === null
      ? null
      : slot.kind === "prompt"
        ? (root["prompt"] as string)
        : (((root["messages"] as Record<string, unknown>[])[slot.index] as Record<string, unknown>)[
            "content"
          ] as string);
  return {
    shapeOk,
    pendingText,
    replacePending: (text: string) => {
      const slot = locatePending(root);
      if (slot === null) return null;
      const next = structuredClone(payload) as Record<string, unknown>;
      if (slot.kind === "prompt") next["prompt"] = text;
      else
        ((next["messages"] as Record<string, unknown>[])[slot.index] as Record<string, unknown>)[
          "content"
        ] = text;
      return JSON.stringify(next);
    },
    mapAllUserTexts: (map: (text: string) => string | null) => {
      const next = structuredClone(payload) as Record<string, unknown>;
      let changed = false;
      if (typeof next["prompt"] === "string") {
        const mapped = map(next["prompt"]);
        if (mapped !== null) {
          next["prompt"] = mapped;
          changed = true;
        }
      }
      if (Array.isArray(next["messages"])) {
        for (const entry of next["messages"] as Record<string, unknown>[]) {
          if (!isPlainObject(entry)) continue;
          if (entry["role"] !== "user" || typeof entry["content"] !== "string") continue;
          const mapped = map(entry["content"]);
          if (mapped !== null) {
            entry["content"] = mapped;
            changed = true;
          }
        }
      }
      return changed ? JSON.stringify(next) : null;
    },
  };
}

/**
 * 拼一次协议说明:对**已经认过的**出站形状,把说明拼在每条用户消息开头
 * (`mapAllUserTexts` 那一用);`prompt` 与 `messages` 两条形状里 `role: "user"`
 * 的内容都会带上,其余角色不动.
 *
 * 工具目录(隔离世界广播下来的 `tools/list`)喂进协议说明;
 * null = 还没取到,说明里会写"先别排围栏".
 *
 * 形状只认一次:接线侧把 `recognizeOutgoingShape` 的结果同时交给认领裁决与这里,
 * 同一条请求不再解析第二遍(#103).
 */
export function rewriteOutgoingBody(
  shape: OutgoingShape,
  tools: readonly ToolInfo[] | null,
): string | null {
  return shape.mapAllUserTexts((text) => prependOnce(text, tools));
}
