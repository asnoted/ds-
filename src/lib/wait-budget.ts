import type { ActionFrame } from "./action";

/**
 * "等多久"的口径与节奏--**无依赖**,谁都能引.
 *
 * 为什么独立成文件(2026-10-04):`wait.ts` 要用 `messages.ts` 的
 * `ROW_SELECTOR` / `conversation` / `nextFrame`,所以 `messages.ts` **不能再引
 * `wait.ts`**(那是循环依赖,会把 vitest 的模块求值卡死).而 `messages.*` 也需要
 * "预算多大,轮询多快"这套口径(它与 `wait.*` 共用一份预算,见 `messages.ts`
 * 文件头的预算说明).于是这套没有依赖的口径落在这里,两边都引它.
 *
 * 语义仍归"等待"域:本文件只放**纯口径**(几个数 + 一个纯函数),不放行为.
 */

/** 轮询节奏:真机挂载一屏约 190ms,500ms 一问足够看见新行. */
export const POLL_INTERVAL_MS = 500;

/**
 * "一帧"的兜底时长(ms),给 `nextFrame` 用:页面**不可见**时 rAF 不回调,
 * 靠它收工.
 *
 * **必须是一帧的量,不能借用 `POLL_INTERVAL_MS`**(真机 2026-10-04 撞过):
 * `settleUntilMounted` 最多等 30 帧,兜底给 500ms 就是**每屏 15 秒**--
 * `messages.list` 连一屏都扫不完,动作永不回话(比挂死更隐蔽:它"在等").
 * 32ms 约两帧,30 帧封顶约 1s,够虚拟列表跟上手(真机一屏约 190ms).
 */
export const FRAME_FALLBACK_MS = 32;

/** 默认等待预算(秒):中继 30s 的锁内,留 5s 回传余量. */
export const DEFAULT_WAIT_SECONDS = 25;
/** 预算上限(秒):再长就顶到中继的锁上,真失败会被吞成中继的 timeout. */
export const MAX_WAIT_SECONDS = 25;
/** 预算下限(秒):0 和负数按"没配"对待会干等,下限 1s 兜底. */
export const MIN_WAIT_SECONDS = 1;

/**
 * 等待预算:`params.timeout`(秒)可配,非法按默认,钳在上下限之间.
 *
 * `wait.*` 与 `messages.*` **共用这一个口径**(`messages.list` 的就绪等待与扫描
 * 共用同一份预算,见 `messages.ts`)--所以口径只有这一处,两边不会漂移.
 */
export function parseWaitSeconds(frame: ActionFrame): number {
  const wanted = frame.params["timeout"];
  const seconds =
    typeof wanted === "number" && Number.isFinite(wanted)
      ? Math.min(Math.max(wanted, MIN_WAIT_SECONDS), MAX_WAIT_SECONDS)
      : DEFAULT_WAIT_SECONDS;
  return seconds;
}
