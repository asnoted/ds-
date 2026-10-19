import { describe, expect, it } from "vitest";

import { ARMED_TTL_MS } from "./armed";
import { CONTINUATION_MARKER, STOP_CONTINUATION_LIMIT, buildContinuation } from "./continuation";
import { describeContinuationFailure, describeThrownFailure } from "./continuationfail";
import { recognizeOutgoingShape } from "./inject";
import { errorPayload, okPayload } from "./reply";
import { INITIAL_ROUNDS, MAX_CONTINUATION_ROUNDS } from "./rounds";
import { decide, endTask, newRun, type RunState } from "./run";

const BODY = "agent:\nstatus: ok\nanswer[1]{text}:\n  入口在 dsb/server.py.";
const PAYLOAD = okPayload(BODY);
const CONT = buildContinuation(PAYLOAD);

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

describe("单槽:一个窗口里只排一条标记", () => {
  it("窗口到点前又到一份结果:不排第二条标记,放行时也就没有裸标记", () => {
    const first = decide(turnOn(true), { type: "result", payload: PAYLOAD });
    const second = decide(first.state, { type: "result", payload: PAYLOAD });
    // 标记是内容无关的:队列里已经有一条,第二份结果只更新正文,不再排队.
    expect(second.state.queued).toBe(buildContinuation(PAYLOAD));
    expect(second.effects).toEqual([]);

    // 放行只有一条:那条裸标记(没有正文可换、会被当成用户自己发的话)不会出现.
    const released = decide(second.state, {
      type: "released",
      message: CONTINUATION_MARKER,
      now: 1_000,
    });
    expect(released.effects).toEqual([
      { kind: "send", message: CONTINUATION_MARKER, continuation: true },
    ]);
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

  it("不是本趟续聊的发送落定:裁决原样(另两条发送路不归这里管,ADR-0001)", () => {
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

describe("出站请求认领:钥匙、过期与处置", () => {
  function armedRun(speak: boolean): RunState {
    const queued = decide(turnOn(speak), { type: "result", payload: PAYLOAD });
    return decide(queued.state, {
      type: "released",
      message: CONTINUATION_MARKER,
      now: 1_000,
    }).state;
  }

  const MARKER_BODY = JSON.stringify({ prompt: CONTINUATION_MARKER });
  const USER_BODY = JSON.stringify({ prompt: "帮我看看 README" });

  it("正文逐字等于短标记:换成工具结果,武装清空(钥匙认领走了)", () => {
    const claimed = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_500,
    });
    expect(claimed.claim).toEqual({ kind: "substituted", body: JSON.stringify({ prompt: CONT }) });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([]);
  });

  it("用户自己发的话:原样放行走协议说明那一支,武装撤销,key-mismatch 留痕(#49)", () => {
    const claimed = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(USER_BODY),
      now: 1_500,
    });
    expect(claimed.claim).toEqual({ kind: "protocol" });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("key-mismatch") },
    ]);
  });

  it("形状认不出(站点换了载荷):与钥匙不符走同一条路径,痕上写形状认不出", () => {
    const claimed = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(JSON.stringify({ input: "短标记也在这里面" })),
      now: 1_500,
    });
    // 同一条路径:原样放行走协议说明那一支 + 武装撤销(#4 的"不再有第三种半通组合")
    expect(claimed.claim).toEqual({ kind: "protocol" });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("shape-unknown") },
    ]);
  });

  it("armed 挂过 TTL 才撞上请求:先作废留痕,再按没有武装处理", () => {
    const claimed = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_000 + ARMED_TTL_MS + 1,
    });
    expect(claimed.claim).toEqual({ kind: "protocol" });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("armed-expired") },
    ]);
  });

  it("限速让动手晚于放行:真发前一刻刷新武装时刻,TTL 从动手起算,不被误判过期", () => {
    const armed = armedRun(true); // 放行那一刻武装:armedAt = 1_000
    const sending = decide(armed, { type: "sending", now: 1_000 + ARMED_TTL_MS * 3 });
    expect(sending.state.armed).toEqual({
      phase: "armed",
      continuation: buildContinuation(PAYLOAD),
      armedAt: 1_000 + ARMED_TTL_MS * 3,
    });

    // 按放行时刻算早过了 TTL,按动手时刻算还在窗口里 → 照旧认领(工具结果进对话).
    const claimed = decide(sending.state, {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_000 + ARMED_TTL_MS * 3 + 50,
    });
    expect(claimed.claim).toEqual({ kind: "substituted", body: JSON.stringify({ prompt: CONT }) });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([]);
  });

  it("没有武装时的动手前一刻:状态与效果都不动", () => {
    const on = turnOn(true);
    const sending = decide(on, { type: "sending", now: 999 });
    expect(sending.state).toBe(on);
    expect(sending.effects).toEqual([]);
  });

  it("pending 不看时间:等用户按发送那条隔多久仍按钥匙认领", () => {
    const claimed = decide(armedRun(false), {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_000 + ARMED_TTL_MS * 100,
    });
    expect(claimed.claim).toEqual({ kind: "substituted", body: JSON.stringify({ prompt: CONT }) });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
  });

  it("消息形状里最后一条 user 不是标记:钥匙不符(哪怕历史里有一条恰好是标记)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: CONTINUATION_MARKER },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "我改主意了,问别的" },
      ],
    });
    const claimed = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(body),
      now: 1_500,
    });
    expect(claimed.claim).toEqual({ kind: "protocol" });
    expect(claimed.state.armed).toEqual({ phase: "idle" });
    expect(claimed.effects).toEqual([
      { kind: "trace", cause: describeContinuationFailure("key-mismatch") },
    ]);
  });

  it("首尾空白与 CRLF 不影响钥匙:站点与受控输入框的换行写法差异(ADR-0002 归一化)", () => {
    for (const variant of [
      `  ${CONTINUATION_MARKER}\n`,
      CONTINUATION_MARKER.replace(/\n/g, "\r\n"),
    ]) {
      const claimed = decide(armedRun(true), {
        type: "claimed",
        shape: recognizeOutgoingShape(JSON.stringify({ prompt: variant })),
        now: 1_500,
      });
      expect(claimed.claim).toEqual({
        kind: "substituted",
        body: JSON.stringify({ prompt: CONT }),
      });
    }
  });

  it("没有武装等着:处置是协议说明那一支,状态与痕迹都不动", () => {
    const idle = decide(turnOn(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_500,
    });
    expect(idle.claim).toEqual({ kind: "protocol" });
    expect(idle.state.armed).toEqual({ phase: "idle" });
    expect(idle.effects).toEqual([]);
  });

  it("一次即作废:认领走之后再撞同样等于标记的请求,不再替换", () => {
    const once = decide(armedRun(true), {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_500,
    });
    const twice = decide(once.state, {
      type: "claimed",
      shape: recognizeOutgoingShape(MARKER_BODY),
      now: 1_600,
    });
    // 一次即作废:武装已被消费,第二次没有正文等着认,也不再留新痕.
    expect(twice.claim).toEqual({ kind: "protocol" });
    expect(twice.effects).toEqual([]);
  });
});

