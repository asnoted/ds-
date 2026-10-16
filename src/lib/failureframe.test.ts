import { describe, expect, it, vi } from "vitest";

import {
  FAILURE_FRAME_BUDGET_CHARS,
  FAILURE_FRAME_CAP,
  captureFailureFrame,
  frameForHead,
  pruneFailureFrames,
  readFailureFrames,
  rememberFailureFrame,
  type FailureFrame,
} from "./failureframe";

const jpeg = (payload = "AAAA"): string => `data:image/jpeg;base64,${payload}`;

const frame = (at: number, payload?: string): FailureFrame => ({ at, dataUrl: jpeg(payload) });

describe("readFailureFrames / 存储是外部输入", () => {
  it("不是数组就当没有", () => {
    expect(readFailureFrames(undefined)).toEqual([]);
    expect(readFailureFrames("上次那帧")).toEqual([]);
    expect(readFailureFrames({ at: 1 })).toEqual([]);
  });

  it("长得不对的一条条丢掉,不猜也不补", () => {
    const frames = readFailureFrames([
      frame(1),
      { at: 2, dataUrl: "https://example.com/帧" }, // 不是内嵌图
      { at: "昨天", dataUrl: jpeg() }, // 时刻不是数字
      { at: 3 }, // 缺 dataUrl
      frame(4),
    ]);
    expect(frames.map((item) => item.at)).toEqual([1, 4]);
  });

  it("配额之外的截掉", () => {
    const raw = Array.from({ length: FAILURE_FRAME_CAP + 3 }, (_, i) => frame(i));
    expect(readFailureFrames(raw)).toHaveLength(FAILURE_FRAME_CAP);
  });
});

describe("rememberFailureFrame / 滚动保留", () => {
  it("新的在最前,只留最近几帧", () => {
    let frames: FailureFrame[] = [];
    for (let at = 1; at <= FAILURE_FRAME_CAP + 2; at += 1) {
      frames = rememberFailureFrame(frames, frame(at));
    }
    expect(frames).toHaveLength(FAILURE_FRAME_CAP);
    expect(frames[0]?.at).toBe(FAILURE_FRAME_CAP + 2);
  });

  it("同一时刻只有一帧:重复的替换,不并排留两条", () => {
    const first = rememberFailureFrame([], frame(1, "old"));
    const second = rememberFailureFrame(first, frame(1, "new"));
    expect(second).toHaveLength(1);
    expect(second[0]?.dataUrl).toBe(jpeg("new"));
  });
});

describe("pruneFailureFrames / 帧随记录过期", () => {
  it("记录滚出册子的那些帧一并清掉", () => {
    const frames = [frame(1), frame(2), frame(3)];
    expect(pruneFailureFrames(frames, [{ at: 2 }, { at: 3 }]).map((item) => item.at)).toEqual([
      2, 3,
    ]);
  });

  it("一条没清就原样返回同一个数组,省掉一次存储写", () => {
    const frames = [frame(1)];
    expect(pruneFailureFrames(frames, [{ at: 1 }])).toBe(frames);
  });
});

describe("frameForHead / 配对", () => {
  it("对上最前面那笔才给", () => {
    const frames = [frame(7), frame(9)];
    expect(frameForHead(frames, [{ at: 9 }, { at: 7 }])?.at).toBe(9);
  });

  it("配不上就是 null--宁可没有,不能张冠李戴", () => {
    expect(frameForHead([frame(7)], [{ at: 9 }])).toBeNull();
    expect(frameForHead([frame(7)], [])).toBeNull();
  });
});

describe("captureFailureFrame / 抓帧失败绝不能影响原失败路径", () => {
  const budget = { budgetChars: FAILURE_FRAME_BUDGET_CHARS };

  it("抓得到就包成帧记录,时刻是失败那一刻", async () => {
    const captured = await captureFailureFrame(42, { capture: async () => jpeg(), ...budget });
    expect(captured).toEqual({ at: 42, dataUrl: jpeg() });
  });

  it("抓这一步抛错(权限、超时、标签页没了)→ null,不往上抛", async () => {
    const captured = await captureFailureFrame(42, {
      capture: async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      },
      ...budget,
    });
    expect(captured).toBeNull();
  });

  it("压缩那一步抛错也吞掉", async () => {
    const shrink = vi.fn(async () => {
      throw new Error("canvas 没了");
    });
    await expect(
      captureFailureFrame(42, { capture: async () => jpeg(), shrink, ...budget }),
    ).resolves.toBeNull();
  });

  it("压不进预算就丢帧留文字,不把超标的塞进存储", async () => {
    const captured = await captureFailureFrame(42, {
      capture: async () => jpeg("x".repeat(FAILURE_FRAME_BUDGET_CHARS)),
      shrink: async (dataUrl) => dataUrl,
      ...budget,
    });
    expect(captured).toBeNull();
  });

  it("抓到的东西不是图就当没抓到", async () => {
    const captured = await captureFailureFrame(42, {
      capture: async () => "not-a-data-url",
      ...budget,
    });
    expect(captured).toBeNull();
  });

  it("不给压缩器就用原图,超预算照样丢", async () => {
    const ok = await captureFailureFrame(42, { capture: async () => jpeg() });
    expect(ok?.at).toBe(42);
    const tooBig = await captureFailureFrame(42, {
      capture: async () => jpeg("x".repeat(FAILURE_FRAME_BUDGET_CHARS)),
    });
    expect(tooBig).toBeNull();
  });
});
