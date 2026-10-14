import { describe, expect, it } from "vitest";

import { CONTROL_ACTIONS } from "./controls";
import { fixtureCases, type ActionCase } from "./fixtures";
import {
  ACTION_REGISTRY,
  ACTION_ROSTER,
  BACKOFF_GATED_ACTIONS,
  SPEAK_GATED_ACTIONS,
  TOGGLE_ACTIONS,
} from "./registry";
import { SEND_PRIMITIVES } from "./sendpace";

/** 探针文件头的原文(与 fixture 同款取法:`import.meta.glob` 急加载,取 `?raw` 原文). */
const PROBE_SOURCES = import.meta.glob<string>("../../scripts/page-action.py", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** 四个标志:每个注册行都得**显式**写着(闸归类不做任何推断,ADR-0023 红线). */
const FLAGS = ["toggleExempt", "speak", "backoff", "paced"] as const;

describe("注册表是唯一声明点(名册从它派生)", () => {
  it("名册里每个动作都有注册行:有执行,且 target 形态是标签页", () => {
    const names = Object.keys(ACTION_ROSTER);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const row = ACTION_REGISTRY[name];
      expect(row, `名册动作 ${name} 没有注册行`).toBeDefined();
      if (row === undefined) continue;
      expect(typeof row.run, `${name} 的执行`).toBe("function");
      expect(row.target, `${name} 的 target 形态`).toBe("tab");
    }
  });

  it("反过来:target 要标签页的行都在名册里(成员与 target 形态互为充要)", () => {
    for (const [name, row] of Object.entries(ACTION_REGISTRY)) {
      expect(
        name in ACTION_ROSTER,
        `${name}:target=${row.target},在名册里=${name in ACTION_ROSTER}`,
      ).toBe(row.target === "tab");
    }
  });

  it("controls 的 8 个控件动作每项都有注册行", () => {
    expect(Object.keys(CONTROL_ACTIONS).length).toBe(8);
    for (const name of Object.keys(CONTROL_ACTIONS)) {
      expect(ACTION_REGISTRY[name]?.target, name).toBe("tab");
    }
  });
});

describe("三道闸名单与限速名单回指到注册行(加动作忘归类当场红)", () => {
  const LISTS = [
    { list: TOGGLE_ACTIONS, flag: "toggleExempt", why: "总开关豁免" },
    { list: SPEAK_GATED_ACTIONS, flag: "speak", why: "代你发言" },
    { list: BACKOFF_GATED_ACTIONS, flag: "backoff", why: "退避" },
    { list: SEND_PRIMITIVES, flag: "paced", why: "发送限速" },
  ] as const;

  it("名单里每个名字都有一行,且行上那个标志显式写着 true", () => {
    for (const { list, flag, why } of LISTS) {
      expect(list.size, `${why}名单是空的`).toBeGreaterThan(0);
      for (const name of list) {
        const row = ACTION_REGISTRY[name];
        expect(row, `${why}名单里的 ${name} 没有注册行`).toBeDefined();
        expect(row?.[flag], `${why}名单里的 ${name},行上 ${flag} 不是 true`).toBe(true);
      }
    }
  });

  it("反向:标志为 true 的行都进了对应名单(名单确实从注册表派生)", () => {
    for (const [name, row] of Object.entries(ACTION_REGISTRY)) {
      for (const { list, flag, why } of LISTS) {
        expect(list.has(name), `${name} 行上 ${flag}=${String(row[flag])},却不在${why}名单`).toBe(
          row[flag],
        );
      }
    }
  });
});

describe("标志是显式写出来的,不靠推断(ADR-0023 红线)", () => {
  it("每个注册行四个标志齐备,都是自己的布尔键", () => {
    for (const [name, row] of Object.entries(ACTION_REGISTRY)) {
      for (const flag of FLAGS) {
        expect(
          Object.prototype.hasOwnProperty.call(row, flag),
          `${name} 缺 ${flag}(闸归类必须显式写,不推断)`,
        ).toBe(true);
        expect(typeof (row as Record<string, unknown>)[flag], `${name}.${flag}`).toBe("boolean");
      }
    }
  });

  it("闸各归各的:总开关那行不进退避闸,chat.switch 进退避不进代你发言", () => {
    // toggle.set 不在退避闸:target 恒为 null,压根走不到探针那一步.
    expect(BACKOFF_GATED_ACTIONS.has("toggle.set")).toBe(false);
    // chat.switch 在退避闸,却不进代你发言闸(不动写作框).
    expect(BACKOFF_GATED_ACTIONS.has("chat.switch")).toBe(true);
    expect(SPEAK_GATED_ACTIONS.has("chat.switch")).toBe(false);
  });
});

describe("target 形态与 fixture / 探针 docstring 的知识对得上", () => {
  it("fixture 里每个认得的动作,target 与注册表一行不差", () => {
    for (const c of fixtureCases<ActionCase>("action.json")) {
      const row = ACTION_REGISTRY[c.request.action];
      if (row === undefined) continue; // 认不出的动作(unknown-action 样例)归档子管,不归注册表管
      const wantsNull = c.request.target === null;
      expect(
        row.target === "null",
        `${c.name}:fixture target=${JSON.stringify(c.request.target)},注册表 target=${row.target}`,
      ).toBe(wantsNull);
    }
  });

  it("探针文件头那句『target: null 只有 …答得出』= 注册表里 target 恒为 null 的行", () => {
    const probe = PROBE_SOURCES["../../scripts/page-action.py"];
    expect(probe, "读不到 scripts/page-action.py").toBeDefined();
    const sentence = probe?.match(/`target: null` 只有([^答]*?)答得出/);
    expect(sentence, "page-action.py 文件头丢了 target: null 那条知识").not.toBeNull();
    const tokens = [...(sentence?.[1] ?? "").matchAll(/`([^`]+)`/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(tokens.length).toBeGreaterThan(0);
    const named = new Set<string>();
    for (const token of tokens) {
      if (token.endsWith(".*")) {
        const prefix = token.slice(0, -1); // "toggle.*" → "toggle."
        for (const name of Object.keys(ACTION_REGISTRY)) {
          if (name.startsWith(prefix)) named.add(name);
        }
      } else {
        named.add(token);
      }
    }
    const local = Object.entries(ACTION_REGISTRY)
      .filter(([, row]) => row.target === "null")
      .map(([name]) => name);
    expect([...named].sort()).toEqual([...local].sort());
  });

  it("探针的 TARGET_NULL_ACTIONS 名单 = 注册表里 target 恒为 null 的行", () => {
    const probe = PROBE_SOURCES["../../scripts/page-action.py"];
    const block = probe?.match(/TARGET_NULL_ACTIONS = frozenset\(([\s\S]*?)\)\n/);
    expect(block, "page-action.py 丢了 TARGET_NULL_ACTIONS 名单").not.toBeNull();
    const names = [...(block?.[1] ?? "").matchAll(/"([a-z.]+)"/g)]
      .flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
      .sort();
    const local = Object.entries(ACTION_REGISTRY)
      .filter(([, row]) => row.target === "null")
      .map(([name]) => name)
      .sort();
    expect(names).toEqual(local);
  });
});
