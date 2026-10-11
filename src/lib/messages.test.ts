import { describe, expect, it } from "vitest";

import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_READ_FAILED } from "./action";
import type { ActionFrame } from "./action";
import { evidenceHtml } from "./evidence";
import { parseWaitSeconds } from "./wait-budget";
import {
  conversationList,
  lastMessage,
  listMessages,
  nextFrame,
  readLast,
  readMessages,
  readRow,
  readyWithin,
  roleOf,
  settleUntilMounted,
  type ListViewport,
  type StyleProbe,
} from "./messages";

const FRAME: ActionFrame = {
  type: "action",
  id: "m-1",
  action: "messages.list",
  params: {},
  target: "42",
};

/**
 * 夹具照抄 2026-10-02 真机抓的结构(页面 commit-id 44809ea4),**文字全是编的**:
 * 行 key,`ds-*` 设计系统类,哈希 class 的位置都按真的来,这样站点一改版测试先红.
 *
 * 列表那层带 `--printable` 是**照抄真的**:真机主聊天区就是 `.ds-virtual-list--printable`,
 * 而且它与"行里渲染出 `.ds-message` 了吗"无关--少了它,"行挂上,正文还没渲染"那种
 * 未就绪状态会被误判成"认不出对话列表"(当场判死,坏了 #40 那条轮询语义).
 */
