/**
 * 一趟续聊的**次序**:事件进(结果到达 / 窗口放行 / 动手前一刻 / 发送出站落定 /
 * 出站请求认领 / 换会话 / 总开关关),裁决出(武装 / 只落草稿 / 发送 / 作废 / 留痕 / 轮数刹车).
 *
 * 为什么单独一个 module:这些判断原先散在注入内容脚本的闭包里,每一条都出过事
 *(#49 武装时机、#52 闸关仍发送、发送失败撤武装),而闭包里的判定单测钉不住
 *(`docs/CODING_STANDARDS.md` 第 1 条).这里只做**读事件 → 出裁决**,纯函数:
 *不碰 DOM,不碰定时器,不发 postMessage,时钟由事件把 `now` 带进来.
 *
 * 接线侧(注入内容脚本)拿到裁决之后只做三步:存回状态、照效果清单执行
 *(`RunEffect`:入队、发送、落草稿、留痕、停手、总开关生效)、把异步结果
 * 作为新事件喂回来.
 *
 * 红线:只管**自动续聊**这一路——另两条发送路不进唯一出站口(ADR-0001);
 * 钥匙仍是短标记逐字相等(ADR-0002);轮数上限与请求体替换口径不动
 * (ADR-0002);失败留痕不进正文(ADR-0004).
 */

import {
  arm,
  armedBody,
  claimArmed,
  disarm,
  expireIfStale,
  idleArmed,
  pend,
  planContinuation,
  settleArmedAfterSend,
  type ArmedState,
} from "./armed";
import { CONTINUATION_MARKER, STOP_CONTINUATION_LIMIT, buildContinuation } from "./continuation";
import {
  describeContinuationFailure,
  describeThrownFailure,
  type ContinuationFailure,
} from "./continuationfail";
import type { OutgoingShape } from "./inject";
import {
  beginRound,
  INITIAL_ROUNDS,
  MAX_CONTINUATION_ROUNDS,
  resetRounds,
  type RoundState,
} from "./rounds";
import { isInjectableReply, type ReplyPayload } from "./reply";

/** 一趟续聊的全部状态:接线侧只存这一个值,不再散着记武装 / 轮数 / 会话. */
export type RunState = {
  /** 武装状态机(`armed.ts`):idle / armed(有 TTL)/ pending(等用户按发送). */
  readonly armed: ArmedState;
  /** 这条任务已经自动续了几轮(`rounds.ts` 的刹车). */
  readonly rounds: RoundState;
  /** 已入队、还没到出站窗口的续聊正文;放行那一刻才武装. */
  readonly queued: string | null;
  /** 上一次见过的页面会话 id:换了会话 = 换了条任务. */
  readonly session: string | null;
  /** "代你发言"闸:关 = 放行时只落草稿,不发送(#52). */
  readonly speak: boolean;
  /** 总开关:关着时结果到达也不入队. */
  readonly enabled: boolean;
};

export function newRun(): RunState {
  return {
    armed: idleArmed(),
    rounds: INITIAL_ROUNDS,
    queued: null,
    session: null,
    speak: false,
    enabled: false,
  };
}

/** 一轮答复里没有围栏 = 任务收尾:轮数归零,下一次任务重新有满额. */
export function endTask(state: RunState): RunState {
  return { ...state, rounds: resetRounds() };
}

/** 裁决要接线侧执行的效果:全部是副作用(DOM / 定时器 / postMessage),这里只声明. */
export type RunEffect =
  /** 进唯一出站口排队,并排下一次开窗(定时器在接线侧). */
  | { readonly kind: "enqueue" }
  /** 把这条消息发出去;`continuation` = 这是本趟续聊的发送,落定后要喂回 `settled`. */
  | { readonly kind: "send"; readonly message: string; readonly continuation: boolean }
  /** 闸关着:只把短标记写进输入框,**不按发送**;结果喂回 `settled`. */
  | { readonly kind: "stage" }
  /** 失败留痕(ADR-0004):上报一条 `cont-fail`,`cause` 是已拼好的短句. */
  | { readonly kind: "trace"; readonly cause: string }
  /** 刹到轮数上限:上报停手,等用户开口. */
  | { readonly kind: "stop"; readonly cause: string; readonly note: string }
  /** 总开关生效:接线侧装 / 卸 fetch 与 XHR 的包装. */
  | { readonly kind: "apply"; readonly enabled: boolean }
  /** 只吭一声(不进失败痕)的说明. */
  | { readonly kind: "log"; readonly note: string };

/** 发送怎么落定的两种回执:发没发出去(断在哪一步),或者抛了错. */
export type SettleOutcome =
  | { readonly sent: boolean; readonly failure: ContinuationFailure | null }
  | { readonly thrown: unknown };

