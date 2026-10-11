/**
 * 出站窗口的计时逻辑(ADR-0002):窗口之间随机等 3~5 秒,到点才放行一次.
 * clock 与 random 全部注入,函数本身不碰时间也不碰随机源.
 */

export const WINDOW_MIN_MS = 3000;
export const WINDOW_MAX_MS = 5000;

export type OutboundWindow = {
  /** 上一次开窗时刻;null 表示还没开过窗. */
  readonly openedAt: number | null;
  /** 到下一次开窗要等多久(毫秒). */
  readonly intervalMs: number;
};

export type WindowStep = {
  readonly window: OutboundWindow;
  readonly opened: boolean;
};

/** 还没开过窗的初始状态:首窗到点即开. */
export function newOutboundWindow(): OutboundWindow {
  return { openedAt: null, intervalMs: 0 };
}

/** 抽下一次开窗间隔:random() ∈ [0, 1] → 3000~5000 毫秒. */
export function drawWindowInterval(random: () => number): number {
  const raw = random();
  const ratio = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  return Math.round(WINDOW_MIN_MS + ratio * (WINDOW_MAX_MS - WINDOW_MIN_MS));
}

/** 此刻该不该开窗:首窗立即开,之后按上一次抽到的间隔等. */
export function isWindowDue(window: OutboundWindow, now: number): boolean {
  if (window.openedAt === null) return true;
  return now - window.openedAt >= window.intervalMs;
}

/** 推进一步:到点就开窗并抽下一个间隔,否则窗口原样不动. */
export function stepOutboundWindow(
  window: OutboundWindow,
  now: number,
  random: () => number,
): WindowStep {
  if (!isWindowDue(window, now)) return { window, opened: false };
  return { window: { openedAt: now, intervalMs: drawWindowInterval(random) }, opened: true };
}