function conversationHtml(): string {
  return `
    <div class="ds-virtual-list ds-virtual-list--printable ds-scroll-area--enabled">
      <div class="ds-virtual-list-items">
        <div class="ds-virtual-list-visible-items">
          <div class="_9663006 _2c189bc" data-virtual-list-item-key="1">
            <div class="d29f3d7d ds-message _63c77b1">
              <div class="fbb737a4">
                <div class="ds-collapsible-text"><div><span>帮我看一眼这段代码</span></div></div>
              </div>
              <div class="_11d6b3a">
                <div role="button" class="ds-button ds-button--icon"><div class="ds-icon"></div></div>
              </div>
            </div>
          </div>
          <div class="_4f9bf79 _43c05b5" data-virtual-list-item-key="2">
            <div class="ds-message _63c77b1">
              <div class="_74c0879">
                <div class="e1675d8b ds-think-content">
                  <div class="ds-markdown"><p>先想想:这里有个坑</p></div>
                </div>
                <div class="e1675d8b ds-think-content">
                  <div class="ds-markdown"><p>想完了,就它吧</p></div>
                </div>
              </div>
              <div class="ds-markdown ds-assistant-message-main-content">
                <p>答案是 <strong>4271</strong>.</p>
                <h3>说明</h3>
                <ul><li><p>第一点</p></li><li><p>第二点</p></li></ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function frameOf(action: string): ActionFrame {
  return { ...FRAME, action };
}

/** 带预算的帧:省得测试为"轮询到到点"真等 25 秒. */
function budgetFrame(action: string, timeout = 1): ActionFrame {
  return { ...FRAME, action, params: { timeout } };
}

/** 第 index 条挂载出来的行;没有就当场抛,别把"没这行"演成 `undefined` 混过去. */
function rowAt(index: number): Element {
  const row = document.querySelectorAll("[data-virtual-list-item-key]")[index];
  if (row === undefined) throw new Error(`没有第 ${index} 行`);
  return row;
}

describe("一行 → 一条消息", () => {
  it("用户行认可折叠文本,助手行认设计系统那个正文类", () => {
    document.body.innerHTML = conversationHtml();
    expect(readRow(rowAt(0))).toEqual({ role: "user", text: "帮我看一眼这段代码" });
    expect(readRow(rowAt(1))).toEqual({
      role: "assistant",
      text: "答案是 4271.\n\n说明\n\n第一点\n\n第二点",
    });
  });

  it("思考块是正文的兄弟节点,取正文类天然排掉它", () => {
    document.body.innerHTML = conversationHtml();
    const assistant = rowAt(1);
    const text = readRow(assistant)?.text ?? "";

    expect(text).not.toContain("先想想");
    expect(text).not.toContain("想完了");
  });

  it("行容器的哈希 class 换掉,去掉都照样认得出(#15:不用会随部署变的 class)", () => {
    document.body.innerHTML = conversationHtml()
      .replace(/_\w{6,7}/g, "rotated-hash")
      .replace(/ d29f3d7d/g, "");
    expect(readRow(rowAt(0))?.role).toBe("user");
    expect(readRow(rowAt(1))?.role).toBe("assistant");
  });

  it("不是消息行的行跳过;认不出角色的消息行带 unknown--都不猜角色", () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list">
        <div data-virtual-list-item-key="1"><span>日期分隔条</span></div>
        <div data-virtual-list-item-key="2"><div class="ds-message"><div>没有可折叠文本</div></div></div>
      </div>`;
    expect(readRow(rowAt(0))).toBeNull(); // 不是消息行(这页有 .ds-message,唯独它没有)
    expect(readRow(rowAt(1))).toEqual({ role: "unknown", text: "没有可折叠文本" });
  });

  it("块级元素分行,行内空格留着--不然段落会粘成一坨", () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list">
        <div data-virtual-list-item-key="1">
          <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">
            <p>第一段</p><p>第二段</p>
          </div></div>
        </div>
      </div>`;
    const row = document.querySelector("[data-virtual-list-item-key]") as Element;

    expect(readRow(row)?.text).toBe("第一段\n\n第二段");
  });

  it("代码块外框:表头与复制/下载按钮是 `<pre>` 的兄弟,不算正文", () => {
    // 代码块原件取自存证 `code.block`(真机 2026-10-07,ADR-0018):表头,复制/下载按钮在
    // `md-code-block-banner-wrap` 里,`<pre>` 与两个角 svg 是它的兄弟--一字不缩写.
    document.body.innerHTML = `
      <div class="ds-virtual-list">
        <div data-virtual-list-item-key="1">
          <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">
            <p>先看这个:</p>
            ${evidenceHtml("code.block")}
            <p>跑完再来.</p>
          </div></div>
        </div>
      </div>`;
    const row = document.querySelector("[data-virtual-list-item-key]") as Element;

    expect(readRow(row)).toEqual({
      role: "assistant",
      text: '先看这个:\n\n```send\n{"tool": "ls", "arguments": {}}\n```\n\n跑完再来.',
    });
  });
});

describe("messages.list / messages.last 执行器", () => {
  it("读出按序的全部消息", async () => {
    document.body.innerHTML = conversationHtml();

    expect(await listMessages(frameOf("messages.list"))).toEqual({
      messages: [
        { role: "user", text: "帮我看一眼这段代码" },
        { role: "assistant", text: "答案是 4271.\n\n说明\n\n第一点\n\n第二点" },
      ],
    });
  });

  it("只回最后一条,形状与 list 一致", async () => {
    document.body.innerHTML = conversationHtml();

    expect(await lastMessage(frameOf("messages.last"))).toEqual({
      messages: [{ role: "assistant", text: "答案是 4271.\n\n说明\n\n第一点\n\n第二点" }],
    });
  });

  it("新对话一行都没有:回空数组,不算错", async () => {
    document.body.innerHTML = "<div>空的</div>";

    expect(await listMessages(frameOf("messages.list"))).toEqual({ messages: [] });
    expect(await lastMessage(frameOf("messages.last"))).toEqual({ messages: [] });
  });

  it("挂着行但认不出角色:如实带 unknown(不猜,不装空对话)", async () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list">
        <div data-virtual-list-item-key="1"><div class="ds-message"><div>认不出</div></div></div>
      </div>`;

    expect(await listMessages(frameOf("messages.list"))).toEqual({
      messages: [{ role: "unknown", text: "认不出" }],
    });
    expect(await lastMessage(frameOf("messages.last"))).toEqual({
      messages: [{ role: "unknown", text: "认不出" }],
    });
  });
});

