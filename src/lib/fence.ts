/**
 * 围栏解析:从模型输出里认出协议围栏,取出围栏正文.
 * 页面 → 扩展的线协议是 ```send(一段工具调用 JSON);页面向人举手是
 * ```ask(#26)--认出但不转给中继,见 `inject.content.ts`.
 *
 * 规则:普通代码块与非协议围栏一律不认;正文可多行,用单独一行 ``` 结束.
 * **一次回答可以排多块**:`parseSendFences` 按顺序全取(执行那一侧用),
 * `parseSendFence` 只取第一块("有没有排围栏"这类判据用,如 `wait.fence`).
 */

const SEND_OPENING = "```send";
const ASK_OPENING = "```ask";
const CLOSING = "```";

/** 一行是不是某种围栏的起始行:```<opening> 后面只能是行尾或空白,```sendfoo 不算. */
function isOpeningLine(line: string, opening: string): boolean {
  if (!line.startsWith(opening)) return false;
  const rest = line.slice(opening.length);
  return rest === "" || /^\s/.test(rest);
}

/**
 * 找出**所有**指定围栏的正文,按出现顺序.
 *
 * 没闭合的那一块(以及排空了的那一块)丢掉,**继续往后找**:不猜半截,
 * 但不因为它放弃后面那些好的.
 */
function parseFences(text: string, opening: string): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isOpeningLine(line, opening)) {
      index += 1;
      continue;
    }

    const rest = line.slice(opening.length).trim();
    const body: string[] = rest === "" ? [] : [rest];
    let cursor = index + 1;
    let closed = false;
    for (; cursor < lines.length; cursor += 1) {
      if ((lines[cursor] ?? "").trim() === CLOSING) {
        closed = true;
        break;
      }
      body.push(lines[cursor] ?? "");
    }

    const joined = body.join("\n").trim();
    if (closed && joined !== "") bodies.push(joined);
    index = closed ? cursor + 1 : cursor;
  }

  return bodies;
}

/**
 * 一次回答里**所有** send 围栏的正文(一段工具调用 JSON 一条),按出现顺序.
 * 执行那一侧用它--排了几块就执行几块.
 */
export function parseSendFences(text: string): readonly string[] {
  return parseFences(text, SEND_OPENING);
}

/**
 * 第一块 send 围栏的正文;一块都没排就是 null.
 * "有没有排围栏"这类判据用它(`wait.fence`),执行那一侧用 `parseSendFences`.
 */
export function parseSendFence(text: string): string | null {
  return parseSendFences(text)[0] ?? null;
}

/** 第一块 ask 围栏的正文(网页向人举手,一次只认一块). */
export function parseAskFence(text: string): string | null {
  return parseFences(text, ASK_OPENING)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* 围栏里的工具调用                                                           */
/* -------------------------------------------------------------------------- */

/** 模型在 ```send 围栏里排的东西:只有 `tool` 与 `arguments` 两个键. */
export type ToolCall = {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 围栏正文 → 工具调用;排得不成形一律 null,不猜.
 *
 * 猜的代价不对称:猜错了会替模型选一个它没想选的工具,所以宁可把
 * `MALFORMED_CALL_HINT` 回灌进去让它自己改,也不在这里修形状.
 *
 * 住这里(而不是 relay):**读 DOM** 的那半边也要认工具调用--新版站点把 ```send
 * 渲染成代码块(``` 标记没了),`messages.ts` 读行文本时得靠它判"这是不是一段
 * 工具调用",好把围栏还原回去.relay 转出去,中继那条线的调用方照旧.
 */
export function parseToolCall(text: string): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const tool = parsed["tool"];
  if (typeof tool !== "string" || tool.trim() === "") return null;
  const args = parsed["arguments"] ?? {};
  if (!isPlainObject(args)) return null;
  return { tool, arguments: args };
}

/** 围栏排坏了时回灌的正文(`status: ok` 的一条,进对话流,让模型自己改). */
export const MALFORMED_CALL_HINT =
  '围栏里不是合法的工具调用.期望形状:{"tool": "工具名", "arguments": {...按该工具的入参...}},' +
  "arguments 是对象(没有参数写 {});每块围栏里只放一条调用(一次可以排多块).";
