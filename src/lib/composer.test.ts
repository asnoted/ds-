import { describe, expect, it } from "vitest";

import { pick } from "./composer";

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