describe("多条虚拟列表:挑对话那一条(#54)", () => {
  it("认装有写作框的主列表,不认右缘那个面板", () => {
    document.body.innerHTML = twoListsHtml();

    const list = conversationList(document);

    expect(list?.classList.contains("ds-virtual-list--printable")).toBe(true);
    expect(list?.querySelector("textarea")).not.toBeNull();
  });

  it("主列表一行没挂,面板里有行:在主列表上等,不回空数组也不读面板", async () => {
    document.body.innerHTML = twoListsHtml();
    stubLayer(document.querySelector(".ds-virtual-list--printable")!, "auto", 100);

    // 页面上有行 → 不是新对话,进就绪轮询;预算耗尽才报 page-changed(不装作空对话).
    // 预算给 1s 免得测试真等 25s.
    await expect(listMessages(budgetFrame("messages.list"))).rejects.toMatchObject({
      code: ACTION_ERROR_PAGE_CHANGED,
    });
  });

  it("主列表挂上无 key 的行:照读,且读出来的是主列表那些,不是面板的", async () => {
    document.body.innerHTML = twoListsHtml(keylessRow("主列表第一条") + keylessRow("主列表第二条"));
    stubLayer(document.querySelector(".ds-virtual-list--printable")!, "auto", 100);

    const result = await listMessages(frameOf("messages.list"));

    expect(result.messages.map((message) => message.text)).toEqual([
      "主列表第一条",
      "主列表第二条",
    ]);
    expect(JSON.stringify(result)).not.toContain("面板里");
  });

  it("没 key 的行:正文当身份,两条一样只留第一条", async () => {
    document.body.innerHTML = twoListsHtml(
      keylessRow("一样的话") + keylessRow("另一句") + keylessRow("一样的话"),
    );
    stubLayer(document.querySelector(".ds-virtual-list--printable")!, "auto", 100);

    expect((await listMessages(frameOf("messages.list"))).messages.map((m) => m.text)).toEqual([
      "一样的话",
      "另一句",
    ]);
  });

  it("没 key 也没正文的行(分隔条):不收", async () => {
    document.body.innerHTML = twoListsHtml(
      '<div class="_81e7b5e"><div class="_a1b2c3"></div></div>' + keylessRow("真的那条"),
    );
    stubLayer(document.querySelector(".ds-virtual-list--printable")!, "auto", 100);

    expect((await listMessages(frameOf("messages.list"))).messages.map((m) => m.text)).toEqual([
      "真的那条",
    ]);
  });

  it("三条判据都不中而页面上有行:当场 page-changed,一拍都不等", async () => {
    // 去掉写作框(①②)与 --printable(②),行里也没有 .ds-message(③)-- 认不出对话列表
    document.body.innerHTML = twoListsHtml(keylessRow("某条"))
      .replace(
        "ds-virtual-list ds-virtual-list--printable ds-scroll-area--enabled",
        "ds-virtual-list",
      )
      .replace("<textarea></textarea>", "");
    let polls = 0;

    await expect(
      readyWithin(READY_DEADLINE, fakeClock(1_000), (): Promise<void> => {
        polls += 1;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: ACTION_ERROR_PAGE_CHANGED });

    expect(polls).toBe(0); // 认不出就是认不出,等也没用
  });

  it("哪儿都没行:新对话,秒回空数组(不轮询)", async () => {
    document.body.innerHTML = twoListsHtml(); // 把面板那三行也拆掉
    document.querySelectorAll(".ds-virtual-list-visible-items > *").forEach((row) => row.remove());

    expect(await listMessages(frameOf("messages.list"))).toEqual({ messages: [] });
    expect(await lastMessage(frameOf("messages.last"))).toEqual({ messages: [] });
  });
});

/**
 * 角色三层里的**渲染层**(气泡):jsdom 不做布局,`getComputedStyle` / `getBoundingClientRect`
 * 拿不到真值,所以用替身探测口,把"算出来的样式 / 几何"写在 `data-*` 上喂进去.
 * 数字照 2026-10-04 真机量的(那批 DOM 已随 Trellis 迁移删除;来历见 `messages.ts`
 * 里那组阈值常量的注释).
 */
const attributeProbe: StyleProbe = {
  style: (el) => ({
    backgroundColor: el.getAttribute("data-bg") ?? "rgba(0, 0, 0, 0)",
    borderRadius: el.getAttribute("data-radius") ?? "0px",
  }),
  rect: (el) => ({
    left: Number(el.getAttribute("data-left") ?? "0"),
    right: Number(el.getAttribute("data-right") ?? "0"),
  }),
};

/** 造一行:行占 0..752,里面放一块"绘制出来的东西"(或什么都不放). */
function bubbleRow(inner: string, rowLeft = 0, rowRight = 752): Element {
  document.body.innerHTML = `
    <div class="ds-virtual-list"><div class="ds-virtual-list-visible-items">
      <div data-virtual-list-item-key="1" data-left="${rowLeft}" data-right="${rowRight}">
        ${inner}
      </div>
    </div></div>`;
  return document.querySelector("[data-virtual-list-item-key]") as Element;
}

describe("角色:渲染层(气泡)", () => {
  it("用户:不满宽的圆角块(真机 22px,贴右)", () => {
    const row = bubbleRow(
      '<div data-bg="rgb(237, 243, 254)" data-radius="22px" data-left="88" data-right="752">继续</div>',
    );
    expect(roleOf(row, attributeProbe)).toBe("user");
  });

  it("用户(长到满宽):还有头像圆兜着", () => {
    const row = bubbleRow(
      '<div data-bg="rgb(237, 243, 254)" data-radius="22px" data-left="0" data-right="752">长消息</div>' +
        '<div data-bg="rgb(255, 255, 255)" data-radius="100px" data-left="710" data-right="740"></div>',
    );
    expect(roleOf(row, attributeProbe)).toBe("user");
  });

  it("助手:整宽素文,什么都不画", () => {
    expect(roleOf(bubbleRow("<p>答案</p>"), attributeProbe)).toBe("assistant");
  });

  it("助手带代码块:满宽 12px 的块不算气泡(真机数字)", () => {
    const row = bubbleRow(
      '<div data-bg="rgb(249, 250, 251)" data-radius="12px" data-left="0" data-right="752">' +
        '<pre>{"tool": "ls"}</pre></div>',
    );
    expect(roleOf(row, attributeProbe)).toBe("assistant");
  });

  it("没有布局(行宽为 0):判不了,回 unknown--不猜", () => {
    expect(roleOf(bubbleRow("<p>答案</p>", 0, 0), attributeProbe)).toBe("unknown");
  });
});

/**
 * 假虚拟列表:jsdom 不做布局(`clientHeight` 恒为 0),真元素滚不动.
 * 每屏是**一批不同**的行--照抄真虚拟列表的挂载/卸载行为.
 */
function virtualScreens(screens: string[][]): ListViewport {
  const HEIGHT = 100;
  const host = document.createElement("div");
  let index = 0;
  const paint = (): void => {
    host.innerHTML = screens[index]?.join("") ?? "";
  };
  paint();
  return {
    get scrollTop(): number {
      return index * HEIGHT;
    },
    set scrollTop(value: number) {
      index = Math.min(screens.length - 1, Math.max(0, Math.round(value / HEIGHT)));
      paint();
    },
    get clientHeight(): number {
      return HEIGHT;
    },
    get scrollHeight(): number {
      return screens.length * HEIGHT;
    },
    querySelectorAll: (selector: string) => host.querySelectorAll(selector),
  };
}

function keyRow(key: number, role: "user" | "assistant"): string {
  const body =
    role === "user"
      ? `<div class="ds-collapsible-text"><span>第 ${key} 问</span></div>`
      : `<div class="ds-markdown ds-assistant-message-main-content"><p>第 ${key} 答</p></div>`;
  return `<div data-virtual-list-item-key="${key}"><div class="ds-message">${body}</div></div>`;
}

/**
 * 挂载要迟几帧才跟上的假虚拟列表--**这才是真机那次超时的根因**(2026-10-02):
 * 一帧一步地扫 80 屏只收到 50 条,而对话有 385 条.中间那些屏就这么被跳过去了,
 * 不是扫得慢,是读的时候那一屏还没挂上.
 *
 * `lag` 是挂载要等几帧;期间再被叫去别的位置,前面那一屏就永远看不到了.
 */
function laggingScreens(
  screens: string[][],
  lag: number,
): {
  view: ListViewport;
  settle: () => Promise<void>;
} {
  const HEIGHT = 100;
  const host = document.createElement("div");
  let index = 0;
  let target = 0;
  let left = 0;
  const paint = (): void => {
    host.innerHTML = screens[index]?.join("") ?? "";
  };
  paint();
  const clamp = (value: number): number =>
    Math.min(screens.length - 1, Math.max(0, Math.round(value / HEIGHT)));
  const view: ListViewport = {
    get scrollTop(): number {
      return index * HEIGHT;
    },
    set scrollTop(value: number) {
      target = clamp(value);
      left = lag;
    },
    get clientHeight(): number {
      return HEIGHT;
    },
    get scrollHeight(): number {
      return screens.length * HEIGHT;
    },
    querySelectorAll: (selector: string) => host.querySelectorAll(selector),
  };
  const settle = async (): Promise<void> => {
    if (left > 0) left -= 1;
    if (left === 0 && target !== index) {
      index = target;
      paint();
    }
  };
  return { view, settle };
}

const settleNow = async (): Promise<void> => {};

describe("虚拟列表:只有视口里的行在 DOM", () => {
  it("一屏一屏滚下去,超出首屏的也收得回来,且顺序是对话顺序", async () => {
    const view = virtualScreens([
      [keyRow(1, "user"), keyRow(2, "assistant")],
      [keyRow(3, "user"), keyRow(4, "assistant")],
      [keyRow(5, "user")],
    ]);

    const messages = await readMessages(view, settleNow);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      "第 1 问",
      "第 2 答",
      "第 3 问",
      "第 4 答",
      "第 5 问",
    ]);
    expect(view.scrollTop).toBe(0); // 归位,别把人的页面留在半空
  });

  it("滚不动(一屏装得下)时扫一遍就停,不会空转", async () => {
    const view = virtualScreens([[keyRow(1, "user")]]);

    expect(await readMessages(view, settleNow)).toEqual([{ role: "user", text: "第 1 问" }]);
  });

  it("内容超长却一步都滚不动 = 滚动层认错了,当场抛--别把首屏当全量交上去", async () => {
    const host = document.createElement("div");
    host.innerHTML = keyRow(1, "user");
    const writes: number[] = [];
    const view: ListViewport = {
      querySelectorAll: (selector: string) => host.querySelectorAll(selector),
      get scrollTop(): number {
        return 0; // 写得进去,位置不前进:不是滚动容器
      },
      set scrollTop(value: number) {
        writes.push(value);
      },
      get clientHeight(): number {
        return 100;
      },
      get scrollHeight(): number {
        return 9_999; // 内容确实超长
      },
    };

    await expect(readMessages(view, settleNow)).rejects.toThrow("滚不动消息列表");
    expect(writes).toContain(100); // 真试过往下滚,不是一上来就卡住
  });

  it("只读最后一条:跳到底扫那一屏就够", async () => {
    const view = virtualScreens([[keyRow(1, "user")], [keyRow(2, "assistant"), keyRow(3, "user")]]);

    expect(await readLast(view, settleNow)).toEqual({ role: "user", text: "第 3 问" });
    expect(view.scrollTop).toBe(0);
  });

  it("挂载迟到的屏也要收得到--一帧一步会把中间的屏跳过去(真机那次超时的根因)", async () => {
    const screens = [
      [keyRow(0, "user")],
      [keyRow(1, "assistant")],
      [keyRow(2, "user")],
      [keyRow(3, "assistant")],
      [keyRow(4, "user")],
    ];
    const { view, settle } = laggingScreens(screens, 3);

    const result = await readMessages(view, settle);

    expect(result.map((m) => m.text)).toEqual([
      "第 0 问",
      "第 1 答",
      "第 2 问",
      "第 3 答",
      "第 4 问",
    ]);
  });

  it("scrollTop 写在真的会滚那一层--两层都能滚时用最里层", async () => {
    document.body.innerHTML = conversationHtml();
    const itemWrites = stubLayer(document.querySelector(".ds-virtual-list-items")!, "auto", 100);
    const listWrites = stubLayer(document.querySelector(".ds-virtual-list")!, "auto", 100);

    const result = await listMessages(frameOf("messages.list"));

    expect(result.messages).toHaveLength(2);
    expect(itemWrites).toEqual([0, 100, 200, 0]); // 真滚过,最后归位
    expect(listWrites).toEqual([]); // 外层那一下都没碰
  });

  it("内层内容溢出却 overflow:visible(滚不动的假象)→ 跳过它,用外层", async () => {
    document.body.innerHTML = conversationHtml();
    // 真机上 `.ds-virtual-list` 是 flex 容器,里面那层撑着全部行,两层都可能报溢出.
    const itemWrites = stubLayer(document.querySelector(".ds-virtual-list-items")!, "visible", 100);
    const listWrites = stubLayer(document.querySelector(".ds-virtual-list")!, "auto", 100);

    await listMessages(frameOf("messages.list"));

    expect(itemWrites).toEqual([]); // 写它就是空操作,识破了
    expect(listWrites).toEqual([0, 100, 200, 0]);
  });

  it("内层 clientHeight 为 0(height:0 + overflow:hidden 的包装层)→ 跳过它,用外层", async () => {
    // 看不见的一屏扫不动:每轮只挪 1px.留着这条是防这种层混进来.
    document.body.innerHTML = conversationHtml();
    const itemWrites = stubLayer(document.querySelector(".ds-virtual-list-items")!, "hidden", 0);
    const listWrites = stubLayer(document.querySelector(".ds-virtual-list")!, "auto", 100);

    const result = await listMessages(frameOf("messages.list"));

    expect(result.messages).toHaveLength(2);
    expect(itemWrites).toEqual([]); // 一屏都看不见,写它等于每轮挪 1px
    expect(listWrites).toEqual([0, 100, 200, 0]);
  });
});

