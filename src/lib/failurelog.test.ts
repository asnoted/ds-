import { describe, expect, it } from "vitest";

import { describeContinuationFailure } from "./continuationfail";
import {
  FAILURE_LOG_CAP,
  describeLastFailure,
  formatAgo,
  formatClock,
  formatDuration,
  markLastFailureRecovered,
  readFailureLog,
  rememberFailure,
  type FailureRecord,
} from "./failurelog";

/** 一个本地时刻,免得测试结果跟着跑机器的时区漂. */
function localTime(hours: number, minutes: number, seconds: number): number {
  return new Date(2026, 8, 30, hours, minutes, seconds).getTime();
}

const healthFailure = (at: number, cause = "超时(5000ms 没回)"): FailureRecord => ({
  at,
  where: "health",
  cause,
});

describe("readFailureLog / 存储是外部输入", () => {
  it("不是数组就当没有历史", () => {
    expect(readFailureLog(undefined)).toEqual([]);
    expect(readFailureLog("上次红过")).toEqual([]);
    expect(readFailureLog({ at: 1 })).toEqual([]);
  });

  it("续聊环节能读回(#51 新加的环节在判据与标签表里都对齐)", () => {
    expect(readFailureLog([{ at: 1, where: "continuation", cause: "没找到输入框" }])).toEqual([
      { at: 1, where: "continuation", cause: "没找到输入框" },
    ]);
  });

  it("续聊失败落进册子:原因短句原样进 where/cause,悬停答得出断在哪一步", () => {
    // #51 的验收主链:上报(页面世界)→ background 落痕 → 悬停回看.这里钉住"落痕 +
    // 回看"这一段;上报的收发各有 parse 的单测在 channel.test.ts.
    const at = localTime(14, 49, 36);
    const cause = describeContinuationFailure("composer-absent");
    const log = rememberFailure([], { at, where: "continuation", cause });
    const shown = describeLastFailure(log, at + 120_000);
    expect(shown).toContain("续聊");
    expect(shown).toContain(cause);
    expect(readFailureLog(log)).toHaveLength(1);
  });

  it('续聊连续失败不把配额刷满(沿用"同一次故障只记一笔",续聊不开后门)', () => {
    const first = rememberFailure([], { at: 1, where: "continuation", cause: "没找到输入框" });
    // 故障还没恢复 → 后续每一次都不另记
    const second = rememberFailure(first, { at: 2, where: "continuation", cause: "没找到输入框" });
    expect(second).toBe(first);
    expect(readFailureLog(second)).toHaveLength(1);
  });

  it("长得不对的一条条丢掉,不猜也不补", () => {
    const records = readFailureLog([
      healthFailure(1),
      { ...healthFailure(2), where: "天上" }, // 环节不在册
      { ...healthFailure(3), cause: "" }, // 空原因
      { ...healthFailure(4), at: "昨天" }, // 时刻不是数字
      { ...healthFailure(5), recoveredAt: "现在" }, // 恢复时刻坏了
      healthFailure(6),
    ]);
    expect(records).toEqual([healthFailure(1), healthFailure(6)]);
  });

  it("恢复时刻在场就整条留下,不在场也不硬造一个", () => {
    const recovered = { ...healthFailure(1), recoveredAt: 9 };
    expect(readFailureLog([recovered])).toEqual([recovered]);
    expect(readFailureLog([healthFailure(1)])[0]?.recoveredAt).toBeUndefined();
  });

  it("配额之外的截掉,免得把 storage 撑大", () => {
    const raw = Array.from({ length: FAILURE_LOG_CAP + 5 }, (_, i) => healthFailure(i));
    expect(readFailureLog(raw)).toHaveLength(FAILURE_LOG_CAP);
  });
});

