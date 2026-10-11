import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_REPORT_MESSAGE_TYPE,
  actionListener,
  actionRequestMessage,
  ACTION_MESSAGE_TYPE,
  askClearedMessage,
  askClearedReportMessage,
  ASK_CLEARED_MESSAGE_TYPE,
  askMessage,
  askReportMessage,
  ASK_MESSAGE_TYPE,
  accountReportMessage,
  parseAccountReport,
  parseAskClearedReport,
  parseAskReport,
  sendRequestMessage,
  sendResponseMessage,
  CHAIN_MESSAGE_SOURCE,
  isReplyPayload,
  parseActionRequest,
  parseSendRequest,
  parseSendResponse,
  parseChainMessage,
  parseSaidReport,
  parseStopReport,
  parseContinuationFailReport,
  CONTINUATION_FAIL_MESSAGE_TYPE,
  parseToolsRequest,
  parseToolsResponse,
  callMessage,
  resultMessage,
  saidMessage,
  saidReportMessage,
  SAID_MESSAGE_TYPE,
  stopMessage,
  continuationFailMessage,
  continuationFailReportMessage,
  parseSendNote,
  sendNoteMessage,
  SEND_NOTE_MESSAGE_SOURCE,
  stopReportMessage,
  STOP_MESSAGE_TYPE,
  TOOLS_REQUEST_MESSAGE_TYPE,
  toolsMessage,
  toolsRequestMessage,
  toolsResponseMessage,
  unreachableResult,
} from "./channel";
import type { ActionFrame } from "./action";
import { ACTION_ERROR_COMPOSER_ABSENT, PageError } from "./action";
import { actionErrorCodes } from "./fixtures";

/** 一个指向某动作的请求帧,`actionListener` 那层收的就是它. */
function requestFor(action: string): unknown {
  return { type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, action } };
}

describe('停手信封(页面世界报"续聊到顶")', () => {
  it("页面世界 → 隔离世界:kind/ id / cause 对得上就收", () => {
    const message = stopMessage("rounds-1", "continuation-limit");
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("cause 空的 / 缺的一律不收(停手不说原因等于没说)", () => {
    expect(parseChainMessage({ ...stopMessage("r", "x"), cause: "   " })).toBeNull();
    expect(parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "stop", id: "r" })).toBeNull();
  });

  it("隔离世界 → background:带上页面会话 id,缺省是 null", () => {
    expect(parseStopReport(stopReportMessage("rounds-1", "continuation-limit", "abc"))).toEqual(
      stopReportMessage("rounds-1", "continuation-limit", "abc"),
    );
    expect(parseStopReport(stopReportMessage("rounds-1", "continuation-limit"))?.page).toBeNull();
    expect(parseStopReport({ ...stopReportMessage("rounds-1", "x"), page: "" })).toBeNull();
  });

  it("别的 type 不抢这条消息", () => {
    expect(parseStopReport(saidReportMessage("说句话"))).toBeNull();
    expect(parseStopReport({ type: STOP_MESSAGE_TYPE, id: "", cause: "x" })).toBeNull();
  });
});

describe('续聊失败信封(页面世界报"这一跳断了",#51)', () => {
  it("页面世界 → 隔离世界:kind / id / cause 对得上就收", () => {
    const message = continuationFailMessage("cont-fail-1", "没找到输入框");
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("cause 空的 / 缺的一律不收(说不出断在哪一步等于没说)", () => {
    expect(parseChainMessage({ ...continuationFailMessage("r", "x"), cause: "   " })).toBeNull();
    expect(
      parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "continuation-fail", id: "r" }),
    ).toBeNull();
  });

  it("隔离世界 → background:带上页面会话 id,缺省是 null", () => {
    expect(
      parseContinuationFailReport(
        continuationFailReportMessage("cont-fail-1", "没找到输入框", "abc"),
      ),
    ).toEqual(continuationFailReportMessage("cont-fail-1", "没找到输入框", "abc"));
    expect(parseContinuationFailReport(continuationFailReportMessage("r", "x"))?.page).toBeNull();
    expect(
      parseContinuationFailReport({ ...continuationFailReportMessage("r", "x"), page: "" }),
    ).toBeNull();
  });

  it("别的 type 不抢这条消息", () => {
    expect(parseContinuationFailReport(saidReportMessage("说句话"))).toBeNull();
    expect(
      parseContinuationFailReport({ type: CONTINUATION_FAIL_MESSAGE_TYPE, id: "", cause: "x" }),
    ).toBeNull();
  });
});

