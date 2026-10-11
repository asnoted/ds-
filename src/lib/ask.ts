/**
 * 网页在等人回(#26):页面模型排了 ```ask 围栏问人,扩展把这笔
 * 挂出来(角标"人"+ 悬停里的问题),人回答之后--页面世界看见
 * 对话继续了--自己清掉.
 *
 * 状态按页面会话分表存 `storage.local`:service worker 被收走,
 * 浏览器重启都丢不了(挂着的"等人回"可能等几小时).正文只记
 * 问题,不记答复,与失败留痕同一口径.
 */

/** 存储键:跟总开关同在 `storage.local`,但各管各的. */
export const ASKS_STORAGE_KEY = "ds-/asks";

/** 一笔挂着的问题:问什么,几点挂的. */
export type PendingAsk = {
  readonly question: string;
  readonly at: number;
};

/** 页面会话 id → 挂着的问题(null 页面会话以空串为键). */
export type PendingAsks = Readonly<Record<string, PendingAsk>>;

/** 角标字:网页在等人回. */
export const ASK_BADGE_TEXT = "人";

/** 悬停里问题正文的上限:问长了裁掉,悬停不是日志. */
const QUESTION_LIMIT = 60;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAsk(value: unknown): value is PendingAsk {
  if (!isPlainObject(value)) return false;
  const question = value["question"];
  const at = value["at"];
  return (
    typeof question === "string" &&
    question.trim() !== "" &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

/**
 * `storage.local` 里那份 → 分表.
 *
 * 存储是外部输入:长得不对的一条条丢掉,不猜不补--
 * 挂一笔认不出的"等人回"比漏挂更误导人.
 */
export function readPendingAsks(raw: unknown): PendingAsks {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, PendingAsk> = {};
  for (const [page, ask] of Object.entries(raw)) {
    if (!isValidAsk(ask)) continue;
    out[page] = ask;
  }
  return out;
}

/**
 * 挂一笔:同一页面会话再问就换成最新这笔(人看到的问题不该是旧的).
 * 问题与时刻都一样(重复上报)就原样返回,调用方据此免一次写.
 */
export function recordPendingAsk(
  asks: PendingAsks,
  page: string | null,
  question: string,
  at: number,
): PendingAsks {
  const key = page ?? "";
  const current = asks[key];
  if (current !== undefined && current.question === question && current.at === at) {
    return asks;
  }
  return { ...asks, [key]: { question, at } };
}

/** 清一笔:对话继续了(人答了或模型自己往下走了),挂着的问题作废. */
export function clearPendingAsk(asks: PendingAsks, page: string | null): PendingAsks {
  const key = page ?? "";
  if (!(key in asks)) return asks;
  const next = { ...asks };
  delete next[key];
  return next;
}

/** 有没有挂着的问题(角标亮"人"的判据). */
export function hasPendingAsk(asks: PendingAsks): boolean {
  return Object.keys(asks).length > 0;
}

/** 悬停里的一句话:几条,最新那条问什么;空表返回 null. */
export function describePendingAsks(asks: PendingAsks): string | null {
  const entries = Object.values(asks);
  if (entries.length === 0) return null;
  const latest = entries.reduce((a, b) => (b.at >= a.at ? b : a));
  const question =
    latest.question.length > QUESTION_LIMIT
      ? `${latest.question.slice(0, QUESTION_LIMIT)}...`
      : latest.question;
  const count = entries.length > 1 ? `(${entries.length} 条)` : "";
  return `网页在等人回${count}:${question}`;
}
