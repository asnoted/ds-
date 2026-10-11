import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import {
  actionListener,
  accountReportMessage,
  askClearedReportMessage,
  askReportMessage,
  sendRequestMessage,
  pageSessionIdOf,
  parseSendResponse,
  parseChainMessage,
  parseToolsResponse,
  resultMessage,
  saidReportMessage,
  continuationFailReportMessage,
  stopReportMessage,
  parseSendNote,
  sendNoteMessage,
  toolsMessage,
  toolsRequestMessage,
  unreachableResult,
  type ActionRoster,
  type AskClearedMessage,
  type AskMessage,
  type CallMessage,
  type ContinuationFailMessage,
  type SaidMessage,
  type StopMessage,
} from "../src/lib/channel";
import { nextMessageId } from "../src/lib/id";
import {
  buttonClick,
  clearComposer,
  findButton,
  listChats,
  newChat,
  pressEnter,
  readAccount,
  readButton,
  readComposer,
  readPressed,
  readComposerPresent,
  readPageState,
  readSidebar,
  readSearch,
  readThink,
  setSearch,
  setSidebar,
  setThink,
  switchChat,
  typeComposer,
} from "../src/lib/page";
import { CONTROL_ACTIONS } from "../src/lib/controls";
import type { ActionFrame } from "../src/lib/action";
import {
  mergeSendPace,
  newSendPace,
  realSleep,
  runPaced,
  SEND_PRIMITIVES,
  type SendIntent,
  type SendPace,
} from "../src/lib/sendpace";
import { lastMessage, listMessages } from "../src/lib/messages";
import { waitFence, waitReply } from "../src/lib/wait";
import {
  parseToggleMessage,
  readToggle,
  stateMessage,
  TOGGLE_STORAGE_KEY,
  SPEAK_STORAGE_KEY,
  readSpeak,
} from "../src/lib/toggle";

/**
 * 隔离世界这一层握着 `browser.*`,页面世界没有:总开关从 `storage.local` 读了广播过去,
 * 页面世界认出的围栏从这里转给 background 打本机网关(`POST /mcp`),结果原样送回
 * 页面世界;工具目录反过来每分钟问 background 要一次,广播给页面世界拼协议说明.
 *
 * 站点范围在 manifest 权限里钉死为 chat.deepseek.com(权限钉死),
 * 总开关不参与站点判定,只决定页面世界要不要接管.
 */
