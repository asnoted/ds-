/**
 * **发送限速**(#61):所有"替用户把消息发出去"的原语,两次触发之间必隔 3~5 秒.
 *
 * 背景:出站窗口(ADR-0002)原先只管**自动续聊**这一路,看门狗催办与 `send.page` 走
 * `runAction`,压根不经过它.于是站点那边看到的是"一次 `send.page` 和一次续聊可能在
 * 一秒内连发"--同一账号,短时间,多条用户消息,正是阶梯处罚盯上的行为面.
 *
 * 口径与出站窗口**同一个区间**(沿用 `outbound.ts` 的 `WINDOW_MIN_MS` / `WINDOW_MAX_MS`),
 * 但**不共用状态**:这里记的是"最近一次发送时刻",两处独立计时,语义也不同(那边是
 * 队列放行,这边是原语节流).
 *
 * 三条口径:
 *
 * - **等,不拒**:间隔不够就**等**够,绝不拒绝,绝不新增失败码(#61 原票口径).调用方
 *   等完照发,agent 侧看不出差别.
 * - **"停止"永不延迟**:圆键那一下可能是发送,也可能是中断生成(真机 2026-10-05:
 *   class 一个不换,只有图标 `d` 换).判出是 `stop` 就不等;**判不出也不等**--
 *   宁可少限一次速,也不能延迟一次中断.
 * - **记发送比限速更保守**:点过圆键但认不出意图时,照样记一笔"可能发出去了",
 *   宁可之后多等一次,也不漏记一次发送.
 */

import { drawWindowInterval } from "./outbound";

/** 哪一侧世界记的(跨世界同步用,见 `sendNoteMessage`). */
export type SendWorld = "main" | "isolated";

/**
 * 发送节流状态.`lastSentAt` 是**最近一次发送**的时刻--两个世界各记各的,收到对方
 * 的通报就取较晚的那个(`mergeSendPace`).
 */
export type SendPace = {
  readonly lastSentAt: number | null;
  /** 上次抽到的间隔(毫秒),下次按它算还差多久. */
  readonly intervalMs: number;
};

/** 初始态:还没发过,第一次不等. */
export function newSendPace(): SendPace {
  return { lastSentAt: null, intervalMs: 0 };
}

/**
 * 记一次发送:落时刻,并抽下一个间隔(与出站窗口同一区间).
 *
 * 不校验"这次是不是隔够了"--调用点已经等过了;这里只管记账.
 */
export function noteSend(pace: SendPace, now: number, random: () => number): SendPace {
  return { lastSentAt: now, intervalMs: drawWindowInterval(random) };
}

/**
 * 还要等多久才够格发(毫秒).0 = 现在就能发.
 *
 * 没发过,或已经隔够,都是 0.**不等负数**:时钟回拨时也当 0,宁可少限一次.
 */
export function sendWaitMs(pace: SendPace, now: number): number {
  if (pace.lastSentAt === null) return 0;
  const waited = now - pace.lastSentAt;
  // 时钟回拨时 waited 为负:这当"隔够"处理(宁可少限一次,也不能凭空多等一个间隔).
  if (waited < 0 || waited >= pace.intervalMs) return 0;
  return pace.intervalMs - waited;
}

/** 这一下到底是不是"发送".圆键那一下可能不是,其余原语恒为 `send`. */
export type SendIntent = "send" | "stop" | "unknown";

/**
 * 发送原语检查点(#61 建,#52 扩):这一下发送要不要等,等多久,要不要记账.
 *
 * 刻意返回**几种结论**而不是一个"放行 / 拒绝":`waitMs` 决定等不等,`paced` 决定这
 * 条原语是否参与限速,`record` 决定发完要不要记一笔.#52 要往这里加第四种结论"拒绝"
 * ("代你发言"闸关着就不许发),届时不必改这三个字段的含义.
 *
 * 三条口径各自对应一种意图:
 *
 * | 意图     | 等   | 记账 |
 * | -------- | ---- | ---- |
 * | `send`   | 等够 | 记   |
 * | `stop`   | 不等 | 不记 |
 * | `unknown`| 不等 | 记   |
 *
 * 最后一行是"记发送比限速更保守":认不出意图时不延迟(那可能是中断生成),但照样记
 * 一笔"可能发出去了"--宁可之后多等一次,也不漏记一次发送.
 */
