/**
 * 自动续聊的刹车:一条任务里最多自动续几轮.
 *
 * 起因是"量":每执行一次工具就自动替用户发一轮,模型可以一直排围栏,一直续下去,
 * 没有任何上限--而账号在站点那边是被**阶梯处罚**过的(3 天判到 8 天),
 * "发了几条"不是唯一判据,但是唯一能自己压住的东西.
 * 参考项目 WebTool-DeepSeek 的做法直接抄:`MAX_CONTINUATION_ROUNDS = 8`,
 * 到顶就停手,计数归零,等用户开口再继续.
 *
 * 只有纯逻辑:一轮 = 一次"工具结果已到手,要替用户发下一轮".
 * 在哪一轮上刹车由调用方(页面世界)决定,这里不碰时间也不碰存储.
 */

/** 一条任务里最多自动续几轮(对齐参考项目的 8). */
export const MAX_CONTINUATION_ROUNDS = 8;

/** 计数状态:只记"这条任务已经自动续了几轮". */
export type RoundState = {
  readonly rounds: number;
};

/** 满额:还没自动续过. */
export const INITIAL_ROUNDS: RoundState = { rounds: 0 };

export type RoundVerdict = {
  /** 放行这一轮自动续聊,还是停手. */
  readonly proceed: boolean;
  /** 判定后的状态(调用方负责存回去). */
  readonly next: RoundState;
};

/**
 * 要替用户发下一轮之前问一次.
 *
 * 到顶就**停手并归零**:停手是这一轮不发(工具结果留在页面上,等用户开口);
 * 归零是让下一次任务还有满额--与参考项目
 * "`continuationRound >= MAX` 就 `continuationRound = 0`"同一套语义.
 */
export function beginRound(state: RoundState, max: number = MAX_CONTINUATION_ROUNDS): RoundVerdict {
  if (state.rounds >= max) return { proceed: false, next: INITIAL_ROUNDS };
  return { proceed: true, next: { rounds: state.rounds + 1 } };
}

/**
 * 归零.两处用:这一轮答复里没有围栏(任务收尾),页面会话换了(换了条任务).
 * 收尾之所以要归零,是因为"模型答完不收尾,一直排围栏"正是要刹的那件事.
 */
export function resetRounds(): RoundState {
  return INITIAL_ROUNDS;
}
