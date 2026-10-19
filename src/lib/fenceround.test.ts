import { describe, expect, it } from "vitest";

import { ACTION_ERROR_TAB_GONE } from "./action";
import { MAX_RESULT_CHARS } from "./continuation";
import { createFenceRound, type FenceRoundDeps, type FenceRoundEffect } from "./fenceround";
import { MALFORMED_CALL_HINT } from "./fence";
import { FAILURE_RELAY_UNREACHABLE } from "./relay";
import { errorPayload, okPayload, type ReplyPayload } from "./reply";

function callJson(tool: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool, arguments: args });
}

type RelayAnswer = { readonly payload: ReplyPayload; readonly cause: string | null };

type Harness = {
  readonly deps: FenceRoundDeps;
  readonly effects: FenceRoundEffect[];
  readonly relayCalls: readonly string[];
  readonly localRuns: readonly {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly tabId: number | undefined;
  }[];
  relayAnswer: () => Promise<RelayAnswer>;
  localAnswer: (tabId: number | undefined) => Promise<ReplyPayload>;
};

function harness(): Harness {
  const effects: FenceRoundEffect[] = [];
  const relayCalls: string[] = [];
  const localRuns: { tool: string; args: Record<string, unknown>; tabId: number | undefined }[] =
    [];
  const h: Harness = {
    effects,
    relayCalls,
    localRuns,
    relayAnswer: async () => ({ payload: okPayload("查到了"), cause: null }),
    localAnswer: async () => okPayload(""),
    deps: {
      callRelay: async (toolCall) => {
        relayCalls.push(toolCall.tool);
        return h.relayAnswer();
      },
      runLocal: async (tool, args, tabId) => {
        localRuns.push({ tool: tool.name, args, tabId });
        return h.localAnswer(tabId);
      },
      now: () => 1_000,
      apply: (effect) => {
        effects.push(effect);
      },
    },
  };
  return h;
}

describe("在途角标与保活配对成效果", () => {
  it("一块普通围栏:保活按住在前,角标亮,图标结论带载荷,收摊先灭角标再松保活;动静一头一尾各记一条", async () => {
    const h = harness();

    await createFenceRound(h.deps).handle([callJson("read", { page: "x" })], 5);

    expect(h.effects).toEqual([
      { kind: "watchdog", tabId: 5, now: 1_000, phase: "out" },
      { kind: "keep-alive", on: true },
      { kind: "in-flight", on: true },
      { kind: "icon", payload: okPayload("查到了"), cause: null },
      { kind: "in-flight", on: false },
      { kind: "keep-alive", on: false },
      { kind: "watchdog", tabId: 5, now: 1_000, phase: "land" },
    ]);
  });

  it("中继回失败载荷:图标结论带着原因,整轮作废时动静照样收尾", async () => {
    const h = harness();
    h.relayAnswer = async () => ({
      payload: errorPayload(FAILURE_RELAY_UNREACHABLE),
      cause: "连接失败",
    });

    const { effects } = await createFenceRound(h.deps).handle([callJson("read", {})], 5);

    expect(effects).toContainEqual({
      kind: "icon",
      payload: errorPayload(FAILURE_RELAY_UNREACHABLE),
      cause: "连接失败",
    });
    expect(effects.at(-1)).toEqual({ kind: "watchdog", tabId: 5, now: 1_000, phase: "void" });
  });

  it("本地工具失败只吭一声:在途角标照样配对,图标结论一条不发", async () => {
    const h = harness();
    h.localAnswer = async () => errorPayload("disabled");

    const { effects } = await createFenceRound(h.deps).handle(
      [callJson("send.page", { question: "在吗?" })],
      2,
    );

    expect(effects.filter((effect) => effect.kind === "icon")).toEqual([]);
    expect(effects).toContainEqual({ kind: "log", note: "本地工具 send.page 回 disabled" });
    expect(effects.filter((effect) => effect.kind === "in-flight")).toEqual([
      { kind: "in-flight", on: true },
      { kind: "in-flight", on: false },
    ]);
    expect(effects.filter((effect) => effect.kind === "keep-alive")).toEqual([
      { kind: "keep-alive", on: true },
      { kind: "keep-alive", on: false },
    ]);
  });
});

describe("同标签页重入护栏", () => {
  it("同一标签页已有本地工具在跑:第二个 round 回提示,不再跑一次", async () => {
    const h = harness();
    let finishFirst: ((payload: ReplyPayload) => void) | undefined;
    h.localAnswer = () =>
      new Promise<ReplyPayload>((resolve) => {
        finishFirst = resolve;
      });
    const round = createFenceRound(h.deps);

    const first = round.handle([callJson("send.page", { question: "在吗?" })], 3);
    const second = await round.handle([callJson("send.page", { question: "又问?" })], 3);

    expect(h.localRuns).toHaveLength(1);
    expect(second.payload).toEqual(
      okPayload("本地工具 send.page 正在跑(同一标签页一次只跑一个),这条没有执行."),
    );

    finishFirst?.(okPayload("问题已发到页面."));
    const firstResult = await first;
    expect(firstResult.payload).toEqual(okPayload("问题已发到页面."));

    // 护栏松开后,同一标签页的下一轮照常跑;别的标签页从头就不受它拦.
    h.localAnswer = async () => okPayload("问题已发到页面.");
    await round.handle([callJson("send.page", { question: "再问?" })], 3);
    await round.handle([callJson("send.page", { question: "在吗?" })], 4);
    expect(h.localRuns).toHaveLength(3);
  });
});

