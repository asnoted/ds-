/**
 * 一趟续聊的**次序**:事件进(结果到达 / 窗口放行 / 发送出站落定 / 出站请求认领 /
 * 换会话 / 总开关关),裁决出(武装 / 只落草稿 / 发送 / 作废 / 留痕 / 轮数刹车).
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
 * 红线:只管**自动续聊**这一路——另两条发送路不进唯一出站口(ADR-0002);
 * 钥匙仍是短标记逐字相等(ADR-0020);轮数上限与请求体替换口径不动
 * (ADR-0014/0015);失败留痕不进正文(ADR-0004).
 */

import { arm, disarm, idleArmed, type ArmedState } from "./armed";
import { CONTINUATION_MARKER, STOP_CONTINUATION_LIMIT, buildContinuation } from "./continuation";
import { describeContinuationFailure, type ContinuationFailure } from "./continuationfail";
import { beginRound, INITIAL_ROUNDS, resetRounds, type RoundState } from "./rounds";
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
  /** 一次发送 / 落草稿落定:`continuation` 说明这次落定属不属于本趟续聊. */
  | {
      readonly type: "settled";
      readonly continuation: boolean;
      readonly outcome: SettleOutcome;
    }
  /** 一条出站请求走到改写点:按钥匙认领,给出这条请求的处置. */
  | { readonly type: "claimed"; readonly body: string; readonly now: number }
  /** 页面会话 id:换了会话 = 轮数归零 + 待发的那条作废. */
  | { readonly type: "session"; readonly key: string | null }
  /** 闸与总开关的状态(隔离世界广播来的同一份消息). */
  | { readonly type: "toggle"; readonly speak: boolean; readonly enabled: boolean };

/** 认领之后这条出站请求怎么处置(接线侧照着返回 fetch 钩子). */
export type ClaimOutcome =
  /** 正文已换成工具结果(短标记逐字相等,钥匙认领走了). */
  | { readonly kind: "substituted"; readonly body: string }
  /** 不归本趟续聊管:接线侧照旧拼协议说明(ADR-0002 的注入说明). */
  | { readonly kind: "protocol" }
  /** 认领走了但请求体形状认不出:原样放行,连协议说明也不拼. */
  | { readonly kind: "untouched" };

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

/** 结果到达:先问轮数刹车,刹得住才入队(入队不武装,放行才武装). */
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
        note: `自动续聊已连到 ${verdict.next.rounds} 轮上限,停手等用户开口`,
      },
    ]);
  }
  return step({ ...state, rounds: verdict.next, queued: buildContinuation(payload) }, [
    { kind: "enqueue" },
  ]);
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
  return step({ ...state, queued: null, armed: arm(continuation, now) }, [
    { kind: "send", message: CONTINUATION_MARKER, continuation: true },
  ]);
}

/** 发送 / 落草稿落定:没发出去立刻撤武装(留着它,下一个出站会顶掉用户的话). */
function onSettled(state: RunState, continuation: boolean, outcome: SettleOutcome): RunDecision {
  void continuation;
  void outcome;
  return step(state, []);
}

/** 换会话 = 换了条任务:轮数归零,写给上一条会话的待发那条作废. */
function onSession(state: RunState, key: string | null): RunDecision {
  void key;
  return step(state, []);
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
    case "settled":
      return onSettled(state, event.continuation, event.outcome);
    case "session":
      return onSession(state, event.key);
    case "toggle":
      return onToggle(state, event.speak, event.enabled);
    case "claimed":
      return step(state, [], { kind: "protocol" });
  }
}
