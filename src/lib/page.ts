import {
  ACTION_ERROR_COMPOSER_ABSENT,
  ACTION_ERROR_PAGE_CHANGED,
  ACTION_ERROR_UNKNOWN,
  PageError,
} from "./action";
import type { ActionFrame } from "./action";
import {
  circleElement,
  findButton,
  pick,
  pressEnter as pressEnterKey,
  read,
  readIntent,
  write,
  COMPOSER_SELECTOR,
  type Intent,
} from "./composer";

/**
 * 当前页面的最小状态.这个执行器跑在目标标签页的内容脚本(ISOLATED 世界)里,
 * 读到的是那个标签页的 DOM;只返回结构稳定,不随 DeepSeek 前端改版一夜崩掉的东西--
 * 地址,标题,写作框在不在,账号在什么处境上.要读 React 状态 / webpack 模块再另开一跳.
 */
export type PageState = {
  readonly url: string;
  readonly title: string;
  readonly composerPresent: boolean;
  readonly account: AccountState;
};

/**
 * 账号处境(#2):**写作框不在的时候,页面自己知道为什么,扩展要认出来**.
 * 禁言期间 DeepSeek 干脆不渲染写作框,此前扩展一声不吭地空等一个永远不会出现的
 * 输入框,人在页面上看得见橙条,agent 什么都看不见.
 *
 * - `ready`:写作框在;
 * - `muted`:站点给了处罚句,`until` 是它写着的解封时刻(认不出时刻就是 `null`,
 *   仍然算禁言--认不出时间不等于没禁);
 * - `signed-out`:站点把没登录的人导到了登录页;
 * - `unknown`:写作框不在,又认不出上面任何一种.**不猜**--分不清就说分不清.
 */
export type AccountState =
  | { readonly kind: "ready" }
  | { readonly kind: "muted"; readonly until: string | null }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unknown" };

/**
 * 处罚句只从警示条里认.会话正文里出现"禁言"是常事(#2 的原话),拿全文去搜
 * 等于把用户聊天里的话当成处罚--所以两头都收:容器是警示条,句子还得同时提到
 * "账号/你"与"禁言/封禁".
 */
const ALERT_SELECTOR = ".ds-alert__content";
/** 解封时刻是纯文本(真机 2026-10-02 抄的:页面上既没有 `<time>` 也没有 `datetime`). */
const MUTE_UNTIL = /禁言至\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*\d{1,2}:\d{2})/;
/** 登录页路径(真机实测过:没登录时站点把人导到这儿). */
const SIGNED_OUT_PATH = /\/sign_in$/;

/** 警示条里的文本认不认得处罚句;认得出就把站上写的解封时刻一起带出来. */
export function readMute(root: ParentNode): { readonly until: string | null } | null {
  for (const index of Array.from(root.querySelectorAll(ALERT_SELECTOR)).values()) {
    const text = index.textContent ?? "";
    if (!/(账号|你)/.test(text)) continue;
    if (!/(禁言|封禁)/.test(text)) continue;
    return { until: MUTE_UNTIL.exec(text)?.[1] ?? null };
  }
  return null;
}

/** 写作框在不在 + 账号在什么处境上.写作框不在时才去认处境. */
export function readAccount(composerPresent: boolean): AccountState {
  if (composerPresent) return { kind: "ready" };
  const mute = readMute(document);
  if (mute !== null) return { kind: "muted", until: mute.until };
  if (SIGNED_OUT_PATH.test(location.pathname)) return { kind: "signed-out" };
  return { kind: "unknown" };
}

/**
 * `AccountState` 的校验:background 侧从标签页回话里读到的是
 * `unknown`,过一遍这个再拿去喂退避判定--形状不对就当认不出
 * (退避闸不猜,放行后由真正的执行去报它该报的码).
 */
export function isAccountState(value: unknown): value is AccountState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record["kind"]) {
    case "ready":
    case "signed-out":
    case "unknown":
      return Object.keys(record).length === 1;
    case "muted":
      return (
        Object.keys(record).length === 2 &&
        (record["until"] === null || typeof record["until"] === "string")
      );
    default:
      return false;
  }
}

/** 写作框在不在(`page.state` 与账号处境周期上报共读这一处). */
export function readComposerPresent(): boolean {
  return document.querySelector(COMPOSER_SELECTOR) !== null;
}

/** 名字对齐 dsb 名册里的 `page.state`(`dsb/actions.py:59-61`).`frame` 不用:读的就是本标签页. */
export function readPageState(_frame: ActionFrame): PageState {
  const composerPresent = readComposerPresent();
  return {
    url: location.href,
    title: document.title,
    composerPresent,
    account: readAccount(composerPresent),
  };
}