export type SendVerdict = {
  /** 要等多久才放行;0 = 立即. */
  readonly waitMs: number;
  /** 这条原语是否参与限速;false = 原样放行. */
  readonly paced: boolean;
  /** 发完要不要记一笔"最近一次发送". */
  readonly record: boolean;
};

/** 问一次:这一下发送该等多久,要不要记. */
export function checkSendIntent(pace: SendPace, now: number, intent: SendIntent): SendVerdict {
  if (intent === "stop") return { waitMs: 0, paced: false, record: false };
  if (intent === "unknown") return { waitMs: 0, paced: false, record: true };
  return { waitMs: sendWaitMs(pace, now), paced: true, record: true };
}

/**
 * 问一次(只分"是 / 不是"两口的调用方):确定是发送就等,不确定一律放行.
 *
 * @param isSend 调用方判得准不准--圆键那一下可能不是发送.
 */
export function checkSend(pace: SendPace, now: number, isSend: boolean): SendVerdict {
  return checkSendIntent(pace, now, isSend ? "send" : "unknown");
}

/**
 * 并进另一侧世界报来的"最近一次发送时刻".
 *
 * 只取**较晚**的那个:两个世界各记各的,谁也不覆盖谁(覆盖会把更早那次丢掉,
 * 紧接着的第二下就少等了).通报带回来的间隔一律不采纳--两个世界各抽各的.
 */
export function mergeSendPace(pace: SendPace, otherLastSentAt: number | null): SendPace {
  if (otherLastSentAt === null) return pace;
  if (pace.lastSentAt !== null && pace.lastSentAt >= otherLastSentAt) return pace;
  return { ...pace, lastSentAt: otherLastSentAt };
}

/** 等一会儿.`setTimeout` 在页面与 service worker 里都有;用注入的 sleep 便于测试. */
export type Sleep = (ms: number) => Promise<void>;

/** 默认的等法:真 `setTimeout`. */
export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 一次"过检查点 → 等 → 发 → 记账"的账. */
export type PacedRun<T> = {
  /** 发完之后的新状态(记账过就是新的,没记就是原样). */
  readonly pace: SendPace;
  readonly result: T;
  /** 这一趟实际等了多久(毫秒)--测试断言"两次相隔 ≥3 秒"靠它. */
  readonly waitedMs: number;
};

/**
 * 发送原语过检查点的**完整时序**(#61):问一次 → 等够 → 执行 → 记账.
 *
 * 两个世界共用这一份(隔离世界的名册接线与页面世界的续聊发送),此前两边各写一遍
 * --同一条规则两份实现,迟早漂.抽出来还有个好处:clock / random / sleep 全注入,
 * 于是"连续两次发送实际相隔 ≥3 秒"这种**时序**判据能被单测钉住(接线层闭包里的
 * 时候钉不住,`CODING_STANDARDS.md` 第 1 条).
 *
 * @param readIntent 动手前读一次意图(圆键那一下可能不是发送).
 * @param shouldRecord 发完之后判要不要记一笔:隔离世界**重读**意图(等的时候圆键
 *   可能变成了停止),页面世界看这次有没有真发出去.
 */
export async function runPaced<T>(options: {
  readonly pace: SendPace;
  readonly readIntent: () => SendIntent;
  readonly execute: () => T | Promise<T>;
  readonly shouldRecord: (result: T) => boolean;
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: Sleep;
}): Promise<PacedRun<T>> {
  const verdict = checkSendIntent(options.pace, options.now(), options.readIntent());
  if (verdict.waitMs > 0) await options.sleep(verdict.waitMs);
  const result = await options.execute();
  const pace = options.shouldRecord(result)
    ? noteSend(options.pace, options.now(), options.random)
    : options.pace;
  return { pace, result, waitedMs: verdict.waitMs };
}

/**
 * 发送原语该限速的名单(#61):三种"替用户把消息发出去"的动作.
 *
 * "停止"不在名单里--中断生成不是发送,永不延迟(见本文件开头第二条口径).
 * `composer.type` / `composer.clear` 也不在:只往输入框里写字不算发出去(#52 让它们
 * 出"代你发言"闸,但仍不参与发送限速).
 */
export const SEND_PRIMITIVES: ReadonlySet<string> = new Set([
  "send.enter",
  "button.click",
  "message.retry",
]);
