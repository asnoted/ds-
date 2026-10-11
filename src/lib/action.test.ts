import { describe, expect, it } from "vitest";

import {
  ACTION_ERROR_DISABLED,
  ACTION_ERROR_UNKNOWN,
  listSessionTabs,
  runAction,
  sendMessageSendToTab,
  isActionOutcome,
  type ActionContext,
  type ActionOutcome,
  type SessionTab,
  type TabCandidate,
  type TabsApi,
  type ToggleApi,
} from "./action";
import type { ActionFrame } from "./action";
import { fixtureCases, fixtureFile, type ActionCase, type ActionFixtureFile } from "./fixtures";

function tabsApi(tabs: readonly TabCandidate[]): TabsApi & { calls: number } {
  const api = {
    calls: 0,
    async query(): Promise<readonly TabCandidate[]> {
      api.calls += 1;
      return tabs;
    },
  };
  return api;
}

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    enabled: true,
    speak: true,
    backoff: { until: null, round: 0 },
    setBackoff: async () => undefined,
    tabs: tabsApi([]),
    ...overrides,
  };
}

function frame(overrides: Partial<ActionFrame> = {}): ActionFrame {
  return { type: "action", id: "1-a", action: "tabs.list", params: {}, target: null, ...overrides };
}

const DEEPSEEK_TAB: TabCandidate = {
  id: 42,
  title: "DeepSeek - 深度求索",
  url: "https://chat.deepseek.com/a/chat/s/abc123",
};

describe("tabs.list 执行器", () => {
  it("只留 chat.deepseek.com,每项 { id, title, url }", async () => {
    const tabs = tabsApi([
      DEEPSEEK_TAB,
      { id: 7, title: "别的站", url: "https://example.com/a/chat/s/nope" },
      { id: 8, title: "没有 url 的 deepseek 标签页" },
      { id: undefined, title: "没有 id", url: "https://chat.deepseek.com/a/chat/s/x" },
      { id: 9, title: undefined, url: "这一行不是 url" },
      { id: 10, title: "deepseek 首页", url: "https://chat.deepseek.com/" },
    ]);

    expect(await listSessionTabs(tabs)).toEqual([
      { id: 42, title: "DeepSeek - 深度求索", url: "https://chat.deepseek.com/a/chat/s/abc123" },
      { id: 10, title: "deepseek 首页", url: "https://chat.deepseek.com/" },
    ]);
    expect(tabs.calls).toBe(1);
  });

  it("结果形状与 protocol/fixtures/action.json 的成功样例同形", async () => {
    const fixture = fixtureCases<ActionCase>("action.json").find(
      ({ name }) => name === "tabs.list 成功",
    );
    expect(fixture).toBeDefined();
    if (!fixture || fixture.response.ok === false) throw new Error("fixture 缺成功样例");

    const outcome = await runAction(frame(), context({ tabs: tabsApi([DEEPSEEK_TAB]) }));

    expect(outcome).toEqual({ ok: true, result: { tabs: [DEEPSEEK_TAB] } });
    if (!outcome.ok) throw new Error("tabs.list 没回结果");
    const result = outcome.result as { tabs: SessionTab[] };
    expect(Object.keys(result)).toEqual(Object.keys(fixture.response.result as object));
    expect(Object.keys(result.tabs[0] ?? {})).toEqual(
      Object.keys((fixture.response.result as { tabs: SessionTab[] }).tabs[0] ?? {}),
    );
  });
});

