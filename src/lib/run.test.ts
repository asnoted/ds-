import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER, buildContinuation } from "./continuation";
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
