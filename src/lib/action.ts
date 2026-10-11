/**
 * 页面动作的执行:谁执行,回什么码.
 *
 * 动作不再有外来的推送面(ADR-0007 的动作流已随问答后端一起废掉,
 * dsb 完全被动)--现在还剩两个调用方:**出站**(看门狗的催办)与
 * **看门狗**(退避闸的探针).执行器(`entrypoints/content.ts` 的名册)
 * 依旧活着:`browser.tabs.sendMessage` 把帧投进目标标签页,当场回一个
 * 同构的 `ActionOutcome`.
 *
 * 每条路都当场回一个册子里的码,没有"不回"这一说:少了这一层,
 * `tab-gone` 会把"标签页没了""没有写作框""页面结构变了""读不完"
 * 四件事说成同一句,agent 只能干瞪眼(2026-10-02 真机:为了知道
 * messages.list 卡在哪一步,只好往产物里塞临时诊断表).
 */

import { gateBackoff, type BackoffState } from "./backoff";
import { isAccountState, type AccountState } from "./page";

/** 权限钉死的那个站点:标签页只认它(manifest 的 host_permissions 同一个域). */
export const DEEPSEEK_HOST = "chat.deepseek.com";

/**
 * background 投给内容脚本的一件动作(与 `protocol/fixtures/action.json`
 * 的请求体同形).
 */
export type ActionFrame = {
  readonly type: "action";
  readonly id: string;
  readonly action: string;
  readonly params: Record<string, unknown>;
  readonly target: string | null;
};

/** `tabs.list` 里的一项:id 是往标签页里执行动作的地址,url 是会话地址. */
export type SessionTab = {
  readonly id: number;
  readonly title: string;
  readonly url: string;
};

/** `chrome.tabs.query` 的最小面:多一个参数都不用(测试喂假的就照这个). */
export type TabsApi = {
  query(query: { currentWindow?: boolean }): Promise<readonly TabCandidate[]>;
};

export type TabCandidate = {
  readonly id?: number;
  readonly title?: string;
  readonly url?: string;
};

/** 执行结果:与中继回给提交方的 `{"ok":true,...}` / `{"ok":false,...}` 同构. */
export type ActionOutcome =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };

/** 失败码:与 `protocol/fixtures/action.json` 的 `errorCodes` 同一份. */
export const ACTION_ERROR_DISABLED = "disabled";
/** 名册有,扩展还没实现的动作:当场说"不认这个名字",别让中继等满 30s 判 timeout. */
export const ACTION_ERROR_UNKNOWN = "unknown-action";
/** 目标标签页不在 / 这一跳没走通(target 认不出,没接执行口,消息没送到内容脚本). */
export const ACTION_ERROR_TAB_GONE = "tab-gone";
/** 账号在站点处罚区(禁言 / 退避中):写动作没推给页面(见 `backoff.ts`). */
export const ACTION_ERROR_BACKING_OFF = "backing-off";
/** 写作框不在:禁言 / 未登录 / 页面没渲染(`page.state` 的 `account` 能说清是哪一种). */
export const ACTION_ERROR_COMPOSER_ABSENT = "composer-absent";
/** 页面还在,但上面找不到认得的那个东西:发送键,停止键,"开启新对话",消息列表. */
export const ACTION_ERROR_PAGE_CHANGED = "page-changed";
/** 读到了也读不完:滚动层认错,或一趟扫不完(成本天花板,见 `messages.ts`). */
export const ACTION_ERROR_READ_FAILED = "read-failed";
/** 等动作(`wait.*`)等到预算耗尽也没等到:目标没来,不是这一跳坏掉. */
export const ACTION_ERROR_TIMEOUT = "timeout";

/**
 * 执行器在页面上"做不到"时抛这个,**抛错原文只进扩展侧日志**--回给中继的只有
 * 上面那三个码.少了这一层,`tab-gone` 会把"标签页没了""没有写作框"
 * "页面结构变了""读不完"四件事说成同一句,agent 只能干瞪眼(2026-10-02 真机:
 * 为了知道 messages.list 卡在哪一步,只好往产物里塞临时诊断表).
 */
export class PageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PageError";
  }
}

/** 不受总开关管的两件动作:开关本身的读写.关掉后还得能把开关翻回来. */
export const TOGGLE_ACTIONS: ReadonlySet<string> = new Set(["toggle.get", "toggle.set"]);

/**
 * "代你发言"闸下的动作:**动写作框的**那些.读(`composer.read`)不受管--
 * 看一眼你写了什么不算替你开口.闸关着时这些一律回 `disabled`.
 */
export const SPEAK_GATED_ACTIONS: ReadonlySet<string> = new Set([
  "composer.type",
  "composer.clear",
  "send.enter",
  // 重新生成:让账号再生成一条回答,等同发送--按最坏拦(同圆键的先例).
  "message.retry",
  // 圆键(`button.click`)可能在发,也可能在停:一律按"可能是替你开口"拦.
  // 闸关着时点击结果**判不出**,保守即正确(2026-10-05 用户定,不按 pressed 动态放行).
  "button.click",
]);

