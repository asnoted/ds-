import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER, buildContinuation } from "./continuation";
import { describeContinuationFailure, describeThrownFailure } from "./continuationfail";
import { okPayload } from "./reply";
import { INITIAL_ROUNDS } from "./rounds";
import { decide, newRun, type RunState } from "./run";

const BODY = "agent:\nstatus: ok\nanswer[1]{text}:\n  入口在 dsb/server.py.";
const PAYLOAD = okPayload(BODY);

function turnOn(speak: boolean): RunState {
  return decide(newRun(), { type: "toggle", speak, enabled: true }).state;
}

describe("放行那一刻才武装(AC①:入队不武装)", () => {
  it("结果到达只入队,武装仍是 idle;窗口放行那一刻才武装", () => {
    const queued = decide(turnOn(true), { type: "result", payload: PAYLOAD });
    expect(queued.state.armed).toEqual({ phase: "idle" });
    expect(queued.state.queued).toBe(buildContinuation(PAYLOAD));
    expect(queued.effects).toEqual([{ kind: "enqueue" }]);

    const released = decide(queued.state, {
      type: "released",
      message: CONTINUATION_MARKER,
      now: 1_000,
    });
    expect(released.state.armed).toEqual({
      phase: "armed",
      continuation: buildContinuation(PAYLOAD),
      armedAt: 1_000,
    });
    expect(released.state.queued).toBeNull();
    expect(released.effects).toEqual([
      { kind: "send", message: CONTINUATION_MARKER, continuation: true },
    ]);
  });

  it("总开关关着时结果到达不入队也不武装", () => {
    const got = decide(newRun(), { type: "result", payload: PAYLOAD });
    expect(got.state.armed).toEqual({ phase: "idle" });
    expect(got.state.queued).toBeNull();
    expect(got.effects).toEqual([]);
  });
});

describe("闸关时只落草稿(AC②:stage-only 结构里没有发送步)", () => {
  it("放行那一刻闸关着:挂 pending,裁决清单里整张都没有发送步(#52)", () => {
    const queued = decide(turnOn(false), { type: "result", payload: PAYLOAD });
    const released = decide(queued.state, {
      type: "released",
      message: CONTINUATION_MARKER,
      now: 1_000,
    });
    expect(released.state.armed).toEqual({
      phase: "pending",
      continuation: buildContinuation(PAYLOAD),
    });
    // 整张效果清单深度相等:只有"落草稿"一步,没有 send(接线层因此碰不到 Enter).
    expect(released.effects).toEqual([{ kind: "stage" }]);
    expect(released.effects.some((effect) => effect.kind === "send")).toBe(false);
  });
});

describe("发送失败立刻撤武装(AC③)", () => {
  function releasedRun(): ReturnType<typeof decide> {
    const queued = decide(turnOn(true), { type: "result", payload: PAYLOAD });
    return decide(queued.state, {
      type: "released",
      message: CONTINUATION_MARKER,
      now: 1_000,
    });
  }

  it("发送没发出去(sent false):武装立刻撤,失败留痕", () => {
    const released = releasedRun();
    expect(released.state.armed.phase).toBe("armed");

    const settled = decide(released.state, {
      type: "settled",
      continuation: true,
      outcome: { sent: false, failure: "send-failed" },
    });
    expect(settled.state.armed).toEqual({ phase: "idle" });
    expect(settled.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("send-failed") },
    ]);
  });

  it("发送抛错:同样立刻撤武装,短句只带错误类型名(ADR-0004)", () => {
    const released = releasedRun();
    const settled = decide(released.state, {
      type: "settled",
      continuation: true,
      outcome: { thrown: new TypeError("boom") },
    });
    expect(settled.state.armed).toEqual({ phase: "idle" });
    expect(settled.effects).toEqual([
      { kind: "trace", cause: describeThrownFailure(new TypeError("boom")) },
    ]);
  });

  it("发出去了:武装留着等出站请求拿钥匙认领,不留痕", () => {
    const released = releasedRun();
    const settled = decide(released.state, {
      type: "settled",
      continuation: true,
      outcome: { sent: true, failure: null },
    });
    expect(settled.state.armed.phase).toBe("armed");
    expect(settled.effects).toEqual([]);
  });

  it("不是本趟续聊的发送落定:裁决原样(另两条发送路不归这里管,ADR-0002)", () => {
    const released = releasedRun();
    const settled = decide(released.state, {
      type: "settled",
      continuation: false,
      outcome: { sent: false, failure: "send-failed" },
    });
    expect(settled.state.armed.phase).toBe("armed");
    expect(settled.effects).toEqual([]);
  });
});

describe("换会话:轮数归零且待发作废(AC④)", () => {
  it("换了会话 id:轮数归零,挂着的 pending 作废并留痕", () => {
    let run = decide(turnOn(false), { type: "session", key: "s1" }).state;
    // 两轮结果 + 两次放行(闸关:只落草稿)把轮数与 pending 攒起来.
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 2 }).state;
    expect(run.rounds.rounds).toBe(2);
    expect(run.armed.phase).toBe("pending");

    const changed = decide(run, { type: "session", key: "s2" });
    expect(changed.state.rounds).toEqual(INITIAL_ROUNDS);
    expect(changed.state.armed).toEqual({ phase: "idle" });
    expect(changed.state.session).toBe("s2");
    expect(changed.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("session-changed") },
    ]);
  });

  it("同一个会话 id 再来一次:轮数与待发都不动", () => {
    let run = decide(turnOn(false), { type: "session", key: "s1" }).state;
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;

    const same = decide(run, { type: "session", key: "s1" });
    expect(same.state.rounds.rounds).toBe(1);
    expect(same.state.armed.phase).toBe("pending");
    expect(same.effects).toEqual([]);
  });

  it("换会话时是 armed(不是 pending):轮数归零,武装留着(出站窗口那一趟还没落定)", () => {
    let run = decide(turnOn(true), { type: "session", key: "s1" }).state;
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;
    expect(run.armed.phase).toBe("armed");

    const changed = decide(run, { type: "session", key: "s2" });
    expect(changed.state.rounds).toEqual(INITIAL_ROUNDS);
    expect(changed.state.armed.phase).toBe("armed");
    expect(changed.effects).toEqual([]);
  });
});
