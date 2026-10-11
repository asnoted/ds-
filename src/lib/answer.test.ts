import { describe, expect, it } from "vitest";

import { detectAskQuestion, detectToolCalls, extractAssistantAnswer } from "./answer";
import { outsideFences } from "./said";

/** 拼一个流式响应:每块一行 `data:` 载荷,形状对齐站点的发消息接口. */
function sse(chunks: string[]): string {
  const lines = chunks.map(
    (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
  );
  return `${lines.join("\n")}\n\ndata: [DONE]\n`;
}

describe("extractAssistantAnswer", () => {
  it("流式响应按块还原成一段正文", () => {
    const raw = sse(["你好,", "这是回答."]);
    expect(extractAssistantAnswer(raw)).toBe("你好,这是回答.");
  });

  it("整块 JSON 响应取 message.content", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: "整段回答" } }] });
    expect(extractAssistantAnswer(raw)).toBe("整段回答");
  });

  it("reasoning 之类的过程文本不当成回答", () => {
    const raw = JSON.stringify({
      choices: [{ message: { reasoning_content: "先想一想", content: "正文" } }],
    });
    expect(extractAssistantAnswer(raw)).toBe("正文");
  });

  it("认不出的响应返回空串", () => {
    expect(extractAssistantAnswer("")).toBe("");
    expect(extractAssistantAnswer("not json at all")).toBe("");
    expect(extractAssistantAnswer(JSON.stringify({ hello: "world" }))).toBe("");
  });
});