/**
 * "退避"闸下的动作:会改变页面状态的那些(写动作 + 开启新对话).
 * 只读动作(`composer.read` / `messages.*` / `page.state` / `tabs.list` / `button.get`)
 * **不受退避影响**--账号在处罚区时人与 agent 仍要能读处境.
 * 名单是显式的(与 `SPEAK_GATED_ACTIONS` 同一规矩),新增写动作要
 * 记进来;`chat.new` 虽不动写作框,但它开新对话,也是写.
 */
export const BACKOFF_GATED_ACTIONS: ReadonlySet<string> = new Set([
  ...SPEAK_GATED_ACTIONS,
  "chat.new",
  // 切换会话:改页面状态是写;不动写作框,不"代你发言",故不进 speak 闸.
  "chat.switch",
  // 侧栏开关:改页面状态是写;不动写作框,不"代你发言",故不进 speak 闸.
  "sidebar.set",
  // 消息工具栏(除 retry 已在 speak 闸里)与代码块:点了会改页面 / 账号状态,是写;不动写作框.
  "message.copy",
  "message.like",
  "message.dislike",
  "message.read",
  "message.share",
  "code.copy",
  "code.download",
  // 写作框旁的两个开关(#30):会改页面状态,是写动作;但不"代你发言",故不进 speak 闸.
  "think.set",
  "search.set",
]);

/**
 * 执行结果的同构校验:`{ok,result}` / `{ok,error}` 两条,外加别的键
 * (旧协议曾带 `action`,留着也不碍事)都认.
 */
export function isActionOutcome(value: unknown): value is ActionOutcome {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  // `ok:true` 必须带一个非 undefined 的 result:`{ok:true}` 与 `{ok:true,result:undefined}`
  // 都不算成功,别把它们当成功收下.
  if (record["ok"] === true) return record["result"] !== undefined;
  if (record["ok"] === false) {
    return typeof record["error"] === "string" && record["error"] !== "";
  }
  return false;
}

/** 总开关的读写口(`toggle.get` / `toggle.set`);真源是 `storage.local`. */
export type ToggleApi = {
  get(): Promise<boolean>;
  set(value: boolean): Promise<boolean>;
};

export type ActionContext = {
  /** 动作现读总开关:关着不执行,回 `disabled`. */
  readonly enabled: boolean;
  /** "代你发言"闸:关着时动写作框的动作回 `disabled`(见 `SPEAK_GATED_ACTIONS`). */
  readonly speak: boolean;
  /** 退避的持久状态(`backoff.ts`):账号在处罚区时写动作回 `backing-off`. */
  readonly backoff: BackoffState;
  /** 退避状态写回口:判定后由 `runAction` 落盘(重启后仍记得). */
  readonly setBackoff: (next: BackoffState) => Promise<void>;
  readonly tabs: TabsApi;
  /** 总开关读写口;没接上时 `toggle.get/set` 落 `unknown-action`. */
  readonly toggle?: ToggleApi;
  /**
   * target 标签页的执行口:把帧送到那个标签页并拿回结果.
   * 抛错 / 答不上同构载荷都由这一层折成 `tab-gone`(见 `sendMessageSendToTab`),
   * 所以签名收紧成非空的 `ActionOutcome`--`runAction` 只管透传.
   */
  readonly sendToTab?: (tabId: number, frame: ActionFrame) => Promise<ActionOutcome>;
};