describe("发送限速的跨世界通报(#61)", () => {
  it("构造与解析对上就收,带 world 与时刻", () => {
    const note = sendNoteMessage("isolated", 1234);
    expect(parseSendNote(note)).toEqual(note);
  });

  it("形状不对的一律不收(不猜,不补)", () => {
    expect(parseSendNote(null)).toBeNull();
    expect(parseSendNote({ source: "别人的", world: "isolated", at: 1 })).toBeNull();
    expect(parseSendNote({ source: SEND_NOTE_MESSAGE_SOURCE, world: "别处", at: 1 })).toBeNull();
    expect(parseSendNote({ source: SEND_NOTE_MESSAGE_SOURCE, world: "isolated" })).toBeNull();
    expect(
      parseSendNote({ source: SEND_NOTE_MESSAGE_SOURCE, world: "isolated", at: "刚才" }),
    ).toBeNull();
    expect(
      parseSendNote({ source: SEND_NOTE_MESSAGE_SOURCE, world: "isolated", at: Number.NaN }),
    ).toBeNull();
  });

  it("不抢 chain 那路的信封", () => {
    expect(parseSendNote(stopMessage("r", "continuation-limit"))).toBeNull();
    expect(parseSendNote(continuationFailMessage("r", "没找到输入框"))).toBeNull();
  });
});

describe("页面世界 ↔ 隔离世界的信封", () => {
  it("围栏正文信封原样过(一轮一块)", () => {
    const message = callMessage("send-1", ['{"tool":"fs_read_file","arguments":{}}']);
    expect(message).toEqual({
      source: CHAIN_MESSAGE_SOURCE,
      kind: "call",
      id: "send-1",
      calls: ['{"tool":"fs_read_file","arguments":{}}'],
    });
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("一轮多块也原样过(顺序不动)", () => {
    const message = callMessage("send-1", ['{"tool":"a","arguments":{}}', '{"tool":"b"}']);
    expect(parseChainMessage(message)?.kind).toBe("call");
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("各块必须是非空文本,空数组不算(一轮至少一块)", () => {
    const base = { source: CHAIN_MESSAGE_SOURCE, kind: "call", id: "send-1" };
    expect(parseChainMessage({ ...base, calls: [] })).toBeNull();
    expect(parseChainMessage({ ...base, calls: ["  "] })).toBeNull();
    expect(parseChainMessage({ ...base, calls: ["{}", ""] })).toBeNull();
    expect(parseChainMessage({ ...base, calls: "{}" })).toBeNull();
  });

  it("结果信封带同构载荷,原样过", () => {
    const message = resultMessage("send-1", { status: "ok", answer: "答复" });
    expect(parseChainMessage(message)).toEqual(message);

    const failed = resultMessage("send-1", { status: "error", error: "relay-unreachable" });
    expect(parseChainMessage(failed)).toEqual(failed);
  });

  it("不是我们的标记,形状不对的一律不收", () => {
    expect(parseChainMessage(undefined)).toBeNull();
    expect(parseChainMessage(null)).toBeNull();
    expect(parseChainMessage("ds-/chain")).toBeNull();
    expect(parseChainMessage({ source: "page", kind: "call", id: "1", calls: ["{}"] })).toBeNull();
    expect(parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "ping" })).toBeNull();
    expect(
      parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "call", id: "", calls: ["{}"] }),
    ).toBeNull();
    expect(
      parseChainMessage({
        source: CHAIN_MESSAGE_SOURCE,
        kind: "call",
        id: "send-1",
        calls: ["   "],
      }),
    ).toBeNull();
    expect(
      parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "call", id: "send-1" }),
    ).toBeNull();
  });

  it("结果信封里的载荷不合线协议就不收", () => {
    expect(
      parseChainMessage({
        source: CHAIN_MESSAGE_SOURCE,
        kind: "result",
        id: "send-1",
        payload: { status: "ok" },
      }),
    ).toBeNull();
    expect(
      parseChainMessage({
        source: CHAIN_MESSAGE_SOURCE,
        kind: "result",
        id: "send-1",
        payload: { status: "nope", error: "x" },
      }),
    ).toBeNull();
    expect(
      parseChainMessage({
        source: CHAIN_MESSAGE_SOURCE,
        kind: "result",
        id: "send-1",
        payload: "agent:\nstatus: ok",
      }),
    ).toBeNull();
  });
});

