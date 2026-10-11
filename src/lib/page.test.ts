import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTION_ERROR_PAGE_CHANGED, ACTION_ERROR_UNKNOWN, PageError } from "./action";
import { evidenceHtml } from "./evidence";
import { fixtureCases, type ActionCase } from "./fixtures";
import {
  BUTTON_SELECTOR,
  buttonClick,
  clearComposer,
  findButton,
  listChats,
  newChat,
  pressEnter,
  readButton,
  readComposer,
  readPageState,
  readSearch,
  readSidebar,
  readThink,
  setSearch,
  setSidebar,
  setThink,
  switchChat,
  TOGGLE_POLL_MS,
  TOGGLE_SETTLE_MS,
  typeComposer,
} from "./page";

const FRAME = {
  type: "action",
  id: "p-1",
  action: "page.state",
  params: {},
  target: "42",
} as const;

describe("page.state 执行器", () => {
  it("读当前地址,标题,写作框在不在", () => {
    document.title = "DeepSeek - 深度求索";
    document.body.innerHTML = "<textarea></textarea>";

    const state = readPageState(FRAME);

    expect(state.url).toBe(location.href);
    expect(state.title).toBe("DeepSeek - 深度求索");
    expect(state.composerPresent).toBe(true);
  });

  it("没有写作框时 composerPresent=false", () => {
    document.body.innerHTML = "<div>无框</div>";

    expect(readPageState(FRAME).composerPresent).toBe(false);
  });

  it("contenteditable 也算写作框", () => {
    document.body.innerHTML = '<div contenteditable="true"></div>';

    expect(readPageState(FRAME).composerPresent).toBe(true);
  });

  // 下面这组是 #2:写作框不在的时候页面自己知道为什么,扩展要认出来,不能空等.
  // 判据的结构与文案是 2026-10-02 从真机页面抄的(`.output/web.html`).
  const MUTE_ALERT =
    '<div class="ds-alert ds-alert--warning ds-alert--bordered">' +
    '<div class="ds-alert__content">由于违反用户使用规范,你的账号已被禁言至 ' +
    '2026 年 10 月 10 日 20:21,如有疑问请 <div role="button">联系我们.</div></div></div>';

  it("写作框在 → 处境 ready", () => {
    document.body.innerHTML = `<textarea></textarea>${MUTE_ALERT}`;

    expect(readPageState(FRAME).account).toEqual({ kind: "ready" });
  });

  it("没有写作框 + 警示条里有处罚句 → muted,解封时刻按站上写的原样带出来", () => {
    document.body.innerHTML = MUTE_ALERT;

    expect(readPageState(FRAME).account).toEqual({
      kind: "muted",
      until: "2026 年 10 月 10 日 20:21",
    });
  });

  it('会话正文里出现"禁言"不算处罚(那是常事)--只在警示条里认', () => {
    document.body.innerHTML = '<div class="_871cbca">你被禁言了吗</div>';

    expect(readPageState(FRAME).account).toEqual({ kind: "unknown" });
  });

  it('警示条里只提"禁言"不提账号/你 → 不算处罚句', () => {
    document.body.innerHTML = '<div class="ds-alert__content">本周禁言赛制调整,详情见公告</div>';

    expect(readPageState(FRAME).account).toEqual({ kind: "unknown" });
  });

  it("是处罚句但认不出时刻 → 仍算 muted,until 交 null(认不出时间≠没禁)", () => {
    document.body.innerHTML =
      '<div class="ds-alert__content">你的账号已被封禁,解除时间另行通知</div>';

    expect(readPageState(FRAME).account).toEqual({ kind: "muted", until: null });
  });

  it("没有写作框,没处罚句,又在登录页 → signed-out", () => {
    window.history.replaceState(null, "", "/sign_in");
    document.body.innerHTML = "<div>登录</div>";

    expect(readPageState(FRAME).account).toEqual({ kind: "signed-out" });
    window.history.replaceState(null, "", "/");
  });

  it("没有写作框,没处罚句,也不在登录页 → unknown,不猜", () => {
    window.history.replaceState(null, "", "/a/chat/s/abc123");
    document.body.innerHTML = "<div>无框</div>";

    expect(readPageState(FRAME).account).toEqual({ kind: "unknown" });
    window.history.replaceState(null, "", "/");
  });

  it("result 的键与共享 fixture 的 page.state 样例一致(TS 与 Python 共读)", () => {
    const sample = fixtureCases<ActionCase>("action.json").find(
      ({ name }) => name === "page.state 成功",
    )?.response;
    if (!sample || !sample.ok) throw new Error("fixture 里没有 page.state 成功样例");

    document.title = "t";
    document.body.innerHTML = "";

    expect(Object.keys(readPageState(FRAME)).sort()).toEqual(
      Object.keys(sample.result as object).sort(),
    );
  });
});