/** 这条 url 是不是 chat.deepseek.com 的(认不出的,别的站的一律不算). */
export function isDeepSeekUrl(url: string): boolean {
  try {
    return new URL(url).hostname === DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/**
 * `tabs.list` 执行器:当前打开的 chat.deepseek.com 标签页,每项 `{id, title, url}`.
 *
 * 没有 `id` 的标签页投不进动作(没有地址可投),认不出的 url 直接丢--
 * 少一项也比把别的站混进来强.
 */
export async function listSessionTabs(tabs: TabsApi): Promise<SessionTab[]> {
  const candidates = await tabs.query({});
  const sessions: SessionTab[] = [];
  for (const tab of candidates) {
    if (tab.id === undefined || typeof tab.url !== "string" || !isDeepSeekUrl(tab.url)) continue;
    sessions.push({
      id: tab.id,
      title: typeof tab.title === "string" ? tab.title : "",
      url: tab.url,
    });
  }
  return sessions;
}

/**
 * 退避闸的探针:向 target 标签页问一次 `page.state`,拿账号处境.
 * 问不到(标签页没了 / 回话不合形状)回 null--调用方当场报
 * `tab-gone`(这一跳走不通),不放行:放行在处罚区是往处罚区
 * 堆活,还会把探针自身的故障藏成执行器的错(实测撞过:放行后
 * 执行撞写作框,报成 composer-absent).
 */
async function probeAccount(
  tabId: number,
  frame: ActionFrame,
  sendToTab: (tabId: number, frame: ActionFrame) => Promise<ActionOutcome>,
): Promise<AccountState | null> {
  const outcome = await sendToTab(tabId, {
    type: "action",
    id: `${frame.id}:backoff`,
    action: "page.state",
    params: {},
    target: frame.target,
  });
  if (!outcome.ok) return null;
  const { result } = outcome;
  if (typeof result !== "object" || result === null) return null;
  const account = (result as Record<string, unknown>)["account"];
  return isAccountState(account) ? account : null;
}

/**
 * 一件动作 → 回传什么.**每条路都当场回一个册子里的码,没有"不回"这一说**:
 * 催办这一跳没人接账,就没法知道是"没送到"还是"送到没成".
 *
 * - 总开关关着 → `disabled`;
 * - 名册有,扩展还没实现 → `unknown-action`;
 * - 带了 target 但这一跳走不通(target 不是整数串 / 没接执行口 / 执行口答不出同构载荷)
 *   → `tab-gone`;
 * - `tabs.list` 走 `listSessionTabs`,成功回 `result`.
 */
export async function runAction(
  frame: ActionFrame,
  context: ActionContext,
): Promise<ActionOutcome> {
  // 总开关关着:一律 `disabled`,**但 toggle.* 例外**--开关的读写不该被开关自己挡住.
  if (!context.enabled && !TOGGLE_ACTIONS.has(frame.action)) {
    return { ok: false, error: ACTION_ERROR_DISABLED };
  }
  // "代你发言"闸:动写作框的动作要这个闸开着,读不受管.
  if (SPEAK_GATED_ACTIONS.has(frame.action) && !context.speak) {
    return { ok: false, error: ACTION_ERROR_DISABLED };
  }
  if (frame.target !== null) {
    // 只认纯数字串:`Number()` 太宽--`""` / `" "` 会收成 0,`"1e3"` / `"0x10"` / `"-1"`
    // / `"+1"` 也都不是标签页地址.再收紧到 `Number.isSafeInteger`,超出安全整数的长串一并挡掉.
    const tabId = /^\d+$/.test(frame.target) ? Number(frame.target) : Number.NaN;
    if (!Number.isSafeInteger(tabId) || context.sendToTab === undefined) {
      return { ok: false, error: ACTION_ERROR_TAB_GONE };
    }
    // 退避闸(写动作):账号在处罚区就拦下,只读不受影响.在 speak 闸
    // 之后--开关关着,闸关着先回 `disabled`,次序不翻.
    if (BACKOFF_GATED_ACTIONS.has(frame.action)) {
      const account = await probeAccount(tabId, frame, context.sendToTab);
      // 问不到账号处境 = 这一跳走不通,当场报 **tab-gone**,不放行--
      // 放行在处罚区是往处罚区堆活,而且会把"探针坏了"藏成执行器的错
      // (实测撞过:放行后执行撞写作框,报成 composer-absent).
      if (account === null) {
        return { ok: false, error: ACTION_ERROR_TAB_GONE };
      }
      const verdict = gateBackoff(context.backoff, account, Date.now());
      // 判定后的状态要落盘:到期放行时清掉终点,重启后退避仍记得.
      await context.setBackoff(verdict.next);
      if (!verdict.proceed) {
        return { ok: false, error: ACTION_ERROR_BACKING_OFF };
      }
    }
    return context.sendToTab(tabId, frame);
  }
  if (frame.action === "tabs.list") {
    return { ok: true, result: { tabs: await listSessionTabs(context.tabs) } };
  }
  if (frame.action === "toggle.get" || frame.action === "toggle.set") {
    if (context.toggle === undefined) return { ok: false, error: ACTION_ERROR_UNKNOWN };
    if (frame.action === "toggle.get") {
      return { ok: true, result: { enabled: await context.toggle.get() } };
    }
    const enabled = frame.params["enabled"];
    // 参数不是布尔就不落一个"写成了"的假象:当认不出这个形状.
    if (typeof enabled !== "boolean") return { ok: false, error: ACTION_ERROR_UNKNOWN };
    return { ok: true, result: { enabled: await context.toggle.set(enabled) } };
  }
  return { ok: false, error: ACTION_ERROR_UNKNOWN }; // 名册有,扩展还没实现
}

/**
 * background 那一跳的执行口:`browser.tabs.sendMessage` 会因为标签页没了 / 内容脚本
 * 没注入而抛错,抛错不许冒到调用方的 catch(那会变成笼统的失败),当场折成
 * `tab-gone`;答的形状不是同构载荷同样折掉.
 *
 * 只吃一个 `sendMessage` 最小面:不碰 `browser.*`,测试喂假的就照这个.
 */
export type SendMessage = (tabId: number, frame: ActionFrame) => Promise<unknown>;

export function sendMessageSendToTab(
  sendMessage: SendMessage,
): (tabId: number, frame: ActionFrame) => Promise<ActionOutcome> {
  return async (tabId, frame) => {
    try {
      const response = await sendMessage(tabId, frame);
      return isActionOutcome(response) ? response : { ok: false, error: ACTION_ERROR_TAB_GONE };
    } catch {
      return { ok: false, error: ACTION_ERROR_TAB_GONE };
    }
  };
}