/** 挑写作框的判据在 `composer.ts`(动作路与续聊路共用一份);这里只折成动作的失败码. */
function composerOrThrow(): HTMLElement {
  const el = pick();
  if (el === null) throw new PageError(ACTION_ERROR_COMPOSER_ABSENT, "页面上没有写作框");
  return el;
}

/** 写不进去只可能是页面结构变了(`pick` 只回能写的形状)——这条是兜底,别装作写过. */
function writeOrThrow(el: HTMLElement, text: string): void {
  if (!write(el, text)) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "写作框写不进去");
}

/** 读写作框里现有的字(不发送);没有写作框回空串(读动作不算错). */
export function readComposer(_frame: ActionFrame): { text: string } {
  const el = pick();
  return { text: el === null ? "" : read(el) };
}

/** 往写作框写一段字(**不发送**).`params.text` 不是字符串就写空. */
export function typeComposer(frame: ActionFrame): Record<string, never> {
  const text = frame.params["text"];
  writeOrThrow(composerOrThrow(), typeof text === "string" ? text : "");
  return {};
}

/** 清空写作框(**不发送**). */
export function clearComposer(_frame: ActionFrame): Record<string, never> {
  writeOrThrow(composerOrThrow(), "");
  return {};
}

/** 点那个圆键(`button.click`).不可用就抛,别假装点过了. */
export function buttonClick(_frame: ActionFrame): Record<string, never> {
  const el = findButton();
  if (el === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "圆键不可用");
  el.click();
  return {};
}

/**
 * 读那个圆键此刻是发送还是停止(`button.get`,**只读不点**).agent 要先读后写:
 * 想停一次生成就读到 `stop` 再点,别点下去才知道点了什么.
 *
 * "认不出"是**成功**返回(键在但不知是什么是有效事实);圆键整个不在才抛
 * `page-changed`.键在但禁用(空输入框态)照样报--图标就是箭头.
 */
export function readButton(_frame: ActionFrame): { readonly pressed: Intent } {
  const el = circleElement();
  if (el === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "圆键不可用");
  return { pressed: readIntent(el) };
}

/**
 * `button.get` 回话 → 页面此刻正在生成(#104,看门狗催办前的那道判读).
 *
 * **只认圆键在"停止"相**;键认不出 / 回话形状不对都不算在生成--
 * 看门狗不按看不见的东西行事:没观测到输出,催办照旧走.
 */
export function isGenerating(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return (result as { pressed?: unknown }).pressed === "stop";
}

/** 在写作框上按回车(站点自己也接这条路);键码补法那一份在 `composer.ts`. */
export function pressEnter(_frame: ActionFrame): Record<string, never> {
  pressEnterKey(composerOrThrow());
  return {};
}

/** "开启新对话":侧栏那个 `tabindex=0` 的条目.文字是**本地化**的,认不出就抛. */
export function newChat(_frame: ActionFrame): Record<string, never> {
  const entries = document.querySelectorAll<HTMLElement>('[tabindex="0"]');
  const el = [...entries].find((entry) => (entry.textContent || "").trim() === "开启新对话");
  if (el === undefined) throw new PageError(ACTION_ERROR_PAGE_CHANGED, '找不到"开启新对话"');
  el.click();
  return {};
}

/**
 * 侧栏开关(真机契约见 git 历史里已退役的 frontend spec"侧栏开关",ADR-0001).**两态是同一个控件**:图标 `path` 不变,只是位置从
 * "展开:2 颗里第 2"变成"收起:3 颗里第 1".顶栏图标键没有任何语义属性(无字,无 aria,无 title),
 * 身份只靠位置--所以用结构不变量把"点错"变成"停下":
 *
 * - 锚:"开启新对话"条目(同 `chat.new`).它两态都在 DOM,收起时整块没有布局盒--**状态就看它**.
 * - 顶栏图标键:锚的最近祖先里"无字,带 `ds-button--icon`,不在会话条目内,有布局盒"的图标键,
 *   **以第一颗的父元素为顶栏组**,只数该父元素的直接子里的这类键(别处的--如会话列表里分组标题的
 *   折叠小键--不参与,真机 2026-10-07 展开态下最近祖先里就有一颗);展开必须恰好 2 颗取第 2,
 *   收起必须恰好 3 颗取第 1.
 * - 任一不符都当结构变了,`page-changed`,不点(点错会点到搜索或开出新会话).
 *
 * 图标 `path`,屏幕坐标,哈希 class 都不作判据.
 */
const NEW_CHAT_LABEL = "开启新对话";
const SIDEBAR_BUTTON_SELECTOR = '[role="button"].ds-button--icon';
const CHAT_ROW_ANCESTOR = 'a[href^="/a/chat/s/"]';