describe("隔离世界 ↔ background 的信封", () => {
  it("请求与响应原样过", () => {
    const request = sendRequestMessage("send-2", ['{"tool":"ping_now","arguments":{}}']);
    expect(parseSendRequest(request)).toEqual(request);

    const two = sendRequestMessage("send-3", ['{"tool":"a","arguments":{}}', '{"tool":"b"}']);
    expect(parseSendRequest(two)).toEqual(two);

    const response = sendResponseMessage("send-2", {
      status: "error",
      error: "relay-unreachable",
    });
    expect(parseSendResponse(response)).toEqual(response);
  });

  it("认不出的请求与响应不收", () => {
    expect(parseSendRequest({})).toBeNull();
    expect(parseSendRequest({ type: "ds-/other", id: "1", calls: ["{}"] })).toBeNull();
    expect(parseSendRequest({ type: "ds-/send", id: "1", calls: [] })).toBeNull();
    expect(parseSendRequest({ type: "ds-/send", id: "1", calls: [""] })).toBeNull();
    expect(parseSendRequest({ type: "ds-/send", id: "1" })).toBeNull();
    expect(parseSendResponse(undefined)).toBeNull();
    expect(parseSendResponse({ id: "1", payload: { status: "error" } })).toBeNull();
    expect(parseSendResponse({ payload: { status: "ok", answer: "a" } })).toBeNull();
  });

  it("background 没答上来时兜底成中继没响应的载荷", () => {
    const result = unreachableResult("send-2");
    expect(result.payload).toEqual({ status: "error", error: "relay-unreachable" });
    expect(parseChainMessage(result)).toEqual(result);
  });
});

describe("said 上报(围栏之外的话)", () => {
  it("链消息与 runtime 上报都原样过", () => {
    const chain = saidMessage("said-1", "先跟人说一句.");
    expect(chain).toEqual({
      source: CHAIN_MESSAGE_SOURCE,
      kind: "said",
      id: "said-1",
      text: "先跟人说一句.",
    });
    expect(parseChainMessage(chain)).toEqual(chain);

    const report = saidReportMessage("先跟人说一句.");
    expect(report).toEqual({ type: SAID_MESSAGE_TYPE, text: "先跟人说一句." });
    expect(parseSaidReport(report)).toEqual(report);
  });

  it("空文本 / 错 type 不收", () => {
    expect(
      parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "said", id: "1", text: "" }),
    ).toBeNull();
    expect(parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "said", id: "1" })).toBeNull();
    expect(parseSaidReport({ type: SAID_MESSAGE_TYPE, text: "   " })).toBeNull();
    expect(parseSaidReport({ type: "ds-/other", text: "x" })).toBeNull();
    expect(parseSaidReport(undefined)).toBeNull();
  });
});

