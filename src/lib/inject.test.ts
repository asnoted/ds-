import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER } from "./continuation";
import {
  isOutgoingChatRequest,
  outgoingUserTextOf,
  rewriteContinuationBody,
  rewriteOutgoingBody,
} from "./inject";
import { prependInstructions, protocolInstructions } from "./instructions";
import type { ToolInfo } from "./relay";
import { buildReply, okPayload, REPLY_ANCHOR } from "./reply";

/** 工具目录:null = 还没取到(本文件里的对拍都按这份喂). */
const TOOLS: readonly ToolInfo[] | null = null;

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
});

describe("rewriteOutgoingBody", () => {
  it("把协议说明拼在 prompt 开头,原文一个字不丢", () => {
    const prompt = "帮我看看这个报错";
    const rewritten = rewriteOutgoingBody(JSON.stringify({ prompt, chat_session_id: "s1" }), TOOLS);

    expect(rewritten).not.toBeNull();
    const payload = JSON.parse(rewritten ?? "") as Record<string, unknown>;
    expect(payload.prompt).toBe(prependInstructions(prompt, TOOLS));
    expect(payload.chat_session_id).toBe("s1");
    expect(String(payload.prompt).startsWith(`${protocolInstructions(TOOLS)}\n\n`)).toBe(true);
  });

  it("多行消息整段原样跟在协议说明后面", () => {
    const prompt = "第一行\n第二行\n\n第四行(空行后面)";
    const rewritten = rewriteOutgoingBody(JSON.stringify({ prompt }), TOOLS);
    const payload = JSON.parse(rewritten ?? "") as Record<string, unknown>;

    expect(payload.prompt).toBe(`${protocolInstructions(TOOLS)}\n\n${prompt}`);
    expect(String(payload.prompt).endsWith(prompt)).toBe(true);
  });

  it("空消息没东西可发,原样放行", () => {
    expect(rewriteOutgoingBody(JSON.stringify({ prompt: "" }), TOOLS)).toBeNull();
    expect(rewriteOutgoingBody(JSON.stringify({ prompt: "   \n  " }), TOOLS)).toBeNull();
    expect(rewriteOutgoingBody("", TOOLS)).toBeNull();
  });

  it("拼过一遍的不再拼第二遍", () => {
    const once = rewriteOutgoingBody(JSON.stringify({ prompt: "原文" }), TOOLS);

    expect(once).not.toBeNull();
    expect(rewriteOutgoingBody(once ?? "", TOOLS)).toBeNull();
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

    const rewritten = rewriteOutgoingBody(body, TOOLS);
    expect(rewritten).not.toBeNull();

    const payload = JSON.parse(rewritten ?? "") as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[0]?.content).toBe("你是个助手");
    expect(payload.messages[1]?.content).toBe(prependInstructions("上一轮", TOOLS));
    expect(payload.messages[2]?.content).toBe("上一轮答复");
    expect(payload.messages[3]?.content).toBe(prependInstructions("这一轮", TOOLS));
  });

  it("整段历史再发一遍时,拼过的用户消息不会被拼第二次", () => {
    const first = rewriteOutgoingBody(
      JSON.stringify({ messages: [{ role: "user", content: "原文" }] }),
      TOOLS,
    );
    const second = rewriteOutgoingBody(first ?? "", TOOLS);

    expect(second).toBeNull();
  });

  it("认不出的载荷原样放行", () => {
    expect(rewriteOutgoingBody("不是 JSON", TOOLS)).toBeNull();
    expect(rewriteOutgoingBody("[1,2,3]", TOOLS)).toBeNull();
    expect(rewriteOutgoingBody('"prompt"', TOOLS)).toBeNull();
    expect(rewriteOutgoingBody(JSON.stringify({ messages: "不是数组" }), TOOLS)).toBeNull();
    expect(rewriteOutgoingBody(JSON.stringify({ text: "别的字段" }), TOOLS)).toBeNull();
    expect(
      rewriteOutgoingBody(JSON.stringify({ messages: [{ role: "tool", content: "回执" }] }), TOOLS),
    ).toBeNull();
    expect(
      rewriteOutgoingBody(JSON.stringify({ messages: [{ role: "user", content: 42 }] }), TOOLS),
    ).toBeNull();
  });

  it("回灌消息(首行锚 agent:)不拼协议说明,首行锚留在第一行", () => {
    const reply = buildReply(okPayload("答复正文"));

    expect(reply.split("\n")[0]).toBe(REPLY_ANCHOR);
    expect(rewriteOutgoingBody(JSON.stringify({ prompt: reply }), TOOLS)).toBeNull();
    expect(
      rewriteOutgoingBody(JSON.stringify({ messages: [{ role: "user", content: reply }] }), TOOLS),
    ).toBeNull();
  });

  it("只是以 agent 开头的普通消息照样拼说明", () => {
    const rewritten = rewriteOutgoingBody(JSON.stringify({ prompt: "agent 你好,帮我看看" }), TOOLS);
    expect(rewritten).not.toBeNull();
    expect(JSON.parse(rewritten ?? "")["prompt"]).toBe(
      prependInstructions("agent 你好,帮我看看", TOOLS),
    );
  });

  it("工具目录跟着说明一起拼进去(隔离世界广播下来那份)", () => {
    const catalog: readonly ToolInfo[] = [
      { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
    ];
    const rewritten = rewriteOutgoingBody(JSON.stringify({ prompt: "原文" }), catalog);
    const prompt = String(JSON.parse(rewritten ?? "")["prompt"]);
    expect(prompt).toContain("- fs_read_file(path, encoding?) -- [fs] 读文件内容");
    expect(prompt.endsWith("\n\n原文")).toBe(true);
  });

  it('目录还没取到时,说明里写"先别排围栏"', () => {
    const rewritten = rewriteOutgoingBody(JSON.stringify({ prompt: "原文" }), null);
    expect(String(JSON.parse(rewritten ?? "")["prompt"])).toContain("工具表暂未取到");
  });
});

