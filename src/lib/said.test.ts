import { describe, expect, it } from "vitest";

import { outsideFences, SAID_ADD_TOOL } from "./said";

describe("SAID_ADD_TOOL", () => {
  it("指名 dsb 的 said_add 工具(经 `POST /mcp` 的 tools/call 报话)", () => {
    expect(SAID_ADD_TOOL).toBe("said_add");
  });
});

describe("outsideFences", () => {
  it("摘掉围栏,留下围栏外的话", () => {
    const text = "先说一句给人听的.\n\n```send\n帮我跑个东西\n```\n\n排完了,等它.";
    expect(outsideFences(text)).toBe("先说一句给人听的.\n\n\n\n排完了,等它.");
  });

  it("没有围栏就原样", () => {
    expect(outsideFences("只有一句普通回答.")).toBe("只有一句普通回答.");
  });

  it("全是围栏就空", () => {
    expect(outsideFences("```send\n帮我跑个东西\n```")).toBe("");
  });
});
