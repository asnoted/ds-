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
 * (ADR-0003)与各动作的闸归类一字不动,归 `action.ts` / `run.ts` / `registry.ts`;
 * **不碰时钟**:`awaitCleared` / `triggerSend` / `send` 的时钟由调用方注入,
 * 真钟(`Date` / `setTimeout`)那一份在接线侧 `entrypoints/inject.content.ts` 里,
 * 本模块只有 `Clock` 类型.探针 `scripts/page-action.py` 是独立仪器(CODING_STANDARDS
 * 第 5 条),不与这里同源.
 */

import { normalizeText } from "./normalize";

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

/** 时钟:由调用方注入(CODING_STANDARDS 第 1 条)——这里不碰定时器,不碰 `Date`. */
export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

/** 轮询间隔(毫秒):站点清空输入框是几百毫秒内的事,100ms 够密也够省. */
export const POLL_MS = 100;

/**
 * 等框被清空(**发出去的标志**);到 `timeoutMs` 还没清回 `false`,**不抛**--
 * "站点没发出去"与"还没来得及清"对下一步是同一件事(调用方去点圆键兜底,或者留痕作废).
 */
export async function awaitCleared(
  readText: () => string,
  options: { readonly timeoutMs: number; readonly clock: Clock },
): Promise<boolean> {
  const { timeoutMs, clock } = options;
  const startedAt = clock.now();
  for (;;) {
    if (readText().trim() === "") return true;
    if (clock.now() - startedAt >= timeoutMs) return false;
    await clock.sleep(POLL_MS);
  }
}

/**
 * 写作框旁那个圆键:站点设计系统的主操作键(真机 2026-10-04:class 与 `aria-label`
 * 一个不换,只有里面的图标在箭头与方块之间换).
 *
 * **一个按钮只对应一个最小单元**(#15 的原则):它此刻是发送还是停止,是**页面的意图**,
 * 不是控件的身份.所以命中判据只有"在 + 可用",图标不参与;图标唯一去处是读面
 * (`readIntent`),原先按图标分家的 `send.click` / `stop.click` 是"两个动作抢一个键".
 */
export const BUTTON_SELECTOR =
  'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle';

/** 圆键此刻承载什么意图--就是人看一眼图标的结论. */
export type Intent = "send" | "stop" | "unknown";

/**
 * 圆键在不在,有没有渲染出盒子(**不管可不可用**).读面与点击面都靠它区分
 * "键在但禁用"与"键不在"两回事.
 */
export function circleElement(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(BUTTON_SELECTOR);
  if (el === null) return null;
  return el.getClientRects().length === 0 ? null : el; // 还没渲染出来:当没找到
}

/**
 * 可用的圆键:不在,或被禁用(class 带 `ds-button--disabled`--它没有 `disabled` 属性,
 * 空输入框时站点就把它标成禁用)都回 null.
 */
export function findButton(): HTMLElement | null {
  const el = circleElement();
  if (el === null) return null;
  return el.classList.contains("ds-button--disabled") ? null : el;
}

/**
 * 图标口径只有这一处,且**只服务读面**.前缀取自真机路径(真机 2026-10-04 两次抓取):
 * 箭头 `M8.3125 0.980206...` = 发送,方块 `M2 4.88C2 3.68009...` = 停止,两者同为 16×16.
 * 站点换图标就少报一种值--**这是要的**:宁可报"认不出",也不猜是发送还是停止.
 */
const BUTTON_ICON_PREFIXES: ReadonlyArray<readonly [string, Intent]> = [
  ["M8.3125 0.980206", "send"],
  ["M2 4.88C2 3.68009", "stop"],
];

/** 圆键里那个图标的 `d`(两态共用一套 class,只有这个不同). */
function circleIconPath(el: HTMLElement): string | null {
  return el.querySelector("svg path")?.getAttribute("d") ?? null;
}

