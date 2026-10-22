import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER } from "./continuation";
import { isOutgoingChatRequest, recognizeOutgoingShape, rewriteOutgoingBody } from "./inject";
import { prependInstructions, protocolInstructions } from "./instructions";
import type { ToolInfo } from "./relay";
import { buildReply, okPayload, REPLY_ANCHOR } from "./reply";

/** 工具目录:null = 还没取到(本文件里的对拍都按这份喂). */
const TOOLS: readonly ToolInfo[] | null = null;

/** 接线侧就是这么用的:认一次形状,把结果交给拼说明(与认领裁决共用同一次识别). */
function rewrite(body: string, tools: readonly ToolInfo[] | null = TOOLS): string | null {
  return rewriteOutgoingBody(recognizeOutgoingShape(body), { tools });
}

describe("isOutgoingChatRequest", () => {
  it("认得站点原生的发消息出口", () => {
    expect(isOutgoingChatRequest("POST", "https://chat.deepseek.com/api/v0/chat/completion")).toBe(
      true,
    );
    expect(isOutgoingChatRequest("post", "/api/v0/chat/completion")).toBe(true);
    expect(isOutgoingChatRequest("POST", "https://chat.deepseek.com/api/v0/chat/regenerate")).toBe(
      true,
    );
    expect(isOutgoingChatRequest("POST", "https://api.deepseek.com/v1/chat/completions")).toBe(
      true,
    );
  });

  it("方法不对不碰", () => {
    expect(isOutgoingChatRequest("GET", "/api/v0/chat/completion")).toBe(false);
    expect(isOutgoingChatRequest("PUT", "/api/v0/chat/completion")).toBe(false);
  });

  it("同域名的别的接口不碰", () => {
    expect(isOutgoingChatRequest("POST", "/api/v0/chat/create_session")).toBe(false);
    expect(isOutgoingChatRequest("POST", "/api/v0/chat_session/fetch_page")).toBe(false);
    expect(isOutgoingChatRequest("POST", "/api/v0/chat/history_messages?x=1")).toBe(false);
    expect(isOutgoingChatRequest("POST", "https://chat.deepseek.com/api/v0/users/current")).toBe(
      false,
    );
  });

  it("第三方域名上碰巧同名的路径不碰", () => {
    expect(isOutgoingChatRequest("POST", "https://evil.example/v1/chat/completions")).toBe(false);
    expect(
      isOutgoingChatRequest("POST", "https://deepseek.com.evil.example/api/v0/chat/completion"),
    ).toBe(false);
  });

  it("地址本身解不开也不抛:认不出就是不碰", () => {
    expect(isOutgoingChatRequest("POST", "http://[bad/api/v0/chat/completion")).toBe(false);
  });
});

