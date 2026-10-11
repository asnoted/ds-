import { beforeEach, describe, expect, it } from "vitest";

import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_UNKNOWN, PageError } from "./action";
import type { ActionFrame } from "./action";
import { CODE_LABELS, CONTROL_ACTIONS, TOOLBAR_POSITIONS } from "./controls";
import { evidenceHtml } from "./evidence";

/**
 * 原件取自存证(真机 2026-10-07,ADR-0018):`message.toolbar`(assistant 行 6 颗),
 * `message.toolbar.user`(用户行 2 颗,反例),`code.block`.只在取到的原件上做最小变形,不手抄.
 */
const ASSISTANT_TOOLBAR = evidenceHtml("message.toolbar");
const USER_TOOLBAR = evidenceHtml("message.toolbar.user");
const CODE_BLOCK = evidenceHtml("code.block");

const frameOf = (action: string, params: Record<string, unknown>): ActionFrame => ({
  type: "action",
  id: "c-1",
  action,
  params,
  target: "42",
});

function userRow(key: number, text: string): string {
  return `<div data-virtual-list-item-key="${key}"><div class="ds-message"><div class="ds-collapsible-text"><span>${text}</span></div></div>${USER_TOOLBAR}</div>`;
}

function assistantRow(key: number, text: string, toolbar = ASSISTANT_TOOLBAR, extra = ""): string {
  return `<div data-virtual-list-item-key="${key}"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content"><p>${text}</p>${extra}</div></div>${toolbar}</div>`;
}

function conversation(...rows: string[]): void {
  document.body.innerHTML = `<div class="ds-virtual-list ds-virtual-list--printable"><div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">${rows.join("")}</div></div></div>`;
}

/** 给每个 `[role=button]` 记点击:返回按"行序号.按钮序号"取次数的函数. */
function trackClicks(): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = document.querySelectorAll("[data-virtual-list-item-key]");
  rows.forEach((row, rowIndex) => {
    row.querySelectorAll('[role="button"]').forEach((button, buttonIndex) => {
      button.addEventListener("click", () => {
        const key = `${rowIndex}.${buttonIndex + 1}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
    });
  });
  return counts;
}

function codeLabelClicks(): Map<string, number> {
  const counts = new Map<string, number>();
  document.querySelectorAll("div.md-code-block").forEach((block, blockIndex) => {
    block.querySelectorAll('[role="button"]').forEach((button) => {
      const label = (button.textContent || "").trim();
      button.addEventListener("click", () => {
        const key = `${blockIndex}.${label}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
    });
  });
  return counts;
}

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PageError ? error.code : undefined;
  }
  return undefined;
}

const act = (name: string, params: Record<string, unknown>) => {
  const action = CONTROL_ACTIONS[name];
  if (action === undefined) throw new Error(`名册里没有 ${name}`);
  return action(frameOf(name, params));
};

describe("存证原件的前提(变形没把原件改坏)", () => {
  it("assistant 工具栏:6 颗直接子 button,第 5 颗带 aria-label=朗读", () => {
    conversation(assistantRow(1, "答"));
    const toolbar = document.querySelector('[aria-label="朗读"]')?.parentElement as HTMLElement;

    expect(toolbar.children.length).toBe(6);
    expect([...toolbar.children].every((c) => c.getAttribute("role") === "button")).toBe(true);
    expect(toolbar.children[4]?.getAttribute("aria-label")).toBe("朗读");
  });

  it("用户工具栏是反例:只有 2 颗,没有朗读", () => {
    conversation(userRow(1, "问"));

    expect(document.querySelectorAll('[role="button"]').length).toBe(2);
    expect(document.querySelector('[aria-label="朗读"]')).toBeNull();
  });

  it("名册恰是 8 个动作", () => {
    expect(Object.keys(CONTROL_ACTIONS).sort()).toEqual(
      [...Object.keys(TOOLBAR_POSITIONS), ...Object.keys(CODE_LABELS)].sort(),
    );
    expect(Object.keys(CONTROL_ACTIONS).length).toBe(8);
  });
});

