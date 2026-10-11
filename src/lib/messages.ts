import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_READ_FAILED, PageError } from "./action";
import type { ActionFrame } from "./action";
import { parseToolCall } from "./fence";
import { COMPOSER_SELECTOR } from "./page";
import { FRAME_FALLBACK_MS, POLL_INTERVAL_MS, parseWaitSeconds } from "./wait-budget";

/**
 * 读对话(`messages.list` / `messages.last`):**只读页面渲染出来的 DOM**.
 *
 * #20 的口径(2026-10-01 改过一次):数据源只有渲染出来的内容--不 hook 站点的请求或
 * 响应体,不解析它的消息 JSON,不直连站点接口.上一版走 `history_messages` 响应体拦截,
 * 已撤回;这里从头到尾只碰 DOM.
 *
 * 真机结构(2026-10-02 从站点页面抄的,页面 `meta[name=commit-id]` 44809ea4):
 *
 * - **消息列表是虚拟列表**:`.ds-virtual-list` → `.ds-virtual-list-items` →
 *   `.ds-virtual-list-visible-items` → 行.只有视口里的行在 DOM(真机上 6 条消息只挂得出
 *   4 行),所以"读超出首屏的部分"= 一屏一屏往下滚,边滚边收;**滚的是哪一层要现场认**
 *   (见 `conversation`),静态看结构定不了;
 * - **行**挂 `data-virtual-list-item-key`(会话内稳定的序号),收的时候拿它去重;
 *   行自己的 class 是哈希(`_9663006` / `_4f9bf79`),**按 #15 的规矩不认它**;
 * - **角色**认设计系统类:助手行有 `.ds-assistant-message-main-content`(正文所在),
 *   用户行没有;用户行的正文包在 `.ds-collapsible-text` 里,连 19 字的短消息也包;
 * - **思考块**是 `.ds-think-content`,与正文**平级**--取正文那个类天然把它排掉,
 *   不必去猜思考块怎么折叠.
 *
 * 认不出的行一律跳过,**不猜角色**:标错角色比读不到更坏,agent 会拿它当上下文.
 */

/** 消息列表那层;认行,以及滚不动时的兜底都落它身上(滚动那层另找,见 `conversation`). */
const LIST_SELECTOR = ".ds-virtual-list";
/**
 * 主聊天区那条列表的修饰类(设计系统类,非哈希).挑"对话那一条"的第二判据--
 * 写作框挪出列表时的兜底,见 `conversationList`.
 */
const PRINTABLE_LIST_SELECTOR = ".ds-virtual-list--printable";
/**
 * 行.两版站点都认:
 * - **老版**:行上挂 `data-virtual-list-item-key`(会话内序号);
 * - **新版**(2026-10-04 起):行上只有哈希 class,**没有 key**,只能按结构认--
 *   `.ds-virtual-list-visible-items`(虚拟列表最里层)的直接子元素.
 *
 * 哈希 class 不碰(见 #15),所以新版只能落到"结构位置"这条路上.`keysOf` 顺带读 key
 * (老版有,新版没有).逗号两条各认各的,新老结构都不挑.
 *
 * **本锚是 #37(f1c6638)为 `wait.*` 加的,当时没同步 `messages.ts` 的收集路径**--两处
 * 自此对不上:无 key 的行 `wait.*` 认,`messages.list` 却整片丢掉(稳定 `page-changed`).
 * #54 把口径收成一条:两条都认,收行身份见 `sweepInto`.
 */
export const ROW_SELECTOR = "[data-virtual-list-item-key], .ds-virtual-list-visible-items > *";
/** 助手正文(设计系统类).有它就是助手,没有再看用户那条路. */
const ASSISTANT_BODY_SELECTOR = ".ds-assistant-message-main-content";
/** 用户正文(设计系统类). */
const USER_BODY_SELECTOR = ".ds-collapsible-text";
/** 消息行的内层包装:有它才说明这行是一条消息(而不是分隔条之类). */
const MESSAGE_SELECTOR = ".ds-message";