describe("rewriteOutgoingBody", () => {
  it("把协议说明拼在 prompt 开头,原文一个字不丢", () => {
    const prompt = "帮我看看这个报错";
    const rewritten = rewrite(JSON.stringify({ prompt, chat_session_id: "s1" }), TOOLS);

    expect(rewritten).not.toBeNull();
    const payload = JSON.parse(rewritten ?? "") as Record<string, unknown>;
    const ctx = { tools: TOOLS };
    expect(payload.prompt).toBe(prependInstructions(prompt, ctx));
    expect(payload.chat_session_id).toBe("s1");
    expect(String(payload.prompt).startsWith(`${protocolInstructions(ctx)}\n\n`)).toBe(true);
  });

  it("多行消息整段原样跟在协议说明后面", () => {
    const prompt = "第一行\n第二行\n\n第四行(空行后面)";
    const rewritten = rewrite(JSON.stringify({ prompt }), TOOLS);
    const payload = JSON.parse(rewritten ?? "") as Record<string, unknown>;

    expect(payload.prompt).toBe(`${protocolInstructions({ tools: TOOLS })}\n\n${prompt}`);
    expect(String(payload.prompt).endsWith(prompt)).toBe(true);
  });

  it("空消息没东西可发,原样放行", () => {
    expect(rewrite(JSON.stringify({ prompt: "" }), TOOLS)).toBeNull();
    expect(rewrite(JSON.stringify({ prompt: "   \n  " }), TOOLS)).toBeNull();
    expect(rewrite("", TOOLS)).toBeNull();
  });

  it("拼过一遍的不再拼第二遍", () => {
    const once = rewrite(JSON.stringify({ prompt: "原文" }), TOOLS);

    expect(once).not.toBeNull();
    expect(rewrite(once ?? "", TOOLS)).toBeNull();
  });

  it("messages 形状:只动 role: user,历史里的角色照旧", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "你是个助手" },
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "上一轮答复" },
        { role: "user", content: "这一轮" },
      ],
    });

    const rewritten = rewrite(body, TOOLS);
    expect(rewritten).not.toBeNull();

    const payload = JSON.parse(rewritten ?? "") as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[0]?.content).toBe("你是个助手");
    expect(payload.messages[1]?.content).toBe(prependInstructions("上一轮", { tools: TOOLS }));
    expect(payload.messages[2]?.content).toBe("上一轮答复");
    expect(payload.messages[3]?.content).toBe(prependInstructions("这一轮", { tools: TOOLS }));
  });

  it("整段历史再发一遍时,拼过的用户消息不会被拼第二次", () => {
    const first = rewrite(JSON.stringify({ messages: [{ role: "user", content: "原文" }] }), TOOLS);
    const second = rewrite(first ?? "", TOOLS);

    expect(second).toBeNull();
  });

  it("认不出的载荷原样放行", () => {
    expect(rewrite("不是 JSON", TOOLS)).toBeNull();
    expect(rewrite("[1,2,3]", TOOLS)).toBeNull();
    expect(rewrite('"prompt"', TOOLS)).toBeNull();
    expect(rewrite(JSON.stringify({ messages: "不是数组" }), TOOLS)).toBeNull();
    expect(rewrite(JSON.stringify({ text: "别的字段" }), TOOLS)).toBeNull();
    expect(
      rewrite(JSON.stringify({ messages: [{ role: "tool", content: "回执" }] }), TOOLS),
    ).toBeNull();
    expect(
      rewrite(JSON.stringify({ messages: [{ role: "user", content: 42 }] }), TOOLS),
    ).toBeNull();
  });

  it("回灌消息(首行锚 dsb:)不拼协议说明,首行锚留在第一行", () => {
    const reply = buildReply(okPayload("答复正文"));

    expect(reply.split("\n")[0]).toBe(REPLY_ANCHOR);
    expect(rewrite(JSON.stringify({ prompt: reply }), TOOLS)).toBeNull();
    expect(
      rewrite(JSON.stringify({ messages: [{ role: "user", content: reply }] }), TOOLS),
    ).toBeNull();
  });

  it("只是以 dsb 开头的普通消息照样拼说明", () => {
    const rewritten = rewrite(JSON.stringify({ prompt: "dsb 你好,帮我看看" }), TOOLS);
    expect(rewritten).not.toBeNull();
    expect(JSON.parse(rewritten ?? "")["prompt"]).toBe(
      prependInstructions("dsb 你好,帮我看看", { tools: TOOLS }),
    );
  });

  it("说明首行出现在正文中间不算拼过:只有整段就顶在头上才跳过", () => {
    const text = "引用一句:[ds 协议] 这几个字是我自己打的";
    const rewritten = rewrite(JSON.stringify({ prompt: text }), TOOLS);
    expect(rewritten).not.toBeNull();
    expect(JSON.parse(rewritten ?? "")["prompt"]).toBe(prependInstructions(text, { tools: TOOLS }));
  });

  it("工具目录跟着说明一起拼进去(隔离世界广播下来那份)", () => {
    const catalog: readonly ToolInfo[] = [
      { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
    ];
    const rewritten = rewrite(JSON.stringify({ prompt: "原文" }), catalog);
    const prompt = String(JSON.parse(rewritten ?? "")["prompt"]);
    expect(prompt).toContain("- fs_read_file(path, encoding?) -- [fs] 读文件内容");
    expect(prompt.endsWith("\n\n原文")).toBe(true);
  });

  it('目录还没取到时,说明里写"先别排围栏"', () => {
    const rewritten = rewrite(JSON.stringify({ prompt: "原文" }), null);
    expect(String(JSON.parse(rewritten ?? "")["prompt"])).toContain("工具表暂未取到");
  });
});

