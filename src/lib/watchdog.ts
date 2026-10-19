/**
 * 链子看门狗(#24):真机两次无人看管的停摆(33 分钟,10.7 小时)都是
 * 网页侧先死--DeepSeek 标签页自己漂回新对话,会话上下文不在,网页模型
 * 不再排围栏;中继和扩展都好好的.看门狗在武装中盯住这件事:
 *
 * - 记住武装后标签页所在的会话 url,它一离开就把它导航回去(漂移是
 *   观察到的死因,所以先于静默处理);
 * - **任务门**(#104):只有"活开着"才有催办资格--回灌把结果交给模型
 *   开一笔活(`watchdogSeenActivity`),模型干净收尾(内容脚本报 end-task)
 *   收掉它(`watchdogTaskClosed`);没事可做的会话结构上一个字都不会发;
 * - 活开着且距上次动静超过静默窗口才催办:每笔活最多 `maxNudges` 条,
 *   送满仍无动静就停手并留痕(ADR-0004);
 * - **连续两笔活都靠催办推进就封掉本武装期**(#104 的兜底):不无限替人
 *   开口,总开关关一次(watches 清空)才解;
 * - 总开关关掉即全停(闹钟与状态都由编排层清掉).
 *
 * 决策全是纯函数:编排层(service worker)只喂"此刻标签页在哪,距上次
 * 动静多久",开活 / 收活与投递在 `background.ts` 里走真执行(单测只测
 * 决策与状态迁移,见 `watchdog.test.ts`).
 *
 * 三个边界:
 *
 * - **站外漂移看不见**:没有 tabs 权限,非本站标签页的 url 读不到--
 *   真机故障正是站内漂到新对话,那一档在扫的范围里;不为它扩权.
 * - **催办计数只认送出去的**:催办走与动作流同一套执行门(总开关 /
 *   替人发言 / 退避),闸拦着时这次不算催,下扫再试--所以决策层不动
 *   计数,由编排层按投递结果增.计数与停手按**笔活**算:开活清零、收活
 *   结账,围栏 / 回灌的动静**不**给预算打折--否则催办惹来的回复会把
 *   上限永远解不开(催办喂活自己,#104).
 * - **正在生成时不插嘴**(#104):临催前读圆键连看三拍,在停止相就只把
 *   静默窗口顺延(`watchdogSeenPassing`),不发消息也不动连催计数.
 */

import { pageSessionIdOf } from "./channel";

/** 看门狗的可配项;默认值是"固定"的那份,storage 可覆写. */
export type WatchdogConfig = {
  /** 静默窗口(毫秒):距上次围栏 / 回灌超过它才催办.默认 15 分钟. */
  readonly silenceMs: number;
  /** 每笔活的连催上限:送出去的催办累计到这么多次仍无动静就停手.默认 2 次. */
  readonly maxNudges: number;
  /** 催办正文:打进取页作框的那句.默认"继续". */
  readonly nudgeText: string;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  silenceMs: 15 * 60_000,
  maxNudges: 2,
  nudgeText: "继续",
};

/** 连续几笔活都靠催办推进,本武装期就整个封掉(#104:不无限替人开口). */
export const MAX_CONSECUTIVE_NUDGED_TASKS = 2;

/** 存储键:存 `WatchdogConfig` 的部分覆写,缺的落默认. */
export const WATCHDOG_CONFIG_STORAGE_KEY = "dsb/watchdog";

