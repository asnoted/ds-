/**
 * 链子看门狗(#24):真机两次无人看管的停摆(33 分钟,10.7 小时)都是
 * 网页侧先死--DeepSeek 标签页自己漂回新对话,会话上下文不在,网页模型
 * 不再排围栏;中继和扩展都好好的.看门狗在武装中盯住这件事:
 *
 * - 记住武装后标签页所在的会话 url,它一离开就把它导航回去(漂移是
 *   观察到的死因,所以先于静默处理);
 * - 距上次围栏 / 回灌超过静默窗口就往页面发一条催办(正文固定,可配);
 * - 连催到上限仍无动静就停手并留痕,不无限催;
 * - 总开关关掉即全停(闹钟与状态都由编排层清掉).
 *
 * 决策全是纯函数:编排层(service worker)只喂"此刻标签页在哪,距上次
 * 动静多久",导航与投递都在 `background.ts` 里走真执行(单测只测决策,
 * 见 `watchdog.test.ts`).
 *
 * 三个边界:
 *
 * - **站外漂移看不见**:没有 tabs 权限,非本站标签页的 url 读不到--
 *   真机故障正是站内漂到新对话,那一档在扫的范围里;不为它扩权.
 * - **催办计数只认送出去的**:催办走与动作流同一套执行门(总开关 /
 *   替人发言 / 退避),闸拦着时这次不算催,下扫再试--所以决策层不动
 *   计数,由编排层按投递结果增.
 * - **正在生成时不插嘴**(#104):临催前读一次圆键,在停止相就只把静默
 *   窗口顺延(`watchdogSeenOutput`),不发消息也不动连催计数--输出多半是
 *   催办自己惹来的回复,连计数一起清就成了"催办喂活自己的动静源".
 */

import { pageSessionIdOf } from "./channel";

/** 看门狗的可配项;默认值是"固定"的那份,storage 可覆写. */
export type WatchdogConfig = {
  /** 静默窗口(毫秒):距上次围栏 / 回灌超过它才催办.默认 15 分钟. */
  readonly silenceMs: number;
  /** 连催上限:送出去的催办累计到这么多次仍无动静就停手.默认 3 次. */
  readonly maxNudges: number;
  /** 催办正文:打进取页作框的那句.默认"继续". */
  readonly nudgeText: string;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  silenceMs: 15 * 60_000,
  maxNudges: 3,
  nudgeText: "继续",
};

/** 存储键:存 `WatchdogConfig` 的部分覆写,缺的落默认. */
export const WATCHDOG_CONFIG_STORAGE_KEY = "ds-/watchdog";

/** 一条被武装的 DeepSeek 标签页的看门狗状态. */
export type WatchdogState = {
  /** 记住的会话 url;null = 还没记住(标签页还不在会话页上). */
  readonly sessionUrl: string | null;
  /** 上次围栏或回灌的时刻(毫秒);null = 武装后还没有动静. */
  readonly lastActivityAt: number | null;
  /** 连催次数:上次动静以来送出去了几回催办. */
  readonly nudges: number;
  /** 已停手:连催到上限仍无动静,本武装期不再催(有动静才复位). */
  readonly stoodDown: boolean;
};

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  sessionUrl: null,
  lastActivityAt: null,
  nudges: 0,
  stoodDown: false,
};

/** 看门狗的一次决定. */
export type WatchdogAct =
  | { readonly kind: "nothing" }
  | { readonly kind: "navigate-back"; readonly url: string }
  | { readonly kind: "nudge"; readonly text: string }
  | { readonly kind: "stand-down" };

export type WatchdogDecision = {
  readonly act: WatchdogAct;
  readonly next: WatchdogState;
};

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `storage.local` 里的部分覆写 → 完整配置.
 *
 * 存储是外部输入:长得不对的字段一律落默认,不猜不补--
 * 宁可按默认跑,也不要按一个会半夜催爆的配置跑.
 */
