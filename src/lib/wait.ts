import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_TIMEOUT, PageError } from "./action";
import type { ActionFrame } from "./action";
import { parseSendFence } from "./fence";
import {
  ROW_SELECTOR,
  conversation,
  keysOf,
  nextFrame,
  rowText,
  settleUntilMounted,
  type ListViewport,
} from "./messages";
import { hasReplyAnchor } from "./reply";
import { POLL_INTERVAL_MS, parseWaitSeconds } from "./wait-budget";

/**
 * 等动作(#22):等页面模型排出围栏(`wait.fence`),等一条新的
 * 回灌落地(`wait.reply`).它们是"页面指挥"回路在 agent 侧的
 * 收口--发完问题之后,agent 不用自己轮询读对话来盯进展.
 *
 * **基线**:动作一到就先跳到底,记下"此刻挂着哪些行".真机两种行都见过(2026-10-04):
 * 老版行上有 `data-virtual-list-item-key`--**带符号**(用户侧负,助手侧正,一个来回
 * 两条,同值不同号,见 #37),所以**不能**按数值大小判新(`key > 基线` 漏负 key,
 * `|key| > 基线` 漏同回的对面那条);新版有的行连 key 都没有(只剩哈希 class).
 * 于是基线记两样:**行的 key 集合** + **无 key 行的正文集合**,之后只认"基线里没见过"的
 * 那条--视口里重新挂出的旧行(滚动造成的)不算新消息,旧回灌也就不会被误认成"这一回的答复".
 *
 * **围栏只认闭合的**:`parseSendFence` 对没出完的半截围栏返回
 * null,轮询自然略过--等的是"排完"的围栏,不是排到一半的.
 *
 * **不主动滚**:新消息出来时站点自己把列表滚到底;轮询只扫当前
 * 挂载的行,不去抢滚动条.
 *
 * **预算**:中继推下去等回传的锁是 30s,等待预算默认 25s,可配
 * (`params.timeout`,秒),钳在 [1, 25]--留 5s 余量让结果回得
 * 去(与读对话的扫屏预算同一个理由).到点回在册的 `timeout`.
 */

/**
 * "等多久"的口径与节奏住在 `wait-budget.ts`(无依赖,`messages.ts` 也要用同一套,
 * 而 `messages.ts` 不能引本文件--本文件要引它的 DOM 判据,那会成循环依赖).
 * 这里转出,对外接口与旧版一字不差.
 */
export {
  DEFAULT_WAIT_SECONDS,
  FRAME_FALLBACK_MS,
  MAX_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  POLL_INTERVAL_MS,
  parseWaitSeconds,
} from "./wait-budget";

/**
 * 基线:跳到底,等挂载,记下两样东西--
 *
 * - **行的 key 集合**(原样,带符号):老版站点每条消息一个 `data-virtual-list-item-key`,
 *   会话内**不重复**(真机样本:`-2` 问题 / `2` 围栏 / `-4` 回灌 / `4` 答复--同来回
 *   两条同值不同号,见 #37,所以不能比大小,只能比"见过没有");
 * - **无 key 行的正文集合**:新版站点有的行连 key 都没有,只能拿正文文本当身份.
 *   空文本的行不算(分隔条之类).
 */
export type Baseline = {
  /** 基线那一刻挂着的行 key(原样,带符号). */
  readonly keys: readonly string[];
  /** 基线那一刻无 key 行的正文(新版站点靠它判新). */
  readonly texts: readonly string[];
};

export async function baselineKey(
  view: ListViewport,
  settle: () => Promise<void> = nextFrame,
): Promise<Baseline> {
  const home = view.scrollTop;
  view.scrollTop = view.scrollHeight;
  await settleUntilMounted(view, keysOf(view), settle);
  const keys: string[] = [];
  const texts: string[] = [];
  const rows = view.querySelectorAll(ROW_SELECTOR);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const key = row.getAttribute("data-virtual-list-item-key");
    if (key !== null) {
      keys.push(key);
      continue;
    }
    const text = rowText(row);
    if (text !== null) texts.push(text);
  }
  view.scrollTop = home;
  return { keys, texts };
}

/**
 * 轮询视口里挂载的行,返回第一条"算新,且正文过 `matches` 判定"的**行文本**;
 * 到点没等到回 null.`interval` 可注入,测试不用等真实的 500ms.
 *
 * **算不算新**(两版站点都成立):
 * - 带 key 的行:key **不在** `baseline.keys` 里(老版;一个来回两条同值不同号,
 *   所以只比"见过没有",不比大小);
 * - 无 key 的行:正文文本**不在** `baseline.texts` 里(新版);于是基线时就在的老行,
 *   以及滚动重挂的旧行都不算新(同一条文本重复出现时会漏认,实测对话里少见).
 *
 * **正文**用 `rowText`(角色无关):`wait.*` 不需要角色,站点换版拿掉 role 判据也不影响它.
 */
export async function waitUntilNewMessage(
  view: ListViewport,
  baseline: Baseline,
  deadline: number,
  matches: (text: string) => boolean,
  interval: number = POLL_INTERVAL_MS,
): Promise<string | null> {
  const knownKeys = new Set(baseline.keys);
  const knownTexts = new Set(baseline.texts);
  for (;;) {
    const rows = view.querySelectorAll(ROW_SELECTOR);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      const key = row.getAttribute("data-virtual-list-item-key");
      if (key !== null && knownKeys.has(key)) continue;
      const text = rowText(row);
      if (text === null) continue;
      if (key === null && knownTexts.has(text)) continue;
      if (matches(text)) return text;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 在预算内等消息列表挂出来.
 *
 * 列表不是"动作一到就挂好"的:首页发出第一条消息后,会话页要跨一次导航才把
 * `.ds-virtual-list` 挂上(真机撞过:`wait.*` 一到就撞空列表,当场 `page-changed`).
 * 等待动作就该等--预算内轮询,到点仍没有才是真的"页面上没有消息列表".
 */
async function viewWithin(deadline: number): Promise<ListViewport> {
  for (;;) {
    const view = conversation(document);
    if (view !== null) return view;
    if (Date.now() >= deadline) {
      throw new PageError(ACTION_ERROR_PAGE_CHANGED, "没有消息列表可等");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** `wait.fence`:等基线之后第一条排出闭合 ```send 围栏的消息. */
export async function waitFence(frame: ActionFrame): Promise<{ readonly question: string }> {
  const deadline = Date.now() + parseWaitSeconds(frame) * 1000;
  const view = await viewWithin(deadline);
  const baseline = await baselineKey(view);
  const found = await waitUntilNewMessage(
    view,
    baseline,
    deadline,
    (text) => parseSendFence(text) !== null,
  );
  if (found === null) {
    throw new PageError(ACTION_ERROR_TIMEOUT, "等围栏超时");
  }
  const question = parseSendFence(found);
  // 命中判定本身就要求闭合围栏;这里再取一次,类型上才拿得到字符串.
  if (question === null) {
    throw new PageError(ACTION_ERROR_TIMEOUT, "等围栏超时");
  }
  return { question };
}

/** `wait.reply`:等基线之后第一条首行锚为 `agent:` 的回灌. */
export async function waitReply(frame: ActionFrame): Promise<{ readonly text: string }> {
  const deadline = Date.now() + parseWaitSeconds(frame) * 1000;
  const view = await viewWithin(deadline);
  const baseline = await baselineKey(view);
  const found = await waitUntilNewMessage(view, baseline, deadline, (text) => hasReplyAnchor(text));
  if (found === null) {
    throw new PageError(ACTION_ERROR_TIMEOUT, "等回灌超时");
  }
  return { text: found };
}
