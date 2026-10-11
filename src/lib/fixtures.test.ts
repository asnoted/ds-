import { describe, expect, it } from "vitest";

import {
  FIXTURE_FILENAMES,
  fixtureCases,
  fixtureFile,
  type ActionCase,
  type ActionFixtureFile,
  type ConfigCase,
  type FenceCase,
  type ReplyCase,
} from "./fixtures";
import { isKnownFailureKind, REPLY_ANCHOR } from "./reply";

const EXPECTED_FILES = ["action.json", "config.json", "fence.json", "reply.json"];

/** 配置只有一种解析分支:认端口 / 会话号那套已随问答后端废掉(ADR-0011). */
const KNOWN_CONFIG_KINDS = ["value"];

function rawCases(filename: string): Record<string, unknown>[] {
  return fixtureFile(filename).cases.map((oneCase) => {
    if (typeof oneCase !== "object" || oneCase === null || Array.isArray(oneCase)) {
      throw new Error(`${filename} 的 case 不是对象:${JSON.stringify(oneCase)}`);
    }
    return oneCase as Record<string, unknown>;
  });
}

function expectReplyPayload(value: unknown): void {
  const record = rawPayload(value);
  expect(["ok", "error"]).toContain(record["status"]);
  if (record["status"] === "ok") {
    expect(typeof record["answer"]).toBe("string");
    expect(record).not.toHaveProperty("error");
  } else {
    expect(typeof record["error"]).toBe("string");
    expect(record).not.toHaveProperty("answer");
  }
}

function rawPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`载荷不是对象:${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

describe("共享 fixture 完整性", () => {
  it("四个 fixture 都在,且两半按同一份清单读", () => {
    expect(FIXTURE_FILENAMES).toEqual(EXPECTED_FILES);
  });

  it.each(EXPECTED_FILES)("%s 有说明与非空 cases", (filename) => {
    const file = fixtureFile(filename);
    expect(file.description.length).toBeGreaterThan(0);
    expect(file.cases.length).toBeGreaterThan(0);
  });

  it.each(EXPECTED_FILES)("%s 的 case 名不重样", (filename) => {
    const names = rawCases(filename).map((oneCase) => oneCase["name"]);
    for (const name of names) expect(typeof name).toBe("string");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("围栏 fixture 自洽", () => {
  it("抽出围栏正文的输入里必须排着 ```send 围栏", () => {
    for (const { input, expectedCalls } of fixtureCases<FenceCase>("fence.json")) {
      if (expectedCalls.length > 0) expect(input).toContain("```send");
    }
  });

  it("抽出几块,输入里就得有几个围栏起始行(多块那条判据的镜子)", () => {
    for (const { name, input, expectedCalls } of fixtureCases<FenceCase>("fence.json")) {
      const openings = input.split("\n").filter((line) => line.trim() === "```send").length;
      expect(openings, name).toBeGreaterThanOrEqual(expectedCalls.length);
    }
  });
});

describe("回灌 fixture 自洽", () => {
  it("载荷符合 status + answer/error 的同构形状", () => {
    for (const { payload } of fixtureCases<ReplyCase>("reply.json")) {
      expectReplyPayload(payload);
    }
  });

  it("预期消息首行是首行锚,且带着载荷", () => {
    for (const { expectedMessage } of fixtureCases<ReplyCase>("reply.json")) {
      const lines = expectedMessage.split("\n");
      expect(lines[0]).toBe(REPLY_ANCHOR);
      expect(lines.slice(1).join("\n")).toContain("status:");
    }
  });

  it("正文里没有换行转义(解码方是 LLM,字面 \\n 它不会还原)", () => {
    for (const { expectedMessage } of fixtureCases<ReplyCase>("reply.json")) {
      expect(expectedMessage).not.toMatch(/\\n/);
    }
  });

  it("error 分支的错误码扩展侧都有失败提示(对拍:两码在册)", () => {
    for (const { payload } of fixtureCases<ReplyCase>("reply.json")) {
      if (payload.status === "error") expect(isKnownFailureKind(payload.error)).toBe(true);
    }
  });
});

describe("配置 fixture 自洽", () => {
  it("只覆盖已知的解析分支,key 与输入输出都在场", () => {
    for (const { name, kind, key, input, expected } of fixtureCases<ConfigCase>("config.json")) {
      expect(KNOWN_CONFIG_KINDS).toContain(kind);
      expect(typeof name).toBe("string");
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(typeof input).toBe("string");
      expect(typeof expected).toBe("object");
    }
  });
});

describe("动作 fixture 自洽", () => {
  it("失败码册子里 code 不重样,when 非空", () => {
    const file = fixtureFile("action.json") as ActionFixtureFile;
    const codes = file.errorCodes.map(({ code, when }) => {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
      expect(typeof when).toBe("string");
      expect(when.length).toBeGreaterThan(0);
      return code;
    });
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("每个 case:请求体三条字段在场,响应是同构的两条之一", () => {
    for (const { request, response } of fixtureCases<ActionCase>("action.json")) {
      expect(typeof request.action).toBe("string");
      expect(request.params).toBeTypeOf("object");
      expect(request.target === null || typeof request.target === "string").toBe(true);
      expect(typeof response.ok).toBe("boolean");
      expect(response).not.toHaveProperty("action"); // 扩展只回 {ok,result} / {ok,error}
    }
  });

  it("成功不带 error,失败带册子上的码(对拍)", () => {
    const codes = (fixtureFile("action.json") as ActionFixtureFile).errorCodes.map(
      ({ code }) => code,
    );
    for (const { name, response } of fixtureCases<ActionCase>("action.json")) {
      if (response.ok) {
        expect(response).not.toHaveProperty("error");
        expect(response).toHaveProperty("result");
      } else {
        expect(codes).toContain(response.error);
        expect(response).not.toHaveProperty("result");
      }
      expect(typeof name).toBe("string");
    }
  });
});