/** 给某一层钉上"内容 300px,视口 client px",并记下 `scrollTop` 被写过什么. */
function stubLayer(element: Element, overflowY: string, client: number): number[] {
  const writes: number[] = [];
  let top = 0;
  element.setAttribute("style", `overflow-y: ${overflowY}`);
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: (): number => top,
      set: (value: number) => {
        top = value;
        writes.push(value);
      },
    },
    scrollHeight: { configurable: true, get: (): number => 300 },
    clientHeight: { configurable: true, get: (): number => client },
  });
  return writes;
}

/**
 * 夹具照抄 2026-10-05 真机量到的**两条**虚拟列表(会话 613e11ee,commit-id 44809ea4):
 *
 * - 主聊天区 `.ds-virtual-list--printable`(x=261,1209×742,自己是滚动层,
 *   写作框 `_871cbca` sticky 在里面)--**此刻 0 行**:`visible-items` 零子节点,
 *   `items` 只有 `min-height: 1680px` 的占位;
 * - 右缘一个 `position: fixed` 的 34px 窄条 `_189b4a0`(悬停展开成 240×210 面板)
 *   --**3 行**,行上没有 `data-virtual-list-item-key`,也没有 `.ds-message`.
 *
 * `mainRows` 是"行挂上之后"的形状(照抄站点新版行:只有哈希 class,没有 key),
 * 空串表示还没挂.#54 的病根就在这两条并存:老实现拿第一个命中行倒推,认成了那个面板.
 */
