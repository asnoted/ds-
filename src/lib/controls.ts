/**
 * 对话内容里的控件动作:消息工具栏六项(`message.*`)与代码块两项(`code.*`).
 *
 * 与 `messages.ts`(只读)相邻而不同:这里**点**.参数都是 `{ index }`,成功回 `{}`,点完不回读
 * (站点异步生效,`think.set` 已踩过).
 *
 * **`index` 数的是当前挂载的行 / 代码块**,0 起,负数从末尾数(`-1` = 最新一个)--**不是**
 * `messages.list` 的下标:后者靠滚动把整段对话扫一遍,而工具栏只存在于挂载的行里.
 *
 * **定位**:消息工具栏六颗按钮逐字节同形,身份只靠 DOM 序.所以以 `aria-label="朗读"` 为语义锚
 * (它唯一带 aria-label),再校验"它的容器恰好 6 颗,它在第 5 位"--任何一处不符都当结构变了,
 * `page-changed`,不点,宁可停也不凭序号猜.图标 `path` 不作判据(只在存证里留证据,ADR-0018).
 * 代码块靠块内文字("复制"/"下载").哈希 class 一概不碰.
 */

import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_UNKNOWN, PageError } from "./action";
import type { ActionFrame } from "./action";
import { ROW_SELECTOR, conversationList, readRow } from "./messages";

/** 工具栏里按钮的总数与"朗读"所在的位置(1 起). */
const TOOLBAR_SIZE = 6;
const READ_POSITION = 5;
const READ_ANCHOR = '[aria-label="朗读"]';
const CODE_BLOCK_SELECTOR = "div.md-code-block";

/** 动作名 → 它在工具栏里排第几(1 起,真机 2026-10-07 存证 `message.*`). */
export const TOOLBAR_POSITIONS = {
  "message.copy": 1,
  "message.retry": 2,
  "message.like": 3,
  "message.dislike": 4,
  "message.read": 5,
  "message.share": 6,
} as const;

/** 代码块按钮的文字.文字是本地化的(这里只认中文);认不出当控件不在. */
export const CODE_LABELS = {
  "code.copy": "复制",
  "code.download": "下载",
} as const;

/** `{ index }`:必须是整数,否则当参数形状不对. */
function parseIndex(frame: ActionFrame): number {
  const index = frame.params["index"];
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw new PageError(ACTION_ERROR_UNKNOWN, "index 必须是整数");
  }
  return index;
}

/** 从集合里按位置取:非负从头数,负数从末尾数;越界回 `undefined`. */
function pick<T>(items: readonly T[], index: number): T | undefined {
  return items[index < 0 ? items.length + index : index];
}

/** 当前挂载的消息行(与 `messages.list` 同一个"消息行"口径:`readRow` 认得出的行). */
function mountedMessageRows(): Element[] {
  const list = conversationList(document);
  if (list === null) return [];
  return [...list.querySelectorAll(ROW_SELECTOR)].filter((row) => readRow(row) !== null);
}

/** 当前挂载的代码块(对话列表内,文档序). */
function mountedCodeBlocks(): Element[] {
  const list = conversationList(document);
  if (list === null) return [];
  return [...list.querySelectorAll(CODE_BLOCK_SELECTOR)];
}

/** 点之前的"可用"判据:`aria-disabled="true"` 不算可用(元素在 ≠ 可用). */
function clickIfUsable(el: HTMLElement, what: string): void {
  if (el.getAttribute("aria-disabled") === "true") {
    throw new PageError(ACTION_ERROR_PAGE_CHANGED, `${what}不可用`);
  }
  el.click();
}

/**
 * 找这一行的工具栏并取第 `position` 颗.用户消息的工具栏只有 2 颗,没有"朗读",
 * 自然落入"没找到",不需要另做角色判断.
 */
function toolbarButton(row: Element, position: number): HTMLElement {
  const anchor = row.querySelector<HTMLElement>(READ_ANCHOR);
  const toolbar = anchor?.parentElement ?? null;
  if (anchor === null || toolbar === null) {
    throw new PageError(ACTION_ERROR_PAGE_CHANGED, "这一行没有消息工具栏(可能是用户消息)");
  }
  const buttons = [...toolbar.children];
  const regular =
    buttons.length === TOOLBAR_SIZE &&
    buttons.every((child) => child.getAttribute("role") === "button");
  if (!regular || buttons[READ_POSITION - 1] !== anchor) {
    throw new PageError(
      ACTION_ERROR_PAGE_CHANGED,
      `工具栏结构不符:要恰好 ${TOOLBAR_SIZE} 颗且"朗读"在第 ${READ_POSITION} 位`,
    );
  }
  return buttons[position - 1] as HTMLElement;
}

/** 造一个 `message.*` 动作:按 `index` 取挂载行,点工具栏第 `position` 颗. */
export function messageAction(position: number): (frame: ActionFrame) => Record<string, never> {
  return (frame) => {
    const index = parseIndex(frame);
    const row = pick(mountedMessageRows(), index);
    if (row === undefined) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "没有这一条消息");
    clickIfUsable(toolbarButton(row, position), "工具栏按钮");
    return {};
  };
}

/** 造一个 `code.*` 动作:按 `index` 取挂载的代码块,点块内文字为 `label` 的按钮. */
export function codeAction(label: string): (frame: ActionFrame) => Record<string, never> {
  return (frame) => {
    const index = parseIndex(frame);
    const block = pick(mountedCodeBlocks(), index);
    if (block === undefined) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "没有这个代码块");
    const button = [...block.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (el) => (el.textContent || "").trim() === label,
    );
    if (button === undefined) {
      throw new PageError(ACTION_ERROR_PAGE_CHANGED, `代码块里找不到"${label}"`);
    }
    clickIfUsable(button, `代码块"${label}"`);
    return {};
  };
}

/** 8 个动作的名册(`content.ts` 接线用). */
export const CONTROL_ACTIONS: Readonly<
  Record<string, (frame: ActionFrame) => Record<string, never>>
> = {
  ...Object.fromEntries(
    Object.entries(TOOLBAR_POSITIONS).map(([name, position]) => [name, messageAction(position)]),
  ),
  ...Object.fromEntries(
    Object.entries(CODE_LABELS).map(([name, label]) => [name, codeAction(label)]),
  ),
};
