import { describe, expect, it } from "vitest";

import { backoffMs, gateBackoff, parseMuteUntil, readBackoff } from "./backoff";

const MINUTE = 60_000;

describe("backoffMs:阶梯时长", () => {
  it("第一回 10 分钟,每回乘 2,封顶 8 小时", () => {
    expect(backoffMs(1)).toBe(10 * MINUTE);
    expect(backoffMs(2)).toBe(20 * MINUTE);
    expect(backoffMs(3)).toBe(40 * MINUTE);
    expect(backoffMs(6)).toBe(320 * MINUTE);
    expect(backoffMs(7)).toBe(8 * 60 * MINUTE);
    expect(backoffMs(20)).toBe(8 * 60 * MINUTE); // 封顶
    expect(backoffMs(0)).toBe(10 * MINUTE); // 兜底,不炸
  });
});

describe("parseMuteUntil:站点写的解封时刻", () => {
  it('认"2026 年 10 月 10 日 20:21"这种纯文本', () => {
    const ms = parseMuteUntil("2026 年 10 月 10 日 20:21");
    expect(ms).not.toBeNull();
    // 本地时区拼出来的同一个时刻
    expect(ms).toBe(new Date(2026, 9, 10, 20, 21).getTime());
  });

  it("句子里的时刻也能抠(处罚句整段喂进去)", () => {
    expect(
      parseMuteUntil(
        "由于违反用户使用规范,你的账号已被禁言至 2026 年 10 月 10 日 20:21,如有疑问请",
      ),
    ).toBe(new Date(2026, 9, 10, 20, 21).getTime());
  });

  it("认不出回 null(不猜)", () => {
    expect(parseMuteUntil("")).toBeNull();
    expect(parseMuteUntil("另行通知")).toBeNull();
    expect(parseMuteUntil("2026-10-10 20:21")).toBeNull(); // 不是站点写的格式
  });
});

describe("readBackoff:持久状态", () => {
  it("读出 until 与 round", () => {
    expect(readBackoff({ until: 123, round: 2 })).toEqual({ until: 123, round: 2 });
  });

  it("认不出就当从没退避过", () => {
    expect(readBackoff(undefined)).toEqual({ until: null, round: 0 });
    expect(readBackoff("junk")).toEqual({ until: null, round: 0 });
    expect(readBackoff({ until: "x", round: 2 })).toEqual({ until: null, round: 0 });
    expect(readBackoff({ until: 5, round: -3 })).toEqual({ until: 5, round: 0 });
  });
});

describe("gateBackoff:三态迁移", () => {
  const NOW = 1_800_000_000_000;
  const MUTED_WITH_UNTIL = { kind: "muted", until: "2099 年 1 月 1 日 00:00" } as const;
  const MUTED_NO_UNTIL = { kind: "muted", until: null } as const;

  it("退避/长休没到期:拦下,状态原样(不把终点越推越远)", () => {
    const state = { until: NOW + 60_000, round: 3 };
    // 账号即使 ready(探针读的),时间锁还在--退避是时间锁不是状态锁.
    expect(gateBackoff(state, { kind: "ready" }, NOW)).toEqual({
      proceed: false,
      next: state,
    });
    expect(gateBackoff(state, MUTED_WITH_UNTIL, NOW)).toEqual({
      proceed: false,
      next: state,
    });
  });

  it("禁言且站点写了解封时刻:长休到它为止,回次不动", () => {
    const verdict = gateBackoff({ until: null, round: 1 }, MUTED_WITH_UNTIL, NOW);
    expect(verdict.proceed).toBe(false);
    expect(verdict.next.until).toBe(new Date(2099, 0, 1, 0, 0).getTime());
    expect(verdict.next.round).toBe(1);
  });

  it("禁言但站点没写时刻:按退避走阶梯,回次 +1", () => {
    const verdict = gateBackoff({ until: null, round: 0 }, MUTED_NO_UNTIL, NOW);
    expect(verdict.proceed).toBe(false);
    expect(verdict.next.until).toBe(NOW + 10 * MINUTE);
    expect(verdict.next.round).toBe(1);

    const again = gateBackoff({ until: null, round: 1 }, MUTED_NO_UNTIL, NOW);
    expect(again.next.until).toBe(NOW + 20 * MINUTE);
    expect(again.next.round).toBe(2);
  });

  it("到期且账号正常:放行,清终点,回次留着", () => {
    const verdict = gateBackoff({ until: NOW - 1, round: 2 }, { kind: "ready" }, NOW);
    expect(verdict).toEqual({ proceed: true, next: { until: null, round: 2 } });
  });

  it("从没退避过且账号正常:放行", () => {
    expect(gateBackoff({ until: null, round: 0 }, { kind: "ready" }, NOW)).toEqual({
      proceed: true,
      next: { until: null, round: 0 },
    });
  });

  it("未登录 / 认不出:不猜,不拦", () => {
    expect(gateBackoff({ until: null, round: 0 }, { kind: "signed-out" }, NOW).proceed).toBe(true);
    expect(gateBackoff({ until: null, round: 0 }, { kind: "unknown" }, NOW).proceed).toBe(true);
  });

  it("到期但账号还在处罚区(时刻认不出):重新进退避,阶梯继续", () => {
    // 退避到期了,可页面还禁言,时刻抠不出--新进一回.
    const verdict = gateBackoff({ until: NOW - 1, round: 1 }, MUTED_NO_UNTIL, NOW);
    expect(verdict.proceed).toBe(false);
    expect(verdict.next.round).toBe(2);
    expect(verdict.next.until).toBe(NOW + 20 * MINUTE);
  });
});
