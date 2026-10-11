import { describe, expect, it } from "vitest";

import {
  parseToggleMessage,
  readToggle,
  stateMessage,
  TOGGLE_MESSAGE_SOURCE,
  TOGGLE_STORAGE_KEY,
  wantStateMessage,
} from "./toggle";

describe("readToggle", () => {
  it("缺键即关:总开关默认关,装完不写任何默认值", () => {
    expect(readToggle(undefined)).toBe(false);
    expect(readToggle(null)).toBe(false);
  });

  it("只有显式 true 才是开", () => {
    expect(readToggle(true)).toBe(true);
  });

  it("认不出的值一律按关,不猜", () => {
    expect(readToggle("true")).toBe(false);
    expect(readToggle(1)).toBe(false);
    expect(readToggle(false)).toBe(false);
    expect(readToggle({ enabled: true })).toBe(false);
  });
});

describe("消息信封", () => {
  it("存储键就是总开关的落脚点", () => {
    expect(TOGGLE_STORAGE_KEY).toBe("toggle");
  });

  it("要状态与给状态是两条不同的消息", () => {
    expect(wantStateMessage()).toEqual({ source: TOGGLE_MESSAGE_SOURCE, kind: "want-state" });
    expect(stateMessage(true)).toEqual({
      source: TOGGLE_MESSAGE_SOURCE,
      kind: "state",
      enabled: true,
      speak: false, // 缺省按关(#52)
    });
  });

  it('"代你发言"闸跟着状态消息一起跨世界(#52)', () => {
    const withSpeak = (message: ReturnType<typeof stateMessage>) =>
      message.kind === "state" ? message.speak : undefined;
    expect(withSpeak(stateMessage(true, true))).toBe(true);
    expect(withSpeak(stateMessage(true, false))).toBe(false);
  });
});

describe("parseToggleMessage", () => {
  it("认得自己发的两条消息", () => {
    expect(parseToggleMessage(wantStateMessage())).toEqual(wantStateMessage());
    expect(parseToggleMessage(stateMessage(false))).toEqual(stateMessage(false));
    expect(parseToggleMessage(stateMessage(true))).toEqual(stateMessage(true));
  });

  it("speak 缺字段 / 不是布尔一律当关(#52:那条路宁可等用户按)", () => {
    const base = { source: TOGGLE_MESSAGE_SOURCE, kind: "state", enabled: true };
    const speakOf = (raw: unknown): boolean | undefined => {
      const parsed = parseToggleMessage(raw);
      return parsed?.kind === "state" ? parsed.speak : undefined;
    };
    expect(speakOf(base)).toBe(false);
    expect(speakOf({ ...base, speak: "yes" })).toBe(false);
    expect(speakOf({ ...base, speak: true })).toBe(true);
  });

  it("页面自己 post 的消息一律不收", () => {
    expect(parseToggleMessage({ kind: "state", enabled: true })).toBeNull();
    expect(parseToggleMessage({ source: "别的扩展", kind: "state", enabled: true })).toBeNull();
    expect(parseToggleMessage({ source: TOGGLE_MESSAGE_SOURCE })).toBeNull();
  });

  it("形状不对的不猜", () => {
    expect(parseToggleMessage(null)).toBeNull();
    expect(parseToggleMessage("ds-/toggle")).toBeNull();
    expect(parseToggleMessage({ source: TOGGLE_MESSAGE_SOURCE, kind: "state" })).toBeNull();
    expect(
      parseToggleMessage({ source: TOGGLE_MESSAGE_SOURCE, kind: "state", enabled: "true" }),
    ).toBeNull();
    expect(parseToggleMessage({ source: TOGGLE_MESSAGE_SOURCE, kind: "别的" })).toBeNull();
  });
});
