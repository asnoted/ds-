/**
 * 续聊的**武装状态机**:这一轮的工具结果什么时候等着被送进出站请求.
 *
 * 为什么要有状态机而不是几个布尔量:武装有一多半时间处在"等站点那条请求"的
 * 悬挂期(用户手打消息,站点响应慢,请求根本没发出去),这期间任何一条出站请求
 * 都可能撞上来.旧写法是 `armedContinuation` + `armedAt` 两个散落的量拼出四种情形,
 * 每加一种(比如 #52 的"待发,等用户按发送")就得重写一遍判据.
 *
 * 这里把它收成**显式的态**,纯逻辑,不碰 DOM 与时钟:
 *
 * - `idle`:没什么等着送;
 * - `armed`:出站窗口刚放行,正文等着下一条出站请求来认领(**有 TTL**);
 * - `pending`(#52):闸关着时正文只写进输入框,等用户自己按发送(**无 TTL**--
 *   钥匙使时间不再是安全判据,等多久都安全).
 *
 * **钥匙**(`matchesMarker`):替换只在"这条出站请求的正文逐字等于短标记"时才发生.
 * 站点把我们写进输入框的那条标记原样发出去,正文才换成工具结果;用户自己手打的
 * 任何话都不等于标记,于是**原样放行并撤销武装**--这是"宁可少一轮,也不能吃人说的话"
 * 那条原则的落点,也是 TTL 能收紧到 10 秒的前提.
 */

import { CONTINUATION_MARKER, isArmedFresh } from "./continuation";

/** 武装挂太久就作废(`armed` 态才有时效;`pending` 不看时间).见 continuation.ts 的说明. */
export const ARMED_TTL_MS = 10_000;

export type ArmedState =
  | { readonly phase: "idle" }
  /** 窗口刚放行,等下一条出站请求认领. */
  | { readonly phase: "armed"; readonly continuation: string; readonly armedAt: number }
  /** 闸关着:正文已写进输入框,等用户自己按发送(无 TTL). */
  | { readonly phase: "pending"; readonly continuation: string };

/** 初始态:没什么等着送. */
export function idleArmed(): ArmedState {
  return { phase: "idle" };
}

/**
 * 武装那一刻:出站窗口放行,正文挂上.
 *
 * 单槽--挂起期间来了新一轮,新挂的顶掉旧的(#52 的 `pending` 同样单槽):
 * 旧的那轮已经没意义了,留着只会让用户某次按发送时发出过期结果.
 */
export function arm(continuation: string, armedAt: number): ArmedState {
  return { phase: "armed", continuation, armedAt };
}

/** 闸关着的那一态:正文留着,等用户按发送.没有 armedAt,因为不看时间. */
export function pend(continuation: string): ArmedState {
  return { phase: "pending", continuation };
}

/** 这一刻有没有正文等着送. */
export function isPendingBody(state: ArmedState): boolean {
  return state.phase !== "idle";
}

/** 这一刻挂着的正文;`idle` 返回 null. */
export function armedBody(state: ArmedState): string | null {
  return state.phase === "idle" ? null : state.continuation;
}

/**
 * `armed` 挂太久(`ARMED_TTL_MS`)就作废,返回 `idle`;其余原样返回.
 *
 * 兜的是"以为发出去了,其实没有"那条缝.钥匙(`matchesMarker`)落地后这条兜底
 * 收紧了一档--挂太久时下一个出站多半不是我们那条,但撤销仍然最省事.
 */
export function expireIfStale(state: ArmedState, now: number): ArmedState {
  if (state.phase !== "armed") return state;
  return isArmedFresh(state.armedAt, now, ARMED_TTL_MS) ? state : idleArmed();
}

/**
 * 归一化到"能不能与短标记逐字相等"的口径:统一换行,去掉首尾空白.
 *
 * 站点与 React 受控输入框在换行与首尾空白上不完全一致(CRLF vs LF,末尾多一个
 * `\n`),归一化之后**其余字符仍严格相等**--不多不少地放宽这一点.
 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * 这段正文是不是我们那条短标记(**钥匙**).
 *
 * 只有逐字等于标记才返回 true:用户手打的消息,粘贴进来的内容,带协议说明的历史
 * 回放,全都不是标记,也全都不该被工具结果顶掉.
 */
export function matchesMarker(text: string): boolean {
  return normalize(text) === normalize(CONTINUATION_MARKER);
}

/**
 * 武装认领一条出站请求的结果.
 *
 * `claimed: false` = 这条请求不是我们那条短标记(或者没有正文等着),**原样放行**,
 * 且武装一并撤销(`idle`)--留着它,下一条出站仍可能撞上,且那个时刻已经不代表
 * 任何意图了.
 *
 * `body` 认领成功时的替换结果:字符串是新的正文,null 表示这条请求的形状认不出
 * (调用方据此撤销武装并留痕,见 `inject.ts` 的 `rewriteContinuationBody`).
 */
export type ArmOutcome = {
  readonly state: ArmedState;
  /** 该替换的正文;null = 原样放行. */
  readonly replacement: string | null;
  /** 认领走了没有(false 时武装已撤销). */
  readonly claimed: boolean;
};

/**
 * 认领一条出站请求.
 *
 * @param body 这条请求里**待发那条用户消息**的正文(调用方负责从载荷里取出来).
 * @param shapeOk 调用方是否认得出这条请求的形状;认不出时即便正文等于标记也不替换.
 */
export function claimArmed(state: ArmedState, body: string | null, shapeOk: boolean): ArmOutcome {
  if (state.phase === "idle") {
    return { state, replacement: null, claimed: false };
  }
  // 正文不是我们那条短标记 → 原样放行,武装撤销(用户自己发了别的话).
  if (body === null || !matchesMarker(body)) {
    return { state: idleArmed(), replacement: null, claimed: false };
  }
  const continuation = state.continuation;
  // 认领走了(无论替换成不成功).形状认不出时 replacement 为 null,调用方撤销武装.
  const replacement = shapeOk ? continuation : null;
  return { state: idleArmed(), replacement, claimed: true };
}

/**
 * 武装被撤掉:发送失败,形状认不出,用户发了别的话,闸被关掉--都回到 `idle`.
 */
export function disarm(state: ArmedState): ArmedState {
  return state.phase === "idle" ? state : idleArmed();
}

/**
 * 发送回来之后,武装怎么落(#49 的验收点).
 *
 * - **发出去** → 留着:站点的出站请求马上会拿钥匙来认领,认领那一步才作废它.
 * - **没发出去**(返回 false / 抛错)→ 立刻撤:留着它,下一个出站就是用户自己发的
 *   消息,正文会被工具结果顶掉(把人说的话吃了,比少一轮严重得多).
 *
 * 抽出来是因为这原本藏在 `flush()` 的 `.then` / `.catch` 闭包里--闭包里的判定单测
 * 钉不住(`CODING_STANDARDS.md` 第 1 条).
 */
export function settleArmedAfterSend(state: ArmedState, sent: boolean): ArmedState {
  return sent ? state : disarm(state);
}

export type ContinuationPlan =
  /** 闸开着:挂 armed(有 TTL),照旧自动发. */
  | { readonly action: "arm-and-send" }
  /** 闸关着:挂 pending(无 TTL),**只写进输入框,不按发送**. */
  | { readonly action: "stage-only" };

/**
 * 排这一趟的走向.
 *
 * @param speak "代你发言"闸当前状态(跨世界从隔离世界广播来的).
 */
export function planContinuation(speak: boolean): ContinuationPlan {
  return speak ? { action: "arm-and-send" } : { action: "stage-only" };
}
