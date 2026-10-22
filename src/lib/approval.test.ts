import { describe, expect, it } from "vitest";

import { AUTO_APPROVED_TOOLS, isAutoApproved } from "./approval";

describe("自动放行的工具名单", () => {
  it("只读的两件放行", () => {
    expect(isAutoApproved("read")).toBe(true);
    expect(isAutoApproved("glob")).toBe(true);
  });

  it("会改状态的一律不放行", () => {
    for (const name of ["write", "edit", "grep", "send.page", "", "READ", "read "]) {
      expect(isAutoApproved(name)).toBe(false);
    }
  });

  it("名单就是那两件:新增工具默认仍要人点", () => {
    expect([...AUTO_APPROVED_TOOLS].sort()).toEqual(["glob", "read"]);
  });
});
