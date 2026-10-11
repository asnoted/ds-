import { describe, expect, it, vi } from "vitest";

import { enqueue, newGate, nextOpenAt, release } from "./gate";
import { WINDOW_MAX_MS, WINDOW_MIN_MS } from "./outbound";

const fixedRandom = (value: number) => () => value;

describe("enqueue / 内容进队列", () => {
  it("第一次有内容等窗口时记下进队时刻并抽一个 3~5 秒的间隔", () => {
    const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(0));
    expect(gate.queue).toEqual(["回灌一条"]);
    expect(gate.window).toEqual({ openedAt: 1000, intervalMs: 3000 });
  });

  it("间隔随机但一定落在 3~5 秒(ADR-0002)", () => {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(random));
      expect(gate.window.intervalMs).toBeGreaterThanOrEqual(WINDOW_MIN_MS);
      expect(gate.window.intervalMs).toBeLessThanOrEqual(WINDOW_MAX_MS);
    }
  });

  it("已经有窗口在跑时,再进队不重抽间隔", () => {
    const first = enqueue(newGate(), "a", 1000, fixedRandom(0));
    const second = enqueue(first, "b", 1500, fixedRandom(1));
    expect(second.queue).toEqual(["a", "b"]);
    expect(second.window).toEqual(first.window);
  });

  it("刚建好的出站口什么都没排", () => {
    expect(newGate().queue).toEqual([]);
    expect(nextOpenAt(newGate())).toBeNull();
  });
});

describe("release / 唯一出站口开窗", () => {
  it("窗口没到点:不放行,队列原样,随机源不消耗", () => {
    const random = vi.fn(() => 0);
    const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(1));
    random.mockClear();

    const step = release(gate, 1000 + WINDOW_MAX_MS - 1, random);

    expect(step.released).toEqual([]);
    expect(step.gate).toBe(gate);
    expect(random).not.toHaveBeenCalled();
  });

  it("窗口到点:队列一次性放行,并抽下一个间隔", () => {
    const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(1));
    const step = release(gate, 1000 + WINDOW_MAX_MS, fixedRandom(0));

    expect(step.released).toEqual(["回灌一条"]);
    expect(step.gate.queue).toEqual([]);
    expect(step.gate.window).toEqual({ openedAt: 6000, intervalMs: 3000 });
  });

  it("队列里多条也一次性放行,窗口之间不再发", () => {
    let gate = enqueue(newGate(), "a", 1000, fixedRandom(1));
    gate = enqueue(gate, "b", 2000, fixedRandom(1));

    expect(release(gate, 5999, fixedRandom(0)).released).toEqual([]);
    expect(release(gate, 6000, fixedRandom(0)).released).toEqual(["a", "b"]);
  });

  it("首条回灌也要等满一个窗口才放行", () => {
    const gate = enqueue(newGate(), "回灌一条", 0, fixedRandom(1));

    expect(release(gate, WINDOW_MAX_MS - 1, fixedRandom(0)).released).toEqual([]);
    expect(release(gate, WINDOW_MAX_MS, fixedRandom(0)).released).toEqual(["回灌一条"]);
  });
});

describe("nextOpenAt / 排定时器用", () => {
  it("队列非空时给出下次开窗时刻", () => {
    const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(0.5));
    expect(nextOpenAt(gate)).toBe(5000);
  });

  it("放行完就没有要排的定时器", () => {
    const gate = enqueue(newGate(), "回灌一条", 1000, fixedRandom(0));
    const step = release(gate, 4000, fixedRandom(0));
    expect(nextOpenAt(step.gate)).toBeNull();
  });
});