describe("detectToolCalls / 检测点", () => {
  it("流式回答里排了围栏就认出问题(多行问题也认)", () => {
    const raw = sse(["先说结论.\n```send ", "仓库里 dsb 的入口在哪?\n第二行补充\n```"]);
    expect(detectToolCalls(raw)).toEqual(["仓库里 dsb 的入口在哪?\n第二行补充"]);
  });

  it("整块 JSON 回答里的围栏同样认得", () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: "```send\n问题正文\n```" } }],
    });
    expect(detectToolCalls(raw)).toEqual(["问题正文"]);
  });

  it("普通代码块不触发", () => {
    const raw = sse(["```ts\nconst a = 1;\n```"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("非 say 围栏不触发", () => {
    const raw = sse(["```bash\nls -la\n```"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("`​```sendfoo` 不是围栏起始行", () => {
    const raw = sse(["```sendfoo\n问题\n```"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("一次排多块:全都要,按顺序", () => {
    const raw = sse(["```send\n第一块\n```\n中间\n```send\n第二块\n```"]);
    expect(detectToolCalls(raw)).toEqual(["第一块", "第二块"]);
  });

  it("送出去的那份压成紧凑 JSON(#93):带空格的,多行的都压掉", () => {
    const spaced = sse(['```send\n{"tool": "read", "arguments": {"path": "a.md"}}\n```']);
    expect(detectToolCalls(spaced)).toEqual(['{"tool":"read","arguments":{"path":"a.md"}}']);
    const pretty = sse([
      '```send\n{\n  "tool": "read",\n  "arguments": {\n    "path": "a.md"\n  }\n}\n```',
    ]);
    expect(detectToolCalls(pretty)).toEqual(['{"tool":"read","arguments":{"path":"a.md"}}']);
  });

  it("认不出的形状照原样送(压紧不越权改模型写的东西)", () => {
    expect(detectToolCalls(sse(["```send\n不是 JSON\n```"]))).toEqual(["不是 JSON"]);
    expect(detectToolCalls(sse(["```send\n[1, 2]\n```"]))).toEqual(["[1, 2]"]);
  });

  it("围栏没闭合按无效输入处理", () => {
    const raw = sse(["```send\n问题还没有收尾"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("围栏里问空了不触发", () => {
    const raw = sse(["```send\n```"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("没排围栏的正常回答不触发", () => {
    const raw = sse(["这是不带围栏的回答."]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("正文形状认不出时,兜底路径仍从转义原文里认出围栏", () => {
    const raw = `data: ${JSON.stringify({ unknown_shape: "看这里\n```send\n兜底问题\n```" })}\n`;
    expect(extractAssistantAnswer(raw)).toBe("");
    expect(detectToolCalls(raw)).toEqual(["兜底问题"]);
  });

  it("认不出的响应整段返回 null,不猜", () => {
    expect(detectToolCalls("")).toEqual([]);
    expect(detectToolCalls("<html>502</html>")).toEqual([]);
  });

  it("兜底路径也认没闭合的围栏不算数", () => {
    const raw = `data: ${JSON.stringify({
      unknown_shape: "看这里\n```send\n问题没收尾\n```js\nconst a = 1;",
    })}\n`;
    expect(detectToolCalls(raw)).toEqual([]);
  });
});

describe("出完才判(#29)", () => {
  /**
   * "边收边判"漏检的缩形:正文在前,围栏靠后.前半截(围栏
   * 还没跟到)判不出围栏--检测点只拿"出完的整条"(响应体
   * 读到底)来判,半截不判正是这层契约.
   */
  it("流式半截不判,整条出完才判出靠后的围栏", () => {
    const head = sse(["长回答的正文第一段.\n", "第二段.\n", "第三段.\n"]);
    const opening = sse(["\n```send\n靠后的围栏问题"]); // 围栏开了,还没闭
    const closing = sse(["\n```\n"]);
    expect(detectToolCalls(head)).toEqual([]);
    // 边收边判正是这里漏:围栏没闭合时整段看着像"无围栏的正文".
    expect(detectToolCalls(head + opening)).toEqual([]);
    expect(detectToolCalls(head + opening + closing)).toEqual(["靠后的围栏问题"]);
  });

  it("无围栏的长回答:整条出完也判不出(那条正文走 reportSaid 报协调者)", () => {
    const whole = sse(["长回答的正文第一段,", "第二段,", "第三段."]);
    expect(detectToolCalls(whole)).toEqual([]);
    expect(outsideFences(extractAssistantAnswer(whole))).toBe("长回答的正文第一段,第二段,第三段.");
  });
});

describe("detectToolCalls / 站点那条 OT 增量流", () => {
  /**
   * 真机抓的形状(2026-09-29,chat.deepseek.com/api/v0/chat/completion):
   * 正文不在 `content` 键里,而是散在追加操作中;围栏被切成两个载荷下发
   * (`{"v":"```"}` 紧跟 `{"v":"send"}`);思考片里还举了一个 ```send 的例子.
   */
  const REAL_OT_STREAM = [
    "event: ready",
    'data: {"request_message_id":9,"response_message_id":10,"model_type":"default"}',
    "",
    "event: update_session",
    'data: {"updated_at":1790663229.828996}',
    "",
    'data: {"v":{"response":{"message_id":10,"parent_id":9,"role":"ASSISTANT","thinking_enabled":true,"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"我们需要"}]}}}',
    "",
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"先想清楚.协议要排围栏,例子是:"}',
    'data: {"v":"\\n\\n```send\\n模型自己举的例子\\n```"}',
    'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.214978037}',
    "",
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"```","references":[],"stage_id":1}]}',
    'data: {"p":"response/fragments/-1/content","v":"send"}',
    'data: {"v":"\\n"}',
    'data: {"v":"CONTEXT.md 这个文件是干什么的?\\n"}',
    'data: {"v":"```"}',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":1075},{"p":"quasi_status","v":"FINISHED"}]}',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    "",
    "event: close",
    'data: {"click_behavior":"none","auto_resume":false}',
    "",
  ].join("\n");

  it("正文只在 RESPONSE 片段里,思考片不计入", () => {
    expect(extractAssistantAnswer(REAL_OT_STREAM)).toBe(
      "```send\nCONTEXT.md 这个文件是干什么的?\n```",
    );
  });

  it("围栏被切成两个载荷也认得出问题", () => {
    expect(detectToolCalls(REAL_OT_STREAM)).toEqual(["CONTEXT.md 这个文件是干什么的?"]);
  });

  it("思考片里举的围栏例子不算回答", () => {
    // 把正文片换成一句没有围栏的话:思考片里的 ```send 不能被捞出来当真.
    const noFence = REAL_OT_STREAM.replace(
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"```","references":[],"stage_id":1}]}',
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"好的.","references":[],"stage_id":1}]}',
    )
      .replace('data: {"p":"response/fragments/-1/content","v":"send"}\n', "")
      .replace('data: {"v":"\\n"}\n', "")
      .replace('data: {"v":"CONTEXT.md 这个文件是干什么的?\\n"}\n', "")
      .replace('data: {"v":"```"}\n', "");
    expect(extractAssistantAnswer(noFence)).toBe("好的.");
    expect(detectToolCalls(noFence)).toEqual([]);
  });

  it("状态,计时,token 这些非正文操作不产生正文", () => {
    const onlyOps = [
      'data: {"v":{"response":{"fragments":[]}}}',
      'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.2}',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":10}]}',
      "",
    ].join("\n");
    expect(extractAssistantAnswer(onlyOps)).toBe("");
    expect(detectToolCalls(onlyOps)).toEqual([]);
  });
});

describe("detectAskQuestion / 检测点(#26)", () => {
  it("流式回答里排了 ask 围栏就认出问题", () => {
    const raw = sse(["想一下.\n```ask ", "选 A 还是 B?\n```"]);
    expect(detectAskQuestion(raw)).toBe("选 A 还是 B?");
  });

  it("整块 JSON 回答里的 ask 围栏同样认得", () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: "```ask\n问题正文\n```" } }],
    });
    expect(detectAskQuestion(raw)).toBe("问题正文");
  });

  it("正文形状认不出时,兜底路径仍从转义原文里认出 ask 围栏", () => {
    const raw = `data: ${JSON.stringify({ unknown_shape: "看这里\n```ask\n兜底问题\n```" })}\n`;
    expect(extractAssistantAnswer(raw)).toBe("");
    expect(detectAskQuestion(raw)).toBe("兜底问题");
  });

  it("send 围栏不被 ask 检测器认(别误伤现有路径)", () => {
    const raw = sse(["```send\n仓库入口在哪?\n```"]);
    expect(detectAskQuestion(raw)).toBeNull();
    expect(detectToolCalls(raw)).toEqual(["仓库入口在哪?"]);
  });

  it("ask 围栏不被 send 检测器认", () => {
    const raw = sse(["```ask\n选哪个?\n```"]);
    expect(detectToolCalls(raw)).toEqual([]);
  });

  it("```askfoo 不是围栏起始行", () => {
    const raw = sse(["```askfoo\n问题\n```"]);
    expect(detectAskQuestion(raw)).toBeNull();
  });

  it("围栏没闭合按无效输入处理", () => {
    const raw = sse(["```ask\n问题还没有收尾"]);
    expect(detectAskQuestion(raw)).toBeNull();
  });

  it("没排 ask 围栏的正常回答不触发", () => {
    const raw = sse(["这是不带围栏的回答."]);
    expect(detectAskQuestion(raw)).toBeNull();
  });
});
