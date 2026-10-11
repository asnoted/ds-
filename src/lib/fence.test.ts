import { describe, expect, it } from "vitest";

import { fixtureCases, type FenceCase } from "./fixtures";
import { parseAskFence, parseSendFence, parseSendFences } from "./fence";

describe("parseSendFences / 共享 fixture", () => {
  for (const { name, input, expectedCalls } of fixtureCases<FenceCase>("fence.json")) {
    it(name, () => {
      expect(parseSendFences(input)).toEqual(expectedCalls);
      // 只取第一块的那个口子(`wait.fence` 用)与它同源,别各切一套.
      expect(parseSendFence(input)).toBe(expectedCalls[0] ?? null);
    });
  }
});

describe("parseSendFence / 边界", () => {
  it("没有围栏的输入返回 null", () => {
    expect(parseSendFence("")).toBeNull();
    expect(parseSendFence("只是普通文本")).toBeNull();
  });

  it("问题与围栏起始同一行也算有效围栏", () => {
    expect(parseSendFence("```send 合在一行的问题\n```")).toBe("合在一行的问题");
  });

  it("```sendfoo 不是围栏", () => {
    expect(parseSendFence("```sendfoo\n问题\n```")).toBeNull();
  });

  it("``` send(空格版)不是围栏", () => {
    expect(parseSendFence("``` send\n问题\n```")).toBeNull();
  });

  it("```say 是旧词,不再被认出", () => {
    expect(parseSendFence("```say\n问题\n```")).toBeNull();
  });

  it("围栏里问空了返回 null", () => {
    expect(parseSendFence("```send   \n```")).toBeNull();
    expect(parseSendFence("```send\n   \n   \n```")).toBeNull();
  });

  it("问题正文只裁掉首尾空白,内部换行保留", () => {
    expect(parseSendFence("```send\n  第一行\n第二行  \n```")).toBe("第一行\n第二行");
  });

  it("只取第一块的那个口子(`wait.fence` 用)", () => {
    const text = "```send\n第一个\n```\n```send\n第二个\n```";
    expect(parseSendFence(text)).toBe("第一个");
  });
});

describe("parseSendFences / 一次回答多块", () => {
  it("全取,按出现顺序", () => {
    const text = "开头\n```send\na\n```\n中间的话\n```send\nb\n```\n结尾";
    expect(parseSendFences(text)).toEqual(["a", "b"]);
  });

  it("三块也照取", () => {
    const text = "```send\na\n```\n```send\nb\n```\n```send\nc\n```";
    expect(parseSendFences(text)).toEqual(["a", "b", "c"]);
  });

  it("没闭合的那块里再出现一行 ```send:那是它的内容,直到独占一行的 ``` 才收尾", () => {
    const text = "```send\na\n```send\nb\n```";
    expect(parseSendFences(text)).toEqual(["a\n```send\nb"]);
  });

  it("最后一块没闭合:前面的照认", () => {
    const text = "```send\na\n```\n```send\nb";
    expect(parseSendFences(text)).toEqual(["a"]);
  });

  it("排空的那一块不算,也不影响别的", () => {
    const text = "```send\n\n```\n```send\nb\n```";
    expect(parseSendFences(text)).toEqual(["b"]);
  });

  it("非 send 的围栏夹在中间不算数", () => {
    const text = "```send\na\n```\n```ask\n问人\n```\n```send\nb\n```";
    expect(parseSendFences(text)).toEqual(["a", "b"]);
  });
});

describe("parseAskFence / 边界(#26)", () => {
  it("有效 ask 围栏", () => {
    expect(parseAskFence("```ask\n选 A 还是 B?\n```")).toBe("选 A 还是 B?");
  });

  it("问题与围栏起始同一行也算有效围栏", () => {
    expect(parseAskFence("```ask 合在一行的问题\n```")).toBe("合在一行的问题");
  });

  it("```askfoo 不是围栏", () => {
    expect(parseAskFence("```askfoo\n问题\n```")).toBeNull();
  });

  it("两种围栏各认各的:send 不被 ask 认,ask 不被 send 认", () => {
    expect(parseAskFence("```send\n问题\n```")).toBeNull();
    expect(parseSendFence("```ask\n问题\n```")).toBeNull();
  });

  it("围栏没闭合返回 null", () => {
    expect(parseAskFence("```ask\n问题还没写完")).toBeNull();
  });

  it("围栏里问空了返回 null", () => {
    expect(parseAskFence("```ask   \n```")).toBeNull();
    expect(parseAskFence("```ask\n   \n   \n```")).toBeNull();
  });

  it("普通代码块不是围栏", () => {
    expect(parseAskFence("```py\nprint('hi')\n```")).toBeNull();
  });

  it("只认第一块:后面再排也不追加", () => {
    const text = "```ask\n第一个\n```\n```ask\n第二个\n```";
    expect(parseAskFence(text)).toBe("第一个");
  });
});
