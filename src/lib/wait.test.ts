import { describe, expect, it } from "vitest";

import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_TIMEOUT } from "./action";
import type { ActionFrame } from "./action";
import { baselineKey, parseWaitSeconds, waitFence, waitReply, waitUntilNewMessage } from "./wait";
import type { ListViewport } from "./messages";

const FRAME: ActionFrame = {
  type: "action",
  id: "w-1",
  action: "wait.fence",
  params: {},
  target: "42",
};

function frameOf(action: string, params: Record<string, unknown> = {}): ActionFrame {
  return { ...FRAME, action, params };
}

/**
 * 造一条消息行:助手行认 `.ds-assistant-message-main-content`,
 * 用户行认 `.ds-message` + `.ds-collapsible-text`(结构照抄真机).
 */
function rowHtml(key: string, text: string, assistant = true): string {
  const body = assistant
    ? `<div class="ds-markdown ds-assistant-message-main-content"><p>${text}</p></div>`
    : `<div class="ds-message"><div class="ds-collapsible-text"><div><span>${text}</span></div></div></div>`;
  return `<div data-virtual-list-item-key="${key}">${body}</div>`;
}

/**
 * 列表那层带 `--printable` 是**照抄真的**:真机主聊天区就是 `.ds-virtual-list--printable`
 * (2026-10-04 / 2026-10-05 两次实测都在),而 #54 起"认对话那一条列表"要按它这条判据走
 * --只有哈希 class 的新版行本身认不出列表,得靠这条设计系统修饰类.
 */
function listHtml(rows: string): string {
  return `<div class="ds-virtual-list ds-virtual-list--printable"><div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">${rows}</div></div></div>`;
}

/** 新版站点(2026-10-04 起):行上只有哈希 class,没有 key,没有 `.ds-message`. */
const HASH = "_81e7b5e";
function rowHtmlNoKey(text: string, assistant = true): string {
  const body = assistant
    ? `<div class="${HASH}"><p>${text}</p></div>`
    : `<div class="${HASH}"><span>${text}</span></div>`;
  return `<div class="${HASH}">${body}</div>`;
}

/** 页面里的消息列表层;jsdom 不做布局,`scrollTop` 赋值是空操作,无碍. */
function viewOf(): ListViewport {
  const view = document.querySelector(".ds-virtual-list");
  if (view === null) throw new Error("没有造出消息列表");
  return view;
}

/** 立刻 settle:基线跳底那一下不等真挂载(替身列表不会换行). */
const instant = (): Promise<void> => Promise.resolve();

/** 短的到期点:`waitUntilNewMessage` 的轮询不用等满真实预算. */
function soon(ms = 20): number {
  return Date.now() + ms;
}

describe("等待预算", () => {
  it("没配与非法值按默认 25s", () => {
    expect(parseWaitSeconds(frameOf("wait.fence"))).toBe(25);
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: "10" }))).toBe(25);
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: Number.NaN }))).toBe(25);
  });

  it("配了取配值,钳在 [1, 25]", () => {
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: 3 }))).toBe(3);
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: 0.5 }))).toBe(1);
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: 999 }))).toBe(25);
    expect(parseWaitSeconds(frameOf("wait.fence", { timeout: -5 }))).toBe(1);
  });
});

describe("基线", () => {
  it("记下挂载行的 key 集合", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("1", "旧问题", false) + rowHtml("2", "旧回答") + rowHtml("3", "更新的回答"),
    );
    expect(await baselineKey(viewOf(), instant)).toEqual({ keys: ["1", "2", "3"], texts: [] });
  });

  it("key 带符号,同来回两条同值不同号:原样收进基线", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("-4", "agent:\n旧回灌") +
        rowHtml("4", "旧回答") +
        rowHtml("-6", "旧问题", false) +
        rowHtml("6", "旧围栏"),
    );
    expect(await baselineKey(viewOf(), instant)).toEqual({
      keys: ["-4", "4", "-6", "6"],
      texts: [],
    });
  });

  it("key 原样收,不解析数字(非数字也是合法身份)", async () => {
    document.body.innerHTML = listHtml(rowHtml("abc", "站点改了 key 格式"));
    expect(await baselineKey(viewOf(), instant)).toEqual({ keys: ["abc"], texts: [] });
  });

  it("没有 key 的行(新版站点):基线记正文文本", async () => {
    document.body.innerHTML = listHtml(rowHtmlNoKey("旧问题", false) + rowHtmlNoKey("旧回答"));
    expect(await baselineKey(viewOf(), instant)).toEqual({
      keys: [],
      texts: ["旧问题", "旧回答"],
    });
  });
});

