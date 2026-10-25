/**
 * 一轮围栏的处置:截断、坏围栏提示、本地工具就地截获、非 injectable 整轮作废、
 * 同标签页重入护栏,五条语义都在这一处可读可测.
 *
 * 为什么单独一个 module:这些判断原先内联在 `entrypoints/background.ts` 的闭包里,
 * 而它坏了是**整轮工具调用全废**(爆炸半径最大的一处);闭包里的判定单测钉不住
 * (`docs/CODING_STANDARDS.md` 第 1 条).这层只做处置,注入中继调用 / 本地工具 /
 * 时钟与效果出口,效果(在途角标、保活配对、图标结论、看门狗记忆)只声明,
 * 执行(定时器 / browser API)仍在接线侧.
 *
 * 红线:截获点函数仍叫 `sendCall`,位置原样(`parseToolCall` 之后、打网关之前,
 * 旧 0007 点名);本地工具不打中继、不翻中继图标(旧 0002/0007);一轮上限
 * 9 块、排坏的块占一块、连不上才整轮作废(ADR-0002);失败留痕由接线侧的
 * 图标结论落笔(ADR-0004).
 */

import { ACTION_ERROR_TAB_GONE } from "./action";
import { MALFORMED_CALL_HINT, parseToolCall } from "./fence";
import { findLocalTool, type LocalTool } from "./localtools";
import { MAX_CALLS_PER_ROUND, joinCallAnswers, type ToolAnswer, type ToolCall } from "./relay";
import { errorPayload, isInjectableReply, okPayload, type ReplyPayload } from "./reply";

/**
 * 一次"动静"的三种来路:`out` 围栏出门、`void` 整轮作废、`land` 答复落地.
 * 看门狗只有 `land` 拿来开一笔活(回灌真交出去了),另两种只顺延窗口.
 */
export type FenceRoundPhase = "out" | "void" | "land";

/** 一轮围栏处置交给接线侧的效果:模块只声明与推送,执行(定时器 / browser API)在接线侧. */
export type FenceRoundEffect =
  /** 在途角标:一块围栏出门到回话,转速跟着亮灭. */
  | { readonly kind: "in-flight"; readonly on: boolean }
  /** service worker 保活:按住 / 松手,与在途角标成对. */
  | { readonly kind: "keep-alive"; readonly on: boolean }
  /** 图标结论:中继的回话(带 cause,失败留痕由接线侧落笔);只有中继路径才发. */
  | { readonly kind: "icon"; readonly payload: ReplyPayload; readonly cause: string | null }
  /** 看门狗记忆:围栏出门、整轮作废、答复落地各记一条动静,phase 说得出是哪种. */
  | {
      readonly kind: "watchdog";
      readonly tabId: number | undefined;
      readonly now: number;
      readonly phase: FenceRoundPhase;
    }
  /** 只吭一声(不进失败痕)的说明,如本地工具的失败码. */
  | { readonly kind: "log"; readonly note: string };

/** 注入口:中继调用、本地工具与时钟都在接线侧,这里只拿形状. */
export type FenceRoundDeps = {
  /** 一块普通围栏打中继:一趟一块,回载荷与图标结论的 cause(中继有回话就是可达). */
  readonly callRelay: (toolCall: ToolCall) => Promise<RelayAnswer>;
  /** 本地工具就地跑(一次 fetch 都不打):接线侧包 `runAction` 那层. */
  readonly runLocal: (
    tool: LocalTool,
    args: Record<string, unknown>,
    tabId: number | undefined,
  ) => Promise<ReplyPayload>;
  /** 时钟:看门狗记动静时刻用. */
  readonly now: () => number;
  /** 效果出口:按发生顺序推送,接线侧照做. */
  readonly apply: (effect: FenceRoundEffect) => void;
};

/** 中继的一趟回话:载荷 + 图标结论的 cause(成功是 null,失败是"为什么"). */
export type RelayAnswer = {
  readonly payload: ReplyPayload;
  readonly cause: string | null;
};

/** 一轮处置的结果:答复载荷 + 这一轮推出去的效果清单(按发生顺序). */
export type FenceRoundResult = {
  readonly payload: ReplyPayload;
  readonly effects: readonly FenceRoundEffect[];
};

export type FenceRound = {
  /** 一轮围栏的处置:几块进来,一份答复载荷出去(整轮作废时是那条失败载荷). */
  handle: (calls: readonly string[], tabId: number | undefined) => Promise<FenceRoundResult>;
};

/** 一块围栏的处置:一条答案(进这一轮的正文),或一个失败载荷(整轮作废,不进对话流). */
type CallOutcome =
  | { readonly ok: true; readonly answer: ToolAnswer }
  | { readonly ok: false; readonly payload: ReplyPayload };