describe("rewriteContinuationBody / 续聊把正文换成工具结果", () => {
  const CONTINUATION = "agent:\nstatus: ok\nanswer[1]{text}:\n  入口在 dsb/server.py.";
  /** 短标记:钥匙只认它(#49). */
  const MARKER = CONTINUATION_MARKER;

  it("prompt 形状:正文整条换掉,其余字段一个不动", () => {
    const body = JSON.stringify({ prompt: "agent:\n继续", session_id: "s-1", stream: true });
    const rewritten = rewriteContinuationBody(body, CONTINUATION);
    expect(rewritten).not.toBeNull();
    const payload = JSON.parse(rewritten ?? "");
    expect(payload["prompt"]).toBe(CONTINUATION);
    expect(payload["session_id"]).toBe("s-1");
    expect(payload["stream"]).toBe(true);
  });

  it("messages 形状:换最后一条 user,别的原样", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "agent:\n继续" },
      ],
    });
    const payload = JSON.parse(rewriteContinuationBody(body, CONTINUATION) ?? "");
    expect(payload.messages[0].content).toBe("第一问");
    expect(payload.messages[1].content).toBe("第一答");
    expect(payload.messages[2].content).toBe(CONTINUATION);
  });

  it("认不出形状一律 null:宁可少一轮,也别把用户下一条消息吃了", () => {
    expect(rewriteContinuationBody("不是 JSON", CONTINUATION)).toBeNull();
    expect(rewriteContinuationBody(JSON.stringify({}), CONTINUATION)).toBeNull();
    expect(rewriteContinuationBody(JSON.stringify({ prompt: "   " }), CONTINUATION)).toBeNull();
    expect(rewriteContinuationBody(JSON.stringify({ prompt: 42 }), CONTINUATION)).toBeNull();
    expect(
      rewriteContinuationBody(
        JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }),
        CONTINUATION,
      ),
    ).toBeNull();
  });

  it("解码后的正文是物理换行,不是字面反斜杠 n(解码方是模型,不是解析器)", () => {
    const rewritten = rewriteContinuationBody(JSON.stringify({ prompt: MARKER }), CONTINUATION);
    const decoded = String(JSON.parse(rewritten ?? "")["prompt"]);
    expect(decoded).toContain("\n");
    expect(decoded).not.toContain("\\n");
  });

  // #49 的钥匙:只有正文逐字等于短标记才替换.
  it("正文不是短标记(用户手打的话):原样放行,null(不吃人说的话)", () => {
    expect(
      rewriteContinuationBody(JSON.stringify({ prompt: "帮我看看 README" }), CONTINUATION),
    ).toBeNull();
    expect(rewriteContinuationBody(JSON.stringify({ prompt: "继续" }), CONTINUATION)).toBeNull();
    expect(
      rewriteContinuationBody(JSON.stringify({ prompt: "agent: 继续" }), CONTINUATION),
    ).toBeNull();
    expect(
      rewriteContinuationBody(
        JSON.stringify({ messages: [{ role: "user", content: "我手打的" }] }),
        CONTINUATION,
      ),
    ).toBeNull();
  });

  it("消息形状里最后一条 user 不是标记:原样放行(哪怕历史里有一条恰好是标记)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "agent:\n继续" }, // 历史里恰好是标记,不算数
        { role: "assistant", content: "第一答" },
        { role: "user", content: "我改主意了,问别的" },
      ],
    });
    expect(rewriteContinuationBody(body, CONTINUATION)).toBeNull();
  });

  it("首尾空白与 CRLF 不影响钥匙(站点与受控输入框的换行写法差异)", () => {
    expect(
      rewriteContinuationBody(JSON.stringify({ prompt: `  ${MARKER}\n` }), CONTINUATION),
    ).not.toBeNull();
    expect(
      rewriteContinuationBody(
        JSON.stringify({ prompt: MARKER.replace(/\n/g, "\r\n") }),
        CONTINUATION,
      ),
    ).not.toBeNull();
  });
});

describe("outgoingUserTextOf / 钥匙比对取的那段正文(#49)", () => {
  it("prompt 形状取 prompt", () => {
    expect(outgoingUserTextOf(JSON.stringify({ prompt: CONTINUATION_MARKER }))).toBe(
      CONTINUATION_MARKER,
    );
  });

  it("messages 形状取最后一条 user(只取待发那条)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "待发的" },
      ],
    });
    expect(outgoingUserTextOf(body)).toBe("待发的");
  });

  it("取不出(不是 JSON / 形状认不出 / 没有 user)一律 null", () => {
    expect(outgoingUserTextOf("不是 JSON")).toBeNull();
    expect(outgoingUserTextOf(JSON.stringify({}))).toBeNull();
    expect(outgoingUserTextOf(JSON.stringify({ prompt: "   " }))).toBeNull();
    expect(outgoingUserTextOf(JSON.stringify({ prompt: 42 }))).toBeNull();
    expect(
      outgoingUserTextOf(JSON.stringify({ messages: [{ role: "assistant", content: "x" }] })),
    ).toBeNull();
  });
});