/** 一屏一屏往下扫的硬顶:`scrollHeight` 不涨时别白转(真机一屏约几条消息). */
const MAX_SWEEPS = 2_000;

/**
 * 墙钟预算**由 `params.timeout` 定**(见 `parseWaitSeconds`:缺省 25s,钳 `[1, 25]`),
 * 就绪等待与扫描**共用这一份**--就绪花掉的时间从扫描里扣,所以最坏耗时恒等于预算.
 *
 * 为什么不给两个独立预算:那就成了"就绪 5s + 扫描 25s = 30s",正顶着中继
 * `ACTION_TIMEOUT_SECONDS` 的 30s 锁,于是真原因被吞成一句 `timeout`--2026-10-04
 * 差点这么合上去(PR #44 引入就绪等待后,25s 那个"留 5s 余量"的前提就不成立了).
 * 一份预算则余量恒在:上限 25s 恒小于 30s.
 *
 * 25s 这个缺省是量出来的:真机上虚拟列表挂载一屏新行要 ~190ms(≈12 帧,不是 1 帧),
 * 一个 385 条 / 59049px 的对话要扫 80 屏 ≈ 15s.缺省 25s 让它扫得完,又留 5s 余量
 * 让真失败报得出来.
 *
 * ponytail: 这是 O(消息条数) 的成本,一屏一屏等挂载,天花板就在这儿.真嫌慢就得上
 * 别的取法(比如只回摘要,或分页扫),那是另一个设计决定.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 要单独占一行的标签:`textContent` 会把它们首尾相接,不分段就读成一坨. */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

/**
 * 消息角色.`unknown` 是**认不出**时的老实答案(站点换版会让角色线索消失)--
 * 不许猜成 user / assistant:标错角色比读不到更坏(agent 会拿它当上下文).
 */
export type MessageRole = "user" | "assistant" | "unknown";

export type Message = {
  readonly role: MessageRole;
  readonly text: string;
};

/** 两个读对话动作回同一个形状:`last` 就是最多一条的 `list`,空对话两边都 `[]`. */
export type MessageList = {
  readonly messages: readonly Message[];
};

/**
 * 能滚的消息视口.真 DOM 的 `HTMLElement` 结构上就满足;测试里用替身喂出
 * "滚一屏就换一批行"的假虚拟列表(jsdom 不做布局,`clientHeight` 恒为 0).
 */
export type ListViewport = {
  querySelectorAll(selectors: string): ArrayLike<Element>;
  scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
};

/** 视口里此刻挂着的行的 key 序列:拿它当"这一屏换没换"的凭据. */
export function keysOf(view: ListViewport): string {
  const rows = view.querySelectorAll(ROW_SELECTOR);
  let out = "";
  for (let index = 0; index < rows.length; index += 1) {
    out += `${rows[index]?.getAttribute("data-virtual-list-item-key") ?? ""},`;
  }
  return out;
}

/**
 * 等到挂载的行**真的换了**才算这一屏到了.
 *
 * 一帧是不够的:真机上虚拟列表跟手要好几帧才挂上新的窗口(2026-10-02 实测--
 * 一帧一步地扫 80 屏只收到 50 条,而对话有 385 条).`nextFrame` 一等就往下滚,
 * 后面几十屏看到的还是已经收过的行,于是"超出首屏"那条验收静悄悄过不去.
 * `maxFrames` 是上限:到底那一屏换不换都一样,不能白等到天荒地老.
 */