/** 图标认哪一个意图;认不出(站点换图标 / 思考期环形)回 `unknown`,**不猜**. */
export function readIntent(el: HTMLElement): Intent {
  const icon = circleIconPath(el);
  if (icon === null) return "unknown";
  for (const [prefix, intent] of BUTTON_ICON_PREFIXES) {
    if (icon.startsWith(prefix)) return intent;
  }
  return "unknown";
}

/**
 * 圆键此刻是什么意图(只读不点).键不在或不可用一律 `unknown`--"认不出"与
 * "当下不是发送"在这条读面上同一处置:不点它,也不替它猜.
 */
export function circleIntent(): Intent {
  const el = findButton();
  return el === null ? "unknown" : readIntent(el);
}

/** 落草稿的结果:写成了 / 框里有别人的字(没覆盖)/ 写不进. */
export type StageOutcome = "written" | "draft" | "unwritable";

/**
 * 同一份字的判定:归一化那一份与钥匙共用(`normalize.ts`,ADR-0002:站点与 React
 * 受控输入在换行与首尾空白上与我们写进去的不完全一致),两处都由用例钉着:这里钉
 * "上一轮落的短标记再落一次不算别人的字",`armed.test.ts` 钉"用户手打的话永远不等于标记".
 */
export function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

/**
 * 落一份待发草稿(**不按发送**),带草稿保护:框里有别人正在打的字就不覆盖--宁可少
 * 一轮,也不吃人正在打的东西(#52 的半自动待发续聊靠这条).框里那份是**这一份**
 * (上一轮落的短标记,换行 / 首尾空白不算数)就覆盖:落草稿是幂等的.
 *
 * 只有写入,没有发送步;"代你发言"闸关不关、要不要人按发送都不在这里管(ADR-0003:
 * 写草稿放行,发送才归闸).
 */
export function stage(element: HTMLElement, text: string): StageOutcome {
  const draft = read(element);
  if (draft.trim() !== "" && !sameText(draft, text)) return "draft";
  return write(element, text) ? "written" : "unwritable";
}

/** 按完回车等站点清空的上限(毫秒). */
export const ENTER_WAIT_MS = 600;
/** 点完圆键再等的上限(毫秒):兜底那一下之后站点要更久才清空. */
export const CIRCLE_WAIT_MS = 1200;

/**
 * 把框里**已经写好**的那条字发出去;圆键只当**兜底**,且**只在意图是"发送"时点**.
 *
 * 生成期那个圆键是停止(真机 2026-10-05:class 一个不换,只有图标在箭头与方块之间
 * 换),点下去就是替用户中断一次生成--比这条发不出去坏得多.认不出(思考期环形
 * spinner)同样不点:宁可作废,也不赌那一下是发送.
 */
export async function triggerSend(element: HTMLElement, clock: Clock): Promise<boolean> {
  pressEnter(element);
  if (await awaitCleared(() => read(element), { timeoutMs: ENTER_WAIT_MS, clock })) return true;

  const button = findButton();
  if (button === null || readIntent(button) !== "send") return false;
  button.click();
  return awaitCleared(() => read(element), { timeoutMs: CIRCLE_WAIT_MS, clock });
}

/** 一次发送的结果:发出去了 / 写不进 / 框里有别人的字(没覆盖) / 没发出去(断在哪一步由调用方去留痕). */
export type SendStatus = "unwritable" | "draft" | "sent" | "failed";

/**
 * 把 `message` 写进框里并把这条发出去;**与 `stage` 同一份草稿保护**:框里有别人正在
 * 打的字就不覆盖,回 `draft`(自动续聊宁可少一轮,也不吃人正在打的东西,与其半自动
 * 那一支同一条原则);**发不出去就把原来的字还原**,页面里不留半截东西(草稿保护的
 * 另一面:写得进不等于发得出去,别把人打到一半的稿换成一条发不掉的消息).
 */
export async function send(
  element: HTMLElement,
  message: string,
  clock: Clock,
): Promise<SendStatus> {
  const before = read(element);
  const staged = stage(element, message);
  if (staged !== "written") return staged;
  if (await triggerSend(element, clock)) return "sent";
  if (read(element).includes(message)) write(element, before);
  return "failed";
}