describe("轮询", () => {
  it("只认基线里没见过的 key", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("1", "旧问题", false) +
        rowHtml("2", "旧回答") +
        rowHtml("3", "agent:\nstatus: ok\n新回灌"),
    );
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["1", "2"], texts: [] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toContain("新回灌");
  });

  it("基线本身与更旧的行不算新消息", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("1", "旧问题", false) + rowHtml("2", "agent:\n旧回灌"),
    );
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["1", "2"], texts: [] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toBeNull();
  });

  it("matches 不认的跳过,继续往下认", async () => {
    document.body.innerHTML = listHtml(rowHtml("3", "普通新回答") + rowHtml("4", "agent:\n新回灌"));
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["1", "2"], texts: [] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toContain("新回灌");
  });

  it("负 key 的新回灌也算新(同来回对面那条,#37)", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("3", "旧回答") + rowHtml("-5", "agent:\nstatus: ok\n新回灌"),
    );
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["3"], texts: [] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toContain("新回灌");
  });

  it("基线里见过的旧行不算新(滚动重挂)", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("-3", "agent:\n旧回灌") + rowHtml("2", "旧问题", false),
    );
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["-3", "2"], texts: [] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toBeNull();
  });

  it("无 key 行(新版站点):基线里的旧文本不算新,没见过的算新", async () => {
    document.body.innerHTML = listHtml(
      rowHtmlNoKey("旧问题", false) + rowHtmlNoKey("agent:\n新回灌"),
    );
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: [], texts: ["旧问题"] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toContain("新回灌");
  });

  it("无 key 行:基线里已有的回灌不误认(回 null)", async () => {
    document.body.innerHTML = listHtml(rowHtmlNoKey("agent:\n旧回灌"));
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: [], texts: ["agent:\n旧回灌"] },
      soon(),
      (text) => text.startsWith("agent:"),
      1,
    );
    expect(found).toBeNull();
  });

  it("到点没等到回 null", async () => {
    document.body.innerHTML = listHtml(rowHtml("1", "旧回答"));
    const found = await waitUntilNewMessage(
      viewOf(),
      { keys: ["1"], texts: [] },
      soon(),
      () => true,
      1,
    );
    expect(found).toBeNull();
  });
});

describe("wait.fence / wait.reply", () => {
  it("消息列表晚挂载:等到了就不是 page-changed(等不到新消息才是 timeout)", async () => {
    document.body.innerHTML = "";
    const pending = waitReply(frameOf("wait.reply", { timeout: 2 }));
    setTimeout(() => {
      document.body.innerHTML = listHtml(rowHtml("1", "旧问题", false));
    }, 600);
    await expect(pending).rejects.toMatchObject({ code: ACTION_ERROR_TIMEOUT });
  });

  it("新版站点:```send 被渲染成代码块也能认(围栏正文在 <pre> 里)", async () => {
    document.body.innerHTML = listHtml(rowHtmlNoKey("旧的用户消息", false));
    const pending = waitFence(frameOf("wait.fence", { timeout: 3 }));
    setTimeout(() => {
      // 往同一个容器里追加一行(换 innerHTML 会把视图句柄变成旧 DOM,读不到).
      document
        .querySelector(".ds-virtual-list-visible-items")
        ?.insertAdjacentHTML(
          "beforeend",
          `<div class="${HASH}"><span>send</span><pre>{"tool": "ls", "arguments": {"path": "."}}</pre></div>`,
        );
    }, 600);
    await expect(pending).resolves.toEqual({
      question: '{"tool": "ls", "arguments": {"path": "."}}',
    });
  });

  it("消息列表始终不出现:预算耗尽才报 page-changed", async () => {
    document.body.innerHTML = "";
    await expect(waitFence(frameOf("wait.fence", { timeout: 1 }))).rejects.toMatchObject({
      code: ACTION_ERROR_PAGE_CHANGED,
    });
    await expect(waitReply(frameOf("wait.reply", { timeout: 1 }))).rejects.toMatchObject({
      code: ACTION_ERROR_PAGE_CHANGED,
    });
  });

  it("基线里的旧围栏不误认:等不到新围栏回 timeout", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("1", "旧问题", false) + rowHtml("2", "结论先放这:\n```send\n查一下旧天气\n```"),
    );
    await expect(waitFence(frameOf("wait.fence", { timeout: 1 }))).rejects.toMatchObject({
      code: ACTION_ERROR_TIMEOUT,
    });
  });

  it("基线里的旧回灌不误认:等不到新回灌回 timeout", async () => {
    document.body.innerHTML = listHtml(
      rowHtml("1", "旧问题", false) + rowHtml("2", "agent:\n旧回灌"),
    );
    await expect(waitReply(frameOf("wait.reply", { timeout: 1 }))).rejects.toMatchObject({
      code: ACTION_ERROR_TIMEOUT,
    });
  });
});