export async function settleUntilMounted(
  view: ListViewport,
  was: string,
  settle: () => Promise<void>,
  maxFrames = 30,
): Promise<void> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await settle();
    if (keysOf(view) !== was) return;
  }
}
/**
 * 等下一帧.
 *
 * **`requestAnimationFrame` 必须配超时兜底**(真机 2026-10-04 撞过):页面**不可见**时
 * 浏览器不产生帧,rAF 回调**永不触发**--裸 rAF 的 `Promise` 就永远挂着,
 * `readMessages` / `readLast` 里的 `settleUntilMounted` 随之卡死,动作永不回话
 * (表现是探针等到超时,CDP 那边一句回包都没有).后台标签页,切换走的标签页都会这样.
 * 所以 rAF 与 `setTimeout` **赛跑**,先到者赢.
 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    // 兜底:不可见页面 rAF 不来,这一路一定在 FRAME_FALLBACK_MS 内收工.
    setTimeout(finish, FRAME_FALLBACK_MS);
  });
}

/**
 * 这一层的直接子元素里有 `<pre>` 吗--**代码块外框**的判据.
 *
 * 真机上代码块外框里除了 `<pre>` 正文,还有表头(语言标签)与复制/下载按钮,都是**同级兄弟**
 * (结构见 `site-dom-anchors.md`"围栏在 DOM 里的样子").所以"这一层直接挂着 `<pre>`"
 * 就等于"这一层是代码块外框"--外框里除了 `<pre>` 一律不算正文.
 */
function hasDirectPre(element: Element): boolean {
  const children = element.children;
  for (let index = 0; index < children.length; index += 1) {
    if (children[index]?.tagName === "PRE") return true;
  }
  return false;
}