describe("rememberFailure / 记一笔", () => {
  it("新的在最前--上一笔已经恢复了,这次才是一条新的", () => {
    let records = rememberFailure([], healthFailure(1));
    records = markLastFailureRecovered(records, 2);
    records = rememberFailure(records, healthFailure(3));
    expect(records.map((record) => record.at)).toEqual([3, 1]);
  });

  it("同一次故障只记一笔:还没恢复就挡住,哪怕环节和原因都换了", () => {
    const ongoing = [healthFailure(1, "连接失败")];
    expect(rememberFailure(ongoing, healthFailure(2))).toBe(ongoing);
    expect(rememberFailure(ongoing, { at: 3, where: "call", cause: "超时" })).toBe(ongoing);
  });

  it("恢复过之后,下一次是新的一笔", () => {
    const recovered = markLastFailureRecovered([healthFailure(1)], 5);
    expect(rememberFailure(recovered, healthFailure(9))).not.toBe(recovered);
  });

  it("一次断连刷不出二十条配额", () => {
    let records: FailureRecord[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      records = rememberFailure(records, healthFailure(attempt, "连接失败"));
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.at).toBe(0);
  });
});

describe("markLastFailureRecovered / 收尾", () => {
  it("只给最前面那笔补恢复时刻", () => {
    const records = markLastFailureRecovered([healthFailure(1), healthFailure(2)], 41);
    expect(records[0]).toEqual({ ...healthFailure(1), recoveredAt: 41 });
    expect(records[1]).toEqual(healthFailure(2));
  });

  it("本来就没故障,或已经恢复过:原样返回同一个数组,省掉一次存储写", () => {
    expect(markLastFailureRecovered([], 1)).toEqual([]);
    const recovered = markLastFailureRecovered([healthFailure(1)], 41);
    expect(markLastFailureRecovered(recovered, 99)).toBe(recovered);
  });
});

describe("时间文案", () => {
  it("时刻读成本地的几点几分几秒", () => {
    expect(formatClock(localTime(14, 49, 36))).toBe("14:49:36");
    expect(formatClock(localTime(7, 3, 5))).toBe("07:03:05");
  });

  it("离现在多久:秒 / 分钟 / 小时各报各的", () => {
    const now = localTime(14, 0, 0);
    expect(formatAgo(now - 12_000, now)).toBe("12 秒前");
    expect(formatAgo(now - 120_000, now)).toBe("2 分钟前");
    expect(formatAgo(now - 7_200_000, now)).toBe("2 小时前");
    expect(formatAgo(now + 5_000, now)).toBe("0 秒前"); // 时钟拨快了也别报负数
  });

  it("持续多久:不足一分钟报秒,再往上报分钟", () => {
    expect(formatDuration(0)).toBe("1 秒");
    expect(formatDuration(30_000)).toBe("30 秒");
    expect(formatDuration(240_000)).toBe("4 分钟");
  });
});

describe("describeLastFailure / 一句里答得出三件事", () => {
  const now = localTime(14, 51, 36);

  it("几点红的,为什么红的,多久自己绿的", () => {
    const at = localTime(14, 49, 36);
    const record = { ...healthFailure(at, "超时(5000ms 没回)"), recoveredAt: at + 30_000 };
    const line = describeLastFailure([record], now);
    expect(line).toContain("上次故障 14:49:36");
    expect(line).toContain("2 分钟前");
    expect(line).toContain("周期探活");
    expect(line).toContain("超时(5000ms 没回)");
    expect(line).toContain("30 秒后恢复");
  });

  it("还没恢复就说还没恢复,别替它报喜", () => {
    expect(describeLastFailure([healthFailure(localTime(14, 51, 30))], now)).toContain("还没恢复");
  });

  it("每个环节各有各的说法--排查方向不一样", () => {
    const at = localTime(14, 49, 36);
    const where = (record: FailureRecord) => describeLastFailure([record], now);
    expect(where({ at, where: "health", cause: "x" })).toContain("周期探活");
    expect(where({ at, where: "call", cause: "x" })).toContain("工具调用");
    expect(where({ at, where: "watchdog", cause: "x" })).toContain("看门狗");
    expect(where({ at, where: "rounds", cause: "x" })).toContain("续聊刹车");
    expect(where({ at, where: "continuation", cause: "没找到输入框" })).toContain("续聊");
  });

  it("册子外的环节名不进记录(免得悬停印出 undefined)", () => {
    expect(readFailureLog([{ at: 1, where: "status", cause: "x" }])).toEqual([]);
    expect(readFailureLog([{ at: 1, where: "send", cause: "x" }])).toEqual([]);
  });

  it("一次都没红过就没有这句", () => {
    expect(describeLastFailure([], now)).toBeNull();
  });
});
