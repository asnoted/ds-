/**
 * 检测点:模型回答里的协议围栏(回灌链的第一环).```send 是页面 →
 * 扩展的线协议,围栏里装一段工具调用 JSON,扩展经本机网关转给 MCP servers;
 * ```ask(#26)是页面向人举手,认出后不转给网关.
 *
 * 取回答的地方固定是"发消息那条出站的响应体"--模型的回答只有这一个来源,
 * 用户自己在页面里敲的围栏在请求侧,进不到这里.
 *
 * 响应可能是流式(一行一个 `data:` 载荷)也可能是整块 JSON,两条形状都先还原成
 * 回答正文,再交给 `parseSendFences`;围栏怎么切只有一条路径,这里不自己再切一遍.
 *
 * 站点自己那条是 **OT 增量流**(真机抓到的形状,见 #14):正文不在 `content`/`text`
 * 键里,而是散在 `data: {"v":"..."}` 与 `{"p":"response/fragments/-1/content","v":"..."}` 的
 * 追加操作里,`type: "THINK"` 的片段是思考过程.更麻烦的是围栏会被切进两个载荷
 * (`{"v":"```"}` 紧跟 `{"v":"send"}`),所以"回原文里找 ```send 字样"这条路对它无效--
 * 必须先把片段拼成正文,才谈得上认围栏.
 */

import { parseAskFence, parseSendFences } from "./fence";

/** 围栏起始的字面量:兜底路径要在原文里找到它,再交给围栏解析. */
const SEND_FENCE_OPENING = "```send";
const ASK_FENCE_OPENING = "```ask";

/** 只认"正文"类的字符串键;reasoning 之类的过程文本不当成回答. */
const TEXT_KEYS = new Set(["content", "text"]);
const SKIP_KEYS = new Set(["reasoning", "reasoning_content"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归挑出回答正文的字符串片段,按出现顺序追加到 out. */
function collectText(value: unknown, key: string | null, out: string[]): void {
  if (typeof value === "string") {
    if (key !== null && TEXT_KEYS.has(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, key, out);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [childKey, child] of Object.entries(value)) {
    if (SKIP_KEYS.has(childKey)) continue;
    collectText(child, childKey, out);
  }
}

/** 流式响应里逐行的 `data:` 载荷;`[DONE]`,半行,认不出的一律跳过. */
function ssePayloads(raw: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice("data:".length).trim();
    if (chunk === "" || chunk === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(chunk));
    } catch {
      // 半行载荷不是一条完整回答,忽略.
    }
  }
  return payloads;
}

/* -------------------------------------------------------------------------- */
/* 站点那条 OT 增量流:data: 载荷里的 p / o / v                                */
/* -------------------------------------------------------------------------- */

/** 回灌链只关心回答正文,思考过程与 reasoning 同一待遇(不当成回答). */
const THINKING_FRAGMENT_TYPE = "THINK";

/** 一片回答:`type` 是 THINK(思考)或 RESPONSE(正文),`content` 边写边长. */
type Fragment = { readonly type: string; content: string };

/** 首包播种的形状:`{"v":{"response":{"fragments":[...]}}}`;不是它就返回 null. */
function seededFragments(payload: Record<string, unknown>): unknown[] | null {
  const v = payload["v"];
  if (!isPlainObject(v)) return null;
  const response = v["response"];
  if (!isPlainObject(response)) return null;
  const fragments = response["fragments"];
  return Array.isArray(fragments) ? fragments : null;
}

/** 这条载荷是不是站点的 OT 增量:带 `p` 操作路径的,或者上面那种播种包. */
function isOtPayload(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value["p"] === "string") return true;
  return seededFragments(value) !== null;
}

function fragmentOf(entry: Record<string, unknown>): Fragment {
  return {
    type: typeof entry["type"] === "string" ? entry["type"] : "",
    content: typeof entry["content"] === "string" ? entry["content"] : "",
  };
}

/** `response/fragments/-1/content` → 追加到哪一片(`-1` 是当前那片). */
function fragmentAt(fragments: Fragment[], path: string): Fragment | undefined {
  const step = path.slice("response/fragments/".length, -"/content".length);
  if (step === "-1") return fragments[fragments.length - 1];
  const index = Number(step);
  return Number.isInteger(index) ? fragments[index] : undefined;
}

/**
 * 把 OT 增量流还原成回答正文:片段一路往后追加,`THINK` 片不计入;
 * 状态,计时,token 这些非正文操作一概不碰.
 */
function reconstructAnswer(payloads: readonly unknown[]): string {
  const fragments: Fragment[] = [];

  const apply = (payload: unknown): void => {
    if (!isPlainObject(payload)) return;
    const p = payload["p"];
    const v = payload["v"];

    if (typeof p === "string") {
      if (p === "response/fragments" && Array.isArray(v)) {
        for (const entry of v) if (isPlainObject(entry)) fragments.push(fragmentOf(entry));
        return;
      }
      if (p.endsWith("/content") && typeof v === "string") {
        const target = fragmentAt(fragments, p);
        if (target !== undefined) target.content += v;
        return;
      }
      if (p === "response" && Array.isArray(v)) {
        // 批处理包里还是同一批操作,递着走一遍.
        for (const entry of v) apply(entry);
        return;
      }
      return;
    }

    if (typeof v === "string") {
      // 没带路径的裸追加:接在当前那片后面.
      const last = fragments[fragments.length - 1];
      if (last !== undefined) last.content += v;
      return;
    }

    const seed = seededFragments(payload);
    if (seed !== null) {
      for (const entry of seed) if (isPlainObject(entry)) fragments.push(fragmentOf(entry));
    }
  };

  for (const payload of payloads) apply(payload);

  return fragments
    .filter((fragment) => fragment.type !== THINKING_FRAGMENT_TYPE)
    .map((fragment) => fragment.content)
    .join("");
}