function textOf(root: Element): string {
  const parts: string[] = [];
  const walk = (element: Element): void => {
    // 代码块外框:只有 `<pre>` 算正文,其余兄弟(表头 / 按钮 / 图标)是控件.
    // 不排掉它们,读出来的正文会变成"send 复制 下载 ```send ..."--人看的是代码本身.
    const codeBlock = hasDirectPre(element);
    for (const node of element.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        if (codeBlock) continue;
        const raw = node.textContent ?? "";
        // 带换行的纯空白是排版(缩进),不当正文;行内的单个空格要留着,不然词会粘一起.
        if (raw.trim() === "" && raw.includes("\n")) continue;
        parts.push(raw);
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const child = node as Element;
      if (child.tagName === "PRE") {
        // 新版站点(2026-10-04)把 ```send 围栏渲染成**代码块**:表头"send"+
        // 复制/下载按钮 + `<pre>` 正文--原文里的 ``` 标记在 DOM 里没了.读的时候
        // 把它还原成一段围栏:正文能解析成工具调用就写回 ```send,否则写普通的 ```.
        const body = textOf(child);
        parts.push(`\n\`\`\`${parseToolCall(body) === null ? "" : "send"}\n${body}\n\`\`\`\n`);
        continue;
      }
      if (codeBlock) continue; // 表头 / 复制下载按钮 / 图标--控件不是正文
      if (child.tagName === "BR") {
        parts.push("\n");
        continue;
      }
      if (BLOCK_TAGS.has(child.tagName)) {
        parts.push("\n");
        walk(child);
        parts.push("\n");
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return parts
    .join("")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 读渲染要用的两件事:算出来的样式与几何.
 *
 * 留成**可注入的探测口**,因为 jsdom 不做布局--`getBoundingClientRect` 全零,
 * `getComputedStyle` 没有真底色;测试喂替身,真机走 `domProbe`.
 */
export type StyleProbe = {
  readonly style: (el: Element) => {
    readonly backgroundColor: string;
    readonly borderRadius: string;
  };
  readonly rect: (el: Element) => { readonly left: number; readonly right: number };
};

/** 真机探测口:`getComputedStyle` + `getBoundingClientRect`. */
export const domProbe: StyleProbe = {
  style: (el) => {
    const computed = getComputedStyle(el);
    return { backgroundColor: computed.backgroundColor, borderRadius: computed.borderRadius };
  },
  rect: (el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right };
  },
};

/**
 * 判角色用的阈值.数字是 2026-10-04 真机量的(那批 DOM 已随Trellis 迁移删除,证据
 * 散在下面这段注释与 `site-dom` 的"角色三层解析"里):用户气泡 22px 圆,头像 30px 圆
 * → `border-radius` 100px.
 */
const AVATAR_RADIUS_PX = 100; // 头像圆:30px 圆 → border-radius 100px
const BUBBLE_RADIUS_PX = 16; // 气泡 22px;助手内容块 12px(薄边界,取下界留余量)
const EDGE_EPSILON_PX = 2; // 缘对齐容差

/** `border-radius` 可能写成 `12px 12px 0px 0px`;取第一个数. */
function radiusPx(borderRadius: string): number {
  const value = Number.parseFloat(borderRadius);
  return Number.isFinite(value) ? value : 0;
}

/** 这块真的画了底色吗(`rgba(0, 0, 0, 0)` / `transparent` 都算没画). */
function paints(backgroundColor: string): boolean {
  const color = backgroundColor.trim();
  return color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
}

/**
 * 认角色的三层解析,**首个命中为准,认不出不猜**(见 `guides/human-first-thinking-guide.md`):
 *
 * 1. **标记层**:行上还留着站点的设计系统类(助手 `.ds-assistant-message-main-content`,
 *    用户 `.ds-collapsible-text`)→ 直接用(站点换版前的行为,零回归);
 * 2. **渲染层**:人看的是**气泡**--用户消息被画成一个圆角块(真机:22px 圆角,**不满宽**,
 *    旁边还有 30px 圆头像),助手是整宽素文,一个带底色的块都没有.只认**形状 + 位置 + 头像**,
 *    **颜色不作判据**(暗色主题底色全变);
 * 3. 都不中 → `unknown`--**不猜**:标错角色比读不到更坏(agent 会拿它当上下文).
 *
 * 注:站点换版后某套渲染连 `ds-*` 都撤了(`div._81e7b5e`),那时靠第 2 层气泡兜.
 * 载荷(`chat_message_role`)本来也能当源,但那是改 #20 口径的大动作,为一个**没复现**的
 * 病不值,故不做.
 */
export function roleOf(row: Element, probe: StyleProbe = domProbe): MessageRole {
  if (row.querySelector(ASSISTANT_BODY_SELECTOR) !== null) return "assistant";
  if (row.querySelector(USER_BODY_SELECTOR) !== null) return "user";

  const rowBox = probe.rect(row);
  if (rowBox.right - rowBox.left <= 0) return "unknown"; // 没有布局(未挂载 / jsdom)→ 判不了

  const elements = row.querySelectorAll("*");
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element === undefined) continue;
    const { backgroundColor, borderRadius } = probe.style(element);
    if (!paints(backgroundColor)) continue;
    const radius = radiusPx(borderRadius);
    if (radius >= AVATAR_RADIUS_PX) return "user"; // 头像圆
    const box = probe.rect(element);
    const fullWidth = Math.abs(box.left - rowBox.left) <= EDGE_EPSILON_PX;
    if (radius >= BUBBLE_RADIUS_PX && !fullWidth) return "user"; // 气泡:不满宽的圆角块
  }
  return "assistant"; // 没有气泡:整宽素文就是助手(人也是这么看的)
}

/**
 * 一行 → 一条消息.**角色**走 `roleOf` 四层;**正文**优先取标记层的正文块
 * (不含工具条那一圈),没有就取整行文本(`rowText`,含围栏还原).
 *
 * 站点标记层还在(这页有 `.ds-message`),而这行没有 → 不是消息行(分隔条之类),跳过.
 */
export function readRow(row: Element, probe: StyleProbe = domProbe): Message | null {
  const text = rowText(row);
  if (text === null) return null; // 空行不算消息

  const assistant = row.querySelector(ASSISTANT_BODY_SELECTOR);
  if (assistant !== null) return { role: roleOf(row, probe), text: textOf(assistant) };
  const user = row.querySelector(USER_BODY_SELECTOR);
  if (user !== null) return { role: roleOf(row, probe), text: textOf(user) };

  const doc = row.ownerDocument;
  if (
    row.querySelector(MESSAGE_SELECTOR) === null &&
    doc !== null &&
    doc.querySelector(MESSAGE_SELECTOR) !== null
  ) {
    return null; // 标记层还在而这行没有 → 不是消息行
  }
  return { role: roleOf(row, probe), text };
}

/**
 * 一行 → 正文文本(**不看角色**).`wait.*` 只关心正文里有没有围栏 / 回灌首行锚,
 * 不需要角色,所以在没有 role 判据的新版站点上照样能用.空文本回 `null`.
 */
export function rowText(row: Element): string | null {
  const text = textOf(row);
  return text === "" ? null : text;
}

/**
 * 这一层是不是**纵向真能滚**.光看 `scrollHeight > clientHeight` 不够:`overflow: visible`
 * 的元素内容溢出也报这个数(撑出去但不裁剪),它的 `scrollTop` 却是空操作,写下去
 * 对话一动不动,"超出首屏"那条验收照样不过.两样都得占.
 *
 * `clientHeight` 为 0 的层同样不认:看不见的一屏挪不动,扫的时候每轮只按
 * `max(1, clientHeight)` 挪 **1px**,转满 `MAX_SWEEPS` 也扫不完.留着这条是防这种层
 * 混进来--**它不是真机那次超时的原因**(那次的决定性因素是下面 `settleUntilMounted`
 * 那一头),别拿它当已验过的结论.
 */
function scrollsVertically(element: Element): boolean {
  if (element.clientHeight <= 0) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden";
}

/**
 * 存在性判断一律走 `querySelectorAll(...).length`,**不用 `querySelector(...) !== null`**.
 *
 * 起因是 jsdom 的 nwsapi 有一个坑:页面上有**同类兄弟**(两条 `.ds-virtual-list`)且前一条的行
 * 是空的时,任一条的 `querySelector(ROW_SELECTOR)` 都回 null--而 `querySelectorAll` 是对的.
 * 真机 Chrome 没这毛病,但单测得可信,两种 DOM 都成立的写法只有后者.
 */
function hasRow(list: Element): boolean {
  return list.querySelectorAll(ROW_SELECTOR).length > 0;
}

/** 列表里第一行(没有回 null).走 `querySelectorAll` 的理由见 `hasRow`. */
function firstRow(list: Element): Element | null {
  return list.querySelectorAll(ROW_SELECTOR)[0] ?? null;
}

/**
 * 认**对话那一条**虚拟列表.页面上不止一条 `.ds-virtual-list` 时(#54)必须有判据,
 * 不能"拿第一个命中行倒推它最近的列表"--真机 2026-10-05 抓到第二条是右缘一个
 * `position: fixed` 的 34px 窄条展开出来的 240px 面板(3 行,没有 key,没有 `.ds-message`),
 * 倒推正好认了它.
 *
 * 三条判据**按序取首个命中**,都是语义 / 结构锚,**不碰几何**(宽窄,`position` 会随窗口变,
 * 且 spec 明写几何不当主判据):
 *
 * 1. **装着写作框的那一条**--真机 2026-10-05:写作框 `_871cbca` 是主列表的后代,sticky 在底部,
 *    而主区 0 行的那一刻**只有它**认得出对话("你往哪写,哪就是对话").也不依赖行挂没挂.
 * 2. **带 `ds-virtual-list--printable` 的那一条**--设计系统修饰类(非哈希),本仓早把它当主列表
 *    (见 `hasReadableRow` 的注释);写作框挪出列表时的兜底.
 * 3. **有含 `.ds-message` 的行的那一条**--最强的"这行是消息"证据,但真机 2026-10-05 全站
 *    `.ds-message` 为 **0** 个,所以只排最后(排第一会让那个页面直接判死).
 *
 * 三条都不中 → 回 null.**不回退到"第一个命中行的列表"**:那是 #54 挑错列表的来路.
 */
export function conversationList(root: ParentNode): Element | null {
  const lists = root.querySelectorAll(LIST_SELECTOR);
  const candidates: Element[] = [];
  for (let index = 0; index < lists.length; index += 1) {
    const list = lists[index];
    if (list !== undefined) candidates.push(list);
  }
  for (const list of candidates) {
    if (list.querySelectorAll(COMPOSER_SELECTOR).length > 0) return list;
  }
  for (const list of candidates) {
    if (list.matches(PRINTABLE_LIST_SELECTOR)) return list;
  }
  for (const list of candidates) {
    // `.ds-message` 只出现在消息行的内层包装里,所以"列表里有它"="这个列表在放消息行".
    if (list.querySelectorAll(MESSAGE_SELECTOR).length > 0) return list;
  }
  return null;
}

/** 页面上有没有任何虚拟列表正挂着行(判"新对话"用--见 `listMessages`). */
export function anyListHasRows(root: ParentNode): boolean {
  const lists = root.querySelectorAll(LIST_SELECTOR);
  for (let index = 0; index < lists.length; index += 1) {
    const list = lists[index];
    if (list !== undefined && hasRow(list)) return true;
  }
  return false;
}

/**
 * 认出消息列表,以及**真正会滚的那一层**.认不出回 null(新对话,一行都没有).
 *
 * 只在 `conversationList` 认出的**对话列表**里找行(#54)--别的虚拟列表里的行不是对话.
 * 认不出对话列表而页面上**有行** → 当场 `page-changed`(结构变了,当场说,别装作空对话).
 *
 * 滚动发生在哪一层不能靠猜:真机上 `.ds-virtual-list` 是 `display:flex` 容器,底下还压着
 * 写作框,带 `overflow` 的可能是它自己,也可能是它里面的 `.ds-virtual-list-items`.
 * 往上逐层找**真的滚得动**的才动手,找到为止,谁都不滚就落回列表那层(一屏装得下,
 * 扫一遍就够).
 *
 * 只在行的**真祖先**里找,不进到行里面去:消息正文自己那截(长代码块之类)也会滚,
 * 拿它当列表就废了.
 *
 * `wait.*` 也要从文档里认出这一层(`wait.ts`),导出让它复用同一套判据.
 */
export function conversation(root: ParentNode): ListViewport | null {
  const list = conversationList(root);
  if (list === null) {
    const lists = root.querySelectorAll(LIST_SELECTOR);
    for (let index = 0; index < lists.length; index += 1) {
      const other = lists[index];
      if (other !== undefined && hasRow(other)) {
        throw new PageError(ACTION_ERROR_PAGE_CHANGED, "认不出对话列表"); // 结构变了:当场说
      }
    }
    return null; // 一行都没有:新对话
  }
  const row = firstRow(list);
  if (row === null) return null; // 对话列表还一行没挂:交给就绪轮询,不是结构坏了
  for (let element = row.parentElement; element !== null; element = element.parentElement) {
    if (scrollsVertically(element)) return element;
    if (element === list) break;
  }
  return list;
}

/**
 * 把当前挂载的行扫进 `seen`:按身份去重,**挂载时就读走正文**(行卸载后内容会变).
 *
 * **身份两种**(#54):行上挂着 `data-virtual-list-item-key` 就用 key(老版,带符号,
 * 会话内不重复);key 缺失就用**正文**--站点新版(2026-10-04 起)行只剩哈希 class,没有 key,
 * 按 key 过滤等于**一行都收不进**,`messages.list` 便稳定报 `page-changed`.正文口径与
 * `wait.ts` 的基线(`keys` + `texts`)一致:一个仓里两套身份没道理.
 *
 * 正文也空 → 不收(分隔条之类不是消息;`rowText` 返回 `null`).
 *
 * 取舍:两条**正文完全相同**的消息只留第一条.正文当身份就这代价--同一条消息在滚动中
 * 重挂也只会被认成一条(这是要的),代价是内容真的一样时分不出是哪条.实测对话里少见.
 * 想过内容坐标(`rect.top - viewRect.top + scrollTop`)与 DOM 节点身份,前者在 jsdom 里所有
 * rect 都是 0(**单测验不出它多出来的分辨力**),真机上图片加载与折叠思考块会挪坐标反而造重复;
 * 后者在虚拟列表回收复用节点时会把不同消息并成一条.详见 design.md D4.
 */
function sweepInto(view: ListViewport, seen: Map<string, Message>): void {
  const rows = view.querySelectorAll(ROW_SELECTOR);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const text = rowText(row);
    if (text === null) continue; // 分隔条之类:不收
    const identity = row.getAttribute("data-virtual-list-item-key") ?? text;
    if (seen.has(identity)) continue;
    const message = readRow(row);
    if (message !== null) seen.set(identity, message);
  }
}

