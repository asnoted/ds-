/**
 * 页面动作注册表(#99):一件动作一行,这里是**唯一声明点**.
 *
 * 名册(`ACTION_ROSTER`)、三道闸名单(总开关豁免 / 代你发言 / 退避)与发送限速名单
 * (`SEND_PRIMITIVES`)全部从这张表派生:加一件页面动作 = 加一行 + 一条行为用例,
 * 不再是"碰 5 处代码 + 2 处文档,完整性靠人记".四个标志漏写一个,
 * `registry.test.ts` 的结构守卫当场红.
 *
 * **闸归类必须在行上显式写标志,不做任何推断**:闸只管发送(ADR-0006),
 * 不拿行上别的记述去推闸--推闸等于悄悄改 ADR.
 * `BACKOFF_GATED_ACTIONS` 与 `SPEAK_GATED_ACTIONS` 不再互为子集,各行各写各的.
 *
 * `target` 形态与 `protocol/fixtures/action.json` 对拍:标 `"null"` 的动作由
 * background 的 `runAction` 就地执行(target 只能是 null,探针 `page-action.py`
 * 文件头那条知识由用例核对);标 `"tab"` 的都要目标标签页,在内容脚本的名册里执行.
 */

import type { ActionFrame } from "./action";
import type { ActionRoster } from "./channel";
import { CONTROL_ACTIONS } from "./controls";
import { lastMessage, listMessages } from "./messages";
import {
  buttonClick,
  clearComposer,
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
  typeComposer,
} from "./page";
import { waitFence, waitReply } from "./wait";

/** 执行:target 标签页那一跳的执行器;`null` = background 就地执行(不在名册里). */
export type ActionRun = (frame: ActionFrame) => unknown;

/** target 形态:`"tab"` 要目标标签页 id;`"null"` 只能是 null. */
export type ActionTarget = "tab" | "null";

/** 注册表的一行:名字即键(`ACTION_REGISTRY` 的键). */
export type ActionRow = {
  /** 执行器;`null` = background 就地执行,名册里没有这一件. */
  readonly run: ActionRun | null;
  /** target 形态(与协议 fixture 对拍,见文件头). */
  readonly target: ActionTarget;
  /** 总开关豁免:开关关着也照常执行(开关自己的读写,关掉后还得能翻回来). */
  readonly toggleExempt: boolean;
  /**
   * "代你发言"闸(ADR-0006):关着时回 `disabled`,**页面上不留任何东西**--只管
   * **发送**;写草稿放行.原语收窄过一次:原先管"动写作框的",连 `composer.type` /
   * `composer.clear` 都算;现在只管发--往输入框里写字不叫替人开口,协调者写的内容
   * 只落在草稿里,人自己按发送才算.读(`composer.read`)照旧不受管.
   *
   * 闸关着:`composer.type` 放行、`send.enter` 拦下 → 那条问题留在输入框当草稿;
   * 自动续聊同理,只把短标记写进去,不按发送(`inject.content.ts` 的半自动分支).
   */
  readonly speak: boolean;
  /**
   * 退避闸:会改变页面状态的(写动作 + 开启新对话)在账号处罚区时回 `backing-off`;
   * 读动作一律 false--处罚区里人与 agent 仍要能读处境.名单与 `speak` **各写各的**
   * (ADR-0006:那层"靠在 speak 名单里顺带"的语义已经换了,靠它会跟着漏),
   * 新增写动作要显式记进来.
   */
  readonly backoff: boolean;
  /** 发送限速(ADR-0004 的线,同一分布):与上一次发送之间要隔 3~15 秒的原语. */
  readonly paced: boolean;
};

/** 8 个控件动作的执行仍由 `controls.ts` 出(位置表只有那一份),这里只点名. */
function control(name: string): ActionRun {
  return (frame) => {
    const run = CONTROL_ACTIONS[name];
    if (run === undefined) throw new Error(`controls 名册里没有 ${name}`);
    return run(frame);
  };
}