export function readWatchdogConfig(raw: unknown): WatchdogConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_WATCHDOG_CONFIG;
  }
  const stored = raw as Record<string, unknown>;
  const silenceMs = positiveNumber(stored.silenceMs) ?? DEFAULT_WATCHDOG_CONFIG.silenceMs;
  const rawMax = positiveNumber(stored.maxNudges);
  const maxNudges =
    rawMax !== null && Number.isInteger(rawMax) ? rawMax : DEFAULT_WATCHDOG_CONFIG.maxNudges;
  const nudgeText =
    typeof stored.nudgeText === "string" && stored.nudgeText.trim() !== ""
      ? stored.nudgeText
      : DEFAULT_WATCHDOG_CONFIG.nudgeText;
  return { silenceMs, maxNudges, nudgeText };
}

/**
 * 一次扫描:给此刻的标签页现场,决定拉回 / 催办 / 停手 / 不动.
 *
 * 顺序按真机故障的因果排:先记住会话锚点,再修漂移(标签页离开了
 * 记住的会话--观察到的死因),最后判静默.`next` 里催办计数不增:
 * 送没送出去决策层不知道,那由编排层按投递结果增(见模块头"两个边界").
 */
export function watchdogDecision(
  state: WatchdogState,
  facts: {
    /** 标签页此刻的 url;读不到的一律传 null. */
    readonly tabUrl: string | null;
    /** 现在时刻(毫秒). */
    readonly now: number;
  },
  config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): WatchdogDecision {
  // 扫到会话页且还没记住:记住它--漂移侦测的锚点.
  let next: WatchdogState = state;
  if (
    facts.tabUrl !== null &&
    pageSessionIdOf(facts.tabUrl) !== null &&
    state.sessionUrl === null
  ) {
    next = { ...next, sessionUrl: facts.tabUrl };
  }
  // 漂移:记住过会话,而标签页不在它上面--拉回去(漂去别的会话,
  // 被导航到本站别处都算;停手只停催,不停这条).url 读不到
  // (null)时无从判断,不动--看门狗不按看不见的东西行事.
  if (next.sessionUrl !== null && facts.tabUrl !== null && facts.tabUrl !== next.sessionUrl) {
    return { act: { kind: "navigate-back", url: next.sessionUrl }, next };
  }
  // 静默:距上次围栏 / 回灌超过窗口.还没动静过(null)谈不上静默.
  if (next.lastActivityAt !== null && facts.now - next.lastActivityAt >= config.silenceMs) {
    if (next.stoodDown) return { act: { kind: "nothing" }, next };
    if (next.nudges >= config.maxNudges) {
      return { act: { kind: "stand-down" }, next: { ...next, stoodDown: true } };
    }
    return { act: { kind: "nudge", text: config.nudgeText }, next };
  }
  return { act: { kind: "nothing" }, next };
}

/**
 * 围栏(页面模型排出 send 围栏,问句送进隔离世界)或回灌(答复送回
 * 内容脚本)落地:刷新动静时刻--连催计数与停手随之清零,本武装期
 * 的静默窗口重算.会话 url 不动:动静可能正来自被拉回后的会话.
 */
export function watchdogSeenActivity(state: WatchdogState, now: number): WatchdogState {
  return { ...state, lastActivityAt: now, nudges: 0, stoodDown: false };
}

/**
 * 页面正在输出(圆键在"停止"相):**只把静默窗口往后推**.
 *
 * 与 `watchdogSeenActivity` 的分家是 #104 的要害:输出证明页面活着,但那份
 * 活多半是催办自己惹来的回复--连催计数与停手一起清,三次封顶就永远到不了.
 * 所以这里不碰 `nudges` / `stoodDown`:靠输出续命的会话照旧会在连续三次
 * 催办后停手,链子的真动静(围栏 / 回灌)才享有完整的复位.
 */
export function watchdogSeenOutput(state: WatchdogState, now: number): WatchdogState {
  return { ...state, lastActivityAt: now };
}