export type RunEvent =
  /** 中继回灌的结果到达(总开关关着、载荷不可注入时不入队). */
  | { readonly type: "result"; readonly payload: ReplyPayload }
  /** 出站窗口放行了这一条:武装与发送的走向在这一刻定(放行才武装). */
  | { readonly type: "released"; readonly message: string; readonly now: number }
  /**
   * 真动手发送**前一刻**:把武装的时刻改成此刻.限速(#61)可能让这一发在放行之后
   * 再等过一个间隔,而武装的 TTL(`armed.ts` 的 `ARMED_TTL_MS`)该从**真发出去**那一刻起算.
   */
  | { readonly type: "sending"; readonly now: number }
  /** 一次发送 / 落草稿落定:`continuation` 说明这次落定属不属于本趟续聊. */
  | {
      readonly type: "settled";
      readonly continuation: boolean;
      readonly outcome: SettleOutcome;
    }
  /** 一条出站请求走到改写点(形状已在接线侧认过一次):按钥匙认领,给出这条请求的处置. */
  | { readonly type: "claimed"; readonly shape: OutgoingShape; readonly now: number }
  /** 页面会话 id:换了会话 = 轮数归零 + 待发的那条作废. */
  | { readonly type: "session"; readonly key: string | null }
  /** 闸与总开关的状态(隔离世界广播来的同一份消息). */
  | { readonly type: "toggle"; readonly speak: boolean; readonly enabled: boolean };

/** 认领之后这条出站请求怎么处置(接线侧照着返回 fetch 钩子). */
export type ClaimOutcome =
  /** 正文已换成工具结果(短标记逐字相等,钥匙认领走了). */
  | { readonly kind: "substituted"; readonly body: string }
  /** 不归本趟续聊管:接线侧照旧拼协议说明(ADR-0001 的注入说明);钥匙不符与形状认不出都落这里. */
  | { readonly kind: "protocol" };

export type RunDecision = {
  readonly state: RunState;
  readonly effects: readonly RunEffect[];
  /** 只有 `claimed` 事件才有;其余一律 null. */
  readonly claim: ClaimOutcome | null;
};

function step(
  state: RunState,
  effects: readonly RunEffect[],
  claim: ClaimOutcome | null = null,
): RunDecision {
  return { state, effects, claim };
}

/** 结果到达:入队不武装--放行那一刻才武装(早武装会把用户自己在发的消息顶掉). */
function onResult(state: RunState, payload: ReplyPayload): RunDecision {
  if (!state.enabled) return step(state, []);
  if (!isInjectableReply(payload)) {
    return step(state, [{ kind: "log", note: "中继没问成,失败不进对话流" }]);
  }
  const verdict = beginRound(state.rounds);
  if (!verdict.proceed) {
    return step({ ...state, rounds: verdict.next }, [
      {
        kind: "stop",
        cause: STOP_CONTINUATION_LIMIT,
        note: `自动续聊已连到 ${MAX_CONTINUATION_ROUNDS} 轮上限,停手等用户开口`,
      },
    ]);
  }
  // 上一个窗口到点前又到一份结果:队列里的短标记与正文无关,再排一条只会在放行时多放出
  // 一条没有正文可换的**裸标记**(裸标记会被当成用户自己发的话,还吃下协议说明).
  // 单槽记着最新那份,标记照旧只有一条.
  const effects: RunEffect[] = state.queued === null ? [{ kind: "enqueue" }] : [];
  return step({ ...state, rounds: verdict.next, queued: buildContinuation(payload) }, effects);
}

/**
 * 出站窗口放行:武装放在**这一刻**——从入队到开窗有几秒,期间用户可能自己在
 * 发消息,早武装就会把他的真消息换成工具结果.
 *
 * 闸关着那一支的裁决里**没有发送步**(只有落草稿),接线层照着做就碰不到 Enter(#52).
 */
function onReleased(state: RunState, message: string, now: number): RunDecision {
  const isRun = state.queued !== null && message === CONTINUATION_MARKER;
  if (!isRun) {
    return step(state, [{ kind: "send", message, continuation: false }]);
  }
  const continuation = state.queued;
  const base = { ...state, queued: null };
  if (planContinuation(state.speak).action === "arm-and-send") {
    return step({ ...base, armed: arm(continuation, now) }, [
      { kind: "send", message: CONTINUATION_MARKER, continuation: true },
    ]);
  }
  return step({ ...base, armed: pend(continuation) }, [{ kind: "stage" }]);
}

/**
 * 真动手发送前一刻:把 `armed` 的时刻改成此刻,让 TTL 从**真发出去**那一刻起算.
 *
 * 放行到动手之间,发送限速(#61)可能让我们等过一个间隔(最长 `WINDOW_MAX_MS`),
 * 那段时间没有"等出站请求来认领"这回事--按放行时刻算 TTL,一条合法的续聊会在
 * 我等限速时就过期,结果是被丢进协议说明那一支(工具结果不进对话).
 */
