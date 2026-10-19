/**
 * 出站窗口的计时逻辑(ADR-0001 管开窗节奏与间隔分布):
 * 窗口之间抽 3~15 秒的 Beta(2,4) 间隔--6 秒处概率最大,3 与 15 两端密度趋于零.
 * clock 与 random 全部注入,函数本身不碰时间也不碰随机源.
 */

export const WINDOW_MIN_MS = 3000;
export const WINDOW_MODE_MS = 6000;
export const WINDOW_MAX_MS = 15000;

/** 采样底数:Beta(2,4) = 5 个均匀数里第 2 小的那个(见 drawWindowInterval). */
const WINDOW_SAMPLE_SIZE = 5;
const WINDOW_SAMPLE_RANK = 2;

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

/**
 * 抽下一次开窗间隔:3~15 秒,6 秒处概率最大,两端(3 与 15)密度趋于零.
 *
 * 分布是 Beta(2,4)(ADR-0001):众数 (2-1)/(2+4-2)=1/4,落回区间正是
 * 3 + 12×1/4 = 6 秒.采样不靠截断也不靠拒绝--**5 个均匀数里第 2 小的那个**
 * 恰好服从 Beta(2,4)(第 k 个次序统计量 ~ Beta(k, n+1-k);k=2, n=5),
 * 于是天然有界,越界与非有限的随机数仍夹进 [0,1] 后照常参与排序.
 */
export function drawWindowInterval(random: () => number): number {
  const draws: number[] = [];
  for (let index = 0; index < WINDOW_SAMPLE_SIZE; index += 1) {
    const raw = random();
    draws.push(Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0);
  }
  draws.sort((left, right) => left - right);
  const ratio = draws[WINDOW_SAMPLE_RANK - 1] ?? 0;
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
