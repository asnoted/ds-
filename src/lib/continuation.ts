/**
 * 续聊的组装:**短标记进对话,工具结果走出站请求体**.
 *
 * 原来一次工具调用就是一条 `agent:` 开头的长用户消息(TOON 正文全文进对话历史),
 * 一轮一条--会话里全是机器痕迹,而且这条消息是扩展**自己发**的.
 * 参考项目 WebTool-DeepSeek 的做法是:往输入框填一个**短标记**("继续")发出去,
 * 真正给模型看的正文由 main world 在出站请求体里**替换**掉
 * (`core/interceptor/fetch-hook.ts` 的 `pendingContinuationPrompt`).
 * 于是对话里只多一个短气泡,工具结果不进可见流.
 *
 * 这里只管"短标记长什么样"与"给模型的正文长什么样":替换请求体在
 * `inject.ts`(`rewriteContinuationBody`),轮数刹车在 `rounds.ts`.
 * 载荷形状与 TOON 编码仍归 `reply.ts`--正文还是那一段,只是换了条路走.
 */

import { buildReply, type OkPayload } from "./reply";

/**
 * 对话里那个短标记:**首行仍是首行锚**(`agent:` 恰好占第一行,页面侧据此认出
 * "这条是桥发的"--`wait.reply` 与 `prependOnce` 都读它),第二行才是那个词.
 * 两行高度,比起原来那条 TOON 全文的消息,会话里就只剩这么一点痕迹.
 */
export const CONTINUATION_MARKER = "agent:\n继续";

/**
 * 给模型的**一轮**工具结果正文上限(字符).
 *
 * 2000 字时 `read` 一个大文件交出 16000,这里只放 2000 进去,模型看到 12.5% 且
 * **没有任何办法看到其余部分**--ADR-0026 给 `read` 加了翻页之后这个数就放开了:
 * 一页 `read` 自己就有 16000 字的预算(`dsb/work.py` 的 `WORK_READ_BYTES`),这里
 * 与它对齐,于是**一页 `read` 的结果能原样进对话,不再被腰斩**.
 *
 * 一轮最多 8 块围栏(ADR-0015),所以一轮最坏是 8 × 16000;真要那么多字得每块都
 * 读满一页文件,而那种轮次模型自己也不会连着排.
 *
 * 注意这里**不是**网关那道传输与内存的闸(`dsb/gateway.py` 的 64K,ADR-0016):
 * 两道各管一段,别混(ADR-0016 原话).
 */
export const MAX_RESULT_CHARS = 16_000;

/**
 * **本仓的上下文预算:单条输入 900,000 token.**
 *
 * 实测(ADR-0028):站点的硬墙在 **982,000 < 上限 < 982,700 token**
 * (判据是服务端下发的 `finish_reason: "context_length_exceeded"`).
 * **预算取 900,000,那 ~82,000 token 的差额是余量**--余量用来吸收我们
 * 量不到的部分,主要是站点自己的系统提示词(它计入总上下文,但不在
 * 我们这条消息里),服务端按模型/账号下发的浮动,以及上下文压缩.
 *
 * 这段余量为什么该留着:
 *
 * - 服务端那个数**是下发的配置**(同族的 `input_character_limit` 就是
 *   这么来的),发版或灰度就能改,我们没有能力第一时间知道.
 * - DeepSeek 已经有过上下文压缩的先例.真上了压缩,上限的语义会从
 *   "硬拒"变成"静默截断"--那时贴边写就是在赌它不变.
 * - 8 轮刹车下的最坏情况是 8 × 16,000 = 128,000 字(~80,000 token),
 *   离 900,000 还有一个数量级的余量,**这条闸当前不构成约束**;它是
 *   "万一哪天有人要放宽"时必须先看的那个数.
 *
 * 别把它"顺手改成实测值"--那是把余量删掉,不是把精度调准.
 */
export const MAX_SAFE_INPUT_TOKENS = 900_000;

/**
 * 截断一段工具结果正文.超了在尾巴上留一句"已截断",并写明原长--
 * 让模型知道它看到的不是全文,它会据此改问法,而不是拿半截正文当全貌.
 */
export function truncateResult(text: string, max: number = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...(工具结果已截断:原文 ${text.length} 字,这里是前 ${max} 字)`;
}

/** 续聊正文 = 原来的回灌载荷(`agent:` 锚 + TOON),截断之后改走请求体. */
export function buildContinuation(payload: OkPayload, max: number = MAX_RESULT_CHARS): string {
  return buildReply({ status: "ok", answer: truncateResult(payload.answer, max) });
}

/**
 * 这一刻武装还算不算数(期限由调用方给).
 *
 * 期限本身归状态机所有(`armed.ts` 的 `ARMED_TTL_MS`):#49 之后**它不再承担安全
 * 职责**--替换只看"这条出站请求的正文逐字等于短标记"那把钥匙,用户手打的话永远
 * 不会等于标记,与等多久无关.期限只是别让悬挂态挂太久.
 */
export function isArmedFresh(armedAt: number, now: number, ttlMs: number): boolean {
  return now - armedAt <= ttlMs;
}

/** 停手原因的码:进上报(跨三层),人话进悬停. */
export const STOP_CONTINUATION_LIMIT = "continuation-limit";

/** 停手原因 → 一句能直接进悬停的话(留痕的 `cause`). */
export function describeStop(cause: string): string {
  if (cause === STOP_CONTINUATION_LIMIT) {
    return `自动续聊连到上限,停手等用户开口`;
  }
  return `页面报停手(${cause})`;
}
