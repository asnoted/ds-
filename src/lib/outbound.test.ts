import { describe, expect, it, vi } from "vitest";

import {
  drawWindowInterval,
  isWindowDue,
  newOutboundWindow,
  stepOutboundWindow,
  WINDOW_MAX_MS,
  WINDOW_MIN_MS,
  WINDOW_MODE_MS,
} from "./outbound";
import { fixtureFile, type SendPaceFixtureFile } from "./fixtures";

const fixedRandom = (value: number) => () => value;

/** 可复现的伪随机源:统计口径要的是确定性,不是真随机. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("drawWindowInterval", () => {
  it("随机数 0 与 1 分别落在 3 秒与 15 秒", () => {
    expect(drawWindowInterval(fixedRandom(0))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(1))).toBe(15000);
  });

  it("抽样比率 1/4 = Beta(2,4) 的众数,落回区间正是 6 秒(ADR-0004)", () => {
    expect(drawWindowInterval(fixedRandom(0.25))).toBe(WINDOW_MODE_MS);
  });

  it("常数随机源下第 2 小就是它自己:线性映射到 3~15 秒", () => {
    expect(drawWindowInterval(fixedRandom(0.5))).toBe(9000);
  });

  it("越界的随机数夹进 3~15 秒", () => {
    expect(drawWindowInterval(fixedRandom(-1))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(2))).toBe(15000);
  });

  it("非有限的随机数按最小间隔处理", () => {
    expect(drawWindowInterval(fixedRandom(Number.NaN))).toBe(3000);
    expect(drawWindowInterval(fixedRandom(Number.POSITIVE_INFINITY))).toBe(3000);
  });

  it("任取随机数抽到的间隔都在 3~15 秒内(ADR-0004 的出站口与分布)", () => {
    for (let i = 0; i <= 100; i += 1) {
      const interval = drawWindowInterval(fixedRandom(i / 100));
      expect(interval).toBeGreaterThanOrEqual(WINDOW_MIN_MS);
      expect(interval).toBeLessThanOrEqual(WINDOW_MAX_MS);
    }
  });

  it("统计口径:脊背一路涨到 6 秒再落下,均值约 7 秒,长尾稀薄", () => {
    const random = mulberry32(2026_1015);
    const draws = 20_000;
    const bins = new Array<number>(12).fill(0); // 每格 1000ms,从 3000 起
    const bump = (bin: number) => {
      bins[bin] = (bins[bin] ?? 0) + 1;
    };
    const count = (bin: number) => bins[bin] ?? 0;
    let sum = 0;
    let belowMode = 0;
    let longPause = 0;
    for (let index = 0; index < draws; index += 1) {
      const ms = drawWindowInterval(random);
      expect(ms).toBeGreaterThanOrEqual(WINDOW_MIN_MS);
      expect(ms).toBeLessThanOrEqual(WINDOW_MAX_MS);
      sum += ms;
      if (ms < WINDOW_MODE_MS) belowMode += 1;
      if (ms >= 12_000) longPause += 1;
      bump(Math.min(Math.floor((ms - WINDOW_MIN_MS) / 1000), 11));
    }
    // 均值 = 3 + 12×(2/6) = 7 秒(众数 6 在均值左边,右偏出长尾).
    expect(sum / draws).toBeGreaterThan(6_800);
    expect(sum / draws).toBeLessThan(7_200);
    // 6 秒以下约 36.7%:峰右比峰左厚.
    expect(belowMode / draws).toBeGreaterThan(0.33);
    expect(belowMode / draws).toBeLessThan(0.41);
    // 12~15 秒的长尾有,但只占约 1.6%;紧贴两端的质量更小.
    expect(longPause / draws).toBeGreaterThan(0.005);
    expect(longPause / draws).toBeLessThan(0.03);
    // 单调脊背:一路涨到 6 秒那两格,再一路落下去(峰唯一).
    expect(count(0)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThan(count(2));
    expect(count(3)).toBeGreaterThan(count(4));
    expect(count(4)).toBeGreaterThan(count(5));
    expect(count(5)).toBeGreaterThan(count(6));
    expect(count(6)).toBeGreaterThan(count(7));
    // 最高的两格必须是紧贴 6 秒的那两格.
    const ranked = bins
      .map((n, bin) => ({ count: n, bin }))
      .sort((left, right) => right.count - left.count);
    expect(
      ranked
        .slice(0, 2)
        .map((entry) => entry.bin)
        .sort((left, right) => left - right),
    ).toEqual([2, 3]);
  });

  it("常量与固定随机源口径跟共享规格逐字对齐(send-pace.json,唯一限速)", () => {
    const spec = fixtureFile("send-pace.json") as SendPaceFixtureFile;
    expect(WINDOW_MIN_MS).toBe(spec.minMs);
    expect(WINDOW_MODE_MS).toBe(spec.modeMs);
    expect(WINDOW_MAX_MS).toBe(spec.maxMs);
    for (const { name, u, expectedMs } of spec.cases) {
      expect(drawWindowInterval(fixedRandom(u)), name).toBe(expectedMs);
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
    expect(isWindowDue(first.window, 1000 + WINDOW_MAX_MS - 1)).toBe(false);
    expect(isWindowDue(first.window, 1000 + WINDOW_MAX_MS)).toBe(true);
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