/**
 * 这条原文是不是 OT 形状的响应;是就返回(可能空串的)回答正文,不是返回 null.
 * 认得形状却没正文,也照样返回空串--不再去原文里捞,免得把 THINK 里的围栏例子当真.
 */
function otAnswer(raw: string): string | null {
  const payloads = ssePayloads(raw);
  if (!payloads.some(isOtPayload)) return null;
  return reconstructAnswer(payloads);
}

/** 从响应原文还原模型的回答正文;认不出的响应返回空串(空串过不了围栏解析). */
export function extractAssistantAnswer(raw: string): string {
  if (raw.trim() === "") return "";

  const payloads = ssePayloads(raw);
  if (payloads.length > 0) {
    // 站点自家的 OT 增量流:正文只在片段里,别走下面那条按 `content` 键名猜的路
    if (payloads.some(isOtPayload)) return reconstructAnswer(payloads);

    const parts: string[] = [];
    for (const payload of payloads) collectText(payload, null, parts);
    const joined = parts.join("");
    if (joined !== "") return joined;
  }

  try {
    const parts: string[] = [];
    collectText(JSON.parse(raw), null, parts);
    return parts.join("");
  } catch {
    // 不是 JSON 也不是流式响应:正文取不到,走下面的兜底.
  }
  return "";
}

const JSON_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/** 把响应原文里的转义还原一层,让被 JSON 转义包住的围栏重新变成行. */
const CLOSING_RESIDUE = /^["}\],\s]/;

/**
 * 兜底块里找收尾的 ```:必须独占一行,且后面要么是行尾,要么是原文明末拖出来的
 * JSON 残渣(``\`\`\`"}`` 这种);认不出就不硬切.
 *
 * 尾随的残渣必须容下,否则那一块会被当成"没闭合"整块作废--真机上兜底路径的
 * 原文一律带着这截拖尾.
 */
function cutFencedBlock(block: string, opening: string): string {
  let from = opening.length;
  for (;;) {
    const index = block.indexOf("```", from);
    if (index === -1) return block;
    const before = block.slice(index - 1, index);
    const after = block.slice(index + 3);
    const ownLine = index === 0 || before === "\n";
    const lineEnd = after === "" || after.startsWith("\n") || CLOSING_RESIDUE.test(after);
    if (ownLine && lineEnd) return block.slice(0, index + 3);
    from = index + 3;
  }
}

function unescapeOnce(raw: string): string {
  return raw.replace(/\\(n|r|t|"|\\|\/)/g, (match, char: string) => JSON_ESCAPES[char] ?? match);
}

/**
 * 响应原文 → 指定围栏里的正文(一条一块);没排围栏,排的是普通代码块或非协议
 * 围栏,围栏没闭合,都返回空数组.
 *
 * 三条路共用:OT 增量流先拼正文再认;直出的 JSON 响应从回答正文里认;
 * 都认不出才走兜底--把原文转义还原一层,从围栏起始处切进来,仍然
 * 只用围栏解析这一条路径(`parse`).
 */
function detectFences(
  raw: string,
  opening: string,
  parse: (text: string) => readonly string[],
): readonly string[] {
  // OT 形状认得:只在拼好的正文里找围栏,认不出就是没排--不去原文里捞
  // (思考过程里常常举一个 ```send 的例子,捞了会把例子当真).
  const ot = otAnswer(raw);
  if (ot !== null) return parse(ot);

  const direct = parse(extractAssistantAnswer(raw));
  if (direct.length > 0) return direct;

  // 兜底:正文形状认不出时,把原文转义还原一层,从围栏起始处切进来,**切到收尾行**
  // 再交给围栏解析(原文末尾拖着 JSON 残渣,不切的话收尾行认不出来).
  // 这条路只认第一块:它的活儿是"别把整段回答丢了",一次多块本来就走上面两条
  // 正常路径--OT 流会先拼成完整正文,直出 JSON 会先取出回答正文.
  const restored = unescapeOnce(raw);
  const start = restored.indexOf(opening);
  if (start === -1) return [];
  return parse(cutFencedBlock(restored.slice(start), opening));
}

/** 响应原文 → 各块 send 围栏里的正文(一段工具调用 JSON 一条),按出现顺序. */
export function detectToolCalls(raw: string): readonly string[] {
  return detectFences(raw, SEND_FENCE_OPENING, parseSendFences);
}

/** 响应原文 → ask 围栏里的问题(网页向人举手,不转给网关;一次只认第一块). */
export function detectAskQuestion(raw: string): string | null {
  const questions = detectFences(raw, ASK_FENCE_OPENING, (text) => {
    const question = parseAskFence(text);
    return question === null ? [] : [question];
  });
  return questions[0] ?? null;
}
