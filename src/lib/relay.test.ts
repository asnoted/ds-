import { describe, expect, it } from "vitest";

import {
  FAILURE_RELAY_UNREACHABLE,
  FAILURE_UNEXPECTED_RESPONSE,
  MALFORMED_CALL_HINT,
  MAX_CALLS_PER_ROUND,
  joinCallAnswers,
  MCP_CALL_TIMEOUT_MS,
  MCP_LIST_TIMEOUT_MS,
  MCP_PING_TIMEOUT_MS,
  callToolBody,
  describeBadResponse,
  describeFetchFailure,
  isToolInfo,
  listToolsBody,
  mcpBody,
  parseMcpPing,
  parseMcpResponse,
  parseToolCall,
  parseToolsList,
  pingBody,
  relayMcpUrl,
} from "./relay";

describe("端点与请求体", () => {
  it("打的是本机中继的唯一端点 /mcp", () => {
    expect(relayMcpUrl()).toBe("http://127.0.0.1:8787/mcp");
  });

  it("请求体是标准 JSON-RPC 2.0(jsonrpc + id + method)", () => {
    expect(JSON.parse(mcpBody("1-ping", "ping"))).toEqual({
      jsonrpc: "2.0",
      id: "1-ping",
      method: "ping",
    });
    expect(JSON.parse(pingBody("1-ping")).method).toBe("ping");
    expect(JSON.parse(listToolsBody("2-list")).method).toBe("tools/list");
    expect(JSON.parse(callToolBody("3-call", "fs_read_file", { path: "a.ts" }))).toEqual({
      jsonrpc: "2.0",
      id: "3-call",
      method: "tools/call",
      params: { name: "fs_read_file", arguments: { path: "a.ts" } },
    });
  });

  it("超时三档:调用宽,list 居中,探活最急(先到的必须是中继)", () => {
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThan(MCP_LIST_TIMEOUT_MS);
    expect(MCP_LIST_TIMEOUT_MS).toBeGreaterThan(MCP_PING_TIMEOUT_MS);
  });
});

describe("parseToolCall / 围栏正文 → 工具调用", () => {
  it("只有 tool + arguments 两个键的形状收下", () => {
    expect(parseToolCall('{"tool":"fs_read_file","arguments":{"path":"a.ts"}}')).toEqual({
      tool: "fs_read_file",
      arguments: { path: "a.ts" },
    });
  });

  it("arguments 缺着当空对象(没有参数的工具就该这么排)", () => {
    expect(parseToolCall('{"tool":"ping_now"}')).toEqual({ tool: "ping_now", arguments: {} });
  });

  it("排得不成形一律 null,不猜", () => {
    expect(parseToolCall("不是 JSON")).toBeNull();
    expect(parseToolCall('["fs_read_file"]')).toBeNull();
    expect(parseToolCall('{"tool":""}')).toBeNull();
    expect(parseToolCall('{"tool": 42}')).toBeNull();
    expect(parseToolCall('{"tool":"x","arguments":"没参数"}')).toBeNull();
    expect(parseToolCall("{}")).toBeNull();
  });

  it("围栏排坏时的回灌正文自带正确形状(status: ok 的一条)", () => {
    expect(MALFORMED_CALL_HINT).toContain('{"tool":"工具名","arguments":{...');
    expect(MALFORMED_CALL_HINT).toContain("{}");
  });
});

describe("parseMcpResponse / 响应 → 载荷", () => {
  const id = "9-call";
  const reply = (body: unknown) => JSON.stringify(body);

  it("2xx + 对得上号的 result → ok,文本块依次拼上", () => {
    const payload = parseMcpResponse(
      200,
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "第一块" },
            { type: "text", text: "第二块" },
            { type: "image", data: "..." },
          ],
        },
      }),
      id,
    );
    expect(payload).toEqual({ status: "ok", answer: "第一块\n\n第二块" });
  });

  it("JSON-RPC 的 error 也是有回话 → ok,正文是 `code: message`", () => {
    const payload = parseMcpResponse(
      200,
      reply({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool: x" } }),
      id,
    );
    expect(payload).toEqual({ status: "ok", answer: "-32601: Unknown tool: x" });
  });

  it("`isError` 的结果照旧是正文(模型看得到才接得着往下答)", () => {
    const payload = parseMcpResponse(
      200,
      reply({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: "tool-not-running" }] },
      }),
      id,
    );
    expect(payload).toEqual({ status: "ok", answer: "tool-not-running" });
  });

  it("一个文本块都没有就把整个结果交成 JSON(不猜,不丢)", () => {
    const payload = parseMcpResponse(
      200,
      reply({ jsonrpc: "2.0", id, result: { content: [], tools: [] } }),
      id,
    );
    expect(payload.status).toBe("ok");
    expect(payload.status === "ok" && payload.answer).toBe('{"content":[],"tools":[]}');
  });

  it("非 2xx / 认不出的响应体 → 意外响应(不进对话流)", () => {
    const unexpected = { status: "error" as const, error: FAILURE_UNEXPECTED_RESPONSE };
    expect(parseMcpResponse(500, reply({ jsonrpc: "2.0", id, result: {} }), id)).toEqual(
      unexpected,
    );
    expect(parseMcpResponse(404, "找不到", id)).toEqual(unexpected);
    expect(parseMcpResponse(200, "不是 JSON", id)).toEqual(unexpected);
    expect(parseMcpResponse(200, '"ok"', id)).toEqual(unexpected);
    expect(parseMcpResponse(200, reply({ jsonrpc: "2.0", id }), id)).toEqual(unexpected);
    expect(parseMcpResponse(200, reply({ jsonrpc: "1.0", id, result: {} }), id)).toEqual(
      unexpected,
    );
  });

  it("回话对不上号一律不认(多条请求各排各的号,防领错回话)", () => {
    const body = reply({ jsonrpc: "2.0", id: "别人家的", result: {} });
    expect(parseMcpResponse(200, body, id).status).toBe("error");
  });

  it("error 载荷只有两个在册码", () => {
    expect(FAILURE_RELAY_UNREACHABLE).toBe("relay-unreachable");
    expect(FAILURE_UNEXPECTED_RESPONSE).toBe("unexpected-response");
  });
});

