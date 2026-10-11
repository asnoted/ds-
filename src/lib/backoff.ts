import type { AccountState } from "./page";

/**
 * 出站退避(change: backoff-after-mute).
 *
 * 账号在站点处罚区时,写动作不推给页面,当场回 `backing-off`.
 * 判据只来自站点自己给的东西:`page.state` 读出的 `account`
 * (警示条里的处罚句与解封时刻).站点不给的信息一律不猜--
 * `signed-out` / `unknown` 不拦.
 *
 * 三态:正常 / 长休(站点写了解封时刻)/ 退避(没写时刻,阶梯).
 * 长休停到站点写的时刻;退避按阶梯增长并持久化.退避到期不自动
 * 恢复--第一笔写动作先探活(读一次 `account`),写作框真的
 * 回来了才放行.
 */

/** 退避的持久状态:终点时刻(本地毫秒)与第几回退避. */
export type BackoffState = {
  readonly until: number | null;
  /** 第几回退避;0 表示从没退避过(阶梯从第一回 10 分钟起). */
  readonly round: number;
};

/** 持久存储里的键(与总开关,"替人开口"同一存储面). */
export const BACKOFF_STORAGE_KEY = "backoffUntil";

/** 第一回退避 10 分钟,之后每回乘 2,封顶 8 小时. */
const FIRST_BACKOFF_MINUTES = 10;
const MAX_BACKOFF_MINUTES = 8 * 60;

/** 从持久存储读;认不出就当从没退避过(不拿坏数据当退避). */
export function readBackoff(stored: unknown): BackoffState {
  if (typeof stored === "object" && stored !== null) {
    const record = stored as Record<string, unknown>;
    if (typeof record["until"] === "number" && typeof record["round"] === "number") {
      return {
        until: record["until"],
        round: Math.max(0, Math.floor(record["round"])),
      };
    }
  }
  return { until: null, round: 0 };
}

/** 第 `round` 回退避的时长(毫秒). */
export function backoffMs(round: number): number {
  const minutes = Math.min(
    FIRST_BACKOFF_MINUTES * 2 ** Math.max(0, round - 1),
    MAX_BACKOFF_MINUTES,
  );
  return minutes * 60_000;
}

/**
 * 站点写的解封时刻是纯文本(真机上既无 `<time>` 也无 `datetime`),
 * 如"2026 年 10 月 10 日 20:21".按**本地时区**解析--页面上的
 * 时刻就是用户本地时刻.认不出回 null.
 */
export function parseMuteUntil(text: string): number | null {
  const match = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match;
  const when = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const ms = when.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export type GateVerdict = {
  /** 放行还是拦下. */
  readonly proceed: boolean;
  /** 判定后的状态(调用方负责写回持久存储). */
  readonly next: BackoffState;
};

/**
 * 写动作入队前问一次:账号在处罚区就拦.
 *
 * 顺序是有意的:先看退避到没到期(频繁判定不会把终点越推越远),
 * 再看账号--`muted` 才拦,`signed-out` / `unknown` 不猜,不拦.
 * 到期后恰好撞上这次探活读到的 `ready`,才是真解封,放行并清掉
 * 终点;**回次留着**,下次再进处罚区阶梯才乘得上去.
 */
export function gateBackoff(state: BackoffState, account: AccountState, now: number): GateVerdict {
  if (state.until !== null && state.until > now) {
    return { proceed: false, next: state };
  }
  if (account.kind === "muted") {
    if (account.until !== null) {
      const until = parseMuteUntil(account.until);
      // 站点写了时刻:长休到它为止,回次不动.
      if (until !== null) {
        return { proceed: false, next: { until, round: state.round } };
      }
    }
    // 站点没写时刻(或认不出):按退避走阶梯.
    const round = state.round + 1;
    return { proceed: false, next: { until: now + backoffMs(round), round } };
  }
  // 账号不在处罚区:上头的到期检查没拦,探活就是刚做的这次读取.
  return { proceed: true, next: { until: null, round: state.round } };
}