function twoListsHtml(mainRows = ""): string {
  return `
    <div class="ds-virtual-list ds-virtual-list--printable ds-scroll-area--enabled">
      <div class="ds-scroll-area__gutters"></div>
      <div class="ds-virtual-list-items" style="min-height: 1680px">
        <div class="ds-virtual-list-visible-items" style="transform: translateY(0px)">${mainRows}</div>
      </div>
      <div class="_871cbca"><textarea></textarea></div>
    </div>
    <div class="_189b4a0">
      <div class="ds-scroll-area _4ce999d">
        <div class="ds-virtual-list">
          <div class="ds-virtual-list-items" style="height: 180px">
            <div class="ds-virtual-list-visible-items">
              <div class="_81e7b5e"><div class="_72b6158">面板里那条[ds 协议]</div></div>
              <div class="_81e7b5e"><div class="_72b6158">面板里另一条</div></div>
              <div class="_81e7b5e"><div class="_72b6158">面板里第三条</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/** 站点新版的行(2026-10-04 起):只有哈希 class,没有 key,没有 `ds-message`. */
function keylessRow(text: string): string {
  return `<div class="_81e7b5e"><div class="_72b6158"><p>${text}</p></div></div>`;
}

/**
 * `readyWithin` 的替身件:jsdom 不做布局,滚动层不 `stub` 就永远不滚得动,
 * 而就绪判据要的就是"滚得动 + 至少一行读得出".
 *
 * `ready` 真时钟,`instant` 假时钟--后者用 `settle` 走完预算,不必真等 5s.
 */
const instant = (): Promise<void> => Promise.resolve();
function fakeClock(stepMs: number): () => number {
  let now = 0;
  return (): number => {
    now += stepMs;
    return now;
  };
}
/**
 * 给 `readyWithin` 的 deadline(ms).假时钟从 0 起,每拍 +1_000,所以
 * `12_000` 相当于"第 12 拍到点"--够验"等到"也够验"到点抛",不必真等.
 * 别用 `Infinity`:那就永远等不到,`page-changed` 那几条会转成死循环.
 */
const READY_DEADLINE = 12_000;

describe("就绪轮询(issue #40)", () => {
  it("行还没挂进来:预算内等到那一行,不报 page-changed", async () => {
    // 真机实测(2026-10-04,导航后立刻量):主列表几何已就绪(742×1856,auto),
    // 但 `rows: 0` -- "没就绪"的主症状是读不出行,不是高度为 0.
    document.body.innerHTML = conversationHtml();
    const rows = [...document.querySelectorAll("[data-virtual-list-item-key]")];
    const saved = rows.map((row) => row.innerHTML);
    for (const row of rows) row.innerHTML = ""; // 行在,正文还没渲染
    let polls = 0;

    await readyWithin(READY_DEADLINE, fakeClock(1_000), (): Promise<void> => {
      polls += 1;
      if (polls === 2) rows.forEach((row, index) => (row.innerHTML = saved[index] ?? ""));
      return Promise.resolve();
    });

    expect(polls).toBe(2); // 等了两拍才等到:不是当场报 page-changed
  });

  it('一行都读不出:预算耗尽才报 page-changed(这回是真的"结构变了")', async () => {
    document.body.innerHTML = conversationHtml();
    for (const row of document.querySelectorAll("[data-virtual-list-item-key]")) row.innerHTML = "";
    // 正文永不出来:等再久也没用--这才是该报结构变了的那种.

    await expect(readyWithin(READY_DEADLINE, fakeClock(1_000), instant)).rejects.toMatchObject({
      code: ACTION_ERROR_PAGE_CHANGED,
    });
  });

  it("结构真变了(认不出列表):当场 page-changed,不进轮询", async () => {
    document.body.innerHTML = "<div>没有列表</div>";
    let polls = 0;

    await expect(
      readyWithin(READY_DEADLINE, fakeClock(1_000), (): Promise<void> => {
        polls += 1;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: ACTION_ERROR_PAGE_CHANGED });

    expect(polls).toBe(0); // 一拍都没等:找不到就是找不到,等也没用
  });

  it("认得出列表但一行都没挂:等预算,到点才报 page-changed(不是当场)", async () => {
    // 挂着列表,一行都没有:那是"还没挂上来",等预算;不是"空对话".
    // 列表要**认得出**(带 `--printable`),否则就落成"认不出对话列表"那条(当场报).
    document.body.innerHTML = conversationHtml().replace(
      'class="ds-virtual-list ds-scroll-area--enabled"',
      'class="ds-virtual-list ds-virtual-list--printable ds-scroll-area--enabled"',
    );
    for (const row of document.querySelectorAll("[data-virtual-list-item-key]")) row.remove();
    let polls = 0;

    await expect(
      readyWithin(READY_DEADLINE, fakeClock(1_000), (): Promise<void> => {
        polls += 1;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: ACTION_ERROR_PAGE_CHANGED });

    expect(polls).toBeGreaterThan(0); // 认得出列表 → 该等,不该当场判死
  });

  it("就绪探测不写 scrollTop:别污染 readMessages 的起点", async () => {
    document.body.innerHTML = conversationHtml();
    const writes = stubLayer(document.querySelector(".ds-virtual-list")!, "auto", 100);

    await readyWithin(READY_DEADLINE, fakeClock(1_000), instant);

    expect(writes).toEqual([]); // 就绪只读行,不试写滚动
  });

  it("messages.list / messages.last 走同一条就绪路:就绪后照常读出", async () => {
    document.body.innerHTML = conversationHtml();
    stubLayer(document.querySelector(".ds-virtual-list")!, "auto", 100);

    const list = await listMessages(frameOf("messages.list"));
    const last = await lastMessage(frameOf("messages.last"));

    expect(list.messages).toHaveLength(2);
    expect(last.messages).toHaveLength(1);
  });
});

describe("nextFrame:不可见页面也得收工", () => {
  it("requestAnimationFrame 永不回调(页面不可见)时靠 setTimeout 兜底", async () => {
    // 真机 2026-10-04 撞过:后台标签页不产生帧,裸 rAF 的 Promise 永远挂着,
    // `readMessages` / `readLast` 里的 `settleUntilMounted` 随之卡死,动作永不回话.
    const original = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (): number => 0, // 收下回调但永不调用 = 页面不可见
    });
    try {
      await expect(
        Promise.race([
          nextFrame(),
          new Promise((resolve) => setTimeout(() => resolve("超时"), 3_000)),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it("rAF 正常回调时仍走那一路,不被兜底拖慢", async () => {
    const original = globalThis.requestAnimationFrame;
    let called = false;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback): number => {
        called = true;
        callback(0);
        return 0;
      },
    });
    try {
      await nextFrame();
      expect(called).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe("不可见页面:一屏也要扫得完", () => {
  it("rAF 死掉时,settleUntilMounted 的 30 帧上限收得住(不超 2s)", async () => {
    // 兜底曾借用 POLL_INTERVAL_MS(500ms):30 帧 = 每屏 15s,一屏都扫不完,
    // `messages.list` 于是永不回话(比挂死更隐蔽--它"在等").
    const original = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (): number => 0, // 收下回调但永不调用 = 页面不可见
    });
    try {
      const view = {
        querySelectorAll: (): ArrayLike<Element> => [],
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 300,
      };
      const started = Date.now();
      await settleUntilMounted(view, "1,", nextFrame); // key 集合不变 → 走满 30 帧
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe("预算:params.timeout 一份,就绪与扫描共用", () => {
  it("就绪花掉的时间从扫描里扣(最坏恒等于预算,不顶中继的锁)", async () => {
    // 曾经的坑:就绪 5s + 扫描 25s = 30s,正顶着中继 30s 的锁 → 真原因被吞成 timeout.
    // 现在一份预算:deadline 算一次,两段共用.
    const view = virtualScreens([
      [keyRow(1, "user")],
      [keyRow(2, "assistant")],
      [keyRow(3, "user")],
    ]);
    let clock = 0;
    const now = (): number => clock;
    const settle = (): Promise<void> => {
      clock += 5_000; // 每滚一屏花 5s
      return Promise.resolve();
    };

    // 预算 12s:第一屏吃掉 5s,第二屏吃掉 5s,第三屏时 clock=10s 还没到 12s → 扫完.
    const messages = await readMessages(view, settle, 12_000, now);
    expect(messages).toHaveLength(3);
    expect(clock).toBeLessThanOrEqual(12_000);
  });

  it("预算耗尽:抛 read-failed(读到了也读不完),不是 page-changed", async () => {
    const view = virtualScreens([
      [keyRow(1, "user")],
      [keyRow(2, "assistant")],
      [keyRow(3, "user")],
      [keyRow(4, "assistant")],
    ]);
    let clock = 0;
    const settle = (): Promise<void> => {
      clock += 5_000;
      return Promise.resolve();
    };

    // 预算 12s:滚到第三屏时 clock 已到 15s > 12s → 到点收手.
    await expect(readMessages(view, settle, 12_000, () => clock)).rejects.toMatchObject({
      code: ACTION_ERROR_READ_FAILED,
    });
  });

  it("timeout 缺省 25 / 非法按 25 / 超上限 25 / 低于下限 1(与 wait.* 同口径)", () => {
    const of = (params: Record<string, unknown>): number =>
      parseWaitSeconds({ type: "action", id: "x", action: "messages.list", params, target: "42" });
    expect(of({})).toBe(25);
    expect(of({ timeout: Number.NaN })).toBe(25);
    expect(of({ timeout: "8" })).toBe(25); // 非数
    expect(of({ timeout: 999 })).toBe(25);
    expect(of({ timeout: 0 })).toBe(1);
    expect(of({ timeout: -5 })).toBe(1);
    expect(of({ timeout: 8 })).toBe(8);
  });
});