describe("总开关闸(关着不执行,回 disabled 让中继别等满超时)", () => {
  it("关着时连 tabs.query 都不问,但回一个册子里的 disabled", async () => {
    const tabs = tabsApi([DEEPSEEK_TAB]);
    const outcome = await runAction(frame(), context({ enabled: false, tabs }));

    expect(outcome).toEqual({ ok: false, error: "disabled" });
    expect(tabs.calls).toBe(0);
  });

  it("disabled 与共享 fixture 的样例同一份(TS 与 Python 共读)", () => {
    const book = (fixtureFile("action.json") as ActionFixtureFile).errorCodes.map(
      ({ code }) => code,
    );
    expect(book).toContain(ACTION_ERROR_DISABLED);
    const sample = fixtureCases<ActionCase>("action.json").find(
      ({ name }) => name === "总开关关闭失败",
    )?.response;
    if (!sample || sample.ok) throw new Error("fixture 里没有关开关的失败样例");
    expect(sample.error).toBe(ACTION_ERROR_DISABLED);
  });
});

describe("按 target 路由", () => {
  it("target 指名的标签页交给 sendToTab,结果原样回传", async () => {
    const seen: Array<{ tabId: number; frame: ActionFrame }> = [];
    const target = frame({ action: "composer.read", target: "42" });
    const outcome = await runAction(
      target,
      context({
        sendToTab: async (tabId, received) => {
          seen.push({ tabId, frame: received });
          return { ok: true, result: { text: "页面上的字" } };
        },
      }),
    );

    expect(seen).toEqual([{ tabId: 42, frame: target }]);
    expect(outcome).toEqual({ ok: true, result: { text: "页面上的字" } });
  });

  it("target 不是纯数字串 → tab-gone(认不出的地址等于标签页不在)", async () => {
    for (const bad of ["不是数字", "42.5", "", " ", "1e3", "0x10", "-1", "+1", "9".repeat(30)]) {
      expect(await runAction(frame({ target: bad }), context())).toEqual({
        ok: false,
        error: "tab-gone",
      });
    }
  });

  it("没接执行口 → tab-gone(background 接上后不该出现,留作类型兜底)", async () => {
    expect(await runAction(frame({ target: "42" }), context())).toEqual({
      ok: false,
      error: "tab-gone",
    });
  });
});

describe("sendToTab 接线(background 侧的 browser.tabs.sendMessage)", () => {
  it("对端答的是同构载荷就原样透传", async () => {
    const seen: Array<{ tabId: number; frame: ActionFrame }> = [];
    const sendToTab = sendMessageSendToTab(async (tabId, frame) => {
      seen.push({ tabId, frame });
      return { ok: true, result: { text: "页面上的字" } };
    });

    const outcome = await sendToTab(42, frame({ target: "42" }));

    expect(seen).toEqual([{ tabId: 42, frame: frame({ target: "42" }) }]);
    expect(outcome).toEqual({ ok: true, result: { text: "页面上的字" } });
  });

  it("sendMessage 抛错(标签页没了 / 内容脚本没注入)→ tab-gone,不冒泡", async () => {
    const sendToTab = sendMessageSendToTab(async () => {
      throw new Error("Could not establish connection");
    });

    expect(await sendToTab(42, frame({ target: "42" }))).toEqual({
      ok: false,
      error: "tab-gone",
    });
  });

  it("对端答的形状认不出 → tab-gone(不当成功收下)", async () => {
    const sendToTab = sendMessageSendToTab(async () => ({ ok: "yes" }));

    expect(await sendToTab(42, frame({ target: "42" }))).toEqual({
      ok: false,
      error: "tab-gone",
    });
  });
});

function toggleApi(initial = false): ToggleApi & { value: boolean; sets: number } {
  const api = {
    value: initial,
    sets: 0,
    async get(): Promise<boolean> {
      return api.value;
    },
    async set(value: boolean): Promise<boolean> {
      api.value = value;
      api.sets += 1;
      return api.value;
    },
  };
  return api;
}