describe("轮数刹车与结果到达", () => {
  it("连到上限那一轮:不入队,报停手,轮数归零(下一次任务重新有满额)", () => {
    let run = turnOn(true);
    for (let round = 0; round < MAX_CONTINUATION_ROUNDS; round += 1) {
      run = decide(run, { type: "result", payload: PAYLOAD }).state;
    }
    expect(run.rounds.rounds).toBe(MAX_CONTINUATION_ROUNDS);

    const capped = decide(run, { type: "result", payload: PAYLOAD });
    expect(capped.state.rounds).toEqual(INITIAL_ROUNDS);
    // 已经入队那条原样留着(刹车只管这一轮不发新的,不动已排的).
    expect(capped.state.queued).toBe(run.queued);
    expect(capped.effects).toEqual([
      {
        kind: "stop",
        cause: STOP_CONTINUATION_LIMIT,
        note: `自动续聊已连到 ${MAX_CONTINUATION_ROUNDS} 轮上限,停手等用户开口`,
      },
    ]);
  });

  it("载荷不是 status ok:不入队也不刹车,只吭一声(失败不进对话流)", () => {
    const got = decide(turnOn(true), { type: "result", payload: errorPayload("timeout") });
    expect(got.state.queued).toBeNull();
    expect(got.state.rounds).toEqual(INITIAL_ROUNDS);
    expect(got.effects).toEqual([{ kind: "log", note: expect.stringContaining("中继没问成") }]);
  });

  it("一轮答复没有围栏 = 任务收尾:endTask 只归零轮数,别的不动", () => {
    let run = turnOn(true);
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;
    const done = endTask(run);
    expect(done.rounds).toEqual(INITIAL_ROUNDS);
    expect(done.armed).toEqual(run.armed);
    expect(done.queued).toBeNull();
  });
});

