import { describe, expect, it } from "vitest";

import type { ActionOutcome } from "./action";
import { LOCAL_TOOLS, findLocalTool } from "./localtools";
import { okPayload } from "./reply";

const SEND_PAGE = findLocalTool("send.page");
if (SEND_PAGE === null) throw new Error("名册里应有 send.page");

type Call = { readonly action: string; readonly params: Record<string, unknown> };

/**
 * 记录调用的假 `run`:默认每步成功;`overrides` 按动作名替换某一步的结果
 * (模拟闸挡 / 超时).
 */
function recorder(overrides: Record<string, ActionOutcome> = {}) {
  const calls: Call[] = [];
  const run = async (action: string, params: Record<string, unknown>): Promise<ActionOutcome> => {
    calls.push({ action, params });
    const hit = overrides[action];
    return hit ?? { ok: true, result: {} };
  };
  return { calls, run };
}

describe("findLocalTool / 名册", () => {
  it("按名字找得到 send.page", () => {
    expect(findLocalTool("send.page")).toBe(SEND_PAGE);
  });

  it("不是本地的(网关工具)一律 null", () => {
    expect(findLocalTool("fs_read_file")).toBeNull();
    expect(findLocalTool("")).toBeNull();
  });

  it("名册 v1 只有 send.page", () => {
    expect(LOCAL_TOOLS.map((tool) => tool.name)).toEqual(["send.page"]);
  });
});

describe("send.page / 组合两步", () => {
  it("依次 composer.type → send.enter,发完回空确认(不取答复)", async () => {
    const { calls, run } = recorder();

    const payload = await SEND_PAGE.run({ question: "帮我看看" }, { tabId: 42, run });

    // 正文是空的:页面的回答照旧进对话,模型从下一次输入里看到--不在这里取.
    expect(payload).toEqual(okPayload(""));
    expect(calls.map((call) => call.action)).toEqual(["composer.type", "send.enter"]);
    expect(calls[0]?.params).toEqual({ text: "帮我看看" });
    expect(calls[1]?.params).toEqual({});
  });

  it("入参只有 question 一个(seconds 没有等待对象,收缩时删掉)", () => {
    expect(SEND_PAGE.params).toEqual(["question"]);
  });

  it("不再碰 wait.fence / wait.reply(那三段在 ADR-0014 之后失联)", async () => {
    const { calls, run } = recorder();

    await SEND_PAGE.run({ question: "q" }, { tabId: 1, run });

    expect(calls.map((call) => call.action)).not.toContain("wait.fence");
    expect(calls.map((call) => call.action)).not.toContain("wait.reply");
  });

  it("没有 tab(消息不带 target)→ tab-gone,一步都不跑", async () => {
    const { calls, run } = recorder();
    expect(await SEND_PAGE.run({ question: "q" }, { tabId: undefined, run })).toEqual({
      status: "error",
      error: "tab-gone",
    });
    expect(calls).toEqual([]);
  });

  it("question 非法(缺 / 空 / 非串)→ unknown-action,不发送", async () => {
    const { calls, run } = recorder();
    for (const args of [{}, { question: "" }, { question: "   " }, { question: 42 }]) {
      expect(await SEND_PAGE.run(args, { tabId: 1, run })).toEqual({
        status: "error",
        error: "unknown-action",
      });
    }
    expect(calls).toEqual([]);
  });
});

describe("send.page / 任一步没成就停,原码回", () => {
  it("第一步被闸挡(替人发言关)→ disabled,页面不发送", async () => {
    const { calls, run } = recorder({
      "composer.type": { ok: false, error: "disabled" },
    });

    expect(await SEND_PAGE.run({ question: "q" }, { tabId: 1, run })).toEqual({
      status: "error",
      error: "disabled",
    });
    expect(calls.map((call) => call.action)).toEqual(["composer.type"]);
  });

  it("发送步被挡(退避中)→ 原码回,就此打住", async () => {
    const { calls, run } = recorder({ "send.enter": { ok: false, error: "backing-off" } });

    expect(await SEND_PAGE.run({ question: "q" }, { tabId: 1, run })).toEqual({
      status: "error",
      error: "backing-off",
    });
    expect(calls.map((call) => call.action)).toEqual(["composer.type", "send.enter"]);
  });
});
