/**
 * 在途围栏轮的 id 名册:页面世界**只认自己排出去那一轮**的答复(#108).
 *
 * 那条链是页面世界 ↔ 隔离世界的广播(`window.postMessage`),谁的 `result` 都可能落到
 * 页面世界的收信口上.探针(`scripts/page-action.py`)正是用同一条链驱动本地工具的:
 * 它投一条 `call`(id 形如 `probe-send-page-…`,正文是 `send.page`),与一轮真围栏的
 * `call` **在信封上长得一模一样**,答复也一模一样地回来.不认 id 就会把它当成"这一轮的
 * 工具结果回来了"排进续聊,凭空多发一条 `agent:继续`--12:56:03 那笔 `send-failed`
 * 的来路(现场:模型正在答上一条 `继续`,这条撞上去,Enter 与圆键都发不出去).
 *
 * **一轮一次**:同一个 id 再来一次也不再认--重放与重投都挡在这里.
 *
 * 名单有界:FIFO,最多记 `MAX_PENDING_CALLS` 个.漏掉的答复(页面中途重载之类)会把 id
 * 留在名单上,满了挤掉最老的:错认一个旧 id 的代价是"多一轮",不是"吃人说的话",
 * 所以这里取最简单的有界法,不做 TTL.
 */

/** 名单上限:一轮一个,正常情形至多一两个在途;漏掉的答复靠挤掉最老的清出去. */
export const MAX_PENDING_CALLS = 16;

export type FenceCalls = {
  /** 排出去、还没等到答复的围栏轮 id,按排出的先后. */
  readonly pending: readonly string[];
  /** id → 排出去那一刻所在的页面会话;答复回来时用它判这轮续聊归谁. */
  readonly sessions: Readonly<Record<string, string | null>>;
};

export function newFenceCalls(): FenceCalls {
  return { pending: [], sessions: {} };
}

/** 排出一条围栏轮的 `call`:把 id 与当时的会话记上,等它的答复回来认领. */
export function expectResult(
  calls: FenceCalls,
  id: string,
  session: string | null = null,
): FenceCalls {
  const pending = [...calls.pending, id];
  const overflow = pending.length - MAX_PENDING_CALLS;
  const kept = overflow > 0 ? pending.slice(overflow) : pending;
  // 只给还在名单上的 id 留会话:挤掉的那些不会再有答复.
  const sessions: Record<string, string | null> = {};
  for (const keptId of kept) {
    sessions[keptId] = keptId === id ? session : (calls.sessions[keptId] ?? null);
  }
  return { pending: kept, sessions };
}

/** 认领一条 `result` 的结论:名单(收下就划掉那个 id)+ 认不认这条 + 它归属的会话. */
export type ClaimedResult = {
  readonly calls: FenceCalls;
  /** false = 不是我们排出去那一轮(或已经收过了),调用方丢掉它,别排进续聊. */
  readonly accepted: boolean;
  /** 排出这一轮时所在的页面会话(`accepted` 为 false 时是 null). */
  readonly session: string | null;
};

export function claimResult(calls: FenceCalls, id: string): ClaimedResult {
  if (!calls.pending.includes(id)) return { calls, accepted: false, session: null };
  const sessions = { ...calls.sessions };
  const session = sessions[id] ?? null;
  delete sessions[id];
  return {
    calls: { pending: calls.pending.filter((kept) => kept !== id), sessions },
    accepted: true,
    session,
  };
}
