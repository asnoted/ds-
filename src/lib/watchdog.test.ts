import { describe, expect, it } from "vitest";

import {
  DEFAULT_WATCHDOG_CONFIG,
  INITIAL_WATCHDOG_STATE,
  MAX_CONSECUTIVE_NUDGED_TASKS,
  readWatchdogConfig,
  observedOutput,
  watchdogDecision,
  watchdogNudged,
  watchdogSeenActivity,
  watchdogSeenPassing,
  watchdogTaskClosed,
  type WatchdogState,
} from "./watchdog";

const SESSION_URL = "https://chat.deepseek.com/a/chat/s/sid-1";
const OTHER_SESSION_URL = "https://chat.deepseek.com/a/chat/s/sid-2";
const NEW_CHAT_URL = "https://chat.deepseek.com/";

/** 一条记住过会话、回灌落过地(所以活开着)、有过动静的状态. */
function armedState(overrides: Partial<WatchdogState> = {}): WatchdogState {
  return {
    sessionUrl: SESSION_URL,
    lastActivityAt: 1_000,
    taskOpen: true,
    nudges: 0,
    stoodDown: false,
    nudgedTasks: 0,
    sealed: false,
    ...overrides,
  };
}

describe("watchdogDecision", () => {
  it("扫到会话页先记住,不动", () => {
    const { act, next } = watchdogDecision(INITIAL_WATCHDOG_STATE, {
      tabUrl: SESSION_URL,
      now: 1_000,
    });
    expect(act).toEqual({ kind: "nothing" });
    expect(next.sessionUrl).toBe(SESSION_URL);
  });

  it("非会话页且没记住过,无锚点可拉", () => {
    const { act, next } = watchdogDecision(INITIAL_WATCHDOG_STATE, {
      tabUrl: NEW_CHAT_URL,
      now: 1_000,
    });
    expect(act).toEqual({ kind: "nothing" });
    expect(next.sessionUrl).toBeNull();
  });

  it("离开记住的会话(漂去新对话)→ 导航回去", () => {
    const { act } = watchdogDecision(armedState(), {
      tabUrl: NEW_CHAT_URL,
      now: 1_000,
    });
    expect(act).toEqual({ kind: "navigate-back", url: SESSION_URL });
  });

  it("被导航到本站另一条会话 → 也拉回记住的那条", () => {
    const { act } = watchdogDecision(armedState(), {
      tabUrl: OTHER_SESSION_URL,
      now: 1_000,
    });
    expect(act).toEqual({ kind: "navigate-back", url: SESSION_URL });
  });

  it("标签页读不到(url 为 null)→ 不动", () => {
    const { act } = watchdogDecision(armedState(), { tabUrl: null, now: 1_000 });
    expect(act).toEqual({ kind: "nothing" });
  });

  it("活开着,静默超窗 → 催办,正文取配置", () => {
    const config = { ...DEFAULT_WATCHDOG_CONFIG, nudgeText: "还在吗" };
    const { act } = watchdogDecision(
      armedState(),
      {
        tabUrl: SESSION_URL,
        now: 1_000 + config.silenceMs,
      },
      config,
    );
    expect(act).toEqual({ kind: "nudge", text: "还在吗" });
  });

  it("静默刚好到窗界 → 也算超窗", () => {
    const { act } = watchdogDecision(armedState(), {
      tabUrl: SESSION_URL,
      now: 1_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs,
    });
    expect(act).toEqual({ kind: "nudge", text: DEFAULT_WATCHDOG_CONFIG.nudgeText });
  });

  it("静默未满窗口 → 不动", () => {
    const { act } = watchdogDecision(armedState(), {
      tabUrl: SESSION_URL,
      now: 1_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs - 1,
    });
    expect(act).toEqual({ kind: "nothing" });
  });

  it("还没有动静过(null)→ 不动", () => {
    const { act } = watchdogDecision(armedState({ lastActivityAt: null }), {
      tabUrl: SESSION_URL,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(act).toEqual({ kind: "nothing" });
  });

  it("活没收尾:再安静也不开口(任务门,#104)", () => {
    const { act } = watchdogDecision(armedState({ taskOpen: false, nudgedTasks: 1 }), {
      tabUrl: SESSION_URL,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(act).toEqual({ kind: "nothing" });
  });

  it("本笔活连催到上限 → 停手", () => {
    const { act, next } = watchdogDecision(
      armedState({ nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges }),
      { tabUrl: SESSION_URL, now: 1_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs },
    );
    expect(act).toEqual({ kind: "stand-down" });
    expect(next.stoodDown).toBe(true);
  });

  it("停手之后再扫 → 不动(停着)", () => {
    const { act } = watchdogDecision(
      armedState({ nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges, stoodDown: true }),
      { tabUrl: SESSION_URL, now: Number.MAX_SAFE_INTEGER },
    );
    expect(act).toEqual({ kind: "nothing" });
  });

  it("停手但漂移了 → 仍拉回(停手只停催)", () => {
    const { act } = watchdogDecision(
      armedState({ nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges, stoodDown: true }),
      { tabUrl: NEW_CHAT_URL, now: 1_000 },
    );
    expect(act).toEqual({ kind: "navigate-back", url: SESSION_URL });
  });

  it("已封(连续两笔活靠催办推进)→ 不催,但仍拉回", () => {
    const silent = watchdogDecision(armedState({ sealed: true }), {
      tabUrl: SESSION_URL,
      now: 1_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs,
    });
    expect(silent.act).toEqual({ kind: "nothing" });
    const drifted = watchdogDecision(armedState({ sealed: true }), {
      tabUrl: NEW_CHAT_URL,
      now: 1_000,
    });
    expect(drifted.act).toEqual({ kind: "navigate-back", url: SESSION_URL });
  });

  it("催办没送出去(计数未增)时再扫 → 又催", () => {
    // 编排层只在投递成功时增计数;决策层对原样状态重复给催,
    // 这就是"闸拦着不算催,下扫再试"的纯函数侧面.
    const state = armedState({
      lastActivityAt: 1_000 - DEFAULT_WATCHDOG_CONFIG.silenceMs,
    });
    const first = watchdogDecision(state, { tabUrl: SESSION_URL, now: 1_000 });
    const second = watchdogDecision(first.next, { tabUrl: SESSION_URL, now: 1_000 });
    expect(first.act).toEqual({ kind: "nudge", text: DEFAULT_WATCHDOG_CONFIG.nudgeText });
    expect(second.act).toEqual(first.act);
  });

  it("催办送出去后窗口顺延:30 秒后的下一扫不会再送第二条(静默期按催办时刻重算)", () => {
    const { silenceMs, nudgeText } = DEFAULT_WATCHDOG_CONFIG;
    const due = 1_000 + silenceMs;

    const first = watchdogDecision(armedState(), { tabUrl: SESSION_URL, now: due });
    expect(first.act).toEqual({ kind: "nudge", text: nudgeText });

    const after = watchdogNudged(first.next, due); // 编排层:送出去了
    // 30 秒一扫:刚催过就当场再催的话,两条"继续"挤在半分钟里,静默期就形同虚设.
    expect(watchdogDecision(after, { tabUrl: SESSION_URL, now: due + 30_000 }).act).toEqual({
      kind: "nothing",
    });
    expect(watchdogDecision(after, { tabUrl: SESSION_URL, now: due + silenceMs }).act).toEqual({
      kind: "nudge",
      text: nudgeText,
    });
  });

  it("每轮都靠路过动静顺延窗口,满额的两催照样走到停手(#104)", () => {
    const { silenceMs, maxNudges } = DEFAULT_WATCHDOG_CONFIG;
    let state = armedState();
    let now = 1_000;
    const kinds: string[] = [];
    for (let round = 0; round <= maxNudges; round += 1) {
      now += silenceMs;
      const decision = watchdogDecision(state, { tabUrl: SESSION_URL, now });
      kinds.push(decision.act.kind);
      state = decision.next;
      if (decision.act.kind === "nudge") {
        state = { ...state, nudges: state.nudges + 1 }; // 编排层:送出去了才增
        now += 10;
        state = watchdogSeenPassing(state, now); // 模型回了一段,输出把窗口顺延
      }
    }
    // 顺延只推迟时刻,不吞计数:两催之后的窗口仍到停手.
    expect(kinds).toEqual(["nudge", "nudge", "stand-down"]);
    expect(state.stoodDown).toBe(true);
  });

  it("任务门一整圈:每笔活各有满额,连着两笔回催就封手(#104)", () => {
    const { silenceMs, nudgeText } = DEFAULT_WATCHDOG_CONFIG;
    let now = 1_000;
    let state: WatchdogState = { ...INITIAL_WATCHDOG_STATE, sessionUrl: SESSION_URL };

    /** 一笔活:回灌落地开活 → 静默连催到停手 → 收活结账. */
    const runTask = (): void => {
      state = watchdogSeenActivity(state, now);
      for (;;) {
        now += silenceMs;
        const decision = watchdogDecision(state, { tabUrl: SESSION_URL, now });
        state = decision.next;
        if (decision.act.kind === "nudge") {
          expect(decision.act).toEqual({ kind: "nudge", text: nudgeText });
          state = { ...state, nudges: state.nudges + 1 };
        } else {
          expect(decision.act).toEqual({ kind: "stand-down" });
          break;
        }
      }
      state = watchdogTaskClosed(state);
    };

    runTask();
    expect(state).toMatchObject({ taskOpen: false, nudgedTasks: 1, sealed: false });
    runTask();
    expect(state).toMatchObject({ taskOpen: false, nudgedTasks: 2, sealed: true });

    // 封手后第三笔活照常开,但静默再久也一个字都不发.
    state = watchdogSeenActivity(state, now);
    const decision = watchdogDecision(state, {
      tabUrl: SESSION_URL,
      now: now + silenceMs,
    });
    expect(decision.act).toEqual({ kind: "nothing" });
    expect(MAX_CONSECUTIVE_NUDGED_TASKS).toBe(2);
  });
});

describe("回灌落地 / 路过动静 / 收活", () => {
  it("活开着时落地:只刷窗口,预算与停手原样(按笔活算,#104)", () => {
    const stoodDown = armedState({
      nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges,
      stoodDown: true,
      lastActivityAt: 1,
    });
    const next = watchdogSeenActivity(stoodDown, 5_000);
    expect(next.lastActivityAt).toBe(5_000);
    expect(next.taskOpen).toBe(true);
    // 同笔活里的第二次落地不解预算:催办惹来的回复解不开上限.
    expect(next.nudges).toBe(DEFAULT_WATCHDOG_CONFIG.maxNudges);
    expect(next.stoodDown).toBe(true);
    // 会话锚点不动.
    expect(next.sessionUrl).toBe(SESSION_URL);
    // 到顶的停手还在:超窗再扫也停着.
    const { act } = watchdogDecision(next, {
      tabUrl: SESSION_URL,
      now: 5_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs,
    });
    expect(act).toEqual({ kind: "nothing" });
  });

  it("收着尾时落地:开活,预算归零", () => {
    const closed = armedState({ taskOpen: false, lastActivityAt: 1, nudgedTasks: 1 });
    const next = watchdogSeenActivity(closed, 5_000);
    expect(next.taskOpen).toBe(true);
    expect(next.nudges).toBe(0);
    expect(next.stoodDown).toBe(false);
    expect(next.lastActivityAt).toBe(5_000);
    // 连续笔数是跨活的账,开活不动.
    expect(next.nudgedTasks).toBe(1);
    expect(next.sealed).toBe(false);
  });

  it("路过动静(生成 / 围栏出门 / 整轮作废):只顺延窗口(#104)", () => {
    const state = armedState({
      nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges,
      stoodDown: true,
      lastActivityAt: 1,
    });
    const next = watchdogSeenPassing(state, 5_000);
    expect(next.lastActivityAt).toBe(5_000);
    expect(next.nudges).toBe(DEFAULT_WATCHDOG_CONFIG.maxNudges);
    expect(next.stoodDown).toBe(true);
    expect(next.taskOpen).toBe(true);
    expect(next.sessionUrl).toBe(SESSION_URL);
    // 顺延后未超窗 → 不动;超窗但停着 → 照旧不动(输出没把停手掀翻).
    const { silenceMs } = DEFAULT_WATCHDOG_CONFIG;
    expect(watchdogDecision(next, { tabUrl: SESSION_URL, now: 5_000 + silenceMs - 1 }).act).toEqual(
      { kind: "nothing" },
    );
    expect(watchdogDecision(next, { tabUrl: SESSION_URL, now: 5_000 + silenceMs }).act).toEqual({
      kind: "nothing",
    });
  });

  it("收着尾时路过动静:不借它开活(#104 的要害)", () => {
    const { silenceMs } = DEFAULT_WATCHDOG_CONFIG;
    const closed = armedState({ taskOpen: false, lastActivityAt: 1 });
    const next = watchdogSeenPassing(closed, 5_000);
    expect(next.taskOpen).toBe(false);
    expect(watchdogDecision(next, { tabUrl: SESSION_URL, now: 5_000 + silenceMs }).act).toEqual({
      kind: "nothing",
    });
  });

  it("封是一封到底:干净收尾不解封(解封只有总开关关一次)", () => {
    const { silenceMs } = DEFAULT_WATCHDOG_CONFIG;
    const sealed = armedState({ sealed: true, nudgedTasks: 3 });
    const next = watchdogTaskClosed(sealed);
    expect(next.sealed).toBe(true);
    expect(next.nudgedTasks).toBe(0);
    expect(
      watchdogDecision(
        { ...next, taskOpen: true, lastActivityAt: 1 },
        { tabUrl: SESSION_URL, now: 1 + silenceMs },
      ).act,
    ).toEqual({ kind: "nothing" });
  });

  it("收活结账:本笔活的连催与停手清零,回催过的笔数记进连续", () => {
    const state = armedState({
      nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges,
      stoodDown: true,
      nudgedTasks: 1,
    });
    const next = watchdogTaskClosed(state);
    expect(next.taskOpen).toBe(false);
    expect(next.nudges).toBe(0);
    expect(next.stoodDown).toBe(false);
    expect(next.nudgedTasks).toBe(MAX_CONSECUTIVE_NUDGED_TASKS);
    expect(next.sealed).toBe(true);
  });

  it("干净收尾的活:连续笔数清零", () => {
    const next = watchdogTaskClosed(armedState({ nudgedTasks: 1 }));
    expect(next.taskOpen).toBe(false);
    expect(next.nudgedTasks).toBe(0);
    expect(next.sealed).toBe(false);
  });

  it("收活幂等:活没收尾的不动,收过尾的原样返回", () => {
    const closed = armedState({ taskOpen: false, nudgedTasks: 1 });
    expect(watchdogTaskClosed(closed)).toBe(closed);
    const open = armedState({ nudges: 1, nudgedTasks: 1 });
    const next = watchdogTaskClosed(open);
    expect(next).not.toBe(open);
    expect(next.taskOpen).toBe(false);
  });
});

describe("临催前的观察窗", () => {
  it("一拍读到生成就不出手,读不到连看三拍(#104)", async () => {
    const gaps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      gaps.push(ms);
    };
    // 第一拍就停着:立刻算生成,不白等.
    expect(await observedOutput(async () => true, sleep)).toBe(true);
    expect(gaps).toEqual([]);
    // 空档里前两拍没读到,第三拍读到 → 仍算生成(这就是单拍采样会踩空的那一档).
    const reads = [false, false, true];
    expect(await observedOutput(async () => reads.shift() ?? false, sleep)).toBe(true);
    expect(gaps).toHaveLength(2);
    // 三拍都没读到 → 不算生成,催办照走.
    expect(await observedOutput(async () => false, sleep)).toBe(false);
    expect(gaps).toHaveLength(4);
  });
});

describe("readWatchdogConfig", () => {
  it("缺省 → 默认配置", () => {
    expect(readWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig("not-an-object")).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig([])).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  it("部分覆写,缺的落默认", () => {
    expect(readWatchdogConfig({ maxNudges: 5 })).toEqual({
      ...DEFAULT_WATCHDOG_CONFIG,
      maxNudges: 5,
    });
  });

  it("坏值落回默认:窗口非正,上限非整数,正文空白", () => {
    expect(readWatchdogConfig({ silenceMs: -1 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ silenceMs: 0 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ maxNudges: 0 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ maxNudges: 2.5 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ nudgeText: "   " })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    // 非有限:写进去就成了"永不静默",看门狗静默地不再催办--也得落回默认.
    expect(readWatchdogConfig({ silenceMs: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_WATCHDOG_CONFIG,
    );
  });
});
