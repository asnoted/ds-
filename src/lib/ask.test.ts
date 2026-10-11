import { describe, expect, it } from "vitest";

import {
  ASK_BADGE_TEXT,
  clearPendingAsk,
  describePendingAsks,
  hasPendingAsk,
  readPendingAsks,
  recordPendingAsk,
  type PendingAsks,
} from "./ask";

const AT = 1_700_000_000_000;

describe("recordPendingAsk", () => {
  it("挂一笔:空表变一条", () => {
    const asks = recordPendingAsk({}, "sid-1", "选 A 还是 B?", AT);
    expect(asks).toEqual({ "sid-1": { question: "选 A 还是 B?", at: AT } });
    expect(hasPendingAsk(asks)).toBe(true);
  });

  it("null 页面会话以空串为键", () => {
    const asks = recordPendingAsk({}, null, "拍个板", AT);
    expect(asks).toEqual({ "": { question: "拍个板", at: AT } });
  });

  it("同一会话再问换成最新这笔", () => {
    const once = recordPendingAsk({}, "sid-1", "旧的", AT);
    const twice = recordPendingAsk(once, "sid-1", "新的", AT + 1);
    expect(Object.keys(twice)).toEqual(["sid-1"]);
    expect(twice["sid-1"]?.question).toBe("新的");
  });

  it("不同会话各挂各的", () => {
    const asks = recordPendingAsk(recordPendingAsk({}, "sid-1", "甲", AT), "sid-2", "乙", AT + 1);
    expect(Object.keys(asks).sort()).toEqual(["sid-1", "sid-2"]);
  });

  it("重复上报(同问同时)原样返回,免一次写", () => {
    const once = recordPendingAsk({}, "sid-1", "问题", AT);
    expect(recordPendingAsk(once, "sid-1", "问题", AT)).toBe(once);
  });
});

describe("clearPendingAsk", () => {
  it("清一笔:表空了", () => {
    const once = recordPendingAsk({}, "sid-1", "问题", AT);
    expect(clearPendingAsk(once, "sid-1")).toEqual({});
    expect(hasPendingAsk(clearPendingAsk(once, "sid-1"))).toBe(false);
  });

  it("清别的会话不动这笔", () => {
    const once = recordPendingAsk({}, "sid-1", "问题", AT);
    expect(clearPendingAsk(once, "sid-2")).toBe(once);
  });

  it("没挂过也不报错,原样返回", () => {
    expect(clearPendingAsk({}, "sid-1")).toEqual({});
  });
});

describe("readPendingAsks", () => {
  it("缺省与坏输入 → 空表", () => {
    expect(readPendingAsks(undefined)).toEqual({});
    expect(readPendingAsks("nope")).toEqual({});
    expect(readPendingAsks([])).toEqual({});
  });

  it("合法的都在,形状不对的一条条丢", () => {
    const raw = {
      "sid-1": { question: "甲", at: AT },
      "sid-2": { question: "", at: AT },
      "sid-3": { question: "丙", at: "不是数" },
      "sid-4": "整条不是对象",
    };
    expect(readPendingAsks(raw)).toEqual({
      "sid-1": { question: "甲", at: AT },
    });
  });

  it("记过再读回来,分表原样", () => {
    const once = recordPendingAsk(recordPendingAsk({}, "sid-1", "甲", AT), "sid-2", "乙", AT + 1);
    expect(readPendingAsks(once)).toEqual(once);
  });
});

describe("describePendingAsks", () => {
  it("空表返回 null", () => {
    expect(describePendingAsks({})).toBeNull();
  });

  it("一条:直接摆问题", () => {
    const asks: PendingAsks = { "sid-1": { question: "选 A 还是 B?", at: AT } };
    expect(describePendingAsks(asks)).toBe("网页在等人回:选 A 还是 B?");
  });

  it("多条:摆条数与最新那条", () => {
    const asks: PendingAsks = {
      "sid-1": { question: "旧的", at: AT },
      "sid-2": { question: "新的", at: AT + 1 },
    };
    expect(describePendingAsks(asks)).toBe("网页在等人回(2 条):新的");
  });

  it("问长了裁掉", () => {
    const long = "x".repeat(80);
    const asks: PendingAsks = { "sid-1": { question: long, at: AT } };
    expect(describePendingAsks(asks)).toBe(`网页在等人回:${"x".repeat(60)}...`);
  });

  it('角标字是"人"', () => {
    expect(ASK_BADGE_TEXT).toBe("人");
  });
});