describe("recognizeOutgoingShape / 出站请求体的一次识别", () => {
  it("形状认得出:prompt 是字符串,或 messages 是数组(站点换形状时只改这一处)", () => {
    expect(recognizeOutgoingShape(JSON.stringify({ prompt: "你好" })).shapeOk).toBe(true);
    // 空 prompt 是认得出的形状,只是没有待发的文本
    expect(recognizeOutgoingShape(JSON.stringify({ prompt: "" })).shapeOk).toBe(true);
    expect(recognizeOutgoingShape(JSON.stringify({ messages: [] })).shapeOk).toBe(true);
    expect(
      recognizeOutgoingShape(
        JSON.stringify({ prompt: 42, messages: [{ role: "user", content: "x" }] }),
      ).shapeOk,
    ).toBe(true);
  });

  it("形状认不出:不是 JSON / 不是对象 / 两个字段都不在", () => {
    expect(recognizeOutgoingShape("不是 JSON").shapeOk).toBe(false);
    expect(recognizeOutgoingShape("[1,2,3]").shapeOk).toBe(false);
    expect(recognizeOutgoingShape('"prompt"').shapeOk).toBe(false);
    expect(recognizeOutgoingShape(JSON.stringify({})).shapeOk).toBe(false);
    expect(recognizeOutgoingShape(JSON.stringify({ prompt: 42 })).shapeOk).toBe(false);
    expect(recognizeOutgoingShape(JSON.stringify({ messages: "不是数组" })).shapeOk).toBe(false);
    expect(recognizeOutgoingShape(JSON.stringify({ text: "别的字段" })).shapeOk).toBe(false);
  });

  it("用法一 pendingText:待发那条用户消息(prompt,或 messages 里最后一条 user)", () => {
    expect(
      recognizeOutgoingShape(JSON.stringify({ prompt: CONTINUATION_MARKER })).pendingText,
    ).toBe(CONTINUATION_MARKER);
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "待发的" },
      ],
    });
    expect(recognizeOutgoingShape(body).pendingText).toBe("待发的");
  });

  it("用法一 pendingText:取不出时 null(形状认得出但没有待发的 user 文本)", () => {
    expect(recognizeOutgoingShape("不是 JSON").pendingText).toBeNull();
    expect(recognizeOutgoingShape(JSON.stringify({})).pendingText).toBeNull();
    expect(recognizeOutgoingShape(JSON.stringify({ prompt: "   " })).pendingText).toBeNull();
    expect(recognizeOutgoingShape(JSON.stringify({ prompt: 42 })).pendingText).toBeNull();
    expect(
      recognizeOutgoingShape(JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }))
        .pendingText,
    ).toBeNull();
  });

  it("用法一 pendingText:末条 user 的 content 不是字串时越过它往前找", () => {
    const shape = recognizeOutgoingShape(
      JSON.stringify({
        messages: [
          { role: "user", content: "老消息" },
          { role: "user", content: [{ type: "text", text: "结构化的正文" }] },
        ],
      }),
    );

    expect(shape.pendingText).toBe("老消息");
    const replaced = JSON.parse(shape.replacePending("换掉") ?? "") as {
      messages: { content: unknown }[];
    };
    expect(replaced.messages[0]?.content).toBe("换掉");
    expect(replaced.messages[1]?.content).toEqual([{ type: "text", text: "结构化的正文" }]);
  });

  const CONTINUATION = "agent:\nstatus: ok\nanswer[1]{text}:\n  入口在 dsb/server.py.";

  it("用法二 replacePending:prompt 形状整条换掉,其余字段一个不动", () => {
    const body = JSON.stringify({ prompt: "agent:\n继续", session_id: "s-1", stream: true });
    const rewritten = recognizeOutgoingShape(body).replacePending(CONTINUATION);
    expect(rewritten).not.toBeNull();
    const payload = JSON.parse(rewritten ?? "");
    expect(payload["prompt"]).toBe(CONTINUATION);
    expect(payload["session_id"]).toBe("s-1");
    expect(payload["stream"]).toBe(true);
  });

  it("用法二 replacePending:messages 形状换最后一条 user,别的原样", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "agent:\n继续" },
      ],
    });
    const payload = JSON.parse(recognizeOutgoingShape(body).replacePending(CONTINUATION) ?? "");
    expect(payload.messages[0].content).toBe("第一问");
    expect(payload.messages[1].content).toBe("第一答");
    expect(payload.messages[2].content).toBe(CONTINUATION);
  });

  it("用法二 replacePending:认不出形状或没有待发的槽位一律 null(宁可少一轮)", () => {
    expect(recognizeOutgoingShape("不是 JSON").replacePending(CONTINUATION)).toBeNull();
    expect(recognizeOutgoingShape(JSON.stringify({})).replacePending(CONTINUATION)).toBeNull();
    expect(
      recognizeOutgoingShape(JSON.stringify({ prompt: "   " })).replacePending(CONTINUATION),
    ).toBeNull();
    expect(
      recognizeOutgoingShape(JSON.stringify({ prompt: 42 })).replacePending(CONTINUATION),
    ).toBeNull();
    expect(
      recognizeOutgoingShape(
        JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }),
      ).replacePending(CONTINUATION),
    ).toBeNull();
  });

  it("用法二 replacePending:换进去的正文是物理换行,不是字面反斜杠 n", () => {
    const rewritten = recognizeOutgoingShape(
      JSON.stringify({ prompt: CONTINUATION_MARKER }),
    ).replacePending(CONTINUATION);
    const decoded = String(JSON.parse(rewritten ?? "")["prompt"]);
    expect(decoded).toContain("\n");
    expect(decoded).not.toContain("\\n");
  });

  it("用法三 mapAllUserTexts:所有 user 文本各映一次,别的角色照旧", () => {
    const body = JSON.stringify({
      prompt: "开场白",
      messages: [
        { role: "system", content: "你是个助手" },
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "上一轮答复" },
        { role: "user", content: "这一轮" },
      ],
    });
    const rewritten = recognizeOutgoingShape(body).mapAllUserTexts((text) => `[${text}]`);
    expect(rewritten).not.toBeNull();
    const payload = JSON.parse(rewritten ?? "");
    expect(payload.prompt).toBe("[开场白]");
    expect(payload.messages[0].content).toBe("你是个助手");
    expect(payload.messages[1].content).toBe("[上一轮]");
    expect(payload.messages[2].content).toBe("上一轮答复");
    expect(payload.messages[3].content).toBe("[这一轮]");
  });

  it("用法三 mapAllUserTexts:没有一处改动,或形状认不出 → null", () => {
    expect(
      recognizeOutgoingShape(JSON.stringify({ prompt: "原文" })).mapAllUserTexts(() => null),
    ).toBeNull();
    expect(
      recognizeOutgoingShape(
        JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }),
      ).mapAllUserTexts(() => "[x]"),
    ).toBeNull();
    expect(recognizeOutgoingShape("不是 JSON").mapAllUserTexts((text) => text)).toBeNull();
    expect(
      recognizeOutgoingShape(JSON.stringify({ text: "别的字段" })).mapAllUserTexts((text) => text),
    ).toBeNull();
  });

  it("替换与映射各起一份:同一份形状用两次,后一次看到的还是原正文(#103 共用同一次识别)", () => {
    const shape = recognizeOutgoingShape(JSON.stringify({ prompt: "原文" }));

    expect(String(JSON.parse(shape.replacePending("甲") ?? "")["prompt"])).toBe("甲");
    expect(String(JSON.parse(shape.mapAllUserTexts((text) => `乙:${text}`) ?? "")["prompt"])).toBe(
      "乙:原文",
    );
    expect(String(JSON.parse(shape.mapAllUserTexts((text) => `丙:${text}`) ?? "")["prompt"])).toBe(
      "丙:原文",
    );
    expect(String(JSON.parse(shape.replacePending("丁") ?? "")["prompt"])).toBe("丁");
  });
});
