/**
 * 唯一出站口(GLOSSARY.md):**自动续聊**发消息必须经过的单一出口(ADR-0002).
 *
 * 手动页面动作与看门狗催办走 `runAction`,**不经这里**(#48 实测:`grep "from .../gate"`
 * 全仓只有 `inject.content.ts` 一处).两处文档原先都写着"不存在第二条发送路径",
 * 已按 `continuation` 能力的"出站窗口是'自动续聊'这一路的收口"改对.
 *
 * 内容先进队列,出站窗口(ADR-0002)到点才开,窗口开启时把队列一次性放行,
 * 这条路上窗口之间不发任何消息.窗口的计时与抽间隔全在 `outbound.ts`,这里只管排队与放行.
 *
 * 单来回下队列恒只有一条,但函数按队列写:**续聊**的发送需求只能排进来,不能绕开--
 * 给另两条路也套上窗口是另一个决定(跨世界重构,见 #61).
 */

import {
  drawWindowInterval,
  newOutboundWindow,
  stepOutboundWindow,
  type OutboundWindow,
} from "./outbound";

export type Gate = {
  /** 等着进页面的内容,按进队顺序. */
  readonly queue: readonly string[];
  /** 出站窗口的计时状态. */
  readonly window: OutboundWindow;
};

export type GateStep = {
  readonly gate: Gate;
  /** 这一次开窗放出去的内容(没到点就是空数组). */
  readonly released: readonly string[];
};

export function newGate(): Gate {
  return { queue: [], window: newOutboundWindow() };
}

/**
 * 进队列.第一次有内容等窗口时,把"上一次开窗"记成此刻并抽一个间隔:
 * 首条回灌同样等一个 3~5 秒的窗口,出站节奏从第一条起就落在 ADR-0002 的区间里.
 */
export function enqueue(gate: Gate, message: string, now: number, random: () => number): Gate {
  const queue = [...gate.queue, message];
  const window =
    gate.window.openedAt === null
      ? { openedAt: now, intervalMs: drawWindowInterval(random) }
      : gate.window;
  return { queue, window };
}

/** 到点开窗并把队列一次性放行;没到点窗口原样不动,随机源不消耗. */
export function release(gate: Gate, now: number, random: () => number): GateStep {
  const step = stepOutboundWindow(gate.window, now, random);
  if (!step.opened) return { gate, released: [] };
  return { gate: { queue: [], window: step.window }, released: gate.queue };
}

/** 队列非空时下一次开窗的时刻(毫秒);队列空着就没有要排的定时器. */
export function nextOpenAt(gate: Gate): number | null {
  if (gate.queue.length === 0) return null;
  const { openedAt, intervalMs } = gate.window;
  return openedAt === null ? null : openedAt + intervalMs;
}
