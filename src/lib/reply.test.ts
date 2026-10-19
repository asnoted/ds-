import { describe, expect, it } from "vitest";

import { fixtureCases, type ReplyCase } from "./fixtures";
import {
  buildReply,
  errorPayload,
  failureNotice,
  hasReplyAnchor,
  isInjectableReply,
  isKnownFailureKind,
  isReplyPayload,
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

  it("孤立代理字符折成替换字符:TOON 编不出来也不能把整条回灌丢掉", () => {
    // 工具结果里会有半个代理项:第三方 MCP server 回话里的 `\ud800`(dsb 那边
    // 故意用全转义带上线,解回来还是同一个串),或模型自己写坏的半个 emoji 转义
    // 被错误回执原样回显(`bad-path(路径 x\ud800)`).TOON 的 encode 见到不成对的
    // 代理项**抛 TypeError**,而这段编码在 `decide` 里跑--一抛,这一轮的结果就
    // 整条丢:工具跑了,模型永远等不到回灌.
    // 折法只动不成对的:星平面字(成对)原样留.
    const message = buildReply(okPayload("路径 x\ud800 读不了,😀 照旧"));
    expect(message).toContain("\uFFFD");
    expect(message).toContain("😀");
    expect(parseReplyPayload(message)).toEqual(okPayload("路径 x\uFFFD 读不了,😀 照旧"));
    // 另一支也一样:这条编码只有一个出口,两支都得编得出来.
    expect(parseReplyPayload(buildReply(errorPayload("code\ud800")))).toEqual(
      errorPayload("code\uFFFD"),
    );
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

describe("isReplyPayload / 线上正文的逆", () => {
  // 认得出形状才让载荷进流程;正文那半由 `parseReplyPayload` 解,解出来的值经这儿再认一次.
  it("ok 载荷:answer 得是字符串", () => {
    expect(isReplyPayload({ status: "ok", answer: "答案" })).toBe(true);
    expect(isReplyPayload({ status: "ok", answer: 42 })).toBe(false);
    expect(isReplyPayload({ status: "ok" })).toBe(false);
  });

  it("error 载荷:error 得是字符串", () => {
    expect(isReplyPayload({ status: "error", error: "relay-unreachable" })).toBe(true);
    expect(isReplyPayload({ status: "error", error: 42 })).toBe(false);
    expect(isReplyPayload({ status: "error" })).toBe(false);
  });

  it("认不出的形状整个作废", () => {
    expect(isReplyPayload({ status: "loading" })).toBe(false);
    expect(isReplyPayload(null)).toBe(false);
    expect(isReplyPayload([])).toBe(false);
    expect(isReplyPayload("agent:")).toBe(false);
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

  it("锚是**整行**,不是前缀", () => {
    // 前缀式判定会把人在对话框里打的"agent: 你好"认成回灌 --
    // 那 `wait.ts` 就会把人的消息当成"我灌的那条出来了",白判一次成功.
    expect(hasReplyAnchor("agent:你好")).toBe(false);
    expect(hasReplyAnchor("agent: 你好")).toBe(false);
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

  it("码是从中继线上原样来的:落在原型上的键也不算在册", () => {
    for (const kind of ["toString", "constructor", "hasOwnProperty"]) {
      expect(isKnownFailureKind(kind)).toBe(false);
      expect(failureNotice(kind).title).toBe("中继不可达");
      expect(failureNotice(kind).reason).toContain(kind);
    }
  });
});