describe("composer.* 执行器", () => {
  const typeFrame = (text: unknown) =>
    ({ ...FRAME, action: "composer.type", params: { text } }) as const;

  it("读得到框里的字", () => {
    document.body.innerHTML = "<textarea>写了一半</textarea>";

    expect(readComposer(FRAME)).toEqual({ text: "写了一半" });
  });

  it("写进去的是原生 setter + 冒泡 input(React 受控输入的写法),且不发送", () => {
    document.body.innerHTML = "<textarea></textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;
    const seen: string[] = [];
    el.addEventListener("input", (event) => seen.push((event.target as HTMLTextAreaElement).value));

    typeComposer(typeFrame("你好"));

    expect(el.value).toBe("你好");
    expect(seen).toEqual(["你好"]); // 那次 input 事件真派了,也冒泡到监听者
  });

  it("params.text 不是字符串就写空", () => {
    document.body.innerHTML = "<textarea>旧字</textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;

    typeComposer(typeFrame(42));

    expect(el.value).toBe("");
  });

  it("清空框里的字", () => {
    document.body.innerHTML = "<textarea>旧字</textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;

    clearComposer(FRAME);

    expect(el.value).toBe("");
  });

  it("没有写作框就抛(由收信那层折成失败码)", () => {
    document.body.innerHTML = "<div>无框</div>";

    expect(() => typeComposer(typeFrame("x"))).toThrow();
    expect(() => clearComposer(FRAME)).toThrow();
  });
});

describe("send.* 执行器", () => {
  const SEND = 'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle';

  // jsdom 不做布局,所有元素的 getClientRects 都是空--测试里手工补一个盒子.
  const stubBox = (el: Element): void => {
    (el as HTMLElement).getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };

  it("findButton:在且没禁用就回它", () => {
    document.body.innerHTML = `<div role="button" class="${BUTTON_SELECTOR.split(".").slice(1).join(" ")}"></div>`;
    stubBox(document.querySelector(BUTTON_SELECTOR) as Element);
    expect(findButton()).not.toBeNull();
  });

  it("findButton:class 带 ds-button--disabled 回 null", () => {
    document.body.innerHTML = `<div role="button" class="${BUTTON_SELECTOR.split(".").slice(1).join(" ")} ds-button--disabled"></div>`;
    stubBox(document.querySelector(BUTTON_SELECTOR) as Element);
    expect(findButton()).toBeNull();
  });

  it("findButton:没这个键也回 null", () => {
    document.body.innerHTML = "<div>什么都没有</div>";
    expect(findButton()).toBeNull();
  });

  it("findButton:没渲染出盒子(不可见)也当没找到", () => {
    document.body.innerHTML = `<div role="button" class="${BUTTON_SELECTOR.split(".").slice(1).join(" ")}"></div>`;
    // 不 stub:jsdom 里天然 getClientRects().length === 0
    expect(findButton()).toBeNull();
  });

  it("点那个圆键(设计系统的主操作键)", () => {
    document.body.innerHTML = `<textarea></textarea><div role="button" class="${SEND.split(".").slice(1).join(" ")}"></div>`;
    const el = document.querySelector(SEND) as HTMLElement;
    stubBox(el);
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    buttonClick(FRAME);

    expect(clicked).toBe(1);
  });

  it("圆键禁用(class 带 ds-button--disabled)就抛,别假装点过了", () => {
    document.body.innerHTML = `<div role="button" class="${SEND.split(".").slice(1).join(" ")} ds-button--disabled"></div>`;

    expect(() => buttonClick(FRAME)).toThrow();
  });

  it("找不到圆键也抛", () => {
    document.body.innerHTML = "<div>什么都没有</div>";

    expect(() => buttonClick(FRAME)).toThrow();
  });

  it("回车:在写作框上派 keydown Enter", () => {
    document.body.innerHTML = "<textarea></textarea>";
    const el = document.querySelector("textarea") as HTMLTextAreaElement;
    const keys: string[] = [];
    el.addEventListener("keydown", (event) => keys.push((event as KeyboardEvent).key));

    pressEnter(FRAME);

    expect(keys).toEqual(["Enter"]);
  });
});