function newChatAnchor(): HTMLElement | null {
  const entries = document.querySelectorAll<HTMLElement>('[tabindex="0"]');
  return [...entries].find((entry) => (entry.textContent || "").trim() === NEW_CHAT_LABEL) ?? null;
}

function topIconButtons(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(SIDEBAR_BUTTON_SELECTOR)].filter(
    (button) =>
      (button.textContent || "").trim() === "" &&
      button.closest(CHAT_ROW_ANCESTOR) === null &&
      button.getClientRects().length > 0,
  );
}

/** 当前是不是收起(锚没有布局盒);锚不在回 `null`. */
function sidebarCollapsed(): boolean | null {
  const anchor = newChatAnchor();
  return anchor === null ? null : anchor.getClientRects().length === 0;
}

/** `sidebar.get`:`{ collapsed }`.锚找不到当控件不在. */
export function readSidebar(_frame: ActionFrame): { collapsed: boolean } {
  const collapsed = sidebarCollapsed();
  if (collapsed === null) {
    throw new PageError(ACTION_ERROR_PAGE_CHANGED, `找不到"${NEW_CHAT_LABEL}"`);
  }
  return { collapsed };
}

/** 找开关键并做数量 / 位置校验;对不上就抛 `page-changed`. */
function sidebarToggleButton(collapsed: boolean): HTMLElement {
  const anchor = newChatAnchor();
  let root: HTMLElement | null = anchor?.parentElement ?? null;
  while (root !== null && topIconButtons(root).length < 2) root = root.parentElement;
  const all = root === null ? [] : topIconButtons(root);
  const group = all[0]?.parentElement ?? null;
  const buttons = all.filter((button) => button.parentElement === group);
  const wantCount = collapsed ? 3 : 2;
  if (buttons.length !== wantCount) {
    throw new PageError(
      ACTION_ERROR_PAGE_CHANGED,
      `侧栏顶栏结构不符:${collapsed ? "收起" : "展开"}态顶栏组要恰好 ${wantCount} 颗图标键,实际 ${buttons.length} 颗`,
    );
  }
  return (collapsed ? buttons[0] : buttons[1]) as HTMLElement;
}

/**
 * `sidebar.set`:`{ collapsed: boolean }`.幂等(已在目标态不点不轮询);点完走 `settleTo`,
 * 回达成态.当前态由"开启新对话"锚判出,开关键的位置随之选定(收起取第 1 颗,展开取第 2 颗).
 */
export async function setSidebar(frame: ActionFrame): Promise<{ collapsed: boolean }> {
  const target = frame.params["collapsed"];
  if (typeof target !== "boolean") {
    throw new PageError(ACTION_ERROR_UNKNOWN, "collapsed 必须是布尔");
  }
  const current = readSidebar(frame).collapsed;
  if (current === target) return { collapsed: target };
  sidebarToggleButton(current).click();
  const reached = await settleTo(sidebarCollapsed, target);
  if (reached === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, `找不到"${NEW_CHAT_LABEL}"`);
  return { collapsed: reached };
}

/**
 * 侧栏会话条目:`a[href^="/a/chat/s/"]`,**`href` 末段即会话 id**.标题取条目的
 * `textContent`("更多"按钮只有 svg 没有字,所以整条去空白就是标题)--不靠哈希 class.
 * 真机口径见存证 `sidebar.chat-row`(2026-10-07).
 */
const CHAT_ROW_SELECTOR = 'a[href^="/a/chat/s/"]';

export type ChatRow = {
  readonly id: string;
  readonly title: string;
  readonly current: boolean;
};

function chatRows(): { el: HTMLAnchorElement; row: ChatRow }[] {
  return [...document.querySelectorAll<HTMLAnchorElement>(CHAT_ROW_SELECTOR)].map((el) => {
    const href = el.getAttribute("href") ?? "";
    return {
      el,
      row: {
        id: href.split("/").pop() ?? "",
        title: (el.textContent || "").trim(),
        current: href === location.pathname,
      },
    };
  });
}

/** `chats.list`:侧栏**当前有的**会话,按自上而下的顺序;一条都没有是空数组,不算错. */
export function listChats(_frame: ActionFrame): { chats: ChatRow[] } {
  return { chats: chatRows().map(({ row }) => row) };
}

/**
 * `chat.switch`:`{id}` 或 `{title}` 恰好其一(非空字符串).0 命中 `page-changed`;
 * `title` 命中多条回 `unknown-action`(参数不够指明一条,**宁可拒绝也不替人选一个**);
 * 命中的就是当前会话则不点(幂等).点完**不回读**--站点异步生效,核实用 `page.state` 的 `url`.
 */