/**
 * 读全量:先跳到顶,再一屏一屏往下滚,每屏把没见过的行收进来,最后归位.
 * 首次扫描发生在最上面,往下收的顺序就是对话顺序,不用再按键值排序.
 *
 * **一步都挪不动就当场抛**:内容明明超长却滚不动 = 滚动层认错了(结构变了).这时候
 * 手里只有首屏,闷声交上去 agent 会当它是一整段对话--比读不到更坏.闷着转满
 * `MAX_SWEEPS` 更不行:那是几十秒,正好把真原因吞成中继那个 30s 的 `timeout`.
 *
 * `deadline` 是**调用方给的绝对时刻**(`listMessages` 按 `params.timeout` 算好,
 * 就绪等待已经花掉的时间也从里面扣)--所以这里不再自己计一份墙钟.
 * 缺省给一个"很远"的时刻,保留老调用方(`wait.ts` 不走这条;测试可直接调).
 */
export async function readMessages(
  view: ListViewport,
  settle: () => Promise<void> = nextFrame,
  deadline: number = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): Promise<Message[]> {
  const seen = new Map<string, Message>();
  const home = view.scrollTop;
  view.scrollTop = 0;
  if (home !== 0) await settle();
  for (let guard = 0; guard < MAX_SWEEPS; guard += 1) {
    sweepInto(view, seen);
    if (view.scrollTop + view.clientHeight >= view.scrollHeight - 1) break;
    const before = view.scrollTop;
    const was = keysOf(view);
    view.scrollTop += Math.max(1, view.clientHeight);
    await settleUntilMounted(view, was, settle);
    if (view.scrollTop <= before) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "滚不动消息列表");
    // 越往下内容越多(边滚边加载)就会一直不到底;到点收手,别让中继替我们报 timeout
    if (now() >= deadline) throw new PageError(ACTION_ERROR_READ_FAILED, "扫不完这段对话");
  }
  view.scrollTop = home;
  return [...seen.values()];
}