describe("parseMcpPing / 探活", () => {
  const id = "1-ping";

  it("2xx + 对得上号的 result → 可达", () => {
    expect(parseMcpPing(200, JSON.stringify({ jsonrpc: "2.0", id, result: {} }), id)).toBe(true);
  });

  it("答不上来就不可达,不猜", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    expect(parseMcpPing(200, body, "别的号")).toBe(false);
    expect(parseMcpPing(500, body, id)).toBe(false);
    expect(parseMcpPing(200, "不是 JSON", id)).toBe(false);
    expect(
      parseMcpPing(
        200,
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: 1, message: "x" } }),
        id,
      ),
    ).toBe(false);
  });
});

describe("parseToolsList / 工具表", () => {
  const id = "2-list";
  const body = (tools: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: { tools } });

  it("按 schema 压成一行:必带原名,可选加 ?", () => {
    const tools = parseToolsList(
      200,
      body([
        {
          name: "fs_read_file",
          description: "[fs] 读文件内容",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, encoding: { type: "string" } },
            required: ["path"],
          },
        },
        { name: "ping_now", description: "", inputSchema: {} },
      ]),
      id,
    );
    expect(tools).toEqual([
      { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
      { name: "ping_now", description: "", params: [] },
    ]);
  });

  it("认不出返回 null(调用方沿用上一份,不拿坏数据换)", () => {
    expect(parseToolsList(200, JSON.stringify({ jsonrpc: "2.0", id, result: {} }), id)).toBeNull();
    expect(parseToolsList(200, body([{ description: "没有名字" }]), id)).toBeNull();
    expect(parseToolsList(500, body([]), id)).toBeNull();
    expect(parseToolsList(200, "不是 JSON", id)).toBeNull();
    expect(parseToolsList(200, body([]), "别的号")).toBeNull();
  });

  it("isToolInfo 是信封那边的判据:缺一项就不收", () => {
    expect(isToolInfo({ name: "x", description: "y", params: [] })).toBe(true);
    expect(isToolInfo({ name: "", description: "y", params: [] })).toBe(false);
    expect(isToolInfo({ name: "x", description: "y", params: [1] })).toBe(false);
    expect(isToolInfo(null)).toBe(false);
  });
});

describe("失败的措辞", () => {
  it("超时与连不上分开说(排查方向相反)", () => {
    expect(describeFetchFailure(new DOMException("aborted", "AbortError"), 5_000)).toBe(
      "超时(5000ms 没回)",
    );
    expect(describeFetchFailure(new TypeError("Failed to fetch"), 5_000)).toBe("连接失败");
    expect(describeFetchFailure("别的", 5_000)).toBe("连接失败");
  });

  it("响应认不出时报状态码,2xx 报正文规模(不记正文本身)", () => {
    expect(describeBadResponse(502, "Bad Gateway")).toBe("HTTP 502");
    expect(describeBadResponse(200, "五个字的乱码")).toBe("响应读不出来(6 字)");
  });
});

describe("joinCallAnswers / 一轮多块的结果拼装", () => {
  it("一块:工具正文原样交,不加我们自己写的头", () => {
    expect(joinCallAnswers([{ tool: "fs_read_file", text: "第一行\n第二行" }])).toBe(
      "第一行\n第二行",
    );
  });

  it("多块:每块前面写上是哪件工具,块之间空一行", () => {
    expect(
      joinCallAnswers([
        { tool: "fs_read_file", text: "第一段" },
        { tool: "shell_run", text: "第二段" },
      ]),
    ).toBe("工具 fs_read_file:\n第一段\n\n工具 shell_run:\n第二段");
  });

  it("排坏的围栏也占一块,模型才知道是哪一块没成", () => {
    expect(
      joinCallAnswers([
        { tool: "fs_read_file", text: "第一段" },
        { tool: "排坏的围栏", text: MALFORMED_CALL_HINT },
      ]),
    ).toContain("工具 排坏的围栏:");
  });

  it("空数组回空串--不该发生,但别无中生有", () => {
    expect(joinCallAnswers([])).toBe("");
  });

  it("一轮的上限是个正数(排再多也只是分几轮)", () => {
    expect(MAX_CALLS_PER_ROUND).toBeGreaterThan(0);
  });
});
