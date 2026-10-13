import { describe, expect, it } from "vitest";

import { normalizeText } from "./normalize";

describe("归一化只放宽两处:换行统一与首尾空白(ADR-0020)", () => {
  it("CRLF 统一成 LF,首尾空白去掉", () => {
    expect(normalizeText("agent:\r\n继续")).toBe("agent:\n继续");
    expect(normalizeText("\n  继续\r\n")).toBe("继续");
  });

  it("文内字符与文内空白一个不动:归一化不是模糊比较", () => {
    expect(normalizeText("agent:\n 继续")).toBe("agent:\n 继续");
    expect(normalizeText("继 续")).toBe("继 续");
    expect(normalizeText("agent:\n继续 ")).toBe("agent:\n继续");
  });
});
