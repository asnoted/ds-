/**
 * 失败留痕:图标红过,几点红的,什么原因,事后还得查得到.
 *
 * 这份记录存 `storage.local`,所以 service worker 被收走,浏览器重启都丢不了.之前
 * 失败原因只活在内存的悬停标题里--一关窗口就蒸发,用户问"为什么红"没人答得上来.
 *
 * 正文进不来:一条记录只有**时刻 / 环节 / 原因短句**三个字段,原因由中继的错误码或
 * 网络层折算给出,不含问题与答复.
 */

/** 存储键:跟总开关同在 `storage.local`,但各管各的. */
export const FAILURE_LOG_STORAGE_KEY = "ds-/failures";

/** 留多少条:够回看一整天的零星故障,又不至于把 storage 撑大. */
export const FAILURE_LOG_CAP = 20;

/** 失败发生在哪一环--排查方向完全不同,所以必须留. */
export type FailureWhere = "health" | "call" | "watchdog" | "rounds" | "continuation";

export type FailureRecord = {
  /** 故障**开始**的时刻(同一次故障的延续不另起一条). */
  readonly at: number;
  readonly where: FailureWhere;
  /** 一句能直接进悬停的话,如"超时(5000ms 没回)". */
  readonly cause: string;
  /** 下一次探活把图标翻回绿的时刻;还在红着就还没有这个字段. */
  readonly recoveredAt?: number;
};

const WHERE_LABELS: Readonly<Record<FailureWhere, string>> = {
  health: "周期探活",
  call: "工具调用",
  watchdog: "看门狗",
  rounds: "续聊刹车",
  // 续聊这一跳的失败(发不出去,正文换不进去,钥匙不符,武装撤销...).此前这些
  // 只有控制台一行,扩展侧答不出"为什么这轮工具结果没回到模型手上"(#51).
  continuation: "续聊",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判据必须与 `FailureWhere` 逐字对齐:早先这里认 `"status"` / `"send"`(旧链路的环节名),
 * 两个都不在联合里,也没有标签--存量记录一旦带上它们,悬停那行会印出 `undefined`.
 * 顺带把"认不出的一律丢"这条守住:册子外的词不当环节.
 */
function isFailureWhere(value: unknown): value is FailureWhere {
  return (
    value === "health" ||
    value === "call" ||
    value === "watchdog" ||
    value === "rounds" ||
    value === "continuation"
  );
}

/**
 * `storage.local` 里那份 → 记录数组.
 *
 * 存储是外部输入,跟中继那批响应一个脾气:长得不对的一条条丢掉,
 * 不猜也不补--宁可少一条历史,也不要一条会误导的.
 */
export function readFailureLog(raw: unknown): FailureRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: FailureRecord[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const { at, where, cause, recoveredAt } = item;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (!isFailureWhere(where)) continue;
    if (typeof cause !== "string" || cause.trim() === "") continue;
    if (recoveredAt === undefined) {
      records.push({ at, where, cause });
      continue;
    }
    if (typeof recoveredAt !== "number" || !Number.isFinite(recoveredAt)) continue;
    records.push({ at, where, cause, recoveredAt });
  }
  return records.slice(0, FAILURE_LOG_CAP);
}

/**
 * 记一条失败(新的在最前).
 *
 * **同一次故障只记一笔**:最前面那条还没恢复时,不管这次是哪个环节,哪个原因,都
 * 视作同一段红着的时间在延续(探活每 30s,轮询每 3s 会各失败一次)--这时候原地
 * 不动,留下的是故障**开始**的时刻,不是最后一次重试的时刻.否则一次断连就能把
 * 二十条配额在几秒内刷满,真正要看的前因后果全被冲掉.
 *
 * 返回的数组跟入参同一个引用就表示"没新的可记",调用方据此免掉一次存储写.
 */
export function rememberFailure(
  records: readonly FailureRecord[],
  record: FailureRecord,
): FailureRecord[] {
  const head = records[0];
  if (head !== undefined && head.recoveredAt === undefined) return records as FailureRecord[];
  return [record, ...records].slice(0, FAILURE_LOG_CAP);
}

/**
 * 最前面那条还没恢复的,补上恢复时刻.
 *
 * 没有的话原样返回同一个数组--"已经恢复过"是常态,别每次都往存储里写一遍.
 */
export function markLastFailureRecovered(
  records: readonly FailureRecord[],
  at: number,
): FailureRecord[] {
  const head = records[0];
  if (head === undefined || head.recoveredAt !== undefined) return records as FailureRecord[];
  return [{ ...head, recoveredAt: at }, ...records.slice(1)];
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** 时刻 → `14:49:36`(本地时区,跟人看表的习惯一致). */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 某个时刻离现在多久:秒,分钟,小时--再远就不必细算了. */
export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

/** 这次故障持续了多久:`30 秒` / `4 分钟`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

/**
 * 最近一次故障的一句话,进悬停;没出过事就没有这句.
 *
 *     上次故障 14:49:36(2 分钟前)/ 周期探活 / 超时(5000ms 没回),30 秒后恢复
 *
 * 这一句要能独立回答三个问题:几点红的,为什么红的,多久自己绿的.
 */
export function describeLastFailure(records: readonly FailureRecord[], now: number): string | null {
  const head = records[0];
  if (head === undefined) return null;
  const recovered =
    head.recoveredAt === undefined
      ? ",还没恢复"
      : `,${formatDuration(head.recoveredAt - head.at)}后恢复`;
  return `上次故障 ${formatClock(head.at)}(${formatAgo(head.at, now)})/ ${
    WHERE_LABELS[head.where]
  } / ${head.cause}${recovered}`;
}