/**
 * 只读最后一条:跳到底扫那一屏就够--最后一条永远躺在最底下那屏里,
 * 犯不着为了它把整段对话滚一遍.
 */
export async function readLast(
  view: ListViewport,
  settle: () => Promise<void> = nextFrame,
): Promise<Message | null> {
  const home = view.scrollTop;
  const was = keysOf(view);
  view.scrollTop = view.scrollHeight;
  await settleUntilMounted(view, was, settle);
  const seen = new Map<string, Message>();
  sweepInto(view, seen);
  view.scrollTop = home;
  return [...seen.values()].at(-1) ?? null;
}

/**
 * 视口里此刻至少有一行读得出正文吗?
 *
 * 这是就绪的**唯一**判据,也是真机实测过的那个:2026-10-04 导航后立刻量,主列表
 * `.ds-virtual-list--printable` 的几何**已完全就绪**(742×1856,`overflow:auto`),
 * 只是**一行都还没挂进来**(`rows: 0`).所以"没就绪"的主症状就是"读不出行".
 *
 * 为什么不再加一条"滚得动":`conversation()` 已经用 `scrollsVertically` 挑过滚动层
 * (`clientHeight > 0` + 认得的 `overflowY`),选出来的层在真机上本就能滚;而在 jsdom 里
 * `clientHeight` 恒 0,`getComputedStyle` 没有真 `overflowY`--再加那条只会把"jsdom 无布局"
 * 误判成"页面没就位",把单测全卡到预算耗尽.滚不滚得动由 `readMessages` 自己的
 * "滚不动消息列表"那条抛点负责(它有真机的几何可看),就绪不必重复挑层.
 */
