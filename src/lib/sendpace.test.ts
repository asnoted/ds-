import { describe, expect, it } from "vitest";

import {
  checkSend,
  checkSendIntent,
  mergeSendPace,
  newSendPace,
  noteSend,
  runPaced,
  sendWaitMs,
  SEND_PRIMITIVES,
  type SendIntent,
  type SendPace,
} from "./sendpace";
import { WINDOW_MAX_MS, WINDOW_MIN_MS } from "./outbound";

const random0 = () => 0;
const random1 = () => 1;

describe("发送限速的间隔与出站窗口同区间(#61)", () => {
  it("抽出来的间隔落在 3~15 秒(沿用 outbound 的常量,峰在 6 秒)", () => {
    const low = noteSend(newSendPace(), 0, random0);
    const high = noteSend(newSendPace(), 0, random1);
    expect(low.intervalMs).toBe(WINDOW_MIN_MS);
    expect(high.intervalMs).toBe(WINDOW_MAX_MS);
  });
});

describe("sendWaitMs / 还要等多久", () => {
  it("没发过:不等", () => {
    expect(sendWaitMs(newSendPace(), 999_999)).toBe(0);
  });

  it("刚发完:要等满整个间隔", () => {
    const pace = noteSend(newSendPace(), 1000, random0);
    expect(sendWaitMs(pace, 1000)).toBe(WINDOW_MIN_MS);
  });

  it("隔了一半:等剩下那一半", () => {
    const pace = noteSend(newSendPace(), 1000, random0);
    expect(sendWaitMs(pace, 1000 + 1000)).toBe(WINDOW_MIN_MS - 1000);
  });

  it("隔够了:不等", () => {
    const pace = noteSend(newSendPace(), 1000, random0);
    expect(sendWaitMs(pace, 1000 + WINDOW_MIN_MS)).toBe(0);
    expect(sendWaitMs(pace, 1000 + WINDOW_MIN_MS + 1)).toBe(0);
  });

  it("时钟回拨(now < lastSentAt)不当负数:宁可少限一次", () => {
    const pace: SendPace = { lastSentAt: 10_000, intervalMs: 3000 };
    expect(sendWaitMs(pace, 5000)).toBe(0);
  });
});

describe("checkSend / 发送原语检查点", () => {
  it("确定是发送:参与限速,给出要等多久", () => {
    const pace = noteSend(newSendPace(), 1000, random0);
    const verdict = checkSend(pace, 1000, true);
    expect(verdict.paced).toBe(true);
    expect(verdict.waitMs).toBe(WINDOW_MIN_MS);
  });

  it('判不出是不是发送(可能是"停止"):不参与限速,一律放行', () => {
    const pace = noteSend(newSendPace(), 1000, random0);
    const verdict = checkSend(pace, 1000, false);
    expect(verdict.paced).toBe(false);
    expect(verdict.waitMs).toBe(0);
  });

  it("没有待发的:paced 仍为 true 但不等(口径一致,由记账与否决定)", () => {
    const verdict = checkSend(newSendPace(), 0, true);
    expect(verdict.paced).toBe(true);
    expect(verdict.waitMs).toBe(0);
  });
});

describe("checkSendIntent / 三种意图各自的口径", () => {
  const pace = noteSend(newSendPace(), 1000, random0);

  it("send:等够 + 记账", () => {
    expect(checkSendIntent(pace, 1000, "send")).toEqual({
      waitMs: WINDOW_MIN_MS,
      paced: true,
      record: true,
    });
  });

  it('stop:不等 + 不记("停止"永不延迟)', () => {
    expect(checkSendIntent(pace, 1000, "stop")).toEqual({
      waitMs: 0,
      paced: false,
      record: false,
    });
  });

  it("unknown:不等但记账(宁可之后多等一次,也不漏记一次发送)", () => {
    expect(checkSendIntent(pace, 1000, "unknown")).toEqual({
      waitMs: 0,
      paced: false,
      record: true,
    });
  });

  it("checkSend 是 checkSendIntent 的两口味薄封装", () => {
    expect(checkSend(pace, 1000, true)).toEqual(checkSendIntent(pace, 1000, "send"));
    expect(checkSend(pace, 1000, false)).toEqual(checkSendIntent(pace, 1000, "unknown"));
  });
});

