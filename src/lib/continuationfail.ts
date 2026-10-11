/**
 * 续聊失败的**原因短句**(#51):失败痕里 `cause` 那一格的措辞.
 *
 * 这些短句的唯一收件人是指针悬停那一句--"上次故障 14:49:36(2 分钟前)/ 续聊 /
 * 没找到输入框,30 秒后恢复".所以每条都要能一眼看出**断在哪一步**,且彼此能区分
 * (尤其"没找到输入框""写不进去""发不出去"三种不许合并:它们的修法不同).
 *
 * **正文进不来**(ADR-0004):短句由这里的常量给出,调用点写不出问题,答复,工具
 * 结果或用户消息.`sendToPage` 抛错时只报错误的**类型名**--message 里可能嵌着
 * 用户的东西.
 *
 * **`key-mismatch` 那句为什么不能写成"你发了别的话"**:短标记写进输入框之后是**待发
 * 状态**,用户随后打的任何字都会把它顶掉(受控输入框里必然如此).于是有两种情形在
 * 出站那一刻**长得一模一样**--`pending` 挂着,出站正文不等于标记:用户无视标记发了
 * 自己那条,或者标记先被打字盖掉,用户再发自己那条.只看得出站那一刻分不出来,所以
 * **措辞必须对两种都成立**,并把"可能被打字盖掉了"点出来:指向用户"发了别的话"会
 * 把排查方向整个带偏(#92 真机复现的正是这一种).
 */

/** 失败原因:编码短句进失败痕(也进上报消息). */
export type ContinuationFailure =
  /** 页面里没有站点的输入框(未登录 / 禁言 / 结构变了). */
  | "composer-absent"
  /** 找到输入框了,但写不进去(受控组件不认这次改动). */
  | "composer-unwritable"
  /** 写进去了,Enter 与圆键都没能让站点把消息发出去. */
  | "send-failed"
  /** 认出的请求体形状不对,正文换不进去. */
  | "shape-unknown"
  /** 钥匙不符:站点发出的正文不等于短标记.这一轮续聊丢掉. */
  | "key-mismatch"
  /** 武装挂太久(`ARMED_TTL_MS`)自动作废. */
  | "armed-expired"
  /** 总开关被关掉,续聊整条作废. */
  | "toggle-off"
  /** "代你发言"闸关着,输入框里还有你的草稿--不覆盖,这一轮作废(#52). */
  | "draft-in-composer"
  /** 换了页面会话:待发的那条是写给上一条会话的,作废(#52). */
  | "session-changed";

/** 一句能直接进悬停的话.同样不带任何正文. */
const CAUSES: Readonly<Record<ContinuationFailure, string>> = {
  "composer-absent": "没找到输入框",
  "composer-unwritable": "输入框写不进去",
  "send-failed": "Enter 与发送键都没发出去",
  "shape-unknown": "请求体形状认不出,正文换不进去",
  "key-mismatch": "发出去的正文不是等你的那条短标记(可能被打字盖掉了)",
  "armed-expired": "挂着的续聊过期作废",
  "toggle-off": "总开关关着,续聊作废",
  "draft-in-composer": "你正在打字,没覆盖你的草稿",
  "session-changed": "换了会话,待发的那条作废",
};

/**
 * 原因 → 短句.册子外的码(跨版本残留,拼错)走兜底:照原样带上,不丢--
 * 丢掉的故障在悬停里就变成空白,比一条"未知原因"更难查.
 */
export function describeContinuationFailure(failure: ContinuationFailure | string): string {
  return CAUSES[failure as ContinuationFailure] ?? `页面报续聊失败(${failure})`;
}

/**
 * `sendToPage` 抛错时的原因短句:**只带错误的类型名,不带 message**--
 * message 里可能嵌着用户正在打的东西(ADR-0004:不记正文).
 *
 *     发送过程抛了错(TypeError)
 */
export function describeThrownFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `发送过程抛了错(${name})`;
}
