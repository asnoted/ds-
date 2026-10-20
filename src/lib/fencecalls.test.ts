import { describe, expect, it } from "vitest";

import { claimResult, expectResult, MAX_PENDING_CALLS, newFenceCalls } from "./fencecalls";

describe("在途围栏轮的 id 名册", () => {
  it("认自己排出去那一轮的答复", () => {
    const calls = expectResult(newFenceCalls(), "send-1");
    const claimed = claimResult(calls, "send-1");
    expect(claimed.accepted).toBe(true);
    expect(claimed.calls.pending).toEqual([]);
  });

  // #108:探针用同一条链驱动本地工具,信封形状与围栏轮一样,只是 id 是它的.
  it("探针那条 `probe-send-page-…` 的答复丢掉,还在等的那一轮不受影响", () => {
    const calls = expectResult(newFenceCalls(), "send-1");
    const claimed = claimResult(calls, "probe-send-page-1792230121000");
    expect(claimed.accepted).toBe(false);
    expect(claimed.calls.pending).toEqual(["send-1"]);
    expect(claimResult(claimed.calls, "send-1").accepted).toBe(true);
  });

  it("一轮一次:同一个 id 再来一次不认(重放 / 重投都挡在这儿)", () => {
    const first = claimResult(expectResult(newFenceCalls(), "send-1"), "send-1");
    expect(first.accepted).toBe(true);
    expect(claimResult(first.calls, "send-1").accepted).toBe(false);
  });

  it("认领时把排出那一轮所在的会话一起还回来", () => {
    const calls = expectResult(newFenceCalls(), "send-1", "s1");
    expect(claimResult(calls, "send-1").session).toBe("s1");
  });

  it("空名单上来的任何答复都不认", () => {
    expect(claimResult(newFenceCalls(), "send-1").accepted).toBe(false);
  });

  it("名单有界:FIFO,满了挤掉最老的,它的答复就不再被认", () => {
    let calls = newFenceCalls();
    for (let index = 1; index <= MAX_PENDING_CALLS + 1; index += 1) {
      calls = expectResult(calls, `send-${index}`);
    }
    expect(calls.pending).toHaveLength(MAX_PENDING_CALLS);
    expect(calls.pending[0]).toBe("send-2");
    expect(claimResult(calls, "send-1").accepted).toBe(false);
    expect(claimResult(calls, `send-${MAX_PENDING_CALLS + 1}`).accepted).toBe(true);
  });
});
