/**
 * 回灌组装与失败提示(agent → 页面的线协议).
 *
 * 回灌消息首行固定 `agent:`(首行锚),其后是 TOON 载荷;
 * 载荷只有两个同构分支:status: ok + answer,status: error + error.
 * 失败提示只出现在扩展侧,不进对话流.
 */

import { decode, encode } from "@toon-format/toon";

/** 回灌消息的首行锚. */
export const REPLY_ANCHOR = "agent:";

/**
 * 这段文本是不是一条回灌消息:第一行就是首行锚.
 * 回灌要当真实用户消息发出去,协议说明不能插到它前面--首行锚必须留在第一行.
 */
export function hasReplyAnchor(text: string): boolean {
  return text.split("\n")[0] === REPLY_ANCHOR;
}

/** 工具栏图标点击后给出的启动命令. */
export const RELAY_START_COMMAND = "uv run dsb";

export type OkPayload = { readonly status: "ok"; readonly answer: string };
export type ErrorPayload = { readonly status: "error"; readonly error: string };
export type ReplyPayload = OkPayload | ErrorPayload;

export function okPayload(answer: string): OkPayload {
  return { status: "ok", answer };
}

export function errorPayload(code: string): ErrorPayload {
  return { status: "error", error: code };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 载荷必须是 status + answer/error 的同构形状,认不出的整个作废.
 * (这是**内存里的载荷**形状;线上的 TOON 正文由 `parseReplyPayload` 解.)
 */
export function isReplyPayload(value: unknown): value is ReplyPayload {
  if (!isPlainObject(value)) return false;
  if (value["status"] === "ok") return typeof value["answer"] === "string";
  if (value["status"] === "error") return typeof value["error"] === "string";
  return false;
}

/**
 * 组装一条回灌消息:首行锚 + TOON 载荷(TOON 编码只发生在这里).
 *
 * 多行正文走 TOON 的 tabular form(SPEC §9.3)--一行正文一条 row:
 *
 *     agent:
 *     status: ok
 *     answer[2]{text}:
 *       第一行
 *       第二行
 *
 * 不能编码成裸字符串:SPEC §7.1 规定字符串里的 LF MUST 转义成 `\n`,而解码方是
 * 网页上的 LLM,不是解析器,实测它不会还原(真机:回灌里满屏字面 `\n`,内容没错
 * 但格式全毁).tabular 让换行等于物理行,转义无从发生;SPEC §7.2 的加引号规则
 * 再把会冒充结构的正文行(`agent:`,`status: ...`,`answer[N]: ...`,`- ...`,`# ...`)
 * 封起来,所以正文里没有歧义边界.
 */
export function buildReply(payload: ReplyPayload): string {
  if (payload.status === "ok") {
    const answer = payload.answer.split("\n").map((text) => ({ text }));
    return `${REPLY_ANCHOR}\n${encode({ status: "ok", answer })}`;
  }
  return `${REPLY_ANCHOR}\n${encode(payload)}`;
}

/**
 * 一条回灌消息 → 载荷:`buildReply` 的逆.
 *
 * 给本地工具用--组合(`send.page`)把页面模型的回灌**再交回去**时,得先把
 * TOON 解回成正文(不然会被 `buildReply` 再编码一层,模型看到嵌套结构).
 *
 * 认不出(首行不是锚,TOON 解不开,形状不对)一律 null,不猜:坏输入宁可
 * 当"回灌不认得",也不把半截结构喂给模型.
 */
export function parseReplyPayload(text: string): ReplyPayload | null {
  const newline = text.indexOf("\n");
  const anchor = newline === -1 ? text : text.slice(0, newline);
  if (anchor !== REPLY_ANCHOR) return null;
  const body = newline === -1 ? "" : text.slice(newline + 1);
  let parsed: unknown;
  try {
    parsed = decode(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed["status"] === "ok") {
    // ok 载荷的正文在线上一行一条(`answer[N]{text}:`),解回来拼成整段.
    const rows = parsed["answer"];
    if (!Array.isArray(rows)) return null;
    const lines: string[] = [];
    for (const row of rows) {
      if (!isPlainObject(row) || typeof row["text"] !== "string") return null;
      lines.push(row["text"]);
    }
    return okPayload(lines.join("\n"));
  }
  if (parsed["status"] === "error" && typeof parsed["error"] === "string") {
    return errorPayload(parsed["error"]);
  }
  return null;
}

/**
 * 失败不进对话流:只有 status: ok 的载荷才会往下走(组续聊正文).
 * 写成类型收窄,调用方拿到的直接是 `OkPayload`,不必自己再判一次 status.
 */
export function isInjectableReply(payload: ReplyPayload): payload is OkPayload {
  return payload.status === "ok";
}

/**
 * 扩展侧失败提示能显示的原因;只有两类--连不上,响应认不出
 * (JSON-RPC 的 error 与工具自己的报错都进对话流,不在这里).
 */
export type FailureKind = "relay-unreachable" | "unexpected-response";

export type FailureNotice = {
  /** 工具栏图标的悬停标题. */
  readonly title: string;
  /** 悬停给出的原因. */
  readonly reason: string;
  /** 点击图标后给出的启动命令. */
  readonly command: string;
};

const NOTICES: Record<FailureKind, FailureNotice> = {
  "relay-unreachable": {
    title: "中继不可达",
    reason: "本机中继 dsb 没有响应.",
    command: RELAY_START_COMMAND,
  },
  "unexpected-response": {
    title: "中继响应异常",
    reason: "中继返回了无法识别的响应.",
    command: RELAY_START_COMMAND,
  },
};

export function isKnownFailureKind(kind: string): kind is FailureKind {
  return Object.hasOwn(NOTICES, kind);
}

/** 扩展侧失败提示:没问成时扩展自己给出的提示,不进对话流. */
export function failureNotice(kind: string): FailureNotice {
  if (isKnownFailureKind(kind)) return NOTICES[kind];
  return {
    title: "中继不可达",
    reason: `无法识别的原因(${kind})`,
    command: RELAY_START_COMMAND,
  };
}