export function switchChat(frame: ActionFrame): Record<string, never> {
  const { id, title } = frame.params;
  const given = [id, title].filter((value) => value !== undefined);
  const value = id !== undefined ? id : title;
  if (given.length !== 1 || typeof value !== "string" || value === "") {
    throw new PageError(ACTION_ERROR_UNKNOWN, "chat.switch 要 id 或 title,恰好其一且为非空字符串");
  }
  const wanted = value.trim();
  const hits = chatRows().filter(({ row }) =>
    id !== undefined ? row.id === value : row.title === wanted,
  );
  if (hits.length === 0) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "侧栏上找不到那一条会话");
  if (hits.length > 1) {
    throw new PageError(ACTION_ERROR_UNKNOWN, `标题"${wanted}"命中 ${hits.length} 条,改用 id`);
  }
  const hit = hits[0];
  if (hit !== undefined && !hit.row.current) hit.el.click();
  return {};
}

/**
 * 写作框旁边那两个小开关(#30):站点设计系统的 `div.ds-toggle-button`,状态在
 * `aria-pressed`.**按按钮文字认控件**--文字是本地化的(这里只认中文),认不出当
 * 控件不在,由调用方回 `page-changed`,不猜.
 */
const TOGGLE_SELECTOR = "div.ds-toggle-button";
const THINK_LABEL = "深度思考";
const SEARCH_LABEL = "智能搜索";

/** 按文字找一个开关;`textContent` 前后空白容忍,其余严格相等. */
function findToggle(label: string): HTMLElement | null {
  const entries = document.querySelectorAll<HTMLElement>(TOGGLE_SELECTOR);
  return [...entries].find((entry) => (entry.textContent || "").trim() === label) ?? null;
}

/** 读开关状态:只认 `aria-pressed === "true"` 为开,别的一律算关. */
function readToggleState(el: HTMLElement): boolean {
  return el.getAttribute("aria-pressed") === "true";
}

/** 读一个开关:找不到认得的控件就抛 `page-changed`. */
function readToggleOption(label: string): { enabled: boolean } {
  const el = findToggle(label);
  if (el === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, `找不到"${label}"开关`);
  return { enabled: readToggleState(el) };
}

/** 点完等控件稳定的上限与轮询间隔(毫秒).真机观察站点是几百毫秒内更新状态(#81). */
export const TOGGLE_SETTLE_MS = 1500;
export const TOGGLE_POLL_MS = 50;

/**
 * 点完 **等它稳定**再回**达成态**:每 `TOGGLE_POLL_MS` 读一次,到目标态立刻收,超过
 * `TOGGLE_SETTLE_MS` 就返回当时读到的值(上限内站点不动就当被拒,回未变的值).
 * 站点可能拒它或**异步生效**--回目标态会说谎,**点完立刻读又会把"还没生效"误报成"被拒"**(#81).
 * 超时不抛:"站点拒"与"等不到"下一步相同(再读一次看真值).两个小开关与侧栏开关共用这一处.
 */
async function settleTo<T>(read: () => T, target: T): Promise<T> {
  for (let waited = 0; waited < TOGGLE_SETTLE_MS; waited += TOGGLE_POLL_MS) {
    if (read() === target) return target;
    await new Promise((resolve) => setTimeout(resolve, TOGGLE_POLL_MS));
  }
  return read();
}

/**
 * 把一个开关拨到目标态.**幂等**:已在目标态就不点,不轮询(点了反而拨反);点完走 `settleTo`.
 *
 * `enabled` 非布尔当认不出形状(与主开关 `toggle.set` 同一口径),别把 `"false"`
 * 这种字符串按真值收下.
 */
async function setToggleOption(label: string, frame: ActionFrame): Promise<{ enabled: boolean }> {
  const enabled = frame.params["enabled"];
  if (typeof enabled !== "boolean") {
    throw new PageError(ACTION_ERROR_UNKNOWN, "enabled 必须是布尔");
  }
  const el = findToggle(label);
  if (el === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, `找不到"${label}"开关`);
  if (readToggleState(el) === enabled) return { enabled };
  el.click();
  return { enabled: await settleTo(() => readToggleState(el), enabled) };
}

/** `think.get` / `think.set`:深度思考开关. */
export function readThink(_frame: ActionFrame): { enabled: boolean } {
  return readToggleOption(THINK_LABEL);
}

export function setThink(frame: ActionFrame): Promise<{ enabled: boolean }> {
  return setToggleOption(THINK_LABEL, frame);
}

/** `search.get` / `search.set`:智能搜索开关. */
export function readSearch(_frame: ActionFrame): { enabled: boolean } {
  return readToggleOption(SEARCH_LABEL);
}

export function setSearch(frame: ActionFrame): Promise<{ enabled: boolean }> {
  return setToggleOption(SEARCH_LABEL, frame);
}