describe("chat.new 执行器", () => {
  it('点侧栏那个"开启新对话"条目', () => {
    document.body.innerHTML = '<div tabindex="0">开启新对话</div><div tabindex="0">别的</div>';
    const el = document.querySelector('[tabindex="0"]') as HTMLElement;
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    newChat(FRAME);

    expect(clicked).toBe(1);
  });

  it("找不到那个条目就抛", () => {
    document.body.innerHTML = "<div>什么都没有</div>";

    expect(() => newChat(FRAME)).toThrow();
  });
});

describe("think.* / search.* 开关执行器(#30)", () => {
  const THINK_ON = '<div class="ds-toggle-button" aria-pressed="true">深度思考</div>';
  const THINK_OFF = '<div class="ds-toggle-button" aria-pressed="false">深度思考</div>';

  /** 带 params 的动作帧. */
  const withParams = (params: Record<string, unknown>) => ({ ...FRAME, params });

  /** 执行器抛的 `PageError` 码;没抛或抛的不是 PageError 一律回 undefined. */
  function thrownCode(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (error) {
      return error instanceof PageError ? error.code : undefined;
    }
    return undefined;
  }

  function toggleEl(): HTMLElement {
    return document.querySelector("div.ds-toggle-button") as HTMLElement;
  }

  it("get:aria-pressed=true 才算开着,别的一律算关", () => {
    document.body.innerHTML = THINK_ON;
    expect(readThink(FRAME)).toEqual({ enabled: true });

    document.body.innerHTML = THINK_OFF;
    expect(readThink(FRAME)).toEqual({ enabled: false });
  });

  it("get:tolerant 文字前后空白,只认 div.ds-toggle-button", () => {
    document.body.innerHTML =
      '<div class="other-button" aria-pressed="true">深度思考</div>' +
      '<div class="ds-toggle-button" aria-pressed="false"> 深度思考 </div>';
    expect(readThink(FRAME)).toEqual({ enabled: false });
  });

  it("get:找不到认得的控件 → page-changed(不猜)", () => {
    document.body.innerHTML = '<div class="ds-toggle-button">别的开关</div>';
    expect(thrownCode(() => readThink(FRAME))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });

  afterEach(() => vi.useRealTimers());

  it("set:目标态与当前不同 → 点一下,回达成态", async () => {
    document.body.innerHTML = THINK_OFF;
    const el = toggleEl();
    let clicked = 0;
    el.addEventListener("click", () => {
      clicked += 1;
      el.setAttribute("aria-pressed", "true"); // 模拟站点拨到目标态
    });

    expect(await setThink(withParams({ enabled: true }))).toEqual({ enabled: true });
    expect(clicked).toBe(1);
  });

  it("set:已在目标态 → 不点,不轮询(幂等,点了反而拨反;也不给幂等调用加延迟)", async () => {
    vi.useFakeTimers(); // 一旦实现里等了定时器,下面这个 await 就永远不回
    document.body.innerHTML = THINK_ON;
    const el = toggleEl();
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    expect(await setThink(withParams({ enabled: true }))).toEqual({ enabled: true });
    expect(clicked).toBe(0);
  });

  it("set:回的是达成态,不是目标态(站点一直没拨过去,等满上限后说没拨过去)", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = THINK_OFF;
    toggleEl().addEventListener("click", () => undefined); // 点了也不变

    const pending = setThink(withParams({ enabled: true }));
    await vi.advanceTimersByTimeAsync(TOGGLE_SETTLE_MS + 100);

    expect(await pending).toEqual({ enabled: false });
  });

  it("set:站点异步生效(#81)--点完那一刻还是旧值,上限内才变,回的是变好之后的值", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = THINK_OFF;
    const el = toggleEl();
    el.addEventListener("click", () => {
      setTimeout(() => el.setAttribute("aria-pressed", "true"), 300); // 站点异步生效
    });

    let settled: { enabled: boolean } | undefined;
    const pending = setThink(withParams({ enabled: true })).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBeUndefined(); // 还没变,不能提前回旧值
    await vi.advanceTimersByTimeAsync(300);
    await pending;

    expect(settled).toEqual({ enabled: true });
  });

  it("set:到了目标态就立刻收,不等满上限", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = THINK_OFF;
    const el = toggleEl();
    el.addEventListener("click", () => {
      setTimeout(() => el.setAttribute("aria-pressed", "true"), 120);
    });

    let done = false;
    const pending = setThink(withParams({ enabled: true })).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(120 + TOGGLE_POLL_MS);
    await pending;

    expect(done).toBe(true);
    expect(TOGGLE_SETTLE_MS).toBeGreaterThan(120 + TOGGLE_POLL_MS); // 收的时候离上限还远
  });

  it('set:enabled 非布尔 → unknown-action(别把 "true" 按真值收下)', async () => {
    document.body.innerHTML = THINK_OFF;
    await expect(setThink(withParams({ enabled: "true" }))).rejects.toMatchObject({
      code: ACTION_ERROR_UNKNOWN,
    });
    await expect(setThink(withParams({}))).rejects.toMatchObject({ code: ACTION_ERROR_UNKNOWN });
  });

  it('search:认"智能搜索"那个开关,与 think 各认各的', async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      THINK_ON + '<div class="ds-toggle-button" aria-pressed="false">智能搜索</div>';
    const [think, search] = [...document.querySelectorAll<HTMLElement>("div.ds-toggle-button")] as [
      HTMLElement,
      HTMLElement,
    ];
    let thinkClicked = 0;
    let searchClicked = 0;
    think.addEventListener("click", () => (thinkClicked += 1));
    search.addEventListener("click", () => (searchClicked += 1));

    expect(readSearch(FRAME)).toEqual({ enabled: false });
    // 点了但站点没变 → 回达成态(false),不是目标态(true).
    const pending = setSearch(withParams({ enabled: true }));
    await vi.advanceTimersByTimeAsync(TOGGLE_SETTLE_MS + 100);
    expect(await pending).toEqual({ enabled: false });
    expect(searchClicked).toBe(1);
    expect(thinkClicked).toBe(0); // 没误点深度思考
  });
});