function hasReadableRow(view: ListViewport): boolean {
  const seen = new Map<string, Message>();
  sweepInto(view, seen);
  return seen.size > 0;
}

/**
 * 在预算内等消息列表**就绪**,回那条视口.
 *
 * "就绪"= **至少一行 `readRow` 读得出正文**.罩住两个抛点的病因:
 * - `lastMessage` 的"认不出消息行"--行挂上了,内容还没渲染时读出;
 * - `readMessages` 的"滚不动消息列表"--一行都读不出时它连第一屏都没得扫.
 *
 * 结构**真的变了**(认不出对话列表,锚点失效)不进轮询,当场抛--
 * 轮询只罩"挂着但没就位",不罩"根本找不到".这是 `wait.ts` 的 `viewWithin`
 * 同一套模式(#37 为 `wait.*` 立的规矩),这里扩到读动作.
 *
 * **为什么这里盯 `conversationList` 而不是 `conversation`**(#54):对话列表此刻 0 行时
 * `conversation()` 回 null,而那是**"还没挂上"**,不是"结构坏了"--该等,不该当场抛.
 * `conversationList` 只管认列表(认得出就等它挂行),认不出才抛;行一旦挂上,下一轮
 * `conversation()` 就从**行**推出真正的滚动层,就绪返回的视口与扫描用的是同一层.
 *
 * `deadline` 由调用方按 `params.timeout` 算好(**与扫描共用一份**,见文件头那段预算说明);
 * `now` / `settle` 是替身口:单测用即时 settle + 假时钟把预算走完,不必真等.
 */