describe("mergeSendPace / 跨世界并时刻", () => {
  it("对方报来更晚的时刻:取它的", () => {
    const mine = noteSend(newSendPace(), 1000, random0);
    const merged = mergeSendPace(mine, 5000, random0);
    expect(merged.lastSentAt).toBe(5000);
  });

  it("本地还没发过:也要抽一个间隔,下一发送不能立刻放行", () => {
    const merged = mergeSendPace(newSendPace(), 5000, random0);
    expect(merged.intervalMs).toBe(WINDOW_MIN_MS);
    expect(sendWaitMs(merged, 5000)).toBe(WINDOW_MIN_MS);
  });

  it("我自己的更晚:不覆盖(否则紧接着那一下会少等)", () => {
    const mine = noteSend(newSendPace(), 5000, random0);
    expect(mergeSendPace(mine, 1000, random0)).toBe(mine);
  });

  it("对方没发过(null):原样", () => {
    const mine = newSendPace();
    expect(mergeSendPace(mine, null, random0)).toBe(mine);
  });

  it("对方的通报不覆盖我抽的间隔(各抽各的)", () => {
    const mine = noteSend(newSendPace(), 1000, random1);
    const merged = mergeSendPace(mine, 2000, random0);
    expect(merged.intervalMs).toBe(mine.intervalMs);
  });
});

