/**
 * 写作框(composer)的 DOM 判据(#102):**站点的写作框是哪个、怎么写进去、
 * 这条发出去没有**,只有一份实现.
 *
 * 两路共用这一份:动作路(`send.page` 两步、看门狗催办)走 `page.ts` 的执行器,
 * 续聊路(自动续聊的落草稿与发送)走 `inject.content.ts` 的接线,两边都只调这里的
 * 函数--于是"同一个页面,两条路判出两个框"不再可能(#52 正好藏在这条缝里).
 *
 * 边界(CODING_STANDARDS 第 1 条):这里只搬 **DOM 判据**--挑框,读写,按键,
 * 等清空,圆键此刻是什么意图.**不碰闸**:写草稿放行、发送才归"代你发言"闸的分界
 * (ADR-0023)与各动作的闸归类一字不动,归 `action.ts` / `run.ts` / `registry.ts`;
 * **不碰时钟**:`awaitCleared` / `triggerSend` / `send` 的时钟由调用方注入,
 * 接线侧默认给 `realClock`.探针 `scripts/page-action.py` 是独立仪器(CODING_STANDARDS
 * 第 5 条),不与这里同源.
 */

/**
 * 写作框的认定放宽到两类容器:`<textarea>` 与 contenteditable(DeepSeek 前端两代
 * 都用过).导出来给 `messages.ts` 认"对话那一条虚拟列表"当锚(#54)--
 * 同一个锚只能有一份,两边各写一个字面量就会各自漂移.
 */
export const COMPOSER_SELECTOR = "textarea, [contenteditable='true']";

/** 可见 + 可写的框:没连上页面、没渲染出盒子、只读/禁用的都不算. */
function isWritable(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  // 能被选择器命中就自带 `contenteditable="true"`(jsdom 不实现 `isContentEditable`).
  return element.getAttribute("contenteditable") === "true";
}

/**
 * 挑写作框:**可见 + 可写 + 面积最大,一条规则**(两条路共用,#102 的 pick 统一).
 *
 * 面积最大的那条规则是有意的:写作框是页面上最显眼的输入面,面积即"人在看的那个";
 * DOM 序第一条会被侧栏搜索、历史消息里的小输入面之类抢走.同面积取 DOM 序靠前的
 * (先命中先赢),判据不额外挑.挑不到回 `null`,**不猜**.
 */
export function pick(root: ParentNode = document): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = -1;
  for (const candidate of root.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)) {
    if (!isWritable(candidate)) continue;
    const rect = candidate.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
}
