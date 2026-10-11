import { describe, expect, it } from "vitest";

import { ARMED_TTL_MS } from "./armed";
import {
  buildContinuation,
  CONTINUATION_MARKER,
  describeStop,
  isArmedFresh,
  MAX_RESULT_CHARS,
  MAX_SAFE_INPUT_TOKENS,
  STOP_CONTINUATION_LIMIT,
  truncateResult,
} from "./continuation";
import { hasReplyAnchor, okPayload } from "./reply";

describe("CONTINUATION_MARKER", () => {
  it("守首行锚(第一行恰好是 agent:),第二行才是那个词,总共两行", () => {
    const lines = CONTINUATION_MARKER.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("agent:");
    expect(hasReplyAnchor(CONTINUATION_MARKER)).toBe(true);
    expect(CONTINUATION_MARKER.length).toBeLessThan(20);
  });
});

describe("truncateResult", () => {
  it("没超就一个字不动", () => {
    expect(truncateResult("短的正文")).toBe("短的正文");
  });

  it("刚好到上限不算截断", () => {
    const text = "x".repeat(MAX_RESULT_CHARS);
    expect(truncateResult(text)).toBe(text);
  });

  it('超了留一句"已截断"并写明原长', () => {
    const text = "x".repeat(MAX_RESULT_CHARS + 10);
    const out = truncateResult(text);
    expect(out.startsWith("x".repeat(MAX_RESULT_CHARS))).toBe(true);
    expect(out).toContain("已截断");
    expect(out).toContain(`${MAX_RESULT_CHARS + 10} 字`);
  });

  it("上限可传参", () => {
    expect(truncateResult("abcdef", 3)).toContain("已截断");
    expect(truncateResult("abc", 3)).toBe("abc");
  });

  it("与 dsb 那一页 read 的预算对齐,于是**一页 read 不会被腰斩**(ADR-0026)", () => {
    // 12% 那个窟窿的形状:dsb 交出 16000,这里只放 2000 进去.
    // 两边现在同数,一页 read 的结果能原样进对话--这个不等式别悄悄回去.
    expect(MAX_RESULT_CHARS).toBe(16_000);
    expect(truncateResult("x".repeat(16_000))).toBe("x".repeat(16_000));
  });

  it("MAX_SAFE_INPUT_TOKENS 就是本仓的上下文预算 90 万,不是实测硬墙(ADR-0028)", () => {
    // 实测硬墙在 [982000, 982700).预算取 90 万,差额 ~82,000 token **是余量**--
    // 用来吸收量不到的部分(站点系统提示词,服务端下发的浮动,上下文压缩).
    // 改成实测值 = 把余量删掉,不是把精度调准;要改先读 ADR-0028.
    expect(MAX_SAFE_INPUT_TOKENS).toBe(900_000);
    // 余量真的存在:8 轮刹车下的最坏 128,000 字远在它之下,这条闸当前不咬.
    expect(8 * MAX_RESULT_CHARS).toBeLessThan(MAX_SAFE_INPUT_TOKENS / 2);
  });
});

describe("buildContinuation", () => {
  it("就是原来那段回灌载荷(首行锚 + TOON),只是改走请求体", () => {
    const text = buildContinuation(okPayload("入口在 dsb/server.py."));
    const lines = text.split("\n");
    expect(lines[0]).toBe("agent:");
    expect(lines[1]).toBe("status: ok");
    expect(text).toContain("answer[1]{text}:");
  });

  it("多行正文不产生换行转义(解码方是模型,不是解析器)", () => {
    const text = buildContinuation(okPayload("第一行\n第二行"));
    expect(text).not.toContain("\\n");
    expect(text).toContain("  第一行\n  第二行");
  });

  it('超长结果先截断再编码,末尾带"已截断"', () => {
    const text = buildContinuation(okPayload("x".repeat(MAX_RESULT_CHARS + 5)));
    expect(text).toContain("已截断");
    expect(text).not.toContain("\\n");
  });
});

describe("isArmedFresh / 武装的有效期", () => {
  it("刚武装的算数,过期的作废(期限由调用方给)", () => {
    expect(isArmedFresh(1000, 1000, ARMED_TTL_MS)).toBe(true);
    expect(isArmedFresh(1000, 1000 + ARMED_TTL_MS, ARMED_TTL_MS)).toBe(true);
    expect(isArmedFresh(1000, 1001 + ARMED_TTL_MS, ARMED_TTL_MS)).toBe(false);
  });
});

describe("describeStop", () => {
  it("上限那个码说人话,册子外的码照原样带上", () => {
    expect(describeStop(STOP_CONTINUATION_LIMIT)).toContain("停手");
    expect(describeStop("something-else")).toContain("something-else");
  });
});
