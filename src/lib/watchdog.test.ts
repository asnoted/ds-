import { describe, expect, it } from "vitest";

import {
  DEFAULT_WATCHDOG_CONFIG,
  INITIAL_WATCHDOG_STATE,
  readWatchdogConfig,
  watchdogDecision,
  watchdogSeenActivity,
  type WatchdogState,
} from "./watchdog";

const SESSION_URL = "https://chat.deepseek.com/a/chat/s/sid-1";
const OTHER_SESSION_URL = "https://chat.deepseek.com/a/chat/s/sid-2";
const NEW_CHAT_URL = "https://chat.deepseek.com/";

/** 一条记住过会话,且有过动静的状态. */
function armedState(overrides: Partial<WatchdogState> = {}): WatchdogState {
  return {
    sessionUrl: SESSION_URL,
    lastActivityAt: 1_000,
    nudges: 0,
    stoodDown: false,
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

  it("静默超窗 → 催办,正文取配置", () => {
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

  it("连催到上限 → 停手", () => {
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

  it("动静落地:计数与停手清零,窗口重算", () => {
    const stoodDown = armedState({
      nudges: DEFAULT_WATCHDOG_CONFIG.maxNudges,
      stoodDown: true,
      lastActivityAt: 1,
    });
    const next = watchdogSeenActivity(stoodDown, 5_000);
    expect(next.lastActivityAt).toBe(5_000);
    expect(next.nudges).toBe(0);
    expect(next.stoodDown).toBe(false);
    // 会话锚点不动.
    expect(next.sessionUrl).toBe(SESSION_URL);
    // 清零后再扫:静默从新时刻算,未超窗 → 不动.
    const { act } = watchdogDecision(next, {
      tabUrl: SESSION_URL,
      now: 5_000 + DEFAULT_WATCHDOG_CONFIG.silenceMs - 1,
    });
    expect(act).toEqual({ kind: "nothing" });
  });
});

describe("readWatchdogConfig", () => {
  it("缺省 → 默认配置", () => {
    expect(readWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig("not-an-object")).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig([])).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });

  it("部分覆写,缺的落默认", () => {
    expect(readWatchdogConfig({ maxNudges: 2 })).toEqual({
      ...DEFAULT_WATCHDOG_CONFIG,
      maxNudges: 2,
    });
  });

  it("坏值落回默认:窗口非正,上限非整数,正文空白", () => {
    expect(readWatchdogConfig({ silenceMs: -1 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ silenceMs: 0 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ maxNudges: 0 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ maxNudges: 2.5 })).toEqual(DEFAULT_WATCHDOG_CONFIG);
    expect(readWatchdogConfig({ nudgeText: "   " })).toEqual(DEFAULT_WATCHDOG_CONFIG);
  });
});