export default defineContentScript({
  matches: ["https://chat.deepseek.com/*"],
  runAt: "document_start",
  async main() {
    /**
     * 把两个开关的当前状态广播给页面世界.
     *
     * "代你发言"闸一起来了(#52):自动续聊在 MAIN 世界直接写输入框,按发送,不经
     * `runAction`,所以那个世界拿不到 `storage`--只能由这边每次广播时带上.选项页
     * 改闸 → `storage.onChanged` → 再广播一次,不必刷新页面.
     */
    const broadcast = async () => {
      const stored = await browser.storage.local.get([TOGGLE_STORAGE_KEY, SPEAK_STORAGE_KEY]);
      window.postMessage(
        stateMessage(readToggle(stored[TOGGLE_STORAGE_KEY]), readSpeak(stored[SPEAK_STORAGE_KEY])),
        "*",
      );
    };

    /** 页面世界认出的围栏 → background 打网关 → 结果按同一条信封原路回去. */
    const forwardToRelay = async (call: CallMessage): Promise<void> => {
      try {
        const response = await browser.runtime.sendMessage(sendRequestMessage(call.id, call.calls));
        const parsed = parseSendResponse(response);
        window.postMessage(
          parsed === null ? unreachableResult(call.id) : resultMessage(call.id, parsed.payload),
          "*",
        );
      } catch (error) {
        console.log("[ds-] 工具调用没有送出去", error);
        window.postMessage(unreachableResult(call.id), "*");
      }
    };

    /** 页面世界报上来的围栏之外的话 → background 记进 said;不等回话. */
    const reportSaid = async (said: SaidMessage): Promise<void> => {
      try {
        await browser.runtime.sendMessage(saidReportMessage(said.text));
      } catch (error) {
        console.log("[ds-] said 上报没有送出去", error);
      }
    };

    /** 网页排了 ask 围栏问人(#26):报给 background 挂"等人回".
     * 不等回话--上报是通知,不是请求. */
    const reportAsk = async (ask: AskMessage): Promise<void> => {
      try {
        await browser.runtime.sendMessage(
          askReportMessage(ask.id, ask.question, pageSessionIdOf(location.href)),
        );
      } catch (error) {
        console.log("[ds-] ask 上报没有送出去", error);
      }
    };

    /** 对话继续了(人答了或模型自己往下走了):通知 background 清掉"等人回". */
    const reportAskCleared = async (cleared: AskClearedMessage): Promise<void> => {
      try {
        await browser.runtime.sendMessage(
          askClearedReportMessage(cleared.id, pageSessionIdOf(location.href)),
        );
      } catch (error) {
        console.log("[ds-] ask 清除没有送出去", error);
      }
    };

    /** 自动续聊到顶停手:报给 background 留一笔(ADR-0004),不进对话流. */
    const reportStop = async (stop: StopMessage): Promise<void> => {
      try {
        await browser.runtime.sendMessage(
          stopReportMessage(stop.id, stop.cause, pageSessionIdOf(location.href)),
        );
      } catch (error) {
        console.log("[ds-] 停手上报没有送出去", error);
      }
    };

    /** 续聊这一跳失败:报给 background 落一笔失败痕(#51),不进对话流. */
    const reportContinuationFail = async (fail: ContinuationFailMessage): Promise<void> => {
      try {
        await browser.runtime.sendMessage(
          continuationFailReportMessage(fail.id, fail.cause, pageSessionIdOf(location.href)),
        );
      } catch (error) {
        console.log("[ds-] 续聊失败上报没有送出去", error);
      }
    };

    /**
     * 工具目录同步(协议说明要照着它拼):总开关开着时 60s 问 background 要一次,
     * 取到就广播给页面世界;没取到(网关没连上)一声不吭--页面世界沿用上一份,
     * 说明里写着"工具表暂未取到".
     */
    const TOOLS_SYNC_INTERVAL_MS = 60_000;
    let toolsTimer: ReturnType<typeof setInterval> | undefined;
    const syncTools = async (): Promise<void> => {
      try {
        const response = await browser.runtime.sendMessage(toolsRequestMessage());
        const parsed = parseToolsResponse(response);
        if (parsed === null || parsed.tools === null) return;
        window.postMessage(toolsMessage(nextMessageId("tools"), parsed.tools), "*");
      } catch {
        // 目录是通知:送不出去不重试,下一轮还在.
      }
    };
    const startToolsSync = (): void => {
      if (toolsTimer !== undefined) return;
      void syncTools();
      toolsTimer = setInterval(syncTools, TOOLS_SYNC_INTERVAL_MS);
    };
    const stopToolsSync = (): void => {
      if (toolsTimer === undefined) return;
      clearInterval(toolsTimer);
      toolsTimer = undefined;
    };

    /**
     * 账号处境上报(#2):总开关开着时 30s 一报.禁言期写路径全断,
     * 悬停得把这层说清("禁言至何时")--上报是通知,不等回话.
     */
    const ACCOUNT_REPORT_INTERVAL_MS = 30_000;
    let accountTimer: ReturnType<typeof setInterval> | undefined;
    const reportAccount = async (): Promise<void> => {
      try {
        const account = readAccount(readComposerPresent());
        await browser.runtime.sendMessage(accountReportMessage(account));
        console.log(`[ds-] 账号处境已上报:${account.kind}`);
      } catch {
        // 上报是通知:送不出去不重试,下一报还在.
      }
    };
    const startAccountReporting = (): void => {
      if (accountTimer !== undefined) return;
      void reportAccount();
      accountTimer = setInterval(reportAccount, ACCOUNT_REPORT_INTERVAL_MS);
    };
    const stopAccountReporting = (): void => {
      if (accountTimer === undefined) return;
      clearInterval(accountTimer);
      accountTimer = undefined;
    };

    // 两个内容脚本谁先谁后都可能:页面世界开口要就答一次,这边自己上来也报一次.
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const chain = parseChainMessage(event.data);
      if (chain?.kind === "call") {
        void forwardToRelay(chain);
        return;
      }
      if (chain?.kind === "said") {
        void reportSaid(chain);
        return;
      }
      if (chain?.kind === "ask") {
        void reportAsk(chain);
        return;
      }
      if (chain?.kind === "ask-cleared") {
        void reportAskCleared(chain);
        return;
      }
      if (chain?.kind === "stop") {
        void reportStop(chain);
        return;
      }
      if (chain?.kind === "continuation-fail") {
        void reportContinuationFail(chain);
        return;
      }

      const message = parseToggleMessage(event.data);
      if (message?.kind === "want-state") void broadcast();
    });

    /**
     * 本地名册:动作名 → 执行器.实现的就往这里加一项,收信那层不用动.
     * 没实现的动作由收信那层当场回 `unknown-action`(不白等中继的 30s).
     */
    const ACTION_ROSTER: ActionRoster = {
      "page.state": readPageState,
      "composer.read": readComposer,
      "composer.type": typeComposer,
      "composer.clear": clearComposer,
      // 写作框旁边那两个小开关(#30).
      "think.get": readThink,
      "think.set": setThink,
      "search.get": readSearch,
      "search.set": setSearch,
      "button.get": readButton,
      "button.click": buttonClick,
      "send.enter": pressEnter,
      "chat.new": newChat,
      // 会话切换(chat-switch-action):先读列表拿 id,再按 id / 标题切.
      "chats.list": listChats,
      "chat.switch": switchChat,
      // 侧栏开关(sidebar-toggle):读写成对,同一个控件的两态.
      "sidebar.get": readSidebar,
      "sidebar.set": setSidebar,
      // 消息工具栏六项 + 代码块两项(message-and-code-actions).
      ...CONTROL_ACTIONS,
      // 只读那批:读对话走 DOM(#20 口径),不碰站点的响应体.
      "messages.list": listMessages,
      "messages.last": lastMessage,
      // 等动作(#22):等围栏,等回灌--只读,不动写作框.
      "wait.fence": waitFence,
      "wait.reply": waitReply,
    };

    /**
     * 发送限速(#61):三种"替用户把消息发出去"的原语,执行前先过检查点--
     * 距上一次发送不够 3~5 秒就**等**够(等,不拒,不增失败码).
     *
     * 圆键那一下可能不是发送(`readPressed` 分得出发送 / 停止 / 认不出),按
     * `checkSendIntent` 的三条口径分别处理:**停止永不延迟**,认不出不延迟但照样记账.
     * 其余两种原语(`send.enter` / `message.retry`)恒是发送.
     *
     * 记账之后向页面世界通报一声(`send-note`),让另一边也并进这个时刻--
     * 两边的发送节奏因此合成一条线.
     */
    let sendPace: SendPace = newSendPace();

    function paceRoster(roster: ActionRoster): ActionRoster {
      const paced: Record<string, (frame: ActionFrame) => unknown> = { ...roster };
      for (const action of SEND_PRIMITIVES) {
        const run = roster[action];
        if (run === undefined) continue;
        // 圆键那一下的意图要**动手前**与**发完后**各读一次:等的时候它可能变成了"停止".
        const readIntent = (): SendIntent =>
          action === "button.click" ? readCircleIntent() : "send";
        paced[action] = async (frame: ActionFrame) => {
          const before = sendPace;
          const result = await runPaced({
            pace: before,
            readIntent,
            execute: () => run(frame),
            // 圆键重读一次,判出"停止"就不记账;另两种原语恒是发送.
            shouldRecord: () => readIntent() !== "stop",
            now: () => Date.now(),
            random: () => Math.random(),
            sleep: realSleep,
          });
          if (result.pace !== before) {
            sendPace = result.pace;
            window.postMessage(sendNoteMessage("isolated", sendPace.lastSentAt ?? 0), "*");
          }
          return result.result;
        };
      }
      return paced;
    }

    /**
     * 圆键此刻承载的意图:分不出"发送 / 停止 / 认不出"三种.
     *
     * 读 `d` 的用法与 `inject.content.ts` 的 `triggerSend` **同款**(那是"同圆键的先例"):
     * 图标**不参与命中判据**--名册里仍是一个 `button.click` 对这一个元素,不按图标分家;
     * 这里只是**动手前先读一下**,判出"停止"就别延迟,别记账.认不出(`unknown`)一律
     * 当"不延迟,但记账":宁可之后多等一次,也不延迟一次中断,也不漏记一次发送.
     */
    function readCircleIntent(): SendIntent {
      const button = findButton();
      if (button === null) return "unknown";
      const pressed = readPressed(button);
      if (pressed === "send") return "send";
      if (pressed === "stop") return "stop";
      return "unknown";
    }

    // 页面世界(自动续聊)也发过消息:并进它的时刻,两边的节奏合成一条线.
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const note = parseSendNote(event.data);
      if (note === null || note.world === "isolated") return; // 不认自己发的
      sendPace = mergeSendPace(sendPace, note.at);
    });

    // background 打过来的动作帧(走 `tabs.sendMessage`):当场交回一个 ActionOutcome;
    // 认不出的信封一声不吭,不抢 send 那条路的消息.
    browser.runtime.onMessage.addListener(actionListener(paceRoster(ACTION_ROSTER)));

    // 总开关或"代你发言"闸改了立刻广播,刷新与重启靠 storage 自己保持.
    // speak 也要广播(#52):自动续聊那一侧靠它决定是自动发还是只落草稿,
    // 选项页勾一下就生效,不必刷新页面.
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!(TOGGLE_STORAGE_KEY in changes) && !(SPEAK_STORAGE_KEY in changes)) return;
      void broadcast();
      if (!(TOGGLE_STORAGE_KEY in changes)) return;
      // 账号处境上报跟着总开关走:关着时内容脚本不发声.
      if (readToggle(changes[TOGGLE_STORAGE_KEY].newValue)) {
        startAccountReporting();
        startToolsSync();
      } else {
        stopAccountReporting();
        stopToolsSync();
      }
    });

    await broadcast();
    // 总开关现在开着就立刻开始上报(刷新与重启靠 storage 自己保持).
    const stored = await browser.storage.local.get(TOGGLE_STORAGE_KEY);
    if (readToggle(stored[TOGGLE_STORAGE_KEY])) {
      startAccountReporting();
      startToolsSync();
    }
  },
});
