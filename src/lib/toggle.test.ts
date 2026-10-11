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
    });
  });
});

describe("parseToggleMessage", () => {
  it("认得自己发的两条消息", () => {
    expect(parseToggleMessage(wantStateMessage())).toEqual(wantStateMessage());
    expect(parseToggleMessage(stateMessage(false))).toEqual(stateMessage(false));
    expect(parseToggleMessage(stateMessage(true))).toEqual(stateMessage(true));
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