describe("toggle.get / toggle.set", () => {
  it("toggle.get 回总开关当前状态", async () => {
    const toggle = toggleApi(true);
    expect(await runAction(frame({ action: "toggle.get" }), context({ toggle }))).toEqual({
      ok: true,
      result: { enabled: true },
    });
  });

  it("toggle.set 写入并回新状态", async () => {
    const toggle = toggleApi(false);
    const outcome = await runAction(
      frame({ action: "toggle.set", params: { enabled: true } }),
      context({ toggle }),
    );
    expect(outcome).toEqual({ ok: true, result: { enabled: true } });
    expect(toggle.value).toBe(true);
    expect(toggle.sets).toBe(1);
  });

  it("toggle.set 参数不是布尔 → unknown-action,别假装写过了", async () => {
    const toggle = toggleApi(false);
    for (const bad of [undefined, null, "true", 1, {}, []]) {
      expect(
        await runAction(
          frame({ action: "toggle.set", params: { enabled: bad } }),
          context({ toggle }),
        ),
      ).toEqual({ ok: false, error: "unknown-action" });
    }
    expect(toggle.sets).toBe(0);
  });

  it("context 没接 toggle → toggle.get/set 都回 unknown-action", async () => {
    expect(await runAction(frame({ action: "toggle.get" }), context())).toEqual({
      ok: false,
      error: "unknown-action",
    });
    expect(
      await runAction(frame({ action: "toggle.set", params: { enabled: true } }), context()),
    ).toEqual({ ok: false, error: "unknown-action" });
  });
});