describe("工具目录(协议说明照它拼)", () => {
  const TOOLS = [
    { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
    { name: "shell_run", description: "[sh] 跑命令", params: [] },
  ];

  it("广播消息原样过", () => {
    const message = toolsMessage("tools-1", TOOLS);
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("请求只认标记,回话带目录或 null(取不到沿用上一份)", () => {
    expect(parseToolsRequest(toolsRequestMessage())).toEqual(toolsRequestMessage());
    expect(parseToolsRequest({ type: TOOLS_REQUEST_MESSAGE_TYPE })).toEqual(toolsRequestMessage());
    expect(parseToolsRequest({ type: "ds-/other" })).toBeNull();

    expect(parseToolsResponse(toolsResponseMessage(TOOLS))).toEqual(toolsResponseMessage(TOOLS));
    expect(parseToolsResponse(toolsResponseMessage(null))).toEqual(toolsResponseMessage(null));
    expect(parseToolsResponse({})).toBeNull();
    expect(parseToolsResponse({ tools: [{ name: "" }] })).toBeNull();
  });

  it("目录条目缺一项就不收", () => {
    expect(parseChainMessage({ source: CHAIN_MESSAGE_SOURCE, kind: "tools", id: "1" })).toBeNull();
    expect(
      parseChainMessage({
        source: CHAIN_MESSAGE_SOURCE,
        kind: "tools",
        id: "1",
        tools: [{ name: "x", description: "y" }],
      }),
    ).toBeNull();
  });
});

describe("ask 信封(#26)", () => {
  it("ask 链消息原样过", () => {
    const message = askMessage("ask-1", "选 A 还是 B?");
    expect(message).toEqual({
      source: CHAIN_MESSAGE_SOURCE,
      kind: "ask",
      id: "ask-1",
      question: "选 A 还是 B?",
    });
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("ask-cleared 链消息原样过", () => {
    const message = askClearedMessage("ask-1");
    expect(message).toEqual({
      source: CHAIN_MESSAGE_SOURCE,
      kind: "ask-cleared",
      id: "ask-1",
    });
    expect(parseChainMessage(message)).toEqual(message);
  });

  it("ask 上报原样过,页面会话可带可不带", () => {
    const withPage = askReportMessage("ask-1", "问题", "sid-1");
    expect(parseAskReport(withPage)).toEqual(withPage);
    expect(parseAskReport(askReportMessage("ask-1", "问题"))).toEqual(
      askReportMessage("ask-1", "问题", null),
    );
  });

  it("ask 清除原样过,页面会话可带可不带", () => {
    const withPage = askClearedReportMessage("ask-1", "sid-1");
    expect(parseAskClearedReport(withPage)).toEqual(withPage);
    expect(parseAskClearedReport(askClearedReportMessage("ask-1"))).toEqual(
      askClearedReportMessage("ask-1", null),
    );
  });

  it("形状不对的 ask 信封不收", () => {
    expect(parseAskReport({})).toBeNull();
    expect(parseAskReport({ type: ASK_MESSAGE_TYPE, id: "1", question: "" })).toBeNull();
    expect(parseAskReport({ type: ASK_MESSAGE_TYPE, id: "", question: "q" })).toBeNull();
    expect(parseAskReport({ type: ASK_MESSAGE_TYPE, id: "1", question: "q", page: "" })).toBeNull();
    expect(parseAskClearedReport({ type: ASK_CLEARED_MESSAGE_TYPE, id: "" })).toBeNull();
    expect(parseAskClearedReport({ type: ASK_CLEARED_MESSAGE_TYPE, id: "1", page: 7 })).toBeNull();
    // 两条 ask 信封互不串:ask 上报的形状对 ask 清除不认.
    expect(parseAskClearedReport(askReportMessage("ask-1", "问题"))).toBeNull();
  });
});

describe("账号处境上报(#2)", () => {
  it("上报原样过", () => {
    const message = accountReportMessage({
      kind: "muted",
      until: "2026 年 10 月 10 日 20:21",
    });
    expect(message).toEqual({
      type: ACCOUNT_REPORT_MESSAGE_TYPE,
      account: { kind: "muted", until: "2026 年 10 月 10 日 20:21" },
    });
    expect(parseAccountReport(message)).toEqual(message);
  });

  it("四种处境都收", () => {
    const cases = [
      { kind: "ready" },
      { kind: "muted", until: null },
      { kind: "signed-out" },
      { kind: "unknown" },
    ] as const;
    for (const account of cases) {
      expect(parseAccountReport(accountReportMessage(account))).toEqual(
        accountReportMessage(account),
      );
    }
  });

  it("形状不对的不收", () => {
    expect(parseAccountReport({})).toBeNull();
    expect(parseAccountReport({ type: ASK_MESSAGE_TYPE, account: { kind: "ready" } })).toBeNull();
    expect(parseAccountReport({ type: ACCOUNT_REPORT_MESSAGE_TYPE })).toBeNull();
    expect(parseAccountReport({ type: ACCOUNT_REPORT_MESSAGE_TYPE, account: {} })).toBeNull();
    expect(
      parseAccountReport({ type: ACCOUNT_REPORT_MESSAGE_TYPE, account: { kind: "muted" } }),
    ).toBeNull(); // muted 缺 until
    expect(
      parseAccountReport({
        type: ACCOUNT_REPORT_MESSAGE_TYPE,
        account: { kind: "ready", until: "x" },
      }),
    ).toBeNull(); // ready 不带 until
  });
});

describe("isReplyPayload / 载荷同构", () => {
  it("ok 只认带 string answer 的", () => {
    expect(isReplyPayload({ status: "ok", answer: "" })).toBe(true);
    expect(isReplyPayload({ status: "ok" })).toBe(false);
    expect(isReplyPayload({ status: "ok", answer: 42 })).toBe(false);
  });

  it("error 只认带 string error 的", () => {
    expect(isReplyPayload({ status: "error", error: "unexpected-response" })).toBe(true);
    expect(isReplyPayload({ status: "error" })).toBe(false);
  });

  it("两条之外的形状都不认", () => {
    expect(isReplyPayload(null)).toBe(false);
    expect(isReplyPayload([])).toBe(false);
    expect(isReplyPayload({ status: "loading" })).toBe(false);
  });
});

/** 一件带 target 的动作帧:background 打包,内容脚本拆包都用它对拍. */
const ACTION_FRAME: ActionFrame = {
  type: "action",
  id: "7-x",
  action: "page.state",
  params: { x: 1 },
  target: "42",
};

describe("background ↔ 内容脚本的动作信封", () => {
  it("请求原样过,响应是同构载荷", () => {
    const request = actionRequestMessage(ACTION_FRAME);
    expect(request.type).toBe(ACTION_MESSAGE_TYPE);
    expect(parseActionRequest(request)?.frame).toEqual(ACTION_FRAME);
  });

  it("缺字段 / 错 type / 形状不对的一律 null", () => {
    expect(parseActionRequest(undefined)).toBeNull();
    expect(parseActionRequest({ type: "ds-/send", id: "1", question: "q" })).toBeNull();
    expect(parseActionRequest({ type: ACTION_MESSAGE_TYPE })).toBeNull();
    expect(
      parseActionRequest({ type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, id: "" } }),
    ).toBeNull();
    expect(
      parseActionRequest({ type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, action: "" } }),
    ).toBeNull();
    expect(
      parseActionRequest({ type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, target: 42 } }),
    ).toBeNull();
    expect(
      parseActionRequest({ type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, params: [] } }),
    ).toBeNull();
    expect(
      parseActionRequest({ type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, type: "nope" } }),
    ).toBeNull();
  });
});