describe("闸与总开关", () => {
  it("总开关从开到关:整条链作废——队列清、武装留痕后撤、轮数归零、会话忘掉", () => {
    let run = turnOn(true);
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;
    run = decide(run, { type: "session", key: "s1" }).state;

    const off = decide(run, { type: "toggle", speak: true, enabled: false });
    expect(off.effects).toEqual([
      { kind: "apply", enabled: false },
      { kind: "trace", cause: describeContinuationFailure("toggle-off") },
    ]);
    expect(off.state.armed).toEqual({ phase: "idle" });
    expect(off.state.queued).toBeNull();
    expect(off.state.rounds).toEqual(INITIAL_ROUNDS);
    expect(off.state.session).toBeNull();
    expect(off.state.enabled).toBe(false);
    expect(off.state.speak).toBe(true);
  });

  it("闸从开到关:挂着的那条静默作废,不留痕也不动总开关", () => {
    let run = turnOn(true);
    run = decide(run, { type: "result", payload: PAYLOAD }).state;
    run = decide(run, { type: "released", message: CONTINUATION_MARKER, now: 1 }).state;
    expect(run.armed.phase).toBe("armed");

    const closed = decide(run, { type: "toggle", speak: false, enabled: true });
    expect(closed.state.armed).toEqual({ phase: "idle" });
    expect(closed.state.speak).toBe(false);
    expect(closed.state.enabled).toBe(true);
    expect(closed.effects).toEqual([]);
  });

  it("重复的同值开关:裁决原样,不重复装卸也不重复留痕", () => {
    const on = turnOn(true);
    const again = decide(on, { type: "toggle", speak: true, enabled: true });
    expect(again.state).toBe(on);
    expect(again.effects).toEqual([]);
  });

  it("总开关关着时的关:武装已撤,不再补第二条痕", () => {
    const off = decide(newRun(), { type: "toggle", speak: false, enabled: false });
    expect(off.state).toEqual({ ...newRun(), enabled: false });
    expect(off.effects).toEqual([]);
  });

  it("队列里不是本趟续聊的那条:照发,但不进本趟的落定账", () => {
    const released = decide(turnOn(true), { type: "released", message: "你好", now: 1 });
    expect(released.effects).toEqual([{ kind: "send", message: "你好", continuation: false }]);
    expect(released.state.armed).toEqual({ phase: "idle" });
    expect(released.state.queued).toBeNull();
  });

  it("队列里明明挂着续聊,放行的却不是那个短标记:逐字不等就不认(ADR-0002 钥匙)", () => {
    const queued = decide(turnOn(true), { type: "result", payload: PAYLOAD });
    expect(queued.state.queued).not.toBeNull();

    const released = decide(queued.state, { type: "released", message: "你好", now: 1 });
    // 钥匙不对就不动:照用户的原文发,挂着的续聊原样留着等它自己那条.
    expect(released.effects).toEqual([{ kind: "send", message: "你好", continuation: false }]);
    expect(released.state.queued).toBe(queued.state.queued);
  });

  it("总开关从开到关:还没到出站窗口那条也作废,轮数归零(不留半条链)", () => {
    const queued = decide(turnOn(true), { type: "result", payload: PAYLOAD });
    expect(queued.state.queued).not.toBeNull();
    expect(queued.state.rounds.rounds).toBe(1);

    const off = decide(queued.state, { type: "toggle", speak: true, enabled: false });
    expect(off.state.queued).toBeNull();
    expect(off.state.rounds).toEqual(INITIAL_ROUNDS);
  });
});