export function createFenceRound(deps: FenceRoundDeps): FenceRound {
  /** 正在跑本地工具的标签页(重入护栏:同一标签页一次只跑一个). */
  const localBusy = new Set<number>();

  /**
   * **本地工具的截获点**--`local-tools` 的 requirement(已退役的 spec, 去处见 旧 0001 决定 6)
   * 与 旧 0007 都按这个名字指着这里
   * (#50:这段以前内联在一轮处置的循环体里,于是两份文档指的是一个不存在的函数:
   * 遵守的人找不到地方,将来谁建个同名函数那条 requirement 就"满足"了而截获在别处;
   * #101 把处置抽进本 module 时,名字与位置原样保住).
   *
   * 位置按当初的契约办:`parseToolCall` **之后**,打网关 **之前**先查 `findLocalTool`,
   * 命中就地跑(`runLocal`,一次 fetch 都不打),未命中交 `callRelay` 打网关.
   * 普通工具路径一字不改.
   */
  async function sendCall(
    call: string,
    tabId: number | undefined,
    emit: (effect: FenceRoundEffect) => void,
  ): Promise<CallOutcome> {
    const toolCall = parseToolCall(call);
    if (toolCall === null) {
      // 排坏了不出门:没问过中继,把改法回灌给模型自己改(坏围栏占一块,别的块照常).
      return { ok: true, answer: { tool: "排坏的围栏", text: MALFORMED_CALL_HINT } };
    }
    const local = findLocalTool(toolCall.tool);
    if (local !== null) {
      // 本地工具:就地跑,一次 fetch 都不打(旧 0007),成败都证明不了中继健不健康.
      if (tabId === undefined) return { ok: false, payload: errorPayload(ACTION_ERROR_TAB_GONE) };
      if (localBusy.has(tabId)) {
        // 重入护栏:回一条可见提示让模型别重排,不并发.
        return {
          ok: true,
          answer: {
            tool: toolCall.tool,
            text: `本地工具 ${local.name} 正在跑(同一标签页一次只跑一个),这条没有执行.`,
          },
        };
      }
      localBusy.add(tabId);
      emit({ kind: "keep-alive", on: true });
      emit({ kind: "in-flight", on: true });
      try {
        const payload = await deps.runLocal(local, toolCall.arguments, tabId);
        if (payload.status === "error") {
          emit({ kind: "log", note: `本地工具 ${local.name} 回 ${payload.error}` });
        }
        if (!isInjectableReply(payload)) return { ok: false, payload };
        return { ok: true, answer: { tool: toolCall.tool, text: payload.answer } };
      } finally {
        localBusy.delete(tabId);
        emit({ kind: "in-flight", on: false });
        emit({ kind: "keep-alive", on: false });
      }
    }
    // 普通工具:一趟一块打中继;保活与在途角标按住 / 松手成对(超时是按请求算的).
    emit({ kind: "keep-alive", on: true });
    emit({ kind: "in-flight", on: true });
    try {
      const { payload, cause } = await deps.callRelay(toolCall);
      emit({ kind: "icon", payload, cause });
      // 连不上 / 答不成样:整轮作废,照旧不进对话流(与单块时一个脾气).
      if (!isInjectableReply(payload)) return { ok: false, payload };
      return { ok: true, answer: { tool: toolCall.tool, text: payload.answer } };
    } finally {
      emit({ kind: "in-flight", on: false });
      emit({ kind: "keep-alive", on: false });
    }
  }

  async function handle(
    calls: readonly string[],
    tabId: number | undefined,
  ): Promise<FenceRoundResult> {
    const effects: FenceRoundEffect[] = [];
    const emit = (effect: FenceRoundEffect): void => {
      effects.push(effect);
      deps.apply(effect);
    };
    // 围栏进了中继 = 页面模型排出了围栏;答复送回 = 回灌落地.两头各是一条动静.
    emit({ kind: "watchdog", tabId, now: deps.now(), phase: "out" });

    const planned = calls.slice(0, MAX_CALLS_PER_ROUND);
    const answers: ToolAnswer[] = [];
    for (const call of planned) {
      const outcome = await sendCall(call, tabId, emit);
      if (!outcome.ok) {
        emit({ kind: "watchdog", tabId, now: deps.now(), phase: "void" }); // 整轮作废,答复(失败载荷)照样送回
        return { payload: outcome.payload, effects };
      }
      answers.push(outcome.answer);
    }

    const dropped = calls.length - planned.length;
    // 收尾那句也算这一轮的额度:不然它落在 16,000 之外,被扩展侧同数的闸切掉的
    // 正是"还有几块没执行"(旧 0010 的同一课).
    const note =
      dropped <= 0
        ? ""
        : `\n\n(这一轮最多执行 ${MAX_CALLS_PER_ROUND} 块围栏,还有 ${dropped} 块没执行--下一轮再排.)`;
    const joined = joinCallAnswers(answers, note.length);
    emit({ kind: "watchdog", tabId, now: deps.now(), phase: "land" });
    return { payload: okPayload(joined + note), effects };
  }

  return { handle };
}
