import { describe, expect, it } from "vitest";

import { beginRound, INITIAL_ROUNDS, MAX_CONTINUATION_ROUNDS, resetRounds } from "./rounds";

describe("beginRound", () => {
  it("第一轮放行,轮数从 1 起", () => {
    const verdict = beginRound(INITIAL_ROUNDS);
    expect(verdict.proceed).toBe(true);
    expect(verdict.next.rounds).toBe(1);
  });

  it("连着到上限都放行,到顶那一轮才停手", () => {
    let state = INITIAL_ROUNDS;
    for (let i = 1; i <= MAX_CONTINUATION_ROUNDS; i += 1) {
      const verdict = beginRound(state);
      expect(verdict.proceed).toBe(true);
      expect(verdict.next.rounds).toBe(i);
      state = verdict.next;
    }
    expect(beginRound(state).proceed).toBe(false);
  });

  it("停手的那一次把计数归零:用户开口后重新有满额", () => {
    let state = INITIAL_ROUNDS;
    for (let i = 0; i < MAX_CONTINUATION_ROUNDS; i += 1) state = beginRound(state).next;
    const stopped = beginRound(state);
    expect(stopped.proceed).toBe(false);
    expect(stopped.next).toEqual(INITIAL_ROUNDS);
  });

  it("上限可传参(以后要变成可配走这条路)", () => {
    expect(beginRound({ rounds: 1 }, 2).proceed).toBe(true);
    expect(beginRound({ rounds: 2 }, 2).proceed).toBe(false);
  });
});

describe("resetRounds", () => {
  it("任务收尾与换会话都回到满额", () => {
    expect(resetRounds()).toEqual(INITIAL_ROUNDS);
  });
});