describe("总开关关着时的豁免(toggle.*)", () => {
  it("enabled=false 时 toggle.get / toggle.set 照常执行", async () => {
    const toggle = toggleApi(false);
    const ctx = context({ enabled: false, toggle });
    expect(await runAction(frame({ action: "toggle.get" }), ctx)).toEqual({
      ok: true,
      result: { enabled: false },
    });
    expect(
      await runAction(frame({ action: "toggle.set", params: { enabled: true } }), ctx),
    ).toEqual({ ok: true, result: { enabled: true } });
    expect(toggle.value).toBe(true);
  });

  it("enabled=false 时其余动作一律 disabled(含 tabs.list / 带 target 的)", async () => {
    const ctx = context({ enabled: false, toggle: toggleApi(false) });
    expect(await runAction(frame({ action: "tabs.list" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(await runAction(frame({ action: "composer.read", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
  });
});

describe("名册有,扩展还没实现的动作", () => {
  it("还没实现的动作当场回 unknown-action,别让中继等满 30s", async () => {
    const outcome = await runAction(frame({ action: "page.state" }), context());

    expect(outcome).toEqual({ ok: false, error: "unknown-action" });
  });

  it("unknown-action 与共享 fixture 的样例同一份(TS 与 Python 共读)", () => {
    const book = (fixtureFile("action.json") as ActionFixtureFile).errorCodes.map(
      ({ code }) => code,
    );
    expect(book).toContain(ACTION_ERROR_UNKNOWN);
    const sample = fixtureCases<ActionCase>("action.json").find(
      ({ name }) => name === "未知动作失败",
    )?.response;
    if (!sample || sample.ok) throw new Error("fixture 里没有未知动作的失败样例");
    expect(sample.error).toBe(ACTION_ERROR_UNKNOWN);
  });
});

describe("isActionOutcome 形状", () => {
  it("ok:true 必须有非 undefined 的 result", () => {
    expect(isActionOutcome({ ok: true, result: null })).toBe(true);
    expect(isActionOutcome({ ok: true, result: 0 })).toBe(true);
    expect(isActionOutcome({ ok: true, result: undefined })).toBe(false);
    expect(isActionOutcome({ ok: true })).toBe(false);
  });

  it("ok:false 必须有非空 error 字符串", () => {
    expect(isActionOutcome({ ok: false, error: "x" })).toBe(true);
    expect(isActionOutcome({ ok: false, error: "" })).toBe(false);
    expect(isActionOutcome({ ok: false })).toBe(false);
    expect(isActionOutcome({ ok: false, error: 42 })).toBe(false);
  });

  it("不是对象 / ok 非布尔一律不认", () => {
    expect(isActionOutcome(null)).toBe(false);
    expect(isActionOutcome(undefined)).toBe(false);
    expect(isActionOutcome("yes")).toBe(false);
    expect(isActionOutcome({ ok: "yes" })).toBe(false);
  });
});

describe('"代你发言"闸', () => {
  const ok = async () => ({ ok: true, result: {} }) as const;

  it("闸关着时动写作框的动作回 disabled,读不受管", async () => {
    const ctx = context({ speak: false, sendToTab: ok });
    expect(await runAction(frame({ action: "composer.type", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(await runAction(frame({ action: "composer.clear", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
    // 读不受这个闸管:看一眼你写了什么不算替你开口.
    expect(await runAction(frame({ action: "composer.read", target: "42" }), ctx)).toEqual({
      ok: true,
      result: {},
    });
  });

  it("闸开着时照常走", async () => {
    // 退避闸会先探一次 page.state:答一个 ready 账号,执行帧照常回.
    const sendToTab = async (_tabId: number, received: ActionFrame) =>
      received.action === "page.state"
        ? ({ ok: true, result: { account: { kind: "ready" } } } as const)
        : ({ ok: true, result: {} } as const);
    const ctx = context({ speak: true, sendToTab });
    expect(await runAction(frame({ action: "composer.type", target: "42" }), ctx)).toEqual({
      ok: true,
      result: {},
    });
  });
});

describe("退避闸(账号在处罚区,写动作停发)", () => {
  /** 记下送到标签页的每一帧,断言"探针问了,执行没送". */
  function recordingSendToTab(account: unknown): {
    send: (tabId: number, frame: ActionFrame) => Promise<ActionOutcome>;
    sent: ActionFrame[];
  } {
    const sent: ActionFrame[] = [];
    return {
      sent,
      send: async (_tabId, received) => {
        sent.push(received);
        if (received.action === "page.state") {
          return { ok: true, result: { account } } as const;
        }
        return { ok: true, result: {} } as const;
      },
    };
  }

  const MUTED = { kind: "muted", until: "2099 年 1 月 1 日 00:00" };

  it("禁言中:写动作回 backing-off,执行帧不送到标签页", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const writes: string[] = [];
    const ctx = context({
      sendToTab: send,
      setBackoff: async (next) => {
        writes.push(JSON.stringify(next));
      },
    });

    const outcome = await runAction(
      frame({ action: "composer.type", params: { text: "hi" }, target: "42" }),
      ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "backing-off" });
    // 只问过 page.state(探针),composer.type 没送过去.
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
    // 判定落盘:长休到站点写的时刻.
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "{}").until).toBeGreaterThan(Date.now());
  });

  it("只读动作不受退避影响:照常送到标签页", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    const outcome = await runAction(frame({ action: "messages.list", target: "42" }), ctx);

    expect(outcome).toEqual({ ok: true, result: {} });
    // 读动作不探针,不拦.
    expect(sent.map((f) => f.action)).toEqual(["messages.list"]);
  });

  it("退避到期且账号正常:放行并清掉终点(探活就是刚读的这一次)", async () => {
    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const cleared: string[] = [];
    const ctx = context({
      backoff: { until: Date.now() - 1, round: 2 },
      sendToTab: send,
      setBackoff: async (next) => {
        cleared.push(JSON.stringify(next));
      },
    });

    const outcome = await runAction(frame({ action: "send.enter", target: "42" }), ctx);

    expect(outcome).toEqual({ ok: true, result: {} });
    // 先探针再执行,两帧都送了.
    expect(sent.map((f) => f.action)).toEqual(["page.state", "send.enter"]);
    // 终点清掉,回次留着--下次再进处罚区阶梯才乘得上去.
    expect(JSON.parse(cleared[0] ?? "{}")).toEqual({ until: null, round: 2 });
  });

  it("退避没到期:继续拦,不把终点越推越远", async () => {
    const { send } = recordingSendToTab({ kind: "ready" });
    const until = Date.now() + 60_000;
    const writes: string[] = [];
    const ctx = context({
      backoff: { until, round: 3 },
      sendToTab: send,
      setBackoff: async (next) => {
        writes.push(JSON.stringify(next));
      },
    });

    const outcome = await runAction(frame({ action: "chat.new", target: "42" }), ctx);

    expect(outcome).toEqual({ ok: false, error: "backing-off" });
    // 终点原样保留--频繁判定不会重算.
    expect(JSON.parse(writes[0] ?? "{}")).toEqual({ until, round: 3 });
  });

  it("开关关着先回 disabled:次序不翻(退避闸在 speak 闸之后)", async () => {
    const { send } = recordingSendToTab(MUTED);
    const ctx = context({ enabled: false, speak: false, sendToTab: send });

    expect(await runAction(frame({ action: "composer.type", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
  });

  it("探针问不到:当场报 tab-gone,执行帧不送(不放行往处罚区堆活)", async () => {
    const sent: ActionFrame[] = [];
    const ctx = context({
      sendToTab: async (_tabId, received) => {
        sent.push(received);
        if (received.action === "page.state") {
          return { ok: false, error: "tab-gone" } as const;
        }
        return { ok: true, result: {} } as const;
      },
    });

    const outcome = await runAction(frame({ action: "composer.type", target: "42" }), ctx);

    expect(outcome).toEqual({ ok: false, error: "tab-gone" });
    // 只送了探针,执行帧没送.
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
  });

  it("chat.new 也在退避闸下(开新对话也是写)", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    expect(await runAction(frame({ action: "chat.new", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "backing-off",
    });
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
  });

  it("think.set / search.set 也在退避闸下(改页面状态是写),think.get 不受影响", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    for (const action of ["think.set", "search.set"]) {
      expect(
        await runAction(frame({ action, params: { enabled: true }, target: "42" }), ctx),
      ).toEqual({ ok: false, error: "backing-off" });
    }
    // 读开关是只读:不探针,不拦.
    sent.length = 0;
    expect(await runAction(frame({ action: "think.get", target: "42" }), ctx)).toEqual({
      ok: true,
      result: {},
    });
    expect(sent.map((f) => f.action)).toEqual(["think.get"]);
  });

  it("think.set / search.set 只进退避闸,不进 speak 闸(不代你发言)", async () => {
    // 账号正常 + speak 关着:不该被 speak 闸挡.
    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const ctx = context({ speak: false, sendToTab: send });

    expect(
      await runAction(frame({ action: "think.set", params: { enabled: true }, target: "42" }), ctx),
    ).toEqual({ ok: true, result: {} });
    expect(sent.map((f) => f.action)).toEqual(["page.state", "think.set"]);
  });

  it("chat.switch 在退避闸下(切会话改页面状态),chats.list 不受影响", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    expect(
      await runAction(frame({ action: "chat.switch", params: { id: "a" }, target: "42" }), ctx),
    ).toEqual({ ok: false, error: "backing-off" });
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
    // 读会话列表是只读:不探针,不拦.
    sent.length = 0;
    expect(await runAction(frame({ action: "chats.list", target: "42" }), ctx)).toEqual({
      ok: true,
      result: {},
    });
    expect(sent.map((f) => f.action)).toEqual(["chats.list"]);
  });

  it("chat.switch 只进退避闸,不进 speak 闸(不动写作框,不代你发言)", async () => {
    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const ctx = context({ speak: false, sendToTab: send });

    expect(
      await runAction(frame({ action: "chat.switch", params: { id: "a" }, target: "42" }), ctx),
    ).toEqual({ ok: true, result: {} });
    expect(sent.map((f) => f.action)).toEqual(["page.state", "chat.switch"]);
  });

  it("消息工具栏六项与代码块两项都在退避闸下,读(chats.list 同理)不受影响", async () => {
    const actions = [
      "message.copy",
      "message.retry",
      "message.like",
      "message.dislike",
      "message.read",
      "message.share",
      "code.copy",
      "code.download",
    ];
    for (const action of actions) {
      const { send, sent } = recordingSendToTab(MUTED);
      const ctx = context({ sendToTab: send });

      expect(await runAction(frame({ action, params: { index: -1 }, target: "42" }), ctx)).toEqual({
        ok: false,
        error: "backing-off",
      });
      expect(sent.map((f) => f.action)).toEqual(["page.state"]);
    }
  });

  it("只有 message.retry 进 speak 闸(重新生成等同发送);其余 7 个 speak 关着也放行", async () => {
    const others = [
      "message.copy",
      "message.like",
      "message.dislike",
      "message.read",
      "message.share",
      "code.copy",
      "code.download",
    ];
    for (const action of others) {
      const { send, sent } = recordingSendToTab({ kind: "ready" });
      const ctx = context({ speak: false, sendToTab: send });

      expect(await runAction(frame({ action, params: { index: -1 }, target: "42" }), ctx)).toEqual({
        ok: true,
        result: {},
      });
      expect(sent.map((f) => f.action)).toEqual(["page.state", action]);
    }

    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const ctx = context({ speak: false, sendToTab: send });
    expect(
      await runAction(frame({ action: "message.retry", params: { index: -1 }, target: "42" }), ctx),
    ).toEqual({ ok: false, error: "disabled" });
    expect(sent).toEqual([]);
  });

  it("sidebar.set 在退避闸下(改页面状态),sidebar.get 不受影响", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    expect(
      await runAction(
        frame({ action: "sidebar.set", params: { collapsed: true }, target: "42" }),
        ctx,
      ),
    ).toEqual({ ok: false, error: "backing-off" });
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
    sent.length = 0;
    expect(await runAction(frame({ action: "sidebar.get", target: "42" }), ctx)).toEqual({
      ok: true,
      result: {},
    });
    expect(sent.map((f) => f.action)).toEqual(["sidebar.get"]);
  });

  it("sidebar.set 只进退避闸,不进 speak 闸(不动写作框,不代你发言)", async () => {
    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const ctx = context({ speak: false, sendToTab: send });

    expect(
      await runAction(
        frame({ action: "sidebar.set", params: { collapsed: true }, target: "42" }),
        ctx,
      ),
    ).toEqual({ ok: true, result: {} });
    expect(sent.map((f) => f.action)).toEqual(["page.state", "sidebar.set"]);
  });

  it("button.click 也在退避闸下(点圆键总是改页面状态)", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ sendToTab: send });

    expect(await runAction(frame({ action: "button.click", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "backing-off",
    });
    expect(sent.map((f) => f.action)).toEqual(["page.state"]);
  });

  it("button.click 也进 speak 闸(它可能在替你开口--一律按最坏那条拦)", async () => {
    const { send, sent } = recordingSendToTab({ kind: "ready" });
    const ctx = context({ speak: false, sendToTab: send });

    expect(await runAction(frame({ action: "button.click", target: "42" }), ctx)).toEqual({
      ok: false,
      error: "disabled",
    });
    // speak 闸在退避探针**之前**:闸关着时连账号处境都不问,一个帧都没发.
    expect(sent).toEqual([]);
  });

  it("button.get 是读动作:两闸都不在(读处境不该被人际闸挡住)", async () => {
    const { send, sent } = recordingSendToTab(MUTED);
    const ctx = context({ speak: false, sendToTab: send });

    // 放行到执行器(mock 对非 page.state 一律回 {},本条只验闸放不放)
    expect((await runAction(frame({ action: "button.get", target: "42" }), ctx)).ok).toBe(true);
    // 不探账号处境:不在退避闸名单里(读动作,读处境的人不该被人际闸挡)
    expect(sent.map((f) => f.action)).toEqual(["button.get"]);
  });
});