describe("非 injectable 整轮作废", () => {
  it("中继回失败载荷:整轮作废,后面的块不再打,回灌的就是那条失败载荷", async () => {
    const h = harness();
    h.relayAnswer = async () => ({
      payload: errorPayload(FAILURE_RELAY_UNREACHABLE),
      cause: "连接失败",
    });

    const { payload } = await createFenceRound(h.deps).handle(
      [callJson("read", { page: "a" }), callJson("read", { page: "b" })],
      1,
    );

    expect(h.relayCalls).toEqual(["read"]);
    expect(payload).toEqual(errorPayload(FAILURE_RELAY_UNREACHABLE));
  });

  it("本地工具回失败载荷:同样整轮作废", async () => {
    const h = harness();
    h.localAnswer = async () => errorPayload("disabled");

    const { payload } = await createFenceRound(h.deps).handle(
      [callJson("send.page", { question: "在吗?" }), callJson("read", { page: "a" })],
      1,
    );

    expect(h.relayCalls).toEqual([]);
    expect(payload).toEqual(errorPayload("disabled"));
  });
});

describe("本地工具命中不翻中继图标", () => {
  it("命中名册就地跑:一次中继不打,结果照样进这一轮的正文", async () => {
    const h = harness();
    h.localAnswer = async () => okPayload("问题已发到页面.");

    const { payload, effects } = await createFenceRound(h.deps).handle(
      [callJson("send.page", { question: "在吗?" })],
      7,
    );

    expect(h.relayCalls).toEqual([]);
    expect(h.localRuns).toEqual([{ tool: "send.page", args: { question: "在吗?" }, tabId: 7 }]);
    expect(payload).toEqual(okPayload("问题已发到页面."));
    // 本地工具一次 fetch 都没打:它的成败证明不了中继健不健康,图标结论一条不发.
    expect(effects.filter((effect) => effect.kind === "icon")).toEqual([]);
  });

  it("消息不带标签页:本地工具回 tab-gone,整轮作废", async () => {
    const h = harness();

    const { payload } = await createFenceRound(h.deps).handle(
      [callJson("send.page", { question: "在吗?" })],
      undefined,
    );

    expect(h.localRuns).toEqual([]);
    expect(payload).toEqual(errorPayload(ACTION_ERROR_TAB_GONE));
  });
});

describe("坏围栏回提示", () => {
  it("排坏的那块回 MALFORMED_CALL_HINT,不打中继,别的块照常执行", async () => {
    const h = harness();
    const { payload } = await createFenceRound(h.deps).handle(
      ["这不是 JSON", callJson("read", { page: "x" })],
      1,
    );

    expect(h.relayCalls).toEqual(["read"]);
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    expect(payload.answer).toContain(MALFORMED_CALL_HINT);
    expect(payload.answer).toContain("工具 排坏的围栏:");
  });

  it("坏围栏照样占一块:9 块里 1 块排坏,只剩 7 块打得出去", async () => {
    const h = harness();
    const calls = [
      "坏的",
      ...Array.from({ length: 8 }, (_, index) => callJson("read", { page: index })),
    ];

    const { payload } = await createFenceRound(h.deps).handle(calls, 1);

    expect(h.relayCalls).toHaveLength(7);
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    expect(payload.answer).toContain("还有 1 块没执行");
  });
});

describe("多块都成时按围栏的次序攒", () => {
  it("两块各自带答案:先排的那块抬头在前(同一个工具排两次时,次序是唯一的区分)", async () => {
    const h = harness();
    h.relayAnswer = async () => ({
      payload: okPayload(h.relayCalls[h.relayCalls.length - 1] ?? ""),
      cause: null,
    });

    const { payload } = await createFenceRound(h.deps).handle(
      [callJson("read"), callJson("write")],
      1,
    );

    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    const first = payload.answer.indexOf("工具 read:");
    const second = payload.answer.indexOf("工具 write:");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });
});

describe("超 8 块截断附一句", () => {
  it("排 10 块:只打前 8 块网关,正文末尾说明还有 2 块没执行", async () => {
    const h = harness();
    const calls = Array.from({ length: 10 }, (_, index) => callJson("read", { page: index }));

    const { payload } = await createFenceRound(h.deps).handle(calls, 1);

    expect(h.relayCalls).toEqual(Array.from({ length: 8 }, () => "read"));
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    expect(payload.answer.endsWith("(这一轮最多执行 8 块围栏,还有 2 块没执行--下一轮再排.)")).toBe(
      true,
    );
  });

  it("恰好 8 块:不截断也不加那一句", async () => {
    const h = harness();
    const calls = Array.from({ length: 8 }, (_, index) => callJson("read", { page: index }));

    const { payload } = await createFenceRound(h.deps).handle(calls, 1);

    expect(h.relayCalls).toHaveLength(8);
    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    expect(payload.answer).not.toContain("没执行");
  });

  it("每块都顶格时末句照样在:总量不越过 MAX_RESULT_CHARS,那句'没执行'不会被扩展那道闸切掉", async () => {
    const h = harness();
    h.relayAnswer = async () => ({ payload: okPayload("字".repeat(4_000)), cause: null });
    const calls = Array.from({ length: 9 }, (_, index) => callJson("read", { page: index }));

    const { payload } = await createFenceRound(h.deps).handle(calls, 1);

    expect(payload.status).toBe("ok");
    if (payload.status !== "ok") return;
    expect(payload.answer.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(payload.answer.endsWith("(这一轮最多执行 8 块围栏,还有 1 块没执行--下一轮再排.)")).toBe(
      true,
    );
  });
});