/** 一条被武装的 DeepSeek 标签页的看门狗状态. */
export type WatchdogState = {
  /** 记住的会话 url;null = 还没记住(标签页还不在会话页上). */
  readonly sessionUrl: string | null;
  /** 上次围栏或回灌的时刻(毫秒);null = 武装后还没有动静. */
  readonly lastActivityAt: number | null;
  /** 活开着:回灌交了结果而模型还没干净收尾(收尾由内容脚本报 end-task). */
  readonly taskOpen: boolean;
  /** 本笔活已送出的催办;开活与收活时归零. */
  readonly nudges: number;
  /** 本笔活已停手:连催到上限仍无动静(开活时归零). */
  readonly stoodDown: boolean;
  /** 连续几笔活是靠催办推进的;干净收尾的活把它清零. */
  readonly nudgedTasks: number;
  /** 本武装期已封:连续 `MAX_CONSECUTIVE_NUDGED_TASKS` 笔活都靠催办推进. */
  readonly sealed: boolean;
};

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  sessionUrl: null,
  lastActivityAt: null,
  taskOpen: false,
  nudges: 0,
  stoodDown: false,
  nudgedTasks: 0,
  sealed: false,
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
 * 记住的会话--观察到的死因),最后判静默;静默里再过任务门:活没收尾
 * 就没资格开口,封了就一个字都不发.`next` 里催办计数不增:
 * 送没送出去决策层不知道,那由编排层按投递结果增(见模块头"三个边界").
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
    // 任务门(#104):模型自己收尾了(end-task 上报)= 这条会话没事可做,
    // 再安静也不开口--催出去的「继续」是纯垃圾,还会引它再回一句.
    if (!next.taskOpen) return { act: { kind: "nothing" }, next };
    // 已封(连续两笔活都靠催办推进)与本笔活已停手:都不再催.
    if (next.sealed || next.stoodDown) return { act: { kind: "nothing" }, next };
    if (next.nudges >= config.maxNudges) {
      return { act: { kind: "stand-down" }, next: { ...next, stoodDown: true } };
    }
    return { act: { kind: "nudge", text: config.nudgeText }, next };
  }
  return { act: { kind: "nothing" }, next };
}

/**
 * 回灌落地(答复送回内容脚本)= **开一笔活**:结果已经交到模型手上,
 * 球在它那边;刷新动静时刻,收活前的连催预算从这里归零.
 *
 * 已经在活里(同笔活的第二次落地)只刷新时刻,不动预算--预算按笔活算,
 * 给它打折就又回到"催办惹来的回复把上限解开"的老路(#104).
 * 会话 url 不动:动静可能正来自被拉回后的会话.
 */
export function watchdogSeenActivity(state: WatchdogState, now: number): WatchdogState {
  const base: WatchdogState = { ...state, lastActivityAt: now };
  if (state.taskOpen) return base;
  return { ...base, taskOpen: true, nudges: 0, stoodDown: false };
}

/**
 * **路过动静**:页面正在输出(圆键在"停止"相)、围栏出门、整轮作废--
 * 都只把静默窗口往后推,既不改活也不动预算.
 *
 * 与 `watchdogSeenActivity` 的分家是 #104 的要害:这些动静证明页面活着,
 * 但多半是催办自己惹来的回复--拿它解计数,三次封顶就永远到不了;
 * 而"回灌交没交出去"才决定该不该有下一笔回催的资格.
 */
export function watchdogSeenPassing(state: WatchdogState, now: number): WatchdogState {
  return { ...state, lastActivityAt: now };
}

/**
 * 收活(内容脚本报 end-task:这一轮答复没有围栏 = 模型干净收尾;续聊到顶
 * 停手也算收活):**结账**--本笔活的连催与停手清零;这笔回催过就给
 * `nudgedTasks` 记一笔(连续两笔封掉,#104),干净收尾的活把连续笔数清零.
 *
 * 活没收尾时收到收尾上报是重复的,原样返回(收活幂等,别把账记两遍).
 */
export function watchdogTaskClosed(state: WatchdogState): WatchdogState {
  if (!state.taskOpen) return state;
  const streak = state.nudges > 0 ? state.nudgedTasks + 1 : 0;
  return {
    ...state,
    taskOpen: false,
    nudges: 0,
    stoodDown: false,
    nudgedTasks: streak,
    sealed: state.sealed || streak >= MAX_CONSECUTIVE_NUDGED_TASKS,
  };
}

/** 临催前观察窗的形状:几拍采样,拍与拍之间隔多久(`observedOutput`). */
const OUTPUT_WATCH_PASSES = 3;
const OUTPUT_WATCH_GAP_MS = 2_000;

/**
 * 临催前看够再发(#104 真机复跑实测):生成相不是稳态--页面在流式输出里会从
 * "停止"相抖回"发送"相,空档实测有 2~3s,单次采样正好落在空档,就会往跑着的
 * 会话里插一条催办.几拍里只要有一页读到"停止"相就当它还在生成;
 * 读不出来(键认不出 / 回话形状不对)不算--看不见不等于它在说话.
 */
export async function observedOutput(
  read: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let pass = 0; pass < OUTPUT_WATCH_PASSES; pass += 1) {
    if (pass > 0) await sleep(OUTPUT_WATCH_GAP_MS);
    if (await read()) return true;
  }
  return false;
}