describe("runPaced / 过检查点的完整时序(#61 的 AC)", () => {
  /**
   * 假时钟:`sleep` 推进时间,累计真实经过的毫秒.
   * 于是"两次发送实际相隔 ≥3 秒"能被**断言**,而不只是"判定算对了".
   */
  function fakeClock(start = 0) {
    let at = start;
    let slept = 0;
    return {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
        slept += ms;
      },
      advance: (ms: number) => {
        at += ms;
      },
      get slept() {
        return slept;
      },
    };
  }

  const run = (clock: ReturnType<typeof fakeClock>, pace: SendPace) =>
    runPaced({
      pace: () => pace,
      readIntent: () => "send",
      execute: () => undefined,
      shouldRecord: () => true,
      now: clock.now,
      random: random0,
      sleep: clock.sleep,
    });

  it("没发过时不等:第一次发送立刻执行", async () => {
    const clock = fakeClock();
    const first = await run(clock, newSendPace());
    expect(first.waitedMs).toBe(0);
    expect(clock.slept).toBe(0);
    expect(first.pace.lastSentAt).toBe(0);
  });

  it("连续两次发送:第二次要等够整个间隔,两次**实际相隔 ≥3 秒**(AC)", async () => {
    const clock = fakeClock();
    const first = await run(clock, newSendPace());
    // 隔 1 秒就发第二次--不够,得等剩下的
    clock.advance(1000);
    const second = await run(clock, first.pace);
    expect(second.waitedMs).toBe(WINDOW_MIN_MS - 1000);
    // 两次发送动作之间真实流逝:1 秒(外部)+ 2 秒(等出来的)= 3 秒整
    expect(clock.slept).toBe(WINDOW_MIN_MS - 1000);
    expect(1000 + clock.slept).toBeGreaterThanOrEqual(WINDOW_MIN_MS);
  });

  it('连发三次:每一趟都只等"距上一次还差的那一点",总时长符合窗口', async () => {
    const clock = fakeClock();
    let pace = newSendPace();
    const gaps: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) clock.advance(500); // 每次只隔 0.5 秒
      const step = await run(clock, pace);
      if (i > 0) gaps.push(step.waitedMs);
      pace = step.pace;
    }
    // 每次都补足到 WINDOW_MIN_MS:等 2.5 秒(3s - 0.5s)
    expect(gaps).toEqual([WINDOW_MIN_MS - 500, WINDOW_MIN_MS - 500]);
    expect(clock.slept).toBe(2 * (WINDOW_MIN_MS - 500));
  });

  it("间隔够时不等(不无谓地拖慢人)", async () => {
    const clock = fakeClock();
    const first = await run(clock, newSendPace());
    clock.advance(WINDOW_MIN_MS + 10);
    const second = await run(clock, first.pace);
    expect(second.waitedMs).toBe(0);
    expect(clock.slept).toBe(0);
  });

  it("等的时候另一侧报来更晚的时刻:按新的再等一段,不掉出合并后的线", async () => {
    const clock = fakeClock();
    const first = await run(clock, newSendPace()); // t=0 发, 间隔 3s
    clock.advance(1000); // t=1s, 还差 2s
    let pace = first.pace;
    const result = await runPaced({
      pace: () => pace,
      readIntent: () => "send",
      execute: () => undefined,
      shouldRecord: () => true,
      now: clock.now,
      random: random0,
      sleep: async (ms) => {
        await clock.sleep(ms);
        // 第一段等待里另一侧在 t=2.5s 也发了一条:合并后到期时刻变成 5.5s
        pace = mergeSendPace(pace, 2500, random0);
      },
    });
    expect(result.waitedMs).toBe(WINDOW_MIN_MS - 1000 + (WINDOW_MIN_MS - 500));
    expect(result.pace.lastSentAt).toBe(5500);
  });

  it('"停止"永不延迟:等 0,不记账(delay 一趟都不等)', async () => {
    const clock = fakeClock(1000);
    const pace = noteSend(newSendPace(), 1000, random0);
    const result = await runPaced({
      pace: () => pace,
      readIntent: () => "stop",
      execute: () => undefined,
      shouldRecord: () => false,
      now: clock.now,
      random: random0,
      sleep: clock.sleep,
    });
    expect(result.waitedMs).toBe(0);
    expect(clock.slept).toBe(0);
  });

  it('圆键:等之前是"发送",等的时候变成"停止"→ 不记账', async () => {
    const clock = fakeClock();
    let intent: SendIntent = "send";
    const pace = noteSend(newSendPace(), clock.now(), random0);
    clock.advance(10);
    const result = await runPaced({
      pace: () => pace,
      readIntent: () => intent,
      execute: () => undefined,
      shouldRecord: (_result, atAction) => atAction !== "stop",
      now: clock.now,
      random: random0,
      sleep: async (ms) => {
        await clock.sleep(ms);
        intent = "stop"; // 等的时候站点进生成期,圆键变成停止
      },
    });
    expect(result.waitedMs).toBeGreaterThan(0); // 等之前读到的是发送,照限速等
    expect(result.pace).toBe(pace); // 动手前重读是停止 → 不记账
  });

  it("圆键:动手前是发送,点下去才翻成停止 → 照记账", async () => {
    const clock = fakeClock();
    let intent: SendIntent = "send";
    const pace = noteSend(newSendPace(), clock.now(), random0);
    clock.advance(10);
    let atAction: SendIntent | undefined;
    const result = await runPaced({
      pace: () => pace,
      readIntent: () => intent,
      execute: () => {
        intent = "stop"; // 发送成功,站点进生成期:翻成停止是点击的结果
        return undefined;
      },
      shouldRecord: (_result, read) => {
        atAction = read;
        return read !== "stop";
      },
      now: clock.now,
      random: random0,
      sleep: clock.sleep,
    });
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(atAction).toBe("send"); // 读到的是点击前的意图,不是点击后的图标
    expect(result.pace.lastSentAt).toBe(clock.now());
  });

  it("没真发出去的不记账(页面世界那条:sendToPage 返回 false)", async () => {
    const clock = fakeClock();
    const before = newSendPace();
    const result = await runPaced({
      pace: () => before,
      readIntent: () => "send",
      execute: () => ({ sent: false }),
      shouldRecord: (outcome) => outcome.sent,
      now: clock.now,
      random: random0,
      sleep: clock.sleep,
    });
    // 没记 → 同一个引用原样回来,lastSentAt 仍是 null(下次发送不受这次影响)
    expect(result.pace).toBe(before);
    expect(result.pace.lastSentAt).toBeNull();
  });

  it("动手是异步的:shouldRecord 拿到的是真结果,不是一个 Promise", async () => {
    const clock = fakeClock();
    const before = newSendPace();
    const result = await runPaced({
      pace: () => before,
      readIntent: () => "send",
      execute: async () => ({ sent: true }),
      shouldRecord: (outcome) => outcome.sent,
      now: clock.now,
      random: random0,
      sleep: clock.sleep,
    });
    expect(result.result).toEqual({ sent: true });
    expect(result.pace).not.toBe(before);
  });
});

describe("SEND_PRIMITIVES / 限速名单", () => {
  it("三种发送原语都在", () => {
    expect(SEND_PRIMITIVES.has("send.enter")).toBe(true);
    expect(SEND_PRIMITIVES.has("button.click")).toBe(true);
    expect(SEND_PRIMITIVES.has("message.retry")).toBe(true);
  });

  it('只往输入框写字的,以及"停止"都不在名单里', () => {
    expect(SEND_PRIMITIVES.has("composer.type")).toBe(false);
    expect(SEND_PRIMITIVES.has("composer.clear")).toBe(false);
  });
});