describe("内容脚本的动作收信(entrypoints/content.ts 接的那一层)", () => {
  /** listener 是同步返回,sendResponse 异步被调:等一轮微任务再断言. */
  async function respond(
    roster: Parameters<typeof actionListener>[0],
    message: unknown,
  ): Promise<ReturnType<typeof vi.fn>> {
    const sendResponse = vi.fn();
    const kept = actionListener(roster)(message, undefined, sendResponse);
    expect(kept).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    return sendResponse;
  }

  it("认得出的动作帧当场回一个 ActionOutcome(本轮名册空 → unknown-action)", async () => {
    const sendResponse = await respond({}, { type: ACTION_MESSAGE_TYPE, frame: ACTION_FRAME });

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "unknown-action" });
  });

  it("名册里有的动作走执行器,结果当 result 收下", async () => {
    const handler = vi.fn(() => ({ state: "idle" }));
    const sendResponse = await respond(
      { "page.state": handler },
      {
        type: ACTION_MESSAGE_TYPE,
        frame: ACTION_FRAME,
      },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, result: { state: "idle" } });
  });

  it("执行器抛 PageError → 回它自带的码,别一律 tab-gone", async () => {
    const handler = vi.fn(() => {
      throw new PageError(ACTION_ERROR_COMPOSER_ABSENT, "页面上没有写作框");
    });
    const sendResponse = await respond({ "composer.type": handler }, requestFor("composer.type"));

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "composer-absent" });
  });

  it("执行器抛别的错 → 折成 tab-gone(这一跳走不通,不该猜是哪一种)", async () => {
    const handler = vi.fn(() => {
      throw new Error("undefined is not a function");
    });
    const sendResponse = await respond({ "composer.type": handler }, requestFor("composer.type"));

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "tab-gone" });
  });

  it("PageError 的码必须在册--不在册的折成 tab-gone", async () => {
    const handler = vi.fn(() => {
      throw new PageError("随便编一个码", "x");
    });
    const sendResponse = await respond({ "composer.type": handler }, requestFor("composer.type"));

    expect(actionErrorCodes()).toContain("composer-absent"); // 册子里确实有这三个
    expect(actionErrorCodes()).toContain("backing-off"); // 退避闸的码也在册
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "tab-gone" });
  });

  it("认不出的消息不响应(不抢 send 的消息,不回 undefined 当结果)", async () => {
    const sendResponse = vi.fn();
    expect(
      actionListener({})(sendRequestMessage("send-1", ["问题"]), undefined, sendResponse),
    ).toBeUndefined();
    expect(actionListener({})({ hello: "world" }, undefined, sendResponse)).toBeUndefined();
    expect(actionListener({})(undefined, undefined, sendResponse)).toBeUndefined();
    expect(
      actionListener({})(
        { type: ACTION_MESSAGE_TYPE, frame: { ...ACTION_FRAME, id: "" } },
        undefined,
        sendResponse,
      ),
    ).toBeUndefined();

    await Promise.resolve();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