export const ACTION_REGISTRY: Readonly<Record<string, ActionRow>> = {
  // — background 就地执行:target 恒为 null,名册里没有 —
  "tabs.list": {
    run: null,
    target: "null",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  "toggle.get": {
    run: null,
    target: "null",
    toggleExempt: true,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 总开关的写:豁免总开关(关着时还得能把它打开).
  "toggle.set": {
    run: null,
    target: "null",
    toggleExempt: true,
    speak: false,
    backoff: false,
    paced: false,
  },
  // storage.local 的读写口(探针走消息流取持久态).豁免总开关,理由同 toggle.*:
  // 关掉后探针仍要能读到闸与退避的现值,否则排查只能自己捅 storage.
  "storage.get": {
    run: null,
    target: "null",
    toggleExempt: true,
    speak: false,
    backoff: false,
    paced: false,
  },
  "storage.set": {
    run: null,
    target: "null",
    toggleExempt: true,
    speak: false,
    backoff: false,
    paced: false,
  },
  "storage.remove": {
    run: null,
    target: "null",
    toggleExempt: true,
    speak: false,
    backoff: false,
    paced: false,
  },

  // — 名册:内容脚本执行,target 要标签页 —
  "page.state": {
    run: readPageState,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  "composer.read": {
    run: readComposer,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 写草稿放行(ADR-0006),但仍是写动作,处罚区里照拦(#52).
  "composer.type": {
    run: typeComposer,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "composer.clear": {
    run: clearComposer,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "think.get": {
    run: readThink,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 写作框旁的开关(#30):改页面状态是写;不"代你发言".
  "think.set": {
    run: setThink,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "search.get": {
    run: readSearch,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  "search.set": {
    run: setSearch,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "button.get": {
    run: readButton,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 圆键可能在发也可能在停:一律按"可能是替你开口"拦,按最坏拦(2026-10-05 用户定).
  "button.click": {
    run: buttonClick,
    target: "tab",
    toggleExempt: false,
    speak: true,
    backoff: true,
    paced: true,
  },
  "send.enter": {
    run: pressEnter,
    target: "tab",
    toggleExempt: false,
    speak: true,
    backoff: true,
    paced: true,
  },
  // 开新对话不动写作框,但开的是新对话,也是写.
  "chat.new": {
    run: newChat,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "chats.list": {
    run: listChats,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 切换会话:改页面状态是写;不动写作框,不"代你发言".
  "chat.switch": {
    run: switchChat,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "sidebar.get": {
    run: readSidebar,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 侧栏开关:改页面状态是写;不动写作框,不"代你发言".
  "sidebar.set": {
    run: setSidebar,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  // 消息工具栏六项 + 代码块两项:点了会改页面 / 账号状态,是写(只有 retry 也算发送).
  "message.copy": {
    run: control("message.copy"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  // 重新生成:让账号再生成一条回答,等同发送--按最坏拦.
  "message.retry": {
    run: control("message.retry"),
    target: "tab",
    toggleExempt: false,
    speak: true,
    backoff: true,
    paced: true,
  },
  "message.like": {
    run: control("message.like"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "message.dislike": {
    run: control("message.dislike"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "message.read": {
    run: control("message.read"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "message.share": {
    run: control("message.share"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "code.copy": {
    run: control("code.copy"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  "code.download": {
    run: control("code.download"),
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: true,
    paced: false,
  },
  // 只读那批:读对话走 DOM(#20 口径),不碰站点的响应体.
  "messages.list": {
    run: listMessages,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  "messages.last": {
    run: lastMessage,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  // 等动作(#22):等围栏,等回灌--只读,不动写作框.
  "wait.fence": {
    run: waitFence,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
  "wait.reply": {
    run: waitReply,
    target: "tab",
    toggleExempt: false,
    speak: false,
    backoff: false,
    paced: false,
  },
};

/** 按行上一个标志取动作名:四份名单都从这里来,不再各写各的字面量. */
function actionNamesWhere(flag: (row: ActionRow) => boolean): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, row] of Object.entries(ACTION_REGISTRY)) {
    if (flag(row)) names.add(name);
  }
  return names;
}

/** 内容脚本的本地名册:要标签页、有执行器的那些(动作名 → 执行器). */
export const ACTION_ROSTER: ActionRoster = Object.fromEntries(
  Object.entries(ACTION_REGISTRY).flatMap(([name, row]) =>
    row.run === null ? [] : ([[name, row.run]] as const),
  ),
);

/** 不受总开关管的:开关本身的读写.关掉后还得能把开关翻回来. */
export const TOGGLE_ACTIONS: ReadonlySet<string> = actionNamesWhere((row) => row.toggleExempt);

/** "代你发言"闸下的动作(ADR-0006):**替你把消息发出去**的那些. */
export const SPEAK_GATED_ACTIONS: ReadonlySet<string> = actionNamesWhere((row) => row.speak);

/** 退避闸下的动作:会改变页面状态的那些(写动作 + 开启新对话);读不受管. */
export const BACKOFF_GATED_ACTIONS: ReadonlySet<string> = actionNamesWhere((row) => row.backoff);

/** 发送限速的原语(ADR-0004 的线,同一分布):三次发送之间要合成一条 3~15 秒线的那些. */
export const SEND_PRIMITIVES: ReadonlySet<string> = actionNamesWhere((row) => row.paced);
