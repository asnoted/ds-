import { describe, expect, it } from "vitest";

import { parseSendFences } from "./fence";
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

  /**
   * 正文里**提到**围栏(不在行首那一处)不是围栏:判据与 `fence.ts` 的
   * `isOpeningLine` 是同一条--摘的是"认得出的围栏",不是"哪段字里有 ```send".
   */
  it("正文里提到 ```send 不算围栏:话留着,围栏里的调用不许当成人话", () => {
    const text =
      '我打算用 ```send 围栏派活,下面这句是给人看的.\n\n```send\n{"tool":"ls"}\n```\n\n请稍等.';
    expect(outsideFences(text)).toBe(
      "我打算用 ```send 围栏派活,下面这句是给人看的.\n\n\n\n请稍等.",
    );
  });

  it("围栏正文里带 ``` 时按**行**认闭合:调用正文不许漏进人话", () => {
    const text = '```send\n{"tool":"write","arguments":{"content":"```js x ```"}}\n```\n\n写好了.';
    expect(outsideFences(text)).toBe("写好了.");
  });

  it("```sendfoo 不是围栏(与 fence.ts 同一条),原样留着", () => {
    expect(outsideFences("```sendfoo\nx\n```\n\n嗨.")).toBe("```sendfoo\nx\n```\n\n嗨.");
  });

  it("围栏那边认出来的正文,人话里一个字都不留(两处判据不许漂)", () => {
    const text = '用 ```send 派活,下面那句是给人看的:\n\n```send\n{"tool":"ls"}\n```\n';
    const bodies = parseSendFences(text);
    expect(bodies).toEqual(['{"tool":"ls"}']); // 围栏那半边确实认出来了
    for (const body of bodies) expect(outsideFences(text)).not.toContain(body);
  });
});
