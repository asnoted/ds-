import { describe, expect, it } from "vitest";

import {
  describeContinuationFailure,
  describeThrownFailure,
  type ContinuationFailure,
} from "./continuationfail";

describe("describeContinuationFailure / 原因短句", () => {
  it("每个失败点各有一句,且彼此能区分(尤其输入框那三种不许合并)", () => {
    const composer = describeContinuationFailure("composer-absent");
    const unwritable = describeContinuationFailure("composer-unwritable");
    const sendFailed = describeContinuationFailure("send-failed");
    expect(new Set([composer, unwritable, sendFailed]).size).toBe(3);
    expect(composer).toContain("没找到输入框");
    expect(unwritable).toContain("写不进去");
    expect(sendFailed).toContain("没发出去");
  });

  it("其余几个失败点也说得出是哪一步", () => {
    expect(describeContinuationFailure("shape-unknown")).toContain("形状认不出");
    expect(describeContinuationFailure("key-mismatch")).toContain("短标记");
    expect(describeContinuationFailure("armed-expired")).toContain("过期");
    expect(describeContinuationFailure("toggle-off")).toContain("总开关");
    expect(describeContinuationFailure("draft-in-composer")).toContain("草稿");
    expect(describeContinuationFailure("session-changed")).toContain("换了会话");
  });

  it("换会话与钥匙不符各说各的,不复用同一句", () => {
    expect(describeContinuationFailure("session-changed")).not.toBe(
      describeContinuationFailure("key-mismatch"),
    );
    expect(describeContinuationFailure("session-changed")).not.toContain("你发了");
  });

  // #92:短标记写进输入框后,用户随后打的字会把它顶掉,于是"无视标记发了自己那条"
  // 与"标记先被盖掉,用户再发自己那条"在出站那一刻**分不出来**.措辞必须对两者都
  // 成立,且不能把原因指向用户--那会把排查方向整个带偏.
  it('钥匙不符不指责用户,并把"可能被打字盖掉"点出来(#92)', () => {
    const cause = describeContinuationFailure("key-mismatch");
    expect(cause).not.toContain("你发了");
    expect(cause).toContain("短标记");
    expect(cause).toContain("打字");
  });

  it("册子外的码照原样带上(跨版本残留 / 拼错),不丢成空白", () => {
    expect(describeContinuationFailure("未来加的码")).toBe("页面报续聊失败(未来加的码)");
  });

  it("短句里不带任何正文:拿带明显标记的输入试,断言它不出现在短句里", () => {
    // 用户正在打的字,问题,答复,工具结果--一律不该进失败痕(ADR-0004).
    const secrets = [
      "SECRET-QUESTION-问用户的",
      "SECRET-ANSWER-模型的答复",
      "SECRET-TOOLRESULT-工具结果",
    ];
    for (const secret of secrets) {
      for (const code of [
        "composer-absent",
        "composer-unwritable",
        "send-failed",
        "shape-unknown",
        "key-mismatch",
        "armed-expired",
        "toggle-off",
        "draft-in-composer",
        "session-changed",
      ] satisfies ContinuationFailure[]) {
        expect(describeContinuationFailure(code)).not.toContain(secret);
      }
    }
  });
});

describe("describeThrownFailure / 抛错只留类型名", () => {
  it("带错误类型名,不带 message(message 里可能嵌着用户的东西)", () => {
    const error = new TypeError("SECRET-QUESTION-用户正在打的东西");
    const cause = describeThrownFailure(error);
    expect(cause).toContain("TypeError");
    expect(cause).toContain("抛了错");
    expect(cause).not.toContain("SECRET-QUESTION");
    expect(cause).not.toContain("用户正在打的东西");
  });

  it("不是 Error 的东西也说得清(类型名兜底)", () => {
    expect(describeThrownFailure("一段字符串")).toContain("string");
    expect(describeThrownFailure(undefined)).toContain("undefined");
  });
});
