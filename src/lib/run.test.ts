import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER, buildContinuation } from "./continuation";
import { describeContinuationFailure, describeThrownFailure } from "./continuationfail";
import { okPayload } from "./reply";
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
