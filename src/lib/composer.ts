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

/** 读框里现有的字(不发送):textarea 读 `value`,contenteditable 读 `textContent`. */
export function read(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value;
  }
  return element.textContent ?? "";
}

/**
 * 写进受控输入,返回成败(**不发送**).
 *
 * 走**原型上的原生 value setter**,再派一个冒泡的 `input`:直接 `el.value = x` 会被
 * React 的 value tracker 吞掉--页面看着像没写过.既不是 textarea 也不是可编辑区
 * (挑框之外的手递元素)回 `false`,不假装写过.
 */
export function write(element: HTMLElement, text: string): boolean {
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) return false;
    setter.call(element, text);
  } else if (element.getAttribute("contenteditable") === "true") {
    element.textContent = text;
  } else {
    return false;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/**
 * 在框上按回车(站点自己也接这条路).**键码补法只有这一份**:`keyCode` / `which`
 * 由 `defineProperty` 补成 13(构造参数里塞进去在部分实现上会被丢掉),
 * 页面里认老属性的判断也认得;keydown 与 keyup 都派,真按键就是这一对.
 */
export function pressEnter(element: HTMLElement): void {
  for (const type of ["keydown", "keyup"]) {
    const event = new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "keyCode", { value: 13 });
    Object.defineProperty(event, "which", { value: 13 });
    element.dispatchEvent(event);
  }
}
