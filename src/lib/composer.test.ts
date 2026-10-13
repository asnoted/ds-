import { describe, expect, it } from "vitest";

import {
  awaitCleared,
  BUTTON_SELECTOR,
  circleElement,
  circleIntent,
  findButton,
  pick,
  POLL_MS,
  pressEnter,
  read,
  readIntent,
  write,
  type Clock,
} from "./composer";
import { evidenceHtml } from "./evidence";

/** 假时钟:不真等,`sleep` 直接把虚拟时间推过去,顺便记下每一次等待. */
function fakeClock(): { clock: Clock; slept: number[] } {
  let at = 0;
  const slept: number[] = [];
  return {
    clock: {
      now: () => at,
      sleep: async (ms: number) => {
        slept.push(ms);
        at += ms;
      },
    },
    slept,
  };
}

/** jsdom 不做布局:给元素钉上可见的盒子与尺寸(面积),否则一律当不可见. */
function layout(el: HTMLElement, width: number, height: number): void {
  el.getClientRects = () => [{ width, height }] as unknown as DOMRectList;
  el.getBoundingClientRect = () =>
    ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }) as DOMRect;
}

describe("pick:写作框是哪个", () => {
  const box = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

  it("可见 + 可写 + 面积最大:同一页最大的那个框,DOM 序靠前的不算数", () => {
    document.body.innerHTML = '<textarea id="first"></textarea><textarea id="second"></textarea>';
    layout(box("first"), 120, 40);
    layout(box("second"), 600, 160);

    expect(pick()?.id).toBe("second");
  });

  it("textarea 与 contenteditable 同场比面积,不分先后(挑框规则只有一条)", () => {
    document.body.innerHTML =
      '<textarea id="ta"></textarea><div id="ce" contenteditable="true"></div>';
    layout(box("ta"), 120, 40);
    layout(box("ce"), 600, 160);

    expect(pick()?.id).toBe("ce");
  });

  it("没渲染出盒子(不可见)的不算:面积再大也不挑", () => {
    document.body.innerHTML = '<textarea id="hidden"></textarea><textarea id="shown"></textarea>';
    layout(box("shown"), 120, 40); // `hidden` 不 stub:jsdom 里天然没有布局盒

    expect(pick()?.id).toBe("shown");
  });

  it("只读 / 禁用的 textarea 不算可写,不挑", () => {
    document.body.innerHTML =
      '<textarea id="readonly" readonly></textarea>' +
      '<textarea id="disabled" disabled></textarea>' +
      '<textarea id="ok"></textarea>';
    layout(box("readonly"), 600, 160);
    layout(box("disabled"), 600, 160);
    layout(box("ok"), 120, 40);

    expect(pick()?.id).toBe("ok");
  });

  it("一个可挑的框都没有 → null(不猜)", () => {
    document.body.innerHTML = "<div>无框</div>";

    expect(pick()).toBeNull();
  });

  it("同面积取 DOM 序靠前的:判据不在平局上另起规矩", () => {
    document.body.innerHTML =
      '<textarea id="tie-first"></textarea><textarea id="tie-second"></textarea>';
    layout(box("tie-first"), 300, 100);
    layout(box("tie-second"), 300, 100);

    expect(pick()?.id).toBe("tie-first");
  });
});

describe("读 / 写", () => {
  it("写走原生 value setter + 冒泡 input(React 受控输入只认这一条),回 true", () => {
    document.body.innerHTML = "<textarea></textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;
    const seen: string[] = [];
    el.addEventListener("input", (event) => seen.push((event.target as HTMLTextAreaElement).value));

    expect(write(el, "你好")).toBe(true);
    expect(el.value).toBe("你好");
    expect(seen).toEqual(["你好"]); // 那次 input 事件真派了,也冒泡到监听者
  });

  it("contenteditable 写 textContent + 冒泡 input,回 true", () => {
    document.body.innerHTML = '<div contenteditable="true"></div>';
    const el = document.querySelector("[contenteditable]") as HTMLElement;
    let seenCount = 0;
    el.addEventListener("input", () => (seenCount += 1));

    expect(write(el, "agent:")).toBe(true);
    expect(el.textContent).toBe("agent:");
    expect(seenCount).toBe(1);
  });

  it("既不是 textarea 也不是可编辑区 → 写不进,回 false(不假装写过)", () => {
    document.body.innerHTML = "<div id='plain'>字</div>";
    const el = document.getElementById("plain") as HTMLElement;

    expect(write(el, "改了")).toBe(false);
    expect(el.textContent).toBe("字"); // 一个字都没动
  });

  it("读:textarea 读 value,contenteditable 读 textContent;空框回空串", () => {
    document.body.innerHTML = "<textarea>写了一半</textarea>";
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(read(ta)).toBe("写了一半");

    document.body.innerHTML = '<div contenteditable="true">草稿</div>';
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    expect(read(ce)).toBe("草稿");

    document.body.innerHTML = "<textarea></textarea>";
    expect(read(document.querySelector("textarea") as HTMLTextAreaElement)).toBe("");
  });
});

