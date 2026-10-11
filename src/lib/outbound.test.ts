import { describe, expect, it, vi } from "vitest";

import {
  drawWindowInterval,
  isWindowDue,
  newOutboundWindow,
  stepOutboundWindow,
  WINDOW_MAX_MS,
  WINDOW_MIN_MS,
} from "./outbound";

const fixedRandom = (value: number) => () => value;

describe("drawWindowInterval", () => {
  it("随机数 0 与 1 分别落在 3 秒与 5 秒", () => {
    expect(drawWindowInterval(fixedRandom(0))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(1))).toBe(5000);
  });

  it("中间值线性映射", () => {
    expect(drawWindowInterval(fixedRandom(0.5))).toBe(4000);
  });

  it("越界的随机数夹进 3~5 秒", () => {
    expect(drawWindowInterval(fixedRandom(-1))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(2))).toBe(5000);
  });

  it("非有限的随机数按最小间隔处理", () => {
    expect(drawWindowInterval(fixedRandom(Number.NaN))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(Number.POSITIVE_INFINITY))).toBe(3000);
  });

  it("任取随机数抽到的间隔都在 3~5 秒内(ADR-0002)", () => {
    for (let i = 0; i <= 100; i += 1) {
      const interval = drawWindowInterval(fixedRandom(i / 100));
      expect(interval).toBeGreaterThanOrEqual(WINDOW_MIN_MS);
      expect(interval).toBeLessThanOrEqual(WINDOW_MAX_MS);
    }
  });
});

describe("isWindowDue", () => {
  it("还没开过窗时首窗即开", () => {
    expect(isWindowDue(newOutboundWindow(), 0)).toBe(true);
  });

  it("开窗后在间隔之内不算到点", () => {
    const first = stepOutboundWindow(newOutboundWindow(), 1000, fixedRandom(1));
    expect(first.opened).toBe(true);
    expect(isWindowDue(first.window, 1000 + 4999)).toBe(false);
    expect(isWindowDue(first.window, 1000 + 5000)).toBe(true);
  });

  it("时钟倒退不算到点", () => {
    const first = stepOutboundWindow(newOutboundWindow(), 1000, fixedRandom(1));
    expect(isWindowDue(first.window, 0)).toBe(false);
  });
});

describe("stepOutboundWindow", () => {
  it("开窗时盖下注入的时刻并抽下一个间隔", () => {
    const step = stepOutboundWindow(newOutboundWindow(), 1234, fixedRandom(0));
    expect(step).toEqual({ window: { openedAt: 1234, intervalMs: 3000 }, opened: true });
  });

  it("没到点时窗口原样不动", () => {
    const opened = stepOutboundWindow(newOutboundWindow(), 1234, fixedRandom(1));
    const stepped = stepOutboundWindow(opened.window, 1234 + 4999, fixedRandom(1));
    expect(stepped.opened).toBe(false);
    expect(stepped.window).toBe(opened.window);
  });

  it("没到点时不消耗随机源", () => {
    const random = vi.fn(() => 0.5);
    const opened = stepOutboundWindow(newOutboundWindow(), 1234, random);
    random.mockClear();
    stepOutboundWindow(opened.window, 1235, random);
    expect(random).not.toHaveBeenCalled();
  });

  it("窗口之间连着推进也不会连发,直到间隔走完", () => {
    const random = vi.fn(() => 0);
    let window = newOutboundWindow();
    let opens = 0;

    for (let now = 0; now <= 9000; now += 1000) {
      const step = stepOutboundWindow(window, now, random);
      window = step.window;
      if (step.opened) opens += 1;
    }

    // t=0 开首窗,3000ms 间隔:0s 开,3s 开,6s 开,9s 恰好等到边界.
    expect(opens).toBe(4);
    expect(window).toEqual({ openedAt: 9000, intervalMs: 3000 });
  });
});