function onSending(state: RunState, now: number): RunDecision {
  if (state.armed.phase !== "armed") return step(state, []);
  return step({ ...state, armed: arm(state.armed.continuation, now) }, []);
}

/** 发送 / 落草稿落定:没发出去立刻撤武装(留着它,下一个出站会顶掉用户的话). */
function onSettled(state: RunState, continuation: boolean, outcome: SettleOutcome): RunDecision {
  if (!continuation) return step(state, []);
  if ("thrown" in outcome) {
    return step({ ...state, armed: disarm(state.armed) }, [
      { kind: "trace", cause: describeThrownFailure(outcome.thrown) },
    ]);
  }
  if (outcome.sent) return step(state, []);
  const effects: RunEffect[] =
    outcome.failure === null
      ? []
      : [{ kind: "trace", cause: describeContinuationFailure(outcome.failure) }];
  return step({ ...state, armed: settleArmedAfterSend(state.armed, false) }, effects);
}

/** 换会话 = 换了条任务:轮数归零,写给上一条会话的待发那条作废. */
function onSession(state: RunState, key: string | null): RunDecision {
  if (key === state.session) return step(state, []);
  const effects: RunEffect[] = [];
  let armed = state.armed;
  // 待发的那条(#52 的 pending 态)写进的是**这条**会话的输入框,到了新会话已经不对话了.
  if (armed.phase === "pending") {
    armed = idleArmed();
    effects.push({ kind: "trace", cause: describeContinuationFailure("session-changed") });
  }
  return step({ ...state, session: key, rounds: resetRounds(), armed }, effects);
}

/**
 * 一条出站请求走到改写点:先看挂着的过没过期,再拿钥匙(`matchesMarker`)认领.
 *
 * 形状由接线侧的 `recognizeOutgoingShape` 认过一次,钥匙比对与正文替换共用它.
 * **钥匙不符与形状认不出是同一条路径**:原样放行走协议说明那一支、武装撤销、留一笔痕
 * (cause 按 `shapeOk` 分,ADR-0004 两种断点仍能区分)--不再有"认领走了却换不进"
 * 的第三种半通组合.用户发的是他自己的话时,协议说明照旧拼(#49).
 */
function onClaimed(state: RunState, shape: OutgoingShape, now: number): RunDecision {
  const before = state.armed;
  const armed = expireIfStale(before, now);
  const effects: RunEffect[] = [];
  if (before.phase === "armed" && armed.phase === "idle") {
    effects.push({ kind: "trace", cause: describeContinuationFailure("armed-expired") });
  }

  const pending = armedBody(armed);
  if (pending === null) {
    return step({ ...state, armed }, effects, { kind: "protocol" });
  }

  const outcome = claimArmed(armed, shape.pendingText);
  const next = outcome.claimed ? shape.replacePending(pending) : null;
  if (next === null) {
    effects.push({
      kind: "trace",
      cause: describeContinuationFailure(shape.shapeOk ? "key-mismatch" : "shape-unknown"),
    });
    return step({ ...state, armed: outcome.state }, effects, { kind: "protocol" });
  }
  return step({ ...state, armed: outcome.state }, effects, { kind: "substituted", body: next });
}

/** 闸与总开关:闸关时挂着的作废;总开关关时整条链(队列 / 武装 / 轮数 / 会话)作废. */
function onToggle(state: RunState, speak: boolean, enabled: boolean): RunDecision {
  let next = state;
  const effects: RunEffect[] = [];
  if (speak !== next.speak) {
    next = { ...next, speak };
    if (!speak) next = { ...next, armed: disarm(next.armed) };
  }
  if (enabled !== next.enabled) {
    next = { ...next, enabled };
    effects.push({ kind: "apply", enabled });
    if (!enabled) {
      if (next.armed.phase !== "idle") {
        effects.push({ kind: "trace", cause: describeContinuationFailure("toggle-off") });
      }
      next = {
        ...next,
        armed: idleArmed(),
        queued: null,
        rounds: resetRounds(),
        session: null,
      };
    }
  }
  return step(next, effects);
}

export function decide(state: RunState, event: RunEvent): RunDecision {
  switch (event.type) {
    case "result":
      return onResult(state, event.payload);
    case "released":
      return onReleased(state, event.message, event.now);
    case "sending":
      return onSending(state, event.now);
    case "settled":
      return onSettled(state, event.continuation, event.outcome);
    case "session":
      return onSession(state, event.key);
    case "toggle":
      return onToggle(state, event.speak, event.enabled);
    case "claimed":
      return onClaimed(state, event.shape, event.now);
  }
}