describe("那个圆键:button.get / button.click", () => {
  // jsdom 不做布局,所有元素的 getClientRects 都是空--测试里手工补一个盒子.
  const stubBox = (el: Element): void => {
    (el as HTMLElement).getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };

  const circle = (): Element => document.querySelector(BUTTON_SELECTOR) as Element;

  /** 执行器抛的 `PageError` 码;没抛或抛的不是 PageError 一律回 undefined. */
  function thrownCode(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (error) {
      return error instanceof PageError ? error.code : undefined;
    }
    return undefined;
  }

  // 真机 2026-10-04 抓的(生成中 / 空闲各一次),原件住 `protocol/evidence/controls.json`(ADR-0018).
  // 两态的 class 一个不换,aria-label 为空,只有圆键里的图标不同--**所以那不是两个控件,
  // 是一个**:合成一个动作 button.click(可用就点),读的部分是 button.get(认图标).
  const STOP_BUTTON_HTML = evidenceHtml("circle.stop");

  // 真机抓的是**空输入框态**(带 ds-button--disabled),图标就是发送箭头.
  const SEND_BUTTON_HTML = evidenceHtml("circle.send");

  // 真机 2026-10-05 抓的**思考期**:圆键位置换成 `<div class="ds-loading">` 的 36×36 环形
  // spinner(`data-icon="spin"`),class 里带 `ds-button--disabled`.图标不是 16×16 的
  // 发送/停止两态之一 → `button.get` 报 `unknown`(成功返回),`button.click` 判它不可用.
  const SPINNER_BUTTON_HTML = evidenceHtml("circle.spinner");

  /** 去掉禁用 class:模拟输入框里有内容的空闲态. */
  const SEND_READY_HTML = SEND_BUTTON_HTML.replace("ds-button--disabled ", "");

  it("button.get:箭头(空闲态)读出 send", () => {
    document.body.innerHTML = SEND_BUTTON_HTML;
    stubBox(circle());

    expect(readButton(FRAME)).toEqual({ pressed: "send" });
  });

  it("button.get:方块(生成中)读出 stop", () => {
    document.body.innerHTML = STOP_BUTTON_HTML;
    stubBox(circle());

    expect(readButton(FRAME)).toEqual({ pressed: "stop" });
  });

  it("button.get:图标认不出回 unknown -- 成功返回,不抛", () => {
    // 换一条既非箭头也非方块的 path(站点换图标 / 思考期环形都是这种,见 site-dom)
    document.body.innerHTML = STOP_BUTTON_HTML.replace("M2 4.88", "M9 9.99");
    stubBox(circle());

    expect(readButton(FRAME)).toEqual({ pressed: "unknown" });
  });

  it('button.get:键在但禁用(空输入框)照样读 -- 图标就是箭头,不是"找不到"', () => {
    document.body.innerHTML = SEND_BUTTON_HTML; // 真机那份就带 ds-button--disabled
    stubBox(circle());

    expect(readButton(FRAME)).toEqual({ pressed: "send" });
  });

  it('button.get:圆键整个不在才抛 page-changed(与"认不出"是两回事)', () => {
    document.body.innerHTML = "<div>什么都没有</div>";

    expect(thrownCode(() => readButton(FRAME))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });

  it("button.click:方块态(生成中)照点 -- 那就是停止,页面自己的语义", () => {
    document.body.innerHTML = STOP_BUTTON_HTML;
    const el = circle() as HTMLElement;
    stubBox(el);
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    buttonClick(FRAME);

    expect(clicked).toBe(1);
  });

  it("button.click:箭头态(空闲)照点", () => {
    document.body.innerHTML = SEND_READY_HTML;
    const el = circle() as HTMLElement;
    stubBox(el);
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    buttonClick(FRAME);

    expect(clicked).toBe(1);
  });

  it("button.click:禁用态不点(空输入框时它按 class 禁用)", () => {
    document.body.innerHTML = SEND_BUTTON_HTML;
    const el = circle() as HTMLElement;
    stubBox(el);
    let clicked = 0;
    el.addEventListener("click", () => (clicked += 1));

    expect(() => buttonClick(FRAME)).toThrow();
    expect(clicked).toBe(0);
  });

  it("没渲染出盒子(不可见)当没找到:get 与 click 都不认", () => {
    document.body.innerHTML = STOP_BUTTON_HTML;
    // 不 stub:jsdom 里天然 getClientRects().length === 0

    expect(findButton()).toBeNull();
    expect(() => buttonClick(FRAME)).toThrow();
  });

  it("真机回归:思考期的环形 spinner -- get 报 unknown,click 判不可用(真机 2026-10-05)", () => {
    document.body.innerHTML = SPINNER_BUTTON_HTML;
    stubBox(circle());

    // 图标既非箭头也非方块:读得出"认不出",是成功返回不是失败
    expect(readButton(FRAME)).toEqual({ pressed: "unknown" });
    // 它带 ds-button--disabled → 可用性判据挡住点击(真机确认过它带这个 class)
    expect(thrownCode(() => buttonClick(FRAME))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });
});

describe("chats.list / chat.switch 执行器", () => {
  // 原件取自存证 `sidebar.chat-row`(真机 2026-10-07,ADR-0018):整条 `<a>`,含"更多"按钮.
  // 只在取到的原件上做最小变形--换 href 里的 uuid,换标题文字;不手抄一整条.
  const ROW = evidenceHtml("sidebar.chat-row");
  const ROW_ID = /\/a\/chat\/s\/[0-9a-f-]+/;
  const ROW_TITLE = />[^<>]+<\/div><div class="_254829d">/;

  function row(id: string, title: string): string {
    return ROW.replace(ROW_ID, `/a/chat/s/${id}`).replace(
      ROW_TITLE,
      `>${title}</div><div class="_254829d">`,
    );
  }

  function sidebar(...rows: string[]): void {
    document.body.innerHTML = `<div class="_3098d02"><div>7 天内</div>${rows.join("")}</div>`;
  }

  const switchFrame = (params: Record<string, unknown>) =>
    ({ ...FRAME, action: "chat.switch", params }) as const;

  /** 点了谁:给每条挂计数,返回按 id 取点击次数的函数. */
  function trackClicks(): (id: string) => number {
    const counts = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLAnchorElement>('a[href^="/a/chat/s/"]')) {
      // 真浏览器点 `<a>` 会真导航;jsdom 里拦下默认行为只数次数.
      el.addEventListener("click", (event) => {
        event.preventDefault();
        const id = (el.getAttribute("href") ?? "").split("/").pop() ?? "";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      });
    }
    return (id) => counts.get(id) ?? 0;
  }

  const thrownCode = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof PageError ? error.code : undefined;
    }
    return undefined;
  };

  beforeEach(() => history.pushState({}, "", "/"));

  it("存证原件解析得出 id 与标题(变形没把原件改坏)", () => {
    sidebar(row("aaaa-1111", "协议确认"));

    expect(listChats(FRAME)).toEqual({
      chats: [{ id: "aaaa-1111", title: "协议确认", current: false }],
    });
  });

  it("chats.list:按侧栏顺序列出,同名各占一条,当前会话 current 为真", () => {
    history.pushState({}, "", "/a/chat/s/bbbb-2222");
    sidebar(row("aaaa-1111", "协议确认"), row("bbbb-2222", "重名"), row("cccc-3333", "重名"));

    expect(listChats(FRAME)).toEqual({
      chats: [
        { id: "aaaa-1111", title: "协议确认", current: false },
        { id: "bbbb-2222", title: "重名", current: true },
        { id: "cccc-3333", title: "重名", current: false },
      ],
    });
  });

  it("chats.list:侧栏上一条都没有回空数组,不算错", () => {
    document.body.innerHTML = "<div>空的</div>";

    expect(listChats(FRAME)).toEqual({ chats: [] });
  });

  it("chat.switch:按 id 点中那一条,只点它", () => {
    sidebar(row("aaaa-1111", "协议确认"), row("bbbb-2222", "重名"));
    const clicks = trackClicks();

    expect(switchChat(switchFrame({ id: "bbbb-2222" }))).toEqual({});
    expect([clicks("aaaa-1111"), clicks("bbbb-2222")]).toEqual([0, 1]);
  });

  it("chat.switch:按标题切,标题唯一就点", () => {
    sidebar(row("aaaa-1111", "协议确认"), row("bbbb-2222", "重名"));
    const clicks = trackClicks();

    expect(switchChat(switchFrame({ title: "协议确认" }))).toEqual({});
    expect([clicks("aaaa-1111"), clicks("bbbb-2222")]).toEqual([1, 0]);
  });

  it("chat.switch:标题重名回 unknown-action,一条都不点", () => {
    sidebar(row("aaaa-1111", "重名"), row("bbbb-2222", "重名"));
    const clicks = trackClicks();

    expect(thrownCode(() => switchChat(switchFrame({ title: "重名" })))).toBe(ACTION_ERROR_UNKNOWN);
    expect([clicks("aaaa-1111"), clicks("bbbb-2222")]).toEqual([0, 0]);
  });

  it("chat.switch:id 或标题命中 0 条回 page-changed,不点", () => {
    sidebar(row("aaaa-1111", "协议确认"));
    const clicks = trackClicks();

    expect(thrownCode(() => switchChat(switchFrame({ id: "none" })))).toBe(
      ACTION_ERROR_PAGE_CHANGED,
    );
    expect(thrownCode(() => switchChat(switchFrame({ title: "没有这一条" })))).toBe(
      ACTION_ERROR_PAGE_CHANGED,
    );
    expect(clicks("aaaa-1111")).toBe(0);
  });

  it.each([
    ["都没给", {}],
    ["都给了", { id: "aaaa-1111", title: "协议确认" }],
    ["空串", { id: "" }],
    ["不是字符串", { id: 1111 }],
    ["标题是空串", { title: "" }],
  ])("chat.switch:参数形状不对(%s)回 unknown-action,不点", (_name, params) => {
    sidebar(row("aaaa-1111", "协议确认"));
    const clicks = trackClicks();

    expect(thrownCode(() => switchChat(switchFrame(params)))).toBe(ACTION_ERROR_UNKNOWN);
    expect(clicks("aaaa-1111")).toBe(0);
  });

  it("chat.switch:命中的就是当前会话,不点,回 {}(幂等)", () => {
    history.pushState({}, "", "/a/chat/s/aaaa-1111");
    sidebar(row("aaaa-1111", "协议确认"), row("bbbb-2222", "别的"));
    const clicks = trackClicks();

    expect(switchChat(switchFrame({ id: "aaaa-1111" }))).toEqual({});
    expect([clicks("aaaa-1111"), clicks("bbbb-2222")]).toEqual([0, 0]);
  });

  it("chat.switch:标题前后空白容忍,其余严格相等", () => {
    sidebar(row("aaaa-1111", "协议确认"));
    const clicks = trackClicks();

    expect(switchChat(switchFrame({ title: "  协议确认 " }))).toEqual({});
    expect(clicks("aaaa-1111")).toBe(1);
    expect(thrownCode(() => switchChat(switchFrame({ title: "协议" })))).toBe(
      ACTION_ERROR_PAGE_CHANGED,
    );
  });

  it("结果的键与共享 fixture 的 chats.list 样例一致(TS 与 Python 共读)", () => {
    const sample = fixtureCases<ActionCase>("action.json").find(
      ({ name }) => name === "chats.list 成功",
    )?.response;
    if (!sample || !sample.ok) throw new Error("fixture 里没有 chats.list 成功样例");
    const fixtureRow = (sample.result as { chats: object[] }).chats[0] as object;
    sidebar(row("aaaa-1111", "协议确认"));

    expect(Object.keys(listChats(FRAME).chats[0] as object).sort()).toEqual(
      Object.keys(fixtureRow).sort(),
    );
  });
});

