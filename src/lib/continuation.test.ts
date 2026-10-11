import { describe, expect, it } from "vitest";

import {
  ARMED_TTL_MS,
  buildContinuation,
  CONTINUATION_MARKER,
  describeStop,
  isArmedFresh,
  MAX_RESULT_CHARS,
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
  it("刚武装的算数,过期的作废", () => {
    expect(isArmedFresh(1000, 1000)).toBe(true);
    expect(isArmedFresh(1000, 1000 + ARMED_TTL_MS)).toBe(true);
    expect(isArmedFresh(1000, 1001 + ARMED_TTL_MS)).toBe(false);
  });
});

describe("describeStop", () => {
  it("上限那个码说人话,册子外的码照原样带上", () => {
    expect(describeStop(STOP_CONTINUATION_LIMIT)).toContain("停手");
    expect(describeStop("something-else")).toContain("something-else");
  });
});
