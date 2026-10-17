import { describe, expect, it } from "vitest";

import { CONTINUATION_MARKER } from "./continuation";
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
  send,
  stage,
  triggerSend,
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
  // 真机抓的原件(ADR-0013 存证):两态 class 一个不换,只有圆键里的图标不同--
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

describe("落草稿(stage):草稿保护,框里有别人的字就不覆盖", () => {
  const textarea = (): HTMLTextAreaElement =>
    document.querySelector("textarea") as HTMLTextAreaElement;

  it("空框 → 短标记落进去,回 written;这里只有写入,一次键都不按", () => {
    document.body.innerHTML = "<textarea></textarea>";
    let keys = 0;
    textarea().addEventListener("keydown", () => (keys += 1));

    expect(stage(textarea(), CONTINUATION_MARKER)).toBe("written");
    expect(textarea().value).toBe(CONTINUATION_MARKER);
    expect(keys).toBe(0);
  });

  it("框里有用户正在打的字 → 不覆盖,回 draft(半自动待发续聊的字不被吃)", () => {
    document.body.innerHTML = "<textarea>我正在打的话</textarea>";

    expect(stage(textarea(), CONTINUATION_MARKER)).toBe("draft");
    expect(textarea().value).toBe("我正在打的话"); // 一个字都没动
  });

  it("框里是上一轮落的那份短标记 → 覆盖成新的(换行 / 首尾空白不算别人的字)", () => {
    document.body.innerHTML = `<textarea>${CONTINUATION_MARKER}\r\n </textarea>`;

    expect(stage(textarea(), CONTINUATION_MARKER)).toBe("written");
    expect(textarea().value).toBe(CONTINUATION_MARKER);
  });

  it("框里只剩空白 → 落进去(空白不算别人的草稿)", () => {
    document.body.innerHTML = "<textarea>  \n </textarea>";

    expect(stage(textarea(), CONTINUATION_MARKER)).toBe("written");
    expect(textarea().value).toBe(CONTINUATION_MARKER);
  });

  it("手递一个写不进的元素 → 回 unwritable,不假装落成", () => {
    document.body.innerHTML = '<div id="plain"></div>';
    const el = document.getElementById("plain") as HTMLElement;

    expect(stage(el, CONTINUATION_MARKER)).toBe("unwritable");
    expect(el.textContent).toBe(""); // 一个字都没落进去
  });
});

describe("把这条发出去:生成期绝不点圆键", () => {
  // 真机存证(ADR-0013):两态 class 一个不换,只有图标不同;真机抓的是空输入框态
  // (带 ds-button--disabled),去掉禁用 class 即"输入框里有内容"的空闲态.
  const SEND_READY_HTML = evidenceHtml("circle.send").replace("ds-button--disabled ", "");
  const STOP_HTML = evidenceHtml("circle.stop");
  const SPINNER_HTML = evidenceHtml("circle.spinner");

  const stubBox = (el: Element): void => {
    (el as HTMLElement).getClientRects = () =>
      [{ width: 36, height: 36 }] as unknown as DOMRectList;
  };
  const circle = (): HTMLElement => document.querySelector(BUTTON_SELECTOR) as HTMLElement;
  const textarea = (): HTMLTextAreaElement =>
    document.querySelector("textarea") as HTMLTextAreaElement;

  /** 圆键被点的次数;站点"发出去了"由每个用例自己模拟. */
  function mountCircle(html: string, onSend?: () => void): () => number {
    document.body.insertAdjacentHTML("beforeend", html);
    stubBox(circle());
    let clicks = 0;
    circle().addEventListener("click", () => {
      clicks += 1;
      onSend?.();
    });
    return () => clicks;
  }

  it("按回车就发出去(站点 keydown 里清空框):圆键一下都不点", async () => {
    document.body.innerHTML = "<textarea>要发的话</textarea>";
    const clicks = mountCircle(STOP_HTML); // 圆键此刻是停止,更不该点
    const { clock } = fakeClock();
    let keys = 0;
    textarea().addEventListener("keydown", () => {
      keys += 1;
      textarea().value = "";
    });

    expect(await triggerSend(textarea(), clock)).toBe(true);
    expect(keys).toBe(1);
    expect(clicks()).toBe(0);
  });

  it("回车没发出去,圆键此刻是停止(生成中)→ 不点,回 false,框里的字不动", async () => {
    document.body.innerHTML = "<textarea>要发的话</textarea>";
    const clicks = mountCircle(STOP_HTML);
    const { clock } = fakeClock();

    expect(await triggerSend(textarea(), clock)).toBe(false);
    expect(clicks()).toBe(0);
    expect(textarea().value).toBe("要发的话");
  });

  it("回车没发出去,圆键是思考期环形(认不出)→ 也不点:宁可作废,不赌那一下是发送", async () => {
    document.body.innerHTML = "<textarea>要发的话</textarea>";
    const clicks = mountCircle(SPINNER_HTML);
    const { clock } = fakeClock();

    expect(await triggerSend(textarea(), clock)).toBe(false);
    expect(clicks()).toBe(0);
  });

  it("回车没发出去,圆键此刻是发送 → 点它兜底,站点清空后回 true", async () => {
    document.body.innerHTML = "<textarea>要发的话</textarea>";
    const clicks = mountCircle(SEND_READY_HTML, () => (textarea().value = ""));
    const { clock } = fakeClock();

    expect(await triggerSend(textarea(), clock)).toBe(true);
    expect(clicks()).toBe(1);
  });

  it("没圆键(或不可用)→ 回 false,不抛", async () => {
    document.body.innerHTML = "<textarea>要发的话</textarea>";
    const { clock } = fakeClock();

    expect(await triggerSend(textarea(), clock)).toBe(false);
  });

  it("send:发出去了回 sent(框被站点清空)", async () => {
    document.body.innerHTML = "<textarea></textarea>";
    mountCircle(STOP_HTML);
    const { clock } = fakeClock();
    textarea().addEventListener("keydown", () => (textarea().value = ""));

    expect(await send(textarea(), "要发的话", clock)).toBe("sent");
    expect(textarea().value).toBe("");
  });

  it("send:发不出去就把原来的字还原(页面里不留半截东西)", async () => {
    document.body.innerHTML = "<textarea>半截草稿</textarea>";
    mountCircle(STOP_HTML);
    const { clock } = fakeClock();

    expect(await send(textarea(), "要发的话", clock)).toBe("failed");
    expect(textarea().value).toBe("半截草稿");
  });

  it("send:写不进 → unwritable,框里的字没动", async () => {
    document.body.innerHTML = '<div id="plain">字</div>';
    const { clock } = fakeClock();
    const el = document.getElementById("plain") as HTMLElement;

    expect(await send(el, "要发的话", clock)).toBe("unwritable");
    expect(el.textContent).toBe("字");
  });
});