describe("message.* 动作", () => {
  it.each(Object.entries(TOOLBAR_POSITIONS))("%s 点工具栏第 %d 颗,且只点它", (name, position) => {
    conversation(userRow(1, "问"), assistantRow(2, "答"));
    const clicks = trackClicks();

    expect(act(name, { index: -1 })).toEqual({});
    expect([...clicks.entries()]).toEqual([[`1.${position}`, 1]]);
  });

  it("index:非负从头数,负数从末尾数", () => {
    conversation(
      userRow(1, "问一"),
      assistantRow(2, "答一"),
      userRow(3, "问二"),
      assistantRow(4, "答二"),
    );
    const clicks = trackClicks();

    act("message.copy", { index: 1 });
    act("message.copy", { index: -3 });
    act("message.copy", { index: -1 });

    expect([...clicks.entries()].sort()).toEqual([
      ["1.1", 2],
      ["3.1", 1],
    ]);
  });

  it("点到用户消息回 page-changed,不点", () => {
    conversation(userRow(1, "问"), assistantRow(2, "答"));
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.copy", { index: 0 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
  });

  it("工具栏少一颗:page-changed,不点", () => {
    conversation(assistantRow(1, "答"));
    document.querySelector('[aria-label="朗读"]')?.parentElement?.lastElementChild?.remove();
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.like", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
  });

  it("工具栏多一颗:page-changed,不点", () => {
    conversation(assistantRow(1, "答"));
    const toolbar = document.querySelector('[aria-label="朗读"]')?.parentElement as HTMLElement;
    toolbar.append(toolbar.children[0]?.cloneNode(true) as Node);
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.like", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
  });

  it('"朗读"不在第 5 位(站点把顺序换了):page-changed,不点', () => {
    conversation(assistantRow(1, "答"));
    const toolbar = document.querySelector('[aria-label="朗读"]')?.parentElement as HTMLElement;
    toolbar.insertBefore(toolbar.children[4] as Element, toolbar.children[0] as Element);
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.share", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
  });

  it("目标那颗 aria-disabled=true:page-changed,不点;false 照点", () => {
    conversation(
      assistantRow(1, "答一"),
      assistantRow(
        2,
        "答二",
        ASSISTANT_TOOLBAR.replace('aria-disabled="false"', 'aria-disabled="true"'),
      ),
    );
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.retry", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
    expect(act("message.retry", { index: 0 })).toEqual({});
    expect([...clicks.entries()]).toEqual([["0.2", 1]]);
  });

  it("index 越界(含一行都没有)回 page-changed", () => {
    conversation(assistantRow(1, "答"));
    expect(thrownCode(() => act("message.copy", { index: 1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(thrownCode(() => act("message.copy", { index: -2 }))).toBe(ACTION_ERROR_PAGE_CHANGED);

    document.body.innerHTML = "<div>空的</div>";
    expect(thrownCode(() => act("message.copy", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });

  it.each([
    ["缺失", {}],
    ["小数", { index: 1.5 }],
    ["字符串", { index: "1" }],
    ["null", { index: null }],
  ])("index %s:unknown-action,不点", (_name, params) => {
    conversation(assistantRow(1, "答"));
    const clicks = trackClicks();

    expect(thrownCode(() => act("message.copy", params))).toBe(ACTION_ERROR_UNKNOWN);
    expect(clicks.size).toBe(0);
  });
});

describe("code.* 动作", () => {
  const codeRow = (key: number) => assistantRow(key, "先看这个:", ASSISTANT_TOOLBAR, CODE_BLOCK);

  beforeEach(() => conversation(codeRow(1), codeRow(2)));

  it("code.copy / code.download 各点块内对应文字的那一颗", () => {
    const clicks = codeLabelClicks();

    expect(act("code.copy", { index: 0 })).toEqual({});
    expect(act("code.download", { index: -1 })).toEqual({});
    expect([...clicks.entries()].sort()).toEqual([
      ["0.复制", 1],
      ["1.下载", 1],
    ]);
  });

  it("不会误点同一块里的另一颗(文字区分,不靠顺序)", () => {
    const clicks = codeLabelClicks();

    act("code.copy", { index: 0 });

    expect(clicks.get("0.下载")).toBeUndefined();
  });

  it("块里找不到那个文字:page-changed,不点", () => {
    const clicks = codeLabelClicks();
    document.querySelectorAll("div.md-code-block [role=button]").forEach((button) => {
      if ((button.textContent || "").trim() === "下载") button.textContent = "保存";
    });

    expect(thrownCode(() => act("code.download", { index: 0 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(clicks.size).toBe(0);
  });

  it("index 越界 page-changed;形状错 unknown-action", () => {
    expect(thrownCode(() => act("code.copy", { index: 2 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
    expect(thrownCode(() => act("code.copy", {}))).toBe(ACTION_ERROR_UNKNOWN);
  });

  it("页面上没有代码块:page-changed", () => {
    conversation(assistantRow(1, "没有代码"));

    expect(thrownCode(() => act("code.copy", { index: -1 }))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });
});