export async function readyWithin(
  deadline: number,
  now: () => number = Date.now,
  settle: () => Promise<void> = sleepPoll,
): Promise<ListViewport> {
  for (;;) {
    if (conversationList(document) === null) {
      throw new PageError(ACTION_ERROR_PAGE_CHANGED, "认不出对话列表"); // 结构变了:当场说
    }
    const view = conversation(document);
    if (view !== null && hasReadableRow(view)) return view;
    if (now() >= deadline) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "消息列表还没就绪");
    await settle();
  }
}

function sleepPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

/**
 * `messages.list`:按序的全部消息(角色 + 文本).新对话一行都没有,回空数组不算错.
 *
 * 预算**只算一次**(`params.timeout`,口径与 `wait.*` 同一个 `parseWaitSeconds`),
 * 就绪等待与扫描共用--所以最坏耗时恒等于预算,恒留中继 30s 锁的余量.
 *
 * **早退看"页面上有没有行",不看 `conversation()`**(#54):`conversation()` 只在对话列表
 * 里有行时才给视口,而 #54 那个页面上对话列表 0 行,另一个虚拟列表(面板)里挂着行--照旧
 * 早退就会把"没就绪"当成"空对话"回 `[]`.现在:哪儿都没行 → 新对话,秒回 `[]`;
 * 别处有行 → 进轮询在对话列表上等,到点读不出才 `page-changed`.
 */
export async function listMessages(frame: ActionFrame): Promise<MessageList> {
  if (!anyListHasRows(document)) return { messages: [] }; // 新对话:一行都没有,不轮询
  const deadline = Date.now() + parseWaitSeconds(frame) * 1_000;
  const view = await readyWithin(deadline);
  const messages = await readMessages(view, nextFrame, deadline);
  // 进得来就说明挂着行(`conversation` 靠一行行找上来的),一条没读到 = 认不出结构.
  if (messages.length === 0) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "认不出消息行");
  return { messages };
}

/**
 * `messages.last`:最后一条.形状与 `list` 一致,最多一条.
 *
 * 同样收 `params.timeout`,同样只算一次预算--不因为"只读最后一屏,不扫全量"就另立特例,
 * 调用方不必记"哪个动作有哪个参数".早退口径与 `list` 同一条(#54).
 */
export async function lastMessage(frame: ActionFrame): Promise<MessageList> {
  if (!anyListHasRows(document)) return { messages: [] };
  const deadline = Date.now() + parseWaitSeconds(frame) * 1_000;
  const view = await readyWithin(deadline);
  const message = await readLast(view);
  if (message === null) throw new PageError(ACTION_ERROR_PAGE_CHANGED, "认不出消息行");
  return { messages: [message] };
}