describe("sidebar.get / sidebar.set 执行器", () => {
  // 原件取自存证(真机 2026-10-07,ADR-0018):展开 / 收起两态的顶栏容器.只做最小变形,不手抄.
  const EXPANDED_BAR = evidenceHtml("sidebar.topbar.expanded");
  const COLLAPSED_BAR = evidenceHtml("sidebar.topbar.collapsed");
  const NEW_CHAT = '<div tabindex="0">开启新对话</div>';
  const CHAT_ROW = '<a href="/a/chat/s/aaaa-1111"><div>一条会话</div></a>';

  /** jsdom 没有布局:给元素钉上"有 / 没有布局盒". */
  function layout(el: Element, visible: boolean): void {
    (el as HTMLElement).getClientRects = () =>
      (visible ? [{ width: 1, height: 1 }] : []) as unknown as DOMRectList;
  }

  /** 搭一个侧栏:顶栏容器原件 + 带文字的锚 + 一条会话;按状态给每个元素钉布局盒. */
  function sidebar(collapsed: boolean, bar = collapsed ? COLLAPSED_BAR : EXPANDED_BAR): void {
    document.body.innerHTML = `<div id="root"><div>${bar}</div><div>${NEW_CHAT}${CHAT_ROW}</div></div>`;
    for (const el of document.querySelectorAll("#root *")) layout(el, true);
    // 收起:锚与会话条目没有布局盒(顶栏的几颗按钮仍在).
    const hidden = document.querySelectorAll('[tabindex="0"]:not([role]), a');
    for (const el of hidden) layout(el, !collapsed);
  }

  const toggleFrame = (params: Record<string, unknown>) =>
    ({ ...FRAME, action: "sidebar.set", params }) as const;

  /** 给顶栏组里的按钮记点击;`flip` 为真时点中开关键就把侧栏翻成另一态(模拟站点). */
  function wire(flip?: { afterMs: number; to: boolean }): Map<number, number> {
    const clicks = new Map<number, number>();
    const group = document.querySelector('[role="button"].ds-button--icon')?.parentElement;
    [...(group?.children ?? [])]
      .filter((child) => child.getAttribute("role") === "button")
      .forEach((button, index) => {
        button.addEventListener("click", () => {
          clicks.set(index + 1, (clicks.get(index + 1) ?? 0) + 1);
          if (flip !== undefined) {
            setTimeout(() => {
              const anchor = [...document.querySelectorAll('[tabindex="0"]')].find(
                (e) => e.textContent === "开启新对话",
              );
              if (anchor) layout(anchor, !flip.to);
            }, flip.afterMs);
          }
        });
      });
    return clicks;
  }

  const thrownCode = async (fn: () => unknown): Promise<string | undefined> => {
    try {
      await fn();
    } catch (error) {
      return error instanceof PageError ? error.code : undefined;
    }
    return undefined;
  };

  afterEach(() => vi.useRealTimers());

  it("存证原件的前提:展开顶栏 2 颗,收起顶栏 3 颗,都是无字图标键", () => {
    sidebar(false);
    expect(document.querySelectorAll('[role="button"].ds-button--icon').length).toBe(2);
    sidebar(true);
    expect(document.querySelectorAll('[role="button"].ds-button--icon').length).toBe(3);
  });

  it("sidebar.get:锚有布局盒 = 展开,没有 = 收起", () => {
    sidebar(false);
    expect(readSidebar(FRAME)).toEqual({ collapsed: false });
    sidebar(true);
    expect(readSidebar(FRAME)).toEqual({ collapsed: true });
  });

  it('sidebar.get:找不到"开启新对话"锚回 page-changed', async () => {
    document.body.innerHTML = "<div>没有侧栏</div>";
    expect(await thrownCode(() => readSidebar(FRAME))).toBe(ACTION_ERROR_PAGE_CHANGED);
  });

  it("收起:展开态点 2 颗里的第 2 颗,等稳定后回 collapsed:true,没点别的", async () => {
    vi.useFakeTimers();
    sidebar(false);
    const clicks = wire({ afterMs: 200, to: true });

    const pending = setSidebar(toggleFrame({ collapsed: true }));
    await vi.advanceTimersByTimeAsync(400);

    expect(await pending).toEqual({ collapsed: true });
    expect([...clicks.entries()]).toEqual([[2, 1]]);
  });

  it("展开:收起态点 3 颗里的第 1 颗,没点搜索 / 新对话", async () => {
    vi.useFakeTimers();
    sidebar(true);
    const clicks = wire({ afterMs: 150, to: false });

    const pending = setSidebar(toggleFrame({ collapsed: false }));
    await vi.advanceTimersByTimeAsync(400);

    expect(await pending).toEqual({ collapsed: false });
    expect([...clicks.entries()]).toEqual([[1, 1]]);
  });

  it("已在目标态:不点,不轮询,立即回(fake timers 不推进也不会挂)", async () => {
    vi.useFakeTimers();
    sidebar(false);
    const clicks = wire();

    expect(await setSidebar(toggleFrame({ collapsed: false }))).toEqual({ collapsed: false });
    expect(clicks.size).toBe(0);
  });

  it("站点异步生效:点完那一刻还是旧态,上限内才变,不能提前回旧值(#81 同口径)", async () => {
    vi.useFakeTimers();
    sidebar(false);
    wire({ afterMs: 300, to: true });

    let settled: { collapsed: boolean } | undefined;
    const pending = setSidebar(toggleFrame({ collapsed: true })).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    await pending;

    expect(settled).toEqual({ collapsed: true });
  });

  it("站点拒了这一点:等满上限,回未变的状态而不是目标态", async () => {
    vi.useFakeTimers();
    sidebar(false);
    wire(); // 点了也不翻

    const pending = setSidebar(toggleFrame({ collapsed: true }));
    await vi.advanceTimersByTimeAsync(TOGGLE_SETTLE_MS + 100);

    expect(await pending).toEqual({ collapsed: false });
  });

  it.each([
    ["缺失", {}],
    ["字符串", { collapsed: "yes" }],
    ["数字", { collapsed: 1 }],
  ])("collapsed %s:unknown-action,不点", async (_name, params) => {
    sidebar(false);
    const clicks = wire();

    expect(await thrownCode(() => setSidebar(toggleFrame(params)))).toBe(ACTION_ERROR_UNKNOWN);
    expect(clicks.size).toBe(0);
  });

  it("展开态顶栏多一颗图标键:page-changed,不点", async () => {
    sidebar(false);
    const group = document.querySelector('[role="button"].ds-button--icon')
      ?.parentElement as Element;
    const extra = group.children[0]?.cloneNode(true) as Element;
    group.append(extra);
    layout(extra, true);
    const clicks = wire();

    expect(await thrownCode(() => setSidebar(toggleFrame({ collapsed: true })))).toBe(
      ACTION_ERROR_PAGE_CHANGED,
    );
    expect(clicks.size).toBe(0);
  });

  it("收起态顶栏少一颗:page-changed,不点", async () => {
    sidebar(true);
    const buttons = [...document.querySelectorAll('[role="button"].ds-button--icon')];
    buttons[buttons.length - 1]?.remove();
    const clicks = wire();

    expect(await thrownCode(() => setSidebar(toggleFrame({ collapsed: false })))).toBe(
      ACTION_ERROR_PAGE_CHANGED,
    );
    expect(clicks.size).toBe(0);
  });

  it("别处的图标键不参与:会话列表里分组标题的折叠小键(展开态真机就有一颗)不算顶栏", async () => {
    vi.useFakeTimers();
    sidebar(false);
    // 真机展开态:最近祖先里还有一颗 22px 折叠小键,父元素不同,在会话列表里.
    const stray = document.createElement("div");
    stray.innerHTML =
      '<div><div role="button" class="ds-button ds-button--icon"></div><span>7 天内</span></div>';
    document.querySelector("#root")?.append(stray);
    layout(stray.querySelector('[role="button"]') as Element, true);
    const clicks = wire({ afterMs: 100, to: true });

    const pending = setSidebar(toggleFrame({ collapsed: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toEqual({ collapsed: true });
    expect([...clicks.entries()]).toEqual([[2, 1]]);
  });

  it('会话条目里的"更多"按钮不算顶栏图标键', async () => {
    vi.useFakeTimers();
    sidebar(false);
    const row = document.querySelector("a") as Element;
    row.insertAdjacentHTML(
      "beforeend",
      '<div role="button" class="ds-button ds-button--icon"></div>',
    );
    layout(row.querySelector('[role="button"]') as Element, true);
    const clicks = wire({ afterMs: 100, to: true });

    const pending = setSidebar(toggleFrame({ collapsed: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toEqual({ collapsed: true });
    expect([...clicks.entries()]).toEqual([[2, 1]]);
  });
});