describe("按键", () => {
  it("pressEnter:keydown + keyup,keyCode / which 补成 13,都冒泡(页面里的老判断也认)", () => {
    document.body.innerHTML = "<textarea></textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;
    const seen: string[] = [];
    for (const type of ["keydown", "keyup"]) {
      el.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        seen.push(`${type}:${key.key}:${key.keyCode}:${key.which}:${key.bubbles}`);
      });
    }

    pressEnter(el);

    expect(seen).toEqual(["keydown:Enter:13:13:true", "keyup:Enter:13:13:true"]);
  });
});

describe("等清空(发出去的标志)", () => {
  it("站点当场把框清空 → 立刻回 true,一次都不等", async () => {
    const { clock, slept } = fakeClock();

    expect(await awaitCleared(() => "", { timeoutMs: 600, clock })).toBe(true);
    expect(slept).toEqual([]);
  });

  it("第 3 次轮询才清空 → 回 true,每次等一个轮询间隔", async () => {
    const { clock, slept } = fakeClock();
    let polls = 0;
    const readText = (): string => {
      polls += 1;
      return polls < 3 ? "agent:\n继续" : "";
    };

    expect(await awaitCleared(readText, { timeoutMs: 600, clock })).toBe(true);
    expect(slept).toEqual([POLL_MS, POLL_MS]);
  });

  it("一直不清 → 到点回 false,不加时(等到上限就收)", async () => {
    const { clock, slept } = fakeClock();

    expect(await awaitCleared(() => "还在框里", { timeoutMs: 300, clock })).toBe(false);
    expect(slept).toEqual([POLL_MS, POLL_MS, POLL_MS]);
  });

  it("框里只剩空白也算清空(站点清完会留个换行)", async () => {
    const { clock } = fakeClock();

    expect(await awaitCleared(() => "  \n ", { timeoutMs: 600, clock })).toBe(true);
  });
});

describe("圆键:此刻是什么意图", () => {
  // 真机抓的原件(ADR-0018 存证):两态 class 一个不换,只有圆键里的图标不同--
  // **所以那不是两个控件,是一个**:它此刻是发送还是停止是页面的意图,不是控件的身份.
  const STOP_HTML = evidenceHtml("circle.stop");
  const SEND_HTML = evidenceHtml("circle.send");
  // 思考期:圆键位置换成 36×36 环形 spinner,图标不是两态之一.
  const SPINNER_HTML = evidenceHtml("circle.spinner");
  /** 真机抓的是**空输入框态**(带 ds-button--disabled),去掉禁用 class 即空闲态. */
  const SEND_READY_HTML = SEND_HTML.replace("ds-button--disabled ", "");

  /** jsdom 不做布局:给圆键补一个盒子. */
  const stubBox = (el: Element): void => {
    (el as HTMLElement).getClientRects = () =>
      [{ width: 16, height: 16 }] as unknown as DOMRectList;
  };

  const circle = (): Element => document.querySelector(BUTTON_SELECTOR) as Element;

  it("意图只认图标:箭头是 send,方块是 stop", () => {
    document.body.innerHTML = SEND_READY_HTML;
    stubBox(circle());
    expect(readIntent(circle() as HTMLElement)).toBe("send");

    document.body.innerHTML = STOP_HTML;
    stubBox(circle());
    expect(readIntent(circle() as HTMLElement)).toBe("stop");
  });

  it("图标认不出(站点换图标 / 思考期环形)回 unknown -- 不猜是发送还是停止", () => {
    document.body.innerHTML = SPINNER_HTML;
    stubBox(circle());
    expect(readIntent(circle() as HTMLElement)).toBe("unknown");

    document.body.innerHTML = STOP_HTML.replace("M2 4.88", "M9 9.99");
    stubBox(circle());
    expect(readIntent(circle() as HTMLElement)).toBe("unknown");
  });

  it('circleElement:键在但禁用也返回(读面分得开"键在但禁用"与"键不在")', () => {
    document.body.innerHTML = SEND_HTML; // 真机那份就带 ds-button--disabled
    stubBox(circle());

    expect(circleElement()).not.toBeNull();
  });

  it("findButton:在且没禁用就回它", () => {
    document.body.innerHTML = SEND_READY_HTML;
    stubBox(circle());

    expect(findButton()).not.toBeNull();
  });

  it("findButton:class 带 ds-button--disabled 回 null", () => {
    document.body.innerHTML = SEND_HTML;
    stubBox(circle());

    expect(findButton()).toBeNull();
  });

  it("findButton:没这个键也回 null", () => {
    document.body.innerHTML = "<div>什么都没有</div>";

    expect(findButton()).toBeNull();
  });

  it("findButton:没渲染出盒子(不可见)也当没找到", () => {
    document.body.innerHTML = STOP_HTML; // 不 stub:jsdom 里天然 getClientRects().length === 0

    expect(circleElement()).toBeNull();
    expect(findButton()).toBeNull();
  });

  it('circleIntent:键不在或不可用一律 unknown(认不出与"当下不是发送"同一处置)', () => {
    document.body.innerHTML = STOP_HTML;
    stubBox(circle());
    expect(circleIntent()).toBe("stop");

    document.body.innerHTML = SEND_HTML; // 禁用态:图标是箭头,但键不可用
    stubBox(circle());
    expect(circleIntent()).toBe("unknown");

    document.body.innerHTML = "<div>什么都没有</div>";
    expect(circleIntent()).toBe("unknown");
  });
});
