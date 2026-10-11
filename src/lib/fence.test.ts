import { describe, expect, it } from "vitest";

import { fixtureCases, type FenceCase } from "./fixtures";
import { compactToolCall, parseAskFence, parseSendFence, parseSendFences } from "./fence";

describe("parseSendFences / 共享 fixture", () => {
  for (const { name, input, expectedCalls } of fixtureCases<FenceCase>("fence.json")) {
    it(name, () => {
      expect(parseSendFences(input)).toEqual(expectedCalls);
      // 只取第一块的那个口子(`wait.fence` 用)与它同源,别各切一套.
      expect(parseSendFence(input)).toBe(expectedCalls[0] ?? null);
    });
  }
});

describe("parseSendFences / 只管取正文,压紧是出口那一步的事(#93)", () => {
  it("pretty JSON 逐字取出:一个空格都不动", () => {
    const pretty =
      '```send\n{\n  "tool": "read",\n  "arguments": {\n    "path": "README.md"\n  }\n}\n```';
    expect(parseSendFences(pretty)).toEqual([
      '{\n  "tool": "read",\n  "arguments": {\n    "path": "README.md"\n  }\n}',
    ]);
  });

  it("出口(detectToolCalls)拿到的已经是紧凑形态", () => {
    const pretty =
      '```send\n{\n  "tool": "read",\n  "arguments": {\n    "path": "README.md"\n  }\n}\n```';
    expect(parseSendFences(pretty).map(compactToolCall)).toEqual([
      '{"tool":"read","arguments":{"path":"README.md"}}',
    ]);
  });
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

describe("compactToolCall / 转发给中继前压成紧凑 JSON(#93)", () => {
  it("带空格的单行:冒号后与逗号后的空白都去掉", () => {
    expect(compactToolCall('{"tool": "read", "arguments": {"path": "README.md"}}')).toBe(
      '{"tool":"read","arguments":{"path":"README.md"}}',
    );
  });

  it("多行 pretty JSON:压成一行", () => {
    const pretty = '{\n  "tool": "read",\n  "arguments": {\n    "path": "README.md"\n  }\n}';
    expect(compactToolCall(pretty)).toBe('{"tool":"read","arguments":{"path":"README.md"}}');
  });

  it("本来就紧凑的:原样返回(幂等)", () => {
    const compact = '{"tool":"a","arguments":{}}';
    expect(compactToolCall(compact)).toBe(compact);
    expect(compactToolCall(compactToolCall(compact))).toBe(compact);
  });

  it("已经压过的不再变(幂等是这条能进契约夹具的前提)", () => {
    const once = compactToolCall('{"tool": "a", "arguments": {}}');
    expect(compactToolCall(once)).toBe(once);
  });

  it("键序照模型写的样子,不重排", () => {
    expect(compactToolCall('{"z": 1, "a": 2, "m": 3}')).toBe('{"z":1,"a":2,"m":3}');
  });

  it("非 JSON / 不是对象:原样透传(不猜,不改坏模型写的东西)", () => {
    expect(compactToolCall("不是 JSON")).toBe("不是 JSON");
    expect(compactToolCall("")).toBe("");
    expect(compactToolCall("[1, 2]")).toBe("[1, 2]"); // 数组不是对象
    expect(compactToolCall("42")).toBe("42");
    expect(compactToolCall('"字符串"')).toBe('"字符串"');
  });

  it("半截 JSON(模型写到一半):原样透传,交给上一层报排坏", () => {
    const half = '{"tool": "read", "argum';
    expect(compactToolCall(half)).toBe(half);
  });

  it("中文与转义原样保住(不因为压紧而改内容)", () => {
    expect(compactToolCall('{"路径": "中文/目录", "n": 1.5, "b": true, "z": null}')).toBe(
      '{"路径":"中文/目录","n":1.5,"b":true,"z":null}',
    );
  });

  it("嵌套结构也压紧", () => {
    expect(compactToolCall('{"a": {"b": [1, 2]}, "c": [{"d": 1}]}')).toBe(
      '{"a":{"b":[1,2]},"c":[{"d":1}]}',
    );
  });
});
