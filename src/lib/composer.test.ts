import { describe, expect, it } from "vitest";

import { pick, pressEnter, read, write } from "./composer";

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
