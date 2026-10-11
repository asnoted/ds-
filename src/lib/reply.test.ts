import { describe, expect, it } from "vitest";

import { fixtureCases, type ReplyCase } from "./fixtures";
import {
  buildReply,
  errorPayload,
  failureNotice,
  hasReplyAnchor,
  isInjectableReply,
  isKnownFailureKind,
  okPayload,
  parseReplyPayload,
  REPLY_ANCHOR,
  RELAY_START_COMMAND,
  type FailureKind,
} from "./reply";

/** 扩展侧失败提示能显示的全部原因:只有这两条(连不上 / 认不出). */
const FAILURE_KINDS: readonly FailureKind[] = ["relay-unreachable", "unexpected-response"];

describe("buildReply / 共享 fixture", () => {
  for (const { name, payload, expectedMessage } of fixtureCases<ReplyCase>("reply.json")) {
    it(name, () => {
      expect(buildReply(payload)).toBe(expectedMessage);
      expect(expectedMessage.split("\n")[0]).toBe(REPLY_ANCHOR);
    });
  }
});

describe("buildReply", () => {
  it("首行是固定的 agent: 字面量", () => {
    expect(buildReply(okPayload("答案")).split("\n")[0]).toBe(REPLY_ANCHOR);
    expect(buildReply(errorPayload("relay-unreachable")).split("\n")[0]).toBe(REPLY_ANCHOR);
    expect(buildReply(okPayload("答案")).startsWith(`agent:\n`)).toBe(true);
  });

  it("载荷是 TOON,status 在第一行", () => {
    expect(buildReply(okPayload("答案")).split("\n")[1]).toBe("status: ok");
    expect(buildReply(errorPayload("relay-unreachable")).split("\n")[1]).toBe("status: error");
  });

  it("多行正文走 tabular:一行正文一条 row,不产生字面换行转义", () => {
    const message = buildReply(okPayload("第一行\n第二行"));
    expect(message).toBe("agent:\nstatus: ok\nanswer[2]{text}:\n  第一行\n  第二行");
    expect(message).not.toMatch(/\\n/);
  });

  it("冒充结构的正文行被 TOON 引号封起来,边界无歧义", () => {
    const message = buildReply(okPayload("agent:\nstatus: error\n- 列表项\n# 注释"));
    expect(message).toContain('"agent:"');
    expect(message).toContain('"status: error"');
    expect(message).toContain('"- 列表项"');
    expect(message).toContain('"# 注释"');
    expect(message).not.toMatch(/\\n/);
  });
});

describe("parseReplyPayload / buildReply 的逆", () => {
  it("单行 / 多行 / 空正文都往返得回来(tabular 行拼回整段)", () => {
    for (const answer of ["答复正文", "第一行\n第二行\n第三行", ""]) {
      expect(parseReplyPayload(buildReply(okPayload(answer)))).toEqual(okPayload(answer));
    }
  });

  it("error 载荷也往返", () => {
    expect(parseReplyPayload(buildReply(errorPayload("timeout")))).toEqual(errorPayload("timeout"));
  });

  it("首行不是锚 → null", () => {
    expect(parseReplyPayload("status: ok\nanswer[1]{text}:\n  x")).toBeNull();
    expect(parseReplyPayload("")).toBeNull();
  });

  it("TOON 解不开或形状不对 → null,不猜", () => {
    expect(parseReplyPayload("agent:\n{")).toBeNull();
    expect(parseReplyPayload("agent:\nstatus: ok")).toBeNull();
    expect(parseReplyPayload("agent:\nstatus: error")).toBeNull();
    expect(parseReplyPayload("agent:\nstatus: loading")).toBeNull();
  });
});

describe("载荷同构", () => {
  it("ok 载荷带 answer", () => {
    expect(okPayload("答案")).toEqual({ status: "ok", answer: "答案" });
  });

  it("error 载荷带 error", () => {
    expect(errorPayload("relay-unreachable")).toEqual({
      status: "error",
      error: "relay-unreachable",
    });
  });
});

describe("isInjectableReply / 失败不进对话流", () => {
  it("status: ok 才回灌进页面", () => {
    expect(isInjectableReply(okPayload("答案"))).toBe(true);
  });

  it("status: error 不进对话流(连不上,认不出两种都不进)", () => {
    expect(isInjectableReply(errorPayload("relay-unreachable"))).toBe(false);
    expect(isInjectableReply(errorPayload("unexpected-response"))).toBe(false);
  });
});

describe("hasReplyAnchor / 首行锚认领", () => {
  it("首行是 agent: 就是回灌消息", () => {
    expect(hasReplyAnchor(buildReply(okPayload("答复")))).toBe(true);
    expect(hasReplyAnchor("agent:")).toBe(true);
    expect(hasReplyAnchor("agent:\nstatus: ok\nanswer: x")).toBe(true);
  });

  it("第一行不是首行锚的不算", () => {
    expect(hasReplyAnchor("开头一行\nagent:")).toBe(false);
    expect(hasReplyAnchor("agent 你好")).toBe(false);
    expect(hasReplyAnchor("")).toBe(false);
  });
});

describe("failureNotice / 扩展侧失败提示", () => {
  it("在册的两条码都有提示,且都带启动命令", () => {
    for (const kind of FAILURE_KINDS) {
      expect(isKnownFailureKind(kind)).toBe(true);
      expect(failureNotice(kind).command).toBe(RELAY_START_COMMAND);
    }
  });

  it('连不上时给"中继不可达"', () => {
    const notice = failureNotice("relay-unreachable");
    expect(notice.title).toBe("中继不可达");
    expect(notice.reason).toContain("dsb");
    expect(notice.command).toBe("uv run dsb");
  });

  it("响应认不出时单独一条措辞", () => {
    expect(failureNotice("unexpected-response").title).toBe("中继响应异常");
  });

  it("认不出的原因降级成一条兜底提示", () => {
    const notice = failureNotice("something-new");
    expect(isKnownFailureKind("something-new")).toBe(false);
    expect(notice.title).toBe("中继不可达");
    expect(notice.reason).toContain("something-new");
  });
});
