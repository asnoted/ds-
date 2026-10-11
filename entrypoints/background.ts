import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import {
  ACTION_ERROR_TAB_GONE,
  isDeepSeekUrl,
  runAction,
  sendMessageSendToTab,
  type ActionContext,
  type ActionFrame,
} from "../src/lib/action";
import { readBackoff, BACKOFF_STORAGE_KEY } from "../src/lib/backoff";
import { describeStop } from "../src/lib/continuation";
import {
  actionRequestMessage,
  parseAccountReport,
  parseAskClearedReport,
  parseAskReport,
  parseStopReport,
  parseContinuationFailReport,
  parseSendRequest,
  parseSaidReport,
  parseToolsRequest,
  sendResponseMessage,
  toolsResponseMessage,
  type AccountReport,
  type AskClearedReport,
  type AskReport,
} from "../src/lib/channel";
import {
  FAILURE_LOG_STORAGE_KEY,
  describeLastFailure,
  markLastFailureRecovered,
  readFailureLog,
  rememberFailure,
  type FailureRecord,
  type FailureWhere,
} from "../src/lib/failurelog";
import {
  afterHealthProbe,
  badgeText,
  iconTitle,
  ICON_COLORS,
  ICON_SIZE,
  renderIcon,
  type IconState,
} from "../src/lib/icon";
import { nextMessageId } from "../src/lib/id";
import { findLocalTool, type LocalTool, type LocalToolEnv } from "../src/lib/localtools";
import type { AccountState } from "../src/lib/page";
import {
  FAILURE_RELAY_UNREACHABLE,
  MALFORMED_CALL_HINT,
  MAX_CALLS_PER_ROUND,
  MCP_CALL_TIMEOUT_MS,
  MCP_LIST_TIMEOUT_MS,
  MCP_PING_TIMEOUT_MS,
  callToolBody,
  describeBadResponse,
  describeFetchFailure,
  joinCallAnswers,
  listToolsBody,
  parseMcpPing,
  parseMcpResponse,
  parseToolCall,
  parseToolsList,
  pingBody,
  relayMcpUrl,
  type ToolAnswer,
  type ToolCall,
  type ToolInfo,
} from "../src/lib/relay";
import {
  errorPayload,
  failureNotice,
  isInjectableReply,
  okPayload,
  type FailureNotice,
  type ReplyPayload,
} from "../src/lib/reply";
import { SAID_ADD_TOOL } from "../src/lib/said";
import { readSpeak, readToggle, SPEAK_STORAGE_KEY, TOGGLE_STORAGE_KEY } from "../src/lib/toggle";
import {
  ASKS_STORAGE_KEY,
  clearPendingAsk,
  describePendingAsks,
  hasPendingAsk,
  readPendingAsks,
  recordPendingAsk,
  type PendingAsks,
} from "../src/lib/ask";
import {
  INITIAL_WATCHDOG_STATE,
  WATCHDOG_CONFIG_STORAGE_KEY,
  readWatchdogConfig,
  watchdogDecision,
  watchdogSeenActivity,
  type WatchdogState,
} from "../src/lib/watchdog";

/**
 * background 这一侧干这几件事:
 *
 * 1. 打中继(`POST /mcp`,JSON-RPC 2.0)--探活是 `ping`,干活是 `tools/call`,
 *    一次 fetch 打到底(超时见 `MCP_*_TIMEOUT_MS`);网络层的失败也折成同构载荷,
 *    解析只有一条路径;
 * 2. 工具栏图标即状态位:关 / 开且中继可达 / 开但中继不可达,悬停给原因与启动命令;
 *    工具调用在途时角标转起来(进度不上对话流);
 * 3. 点图标开开关面板(popup)--总开关在面板里改,本身还是只存在
 *    `storage.local`,默认关;
 * 4. 每次翻红都留一笔(时刻 / 环节 / 原因)进 `storage.local`,自己绿了再补上恢复时刻,
 *    悬停回看--否则红过就蒸发,事后没人答不出"为什么红".
 *
 * 两条通知式的小路也在这一层:`said_add`(围栏之外的话报给协调者,报不上不碍事)与
 * `tools/list`(工具目录,协议说明照它拼,60s 由隔离世界来取一次).
 * 不建面板;popup 只放总开关(#28),选项页管"代你发言"闸.
 */
export default defineBackground(() => {
  /** 周期探活的闹钟名与周期:30s 是 alarms 的下限,再密浏览器也不认. */
  const HEALTH_ALARM_NAME = "relay-health";
  const HEALTH_ALARM_PERIOD_MINUTES = 0.5;

  /** 角标转速帧的间隔(#28):够看出在转,又不狂刷. */
  const SPIN_INTERVAL_MS = 250;

  /**
   * 工具目录的保鲜期:隔离世界 60s 才来取一次,这里缓着省一趟 `tools/list`;
   * 过期才重取,取坏的沿用上一份(不拿坏数据换).
   */
  const TOOLS_CACHE_TTL_MS = 60_000;

  /** 图标三态. */
  let state: IconState = "off";
  /** 不可达时的原因与启动命令,进悬停文案. */
  let notice: FailureNotice | null = null;
  /** 工具调用在途(一次 `tools/call` 出门到回话):角标转速与悬停靠它. */
  let inFlight = false;
  /** 角标转速(#28):在途期间 250ms 一帧,回话即停;timer 只在在途时排. */
  let spinTick = 0;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * 账号处境(#2):内容脚本总开关开着时 30s 一报.禁言期写路径全断,
   * 悬停得把这层说清--只放内存,重启后下一报(30s 内)就补上.
   */
  let account: AccountState | null = null;
  /**
   * 失败留痕,新的在最前.启动时从 `storage.local` 载入,所以 service worker 被收走,
   * 浏览器重启都丢不了--只放内存的话,红过一次就再没人答得出"为什么红".
   */
  let failureLog: FailureRecord[] = [];
  /**
   * 网页挂着"等人回"的分表(#26):页面会话 id → 问题.启动时从
   * `storage.local` 载入--挂着的"等人回"可能等几小时,只放内存的话,
   * service worker 一收走就没人知道网页在等谁.
   */
  let pendingAsks: PendingAsks = {};
  /** 往 storage 写留痕的串行队列:探活每 30s 失败一次,并发的读改写会互相踩. */
  let persistQueue: Promise<unknown> = Promise.resolve();
  /** 往 storage 写"等人回"分表的串行队列:并发上报的读改写会互相踩. */
  let persistAsksQueue: Promise<unknown> = Promise.resolve();
  /**
   * 看门狗的在册状态:一条被武装的 DeepSeek 标签页一份.
   * 只在内存里--service worker 有 20s 保活与 30s 探活闹钟按着,
   * 武装期不会被收走;真被重启了,会话 url 由下一扫重新记住.
   */
  const watches = new Map<number, WatchdogState>();

  function persistFailureLog(): void {
    persistQueue = persistQueue
      .then(() => browser.storage.local.set({ [FAILURE_LOG_STORAGE_KEY]: failureLog }))
      .catch(() => undefined); // 留痕写不进去不该把图标也拖死
  }

  function persistPendingAsks(): void {
    persistAsksQueue = persistAsksQueue
      .then(() => browser.storage.local.set({ [ASKS_STORAGE_KEY]: pendingAsks }))
      .catch(() => undefined); // 写不进去不该把图标也拖死
  }

  /**
   * 挂一笔"等人回"(#26):内存改完即上屏,storage 排队跟写.
   * 纯函数对重复上报原样返回,不白写一次,也不白画一次图标.
   */
  async function handleAskReport(report: AskReport): Promise<void> {
    const next = recordPendingAsk(pendingAsks, report.page, report.question, Date.now());
    if (next === pendingAsks) return;
    pendingAsks = next;
    persistPendingAsks();
    await paintIcon();
  }

  /** 对话继续了(人答了或模型自己往下走了):清掉这笔并上屏. */
  async function handleAskCleared(report: AskClearedReport): Promise<void> {
    const next = clearPendingAsk(pendingAsks, report.page);
    if (next === pendingAsks) return;
    pendingAsks = next;
    persistPendingAsks();
    await paintIcon();
  }

  /**
   * 记一笔故障.同一环节同一原因,且上一笔还没恢复的**不重复记**--那只是同一次
   * 故障在延续(探活每 30s 会再失败一次),留下的是故障开始的时刻.
   */
  function recordFailure(where: FailureWhere, cause: string): void {
    const next = rememberFailure(failureLog, { at: Date.now(), where, cause });
    if (next === failureLog) return;
    failureLog = next;
    persistFailureLog();
  }

  /**
   * 图标翻回绿了,给最前面那笔补上恢复时刻.
   *
   * 返回有没有真的改过--没改就不用重画,标题里那句"N 秒后恢复"也不会白拼一遍.
   */
  function recoverFailure(): boolean {
    const next = markLastFailureRecovered(failureLog, Date.now());
    if (next === failureLog) return false;
    failureLog = next;
    persistFailureLog();
    return true;
  }

  /**
   * 上图标:先拼悬停文案,再画像素;像素画不出来就退回角标,三态至少还分得开.
   *
   * 角标每次上屏都写一遍--它不再只是"画不出来时的兜底":开着且可达时还背着
   * 调用在途的转框,这是"等着的时候什么都不知道"那个缺口的出口.
   */
  async function paintIcon(): Promise<void> {
    // 角标转速(#28):在途期间才转.paintIcon 是所有状态变化的漏斗,
    // 排/清都在这儿,转速的生死不用每个调用点各自管.
    const spinInFlight = state === "on-reachable" && inFlight;
    if (spinInFlight) {
      spinTimer ??= setInterval(() => {
        spinTick += 1;
        void paintIcon();
      }, SPIN_INTERVAL_MS);
    } else if (spinTimer !== undefined) {
      clearInterval(spinTimer);
      spinTimer = undefined;
      spinTick = 0;
    }
    await browser.action.setTitle({
      title: iconTitle(
        state,
        notice,
        inFlight,
        describeLastFailure(failureLog, Date.now()),
        describePendingAsks(pendingAsks),
        account,
      ),
    });
    await browser.action.setBadgeText({
      text: badgeText(state, inFlight, hasPendingAsk(pendingAsks), spinTick),
    });
    try {
      await browser.action.setIcon({
        imageData: new ImageData(renderIcon(state), ICON_SIZE, ICON_SIZE),
      });
    } catch (error) {
      const [red, green, blue] = ICON_COLORS[state];
      console.log("[ds-] 图标像素画不出来,退回角标", error);
      await browser.action.setBadgeBackgroundColor({ color: `rgb(${red}, ${green}, ${blue})` });
    }
  }

  /** 在途开关:一进门,一收摊各拨一次,转框跟着走(每次上屏都会重排转速). */
  function setInFlight(next: boolean): void {
    if (inFlight === next) return;
    inFlight = next;
    void paintIcon();
  }

  /**
   * 中继的回话 → 图标状态:有回话即可达,没有回话把原因放进失败提示(扩展侧唯一出口).
   *
   * 成功顺手把留痕收尾,失败另记一笔--工具调用这一环跟探活不一样,`cause` 带的是
   * 具体事实(超时多少毫秒,HTTP 几,响应多少字),比"中继不可达"有信息量得多.
   */
  function applyOutcome(payload: ReplyPayload, cause: string | null = null): void {
    if (state === "off") return;
    if (payload.status === "ok") {
      state = "on-reachable";
      notice = null;
      recoverFailure();
    } else {
      state = "on-unreachable";
      notice = failureNotice(payload.error);
      recordFailure("call", cause ?? notice.reason);
      console.log(`[ds-] 工具调用没成(${payload.error}),已记一笔:${cause ?? notice.reason}`);
    }
    void paintIcon();
  }

  async function fetchWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 探活:开关打开时先看中继在不在(JSON-RPC `ping`).
   *
   * 顺带把**为什么**不可达带回来.以前这里是 `catch { return false }`,超时,连不上,
   * 认不出三件事被折成同一件,图标一红就再没有下文了.
   */
  async function pingRelay(): Promise<{ reachable: boolean; cause: string | null }> {
    const id = nextMessageId("ping");
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), MCP_PING_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pingBody(id),
      });
      const text = await response.text();
      return parseMcpPing(response.status, text, id)
        ? { reachable: true, cause: null }
        : { reachable: false, cause: describeBadResponse(response.status, text) };
    } catch (error) {
      return { reachable: false, cause: describeFetchFailure(error, MCP_PING_TIMEOUT_MS) };
    }
  }

  /**
   * 周期探活的排班:开着才排,关了就撤--总开关关着时扩展不该每 30s 白被叫醒一次.
   * 这条只管"中继还在不在";工具调用在途时的存活另有 keepAliveWhileSending 兜着.
   */
  async function syncHealthAlarm(enabled: boolean): Promise<void> {
    if (enabled) {
      await browser.alarms.create(HEALTH_ALARM_NAME, {
        periodInMinutes: HEALTH_ALARM_PERIOD_MINUTES,
      });
      return;
    }
    await browser.alarms.clear(HEALTH_ALARM_NAME);
  }

  /**
   * 到点探一次:中继死了图标当场翻脸,不必等下一次工具调用失败才暴露.
   * 状态没变就不重画--每 30s 一次,重画是白做的功.
   */
  async function healthProbe(): Promise<void> {
    const probe = await pingRelay();
    const next = afterHealthProbe(state, probe.reachable);
    const flipped = next.state !== state || next.notice !== notice;
    console.log(
      `[ds-] 周期探活:中继${probe.reachable ? "可达" : `不可达(${probe.cause ?? "原因不详"})`},` +
        `图标${flipped ? `翻到 ${next.state}` : "不动"}`,
    );
    // 记账不看 flipped:翻红要留痕,翻绿要收尾,没变的时候同一次故障也记不进第二笔.
    if (probe.reachable) {
      if (state === "on-unreachable") recoverFailure();
    } else {
      recordFailure("health", probe.cause ?? "原因不详");
    }
    if (!flipped) return;
    state = next.state;
    notice = next.notice;
    await paintIcon();
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== HEALTH_ALARM_NAME) return;
    void healthProbe();
    // 看门狗搭这趟车:闹钟只在武装时排,总开关关掉即全停.
    void watchdogSweep();
  });

  /**
   * MV3 的 service worker 闲置 30 秒就会被收走,而工具调用这一趟可能更久
   * (`MCP_CALL_TIMEOUT_MS` 是 130s);在途时点一下扩展 API 把它按住,
   * 不改任何业务行为.
   */
  function keepAliveWhileSending(): () => void {
    const timer = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);
    return () => clearInterval(timer);
  }

  /**
   * 围栏(页面模型排出 send 围栏,围栏正文送进隔离世界)或回灌
   * (答复送回内容脚本)落地:这是一条动静,刷新标签页的
   * 动静时刻--连催计数与停手随之清零.
   */
  function watchdogSeen(tabId: number): void {
    const before = watches.get(tabId) ?? INITIAL_WATCHDOG_STATE;
    watches.set(tabId, watchdogSeenActivity(before, Date.now()));
  }

  /**
   * 催办投递:固定正文打进取页作框并发送.两步都走同一套执行门
   * (`runAction`)--总开关 / 退避照拦,拦着就回 false(不算催,下扫再试);
   * 前半句没成就不发后半句,免得空消息上屏.
   *
   * **"代你发言"闸关着时整个跳过**(#52):催办是"写 + 发"成对的动作,只写不发
   * 会在用户的输入框里留下半截"继续".跳过即不算催(计数不动),下扫再试.
   * 写步本身现在不受 speak 闸管(#52:只管发),所以这个判断必须在这里显式做.
   */
  async function deliverNudge(tabId: number, text: string): Promise<boolean> {
    const context = await actionContext();
    if (!context.speak) {
      console.log('[ds-] "代你发言"闸关着,这次催办整个跳过(不留半截在输入框里)');
      return false;
    }
    const frame = (action: string, params: Record<string, unknown>): ActionFrame => ({
      type: "action",
      id: nextMessageId("watchdog"),
      action,
      params,
      target: String(tabId),
    });
    if (!(await runAction(frame("composer.type", { text }), context)).ok) {
      return false;
    }
    return (await runAction(frame("send.enter", {}), context)).ok;
  }

  /**
   * 看门狗扫一遍:搭周期探活的车(这张闹钟只在武装时排,见
   * `syncHealthAlarm`).决策是纯函数(`watchdog.ts`),这层只管
   * 照做:漂移走 `tabs.update` 导航回去(host permission 覆盖
   * 本站标签页,不必为它申请 tabs 权限),催办走 `deliverNudge`,
   * 停手照 ADR-0004 留一笔(环节 `watchdog`).
   *
   * 站外漂移看不见:没有 tabs 权限,非本站标签页的 url 读不到--
   * 真机故障正是站内漂到新对话,那一档在这条扫的范围里.
   */
  async function watchdogSweep(): Promise<void> {
    const stored = await browser.storage.local.get(WATCHDOG_CONFIG_STORAGE_KEY);
    const config = readWatchdogConfig(stored[WATCHDOG_CONFIG_STORAGE_KEY]);
    const tabs = await browser.tabs.query({});
    const alive = new Set<number>();
    for (const tab of tabs) {
      if (tab.id === undefined || typeof tab.url !== "string" || !isDeepSeekUrl(tab.url)) {
        continue;
      }
      alive.add(tab.id);
      const before = watches.get(tab.id) ?? INITIAL_WATCHDOG_STATE;
      const { act, next } = watchdogDecision(
        before,
        {
          tabUrl: tab.url,
          now: Date.now(),
        },
        config,
      );
      watches.set(tab.id, next);
      if (act.kind === "navigate-back") {
        console.log(`[ds-] 看门狗:标签页 ${tab.id} 离开了会话,导航回去`);
        try {
          await browser.tabs.update(tab.id, { url: act.url });
        } catch (error) {
          console.log("[ds-] 看门狗:导航回去没成", error);
        }
      } else if (act.kind === "nudge") {
        const delivered = await deliverNudge(tab.id, act.text);
        // 计数只认送出去的:闸拦着(退避中 / 没开替人发言)不算催.
        watches.set(tab.id, delivered ? { ...next, nudges: next.nudges + 1 } : next);
        console.log(
          delivered
            ? `[ds-] 看门狗:距上次动静超 ${config.silenceMs / 1000}s,催办已发`
            : "[ds-] 看门狗:催办没送出去(闸拦着或标签页答不上),不算催",
        );
      } else if (act.kind === "stand-down") {
        console.log(`[ds-] 看门狗:连催 ${config.maxNudges} 次无动静,停手`);
        recordFailure("watchdog", `连催 ${config.maxNudges} 次无动静`);
      }
    }
    // 关掉 / 离开本站的标签页不再扫:状态跟着标签页走,不留僵尸.
    for (const tabId of watches.keys()) {
      if (!alive.has(tabId)) watches.delete(tabId);
    }
  }

  /** 正在跑本地工具的标签页(重入护栏:同一标签页一次只跑一个). */
  const localBusy = new Set<number>();

  /**
   * 本地工具:围栏里排的是扩展自己的工具名(`findLocalTool` 命中),**不转发 dsb**,
   * 就地执行.组合内部的页面动作各走一遍 `runAction`,所以总开关 / 替人发言 / 退避
   * 三道闸照拦;失败码是现成册子里的,不编新码.
   *
   * **不碰中继图标**:本地工具一次 fetch 都没打,它的成败证明不了中继健不健康--闸关着
   * 回 `disabled` 是你自己关的,不是中继坏了.与 `deliverNudge` 同一口径:失败只进控制台,
   * 不翻红,不留失败痕.在途角标转,保活按住照旧.同一标签页已有本地工具在跑时,回一条
   * 可见提示(让模型别重排),不并发.
   *
   * 组合不该抛(内部把失败都折成载荷);真抛了是 bug,交给内容脚本那层既有的兜底.
   */
  async function runLocalTool(
    tool: LocalTool,
    args: Record<string, unknown>,
    tabId: number | undefined,
  ): Promise<ReplyPayload> {
    if (tabId === undefined) return errorPayload(ACTION_ERROR_TAB_GONE);
    if (localBusy.has(tabId)) {
      return okPayload(`本地工具 ${tool.name} 正在跑(同一标签页一次只跑一个),这条没有执行.`);
    }
    localBusy.add(tabId);
    const releaseKeepAlive = keepAliveWhileSending();
    setInFlight(true);
    try {
      const context = await actionContext();
      const env: LocalToolEnv = {
        tabId,
        run: (action, params) =>
          runAction(
            { type: "action", id: nextMessageId("local"), action, params, target: String(tabId) },
            context,
          ),
      };
      const payload = await tool.run(args, env);
      if (payload.status === "error") {
        console.log(`[ds-] 本地工具 ${tool.name} 回 ${payload.error}`);
      }
      return payload;
    } finally {
      localBusy.delete(tabId);
      setInFlight(false);
      releaseKeepAlive();
    }
  }

  /** 一块围栏的处置:一条答案(进这一轮的正文),或一个失败载荷(整轮作废,不进对话流). */
  type CallOutcome =
    | { readonly ok: true; readonly answer: ToolAnswer }
    | { readonly ok: false; readonly payload: ReplyPayload };

  /**
   * **本地工具的截获点**--`local-tools` 的 requirement 与 ADR-0013 都按这个名字指着这里
   * (#50:这段以前内联在 `sendCalls` 的循环体里,于是两份文档指的是一个不存在的函数:
   * 遵守的人找不到地方,将来谁建个同名函数那条 requirement 就"满足"了而截获在别处).
   *
   * 位置照 spec 的话办:`parseToolCall` **之后**,`fetch` **之前**先查 `findLocalTool`,
   * 命中就地跑(`runLocalTool`,一次 fetch 都不打),未命中交 `sendOneCall` 打网关.
   * 普通工具路径一字不改.
   */
  async function sendCall(call: string, tabId: number | undefined): Promise<CallOutcome> {
    const toolCall = parseToolCall(call);
    if (toolCall === null) {
      // 排坏了不出门:没问过网关,图标状态别动,把改法回灌给模型自己改.
      return { ok: true, answer: { tool: "排坏的围栏", text: MALFORMED_CALL_HINT } };
    }
    const local = findLocalTool(toolCall.tool);
    const payload =
      local === null
        ? await sendOneCall(toolCall)
        : await runLocalTool(local, toolCall.arguments, tabId);
    // 连不上 / 答不成样:整轮作废,照旧不进对话流(与单块时一个脾气).
    if (!isInjectableReply(payload)) return { ok: false, payload };
    return { ok: true, answer: { tool: toolCall.tool, text: payload.answer } };
  }

  /**
   * 一轮的工具调用:**一块一趟**打网关(每趟自己一份超时预算,不共用),
   * 打完拼成一段正文交回.
   *
   * 一趟一趟而不是一次请求带多块:中继那一侧一次 `tools/call` 就是一件工具,
   * 而扩展对一条在途 fetch 的保活与超时是**按请求**算的(`MCP_CALL_TIMEOUT_MS`)
   * --多块挤一趟,几件慢工具叠起来就会先撞扩展的超时,报出来的还是没信息量的
   * "中继不可达".一趟一块,超时账各算各的.
   *
   * 本地工具(`findLocalTool` 命中)就地跑,同样占一轮里的一块--判定与分派都在
   * `sendCall` 里(那是 spec 与 ADR-0013 点名的截获点,见它的注释).
   */
  async function sendCalls(
    calls: readonly string[],
    tabId: number | undefined,
  ): Promise<ReplyPayload> {
    const planned = calls.slice(0, MAX_CALLS_PER_ROUND);
    const answers: ToolAnswer[] = [];
    for (const call of planned) {
      const outcome = await sendCall(call, tabId); // 一块的处置在它那里:本地截获 / 转网关
      if (!outcome.ok) return outcome.payload; // 整轮作废,不进对话流
      answers.push(outcome.answer);
    }

    const dropped = calls.length - planned.length;
    const joined = joinCallAnswers(answers);
    if (dropped <= 0) return okPayload(joined);
    return okPayload(
      `${joined}\n\n(这一轮最多执行 ${MAX_CALLS_PER_ROUND} 块围栏,还有 ${dropped} 块没执行--下一轮再排.)`,
    );
  }

  /**
   * 打中继:一段围栏正文 → 一次 `tools/call`,一次 fetch 打到底.
   *
   * 不轮询,不重试:dsb 是本机服务,答不上来是"连不上 / 认不出"这两件有信息量的事,
   * 中间态不存在;正在跑的调用也不该再发第二个请求去问它(同一 id 只起一份活,
   * 但扩展先 abort 报出来的只会是没信息量的"中继不可达",还会白扔一次调用).
   *
   * 在途期间另开保活(`keepAliveWhileSending`),收摊时无论成败都先下在途标记,
   * 再由调用方上屏,免得答案都回来了角标还挂着转框.
   *
   * 本地工具(`findLocalTool` 命中)不走这里:见 `runLocalTool`.
   */
  async function sendOneCall(toolCall: ToolCall): Promise<ReplyPayload> {
    const releaseKeepAlive = keepAliveWhileSending();
    const id = nextMessageId("call");
    setInFlight(true);
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), MCP_CALL_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callToolBody(id, toolCall.tool, toolCall.arguments),
      });
      const text = await response.text();
      const payload = parseMcpResponse(response.status, text, id);
      applyOutcome(
        payload,
        payload.status === "error" ? describeBadResponse(response.status, text) : null,
      );
      return payload;
    } catch (error) {
      const cause = describeFetchFailure(error, MCP_CALL_TIMEOUT_MS);
      console.log(`[ds-] 工具调用没连上(${cause})`);
      const failure = errorPayload(FAILURE_RELAY_UNREACHABLE);
      applyOutcome(failure, cause);
      return failure;
    } finally {
      setInFlight(false);
      releaseKeepAlive();
    }
  }

  /**
   * 工具目录:先看保鲜期内的缓存,过期才打 `tools/list`.
   *
   * 取坏的**沿用上一份**(不拿坏数据换);一份都没有就是 null--隔离世界拿不到
   * 也就不会广播,页面世界继续说"工具表暂未取到".
   * `said_*` 是自家工具(记话/读话,协调者用的),不进模型的目录.
   */
  let toolsCache: { at: number; tools: readonly ToolInfo[] } | null = null;
  async function serveTools(): Promise<readonly ToolInfo[] | null> {
    if (toolsCache !== null && Date.now() - toolsCache.at < TOOLS_CACHE_TTL_MS) {
      return toolsCache.tools;
    }
    const id = nextMessageId("tools");
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), MCP_LIST_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: listToolsBody(id),
      });
      const tools = parseToolsList(response.status, await response.text(), id);
      if (tools === null) return toolsCache?.tools ?? null;
      const visible = tools.filter((tool) => !tool.name.startsWith("said_"));
      toolsCache = { at: Date.now(), tools: visible };
      return visible;
    } catch (error) {
      console.log("[ds-] 工具表没取到", describeFetchFailure(error, MCP_LIST_TIMEOUT_MS));
      return toolsCache?.tools ?? null;
    }
  }

  /**
   * 报一段"说给人听"的话(`said_add`):报不上不碍事--这条只是让人看见,
   * 不是问答回路,所以不翻图标,不留痕,也不进对话流.
   */
  async function reportSaid(text: string): Promise<void> {
    const id = nextMessageId("said");
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), MCP_LIST_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callToolBody(id, SAID_ADD_TOOL, { text }),
      });
      const payload = parseMcpResponse(response.status, await response.text(), id);
      if (payload.status === "error") console.log(`[ds-] said 没报上去(${payload.error})`);
    } catch (error) {
      console.log("[ds-] said 没报上去", describeFetchFailure(error, MCP_LIST_TIMEOUT_MS));
    }
  }

  /**
   * 动作执行的门面:总开关 / 替人发言 / 退避现读 storage(同一处真源).
   * 看门狗的催办也走同一套门--催办也是替人发言,闸拦着就不喊.
   */
  async function actionContext(): Promise<ActionContext> {
    const stored = await browser.storage.local.get([
      TOGGLE_STORAGE_KEY,
      SPEAK_STORAGE_KEY,
      BACKOFF_STORAGE_KEY,
    ]);
    return {
      enabled: readToggle(stored[TOGGLE_STORAGE_KEY]),
      speak: readSpeak(stored[SPEAK_STORAGE_KEY]),
      // 退避:现读持久状态;判定后由 runAction 写回(重启后仍记得).
      backoff: readBackoff(stored[BACKOFF_STORAGE_KEY]),
      setBackoff: async (next) => {
        await browser.storage.local.set({ [BACKOFF_STORAGE_KEY]: next });
      },
      tabs: { query: (query) => browser.tabs.query(query) },
      // 总开关读写口:真源就是 storage.local(同一条真源,图标与武装都跟着它走).
      // 写入触发 storage.onChanged → syncFromStorage,武装随之生效.
      toggle: {
        get: async () => {
          const stored = await browser.storage.local.get(TOGGLE_STORAGE_KEY);
          return readToggle(stored[TOGGLE_STORAGE_KEY]);
        },
        set: async (value) => {
          await browser.storage.local.set({ [TOGGLE_STORAGE_KEY]: value });
          return value;
        },
      },
      // 带 target 的动作投进那个标签页:帧裹一层 ds-/action 送过去;
      // 标签页没了 / 内容脚本没注入(sendMessage 抛错)都折成 tab-gone,不冒泡.
      sendToTab: sendMessageSendToTab((tabId, frameToTab) =>
        browser.tabs.sendMessage(tabId, actionRequestMessage(frameToTab)),
      ),
    };
  }

  /** 总开关变了就跟图标:关了即"关",开了先按可达摆,再探一次中继. */
  async function syncFromStorage(): Promise<void> {
    const stored = await browser.storage.local.get([
      TOGGLE_STORAGE_KEY,
      FAILURE_LOG_STORAGE_KEY,
      ASKS_STORAGE_KEY,
    ]);
    const enabled = readToggle(stored[TOGGLE_STORAGE_KEY]);
    failureLog = readFailureLog(stored[FAILURE_LOG_STORAGE_KEY]); // 留痕先上手,标题才拼得出历史
    pendingAsks = readPendingAsks(stored[ASKS_STORAGE_KEY]); // 等人回先上手,角标与悬停才拼得出
    await syncHealthAlarm(enabled); // 排班先跟着开关走,图标再跟着探测结果走
    if (!enabled) {
      state = "off";
      notice = null;
      inFlight = false; // 关了就不该再揣着上一次调用的在途
      watches.clear(); // 看门狗全停:不导航,不催办,不留痕;重武装时重新记住
      await paintIcon();
      return;
    }

    state = "on-reachable";
    notice = null;
    await paintIcon();

    const probe = await pingRelay();
    if (!probe.reachable) {
      if (state !== "on-reachable") return; // 等待期间开关被关掉了,别再翻红
      state = "on-unreachable";
      notice = failureNotice(FAILURE_RELAY_UNREACHABLE);
      recordFailure("health", probe.cause ?? "原因不详");
      await paintIcon();
      return;
    }
    // 探到了就说明上一次的红到此为止(包括关着浏览器时留下的那笔),补一句再画.
    if (state === "on-reachable" && recoverFailure()) await paintIcon();
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!(TOGGLE_STORAGE_KEY in changes)) return;
    void syncFromStorage();
  });

  // 隔离世界送来的围栏:打中继,把同构载荷原路交回.
  browser.runtime.onMessage.addListener((message, sender) => {
    const request = parseSendRequest(message);
    if (request !== null) {
      // 围栏进了中继 = 页面模型排出了围栏:这是一条动静.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) watchdogSeen(tabId);
      return sendCalls(request.calls, tabId).then((payload) => {
        // 答复送回内容脚本 = 回灌落地(送进作框由页面世界自己完成).
        if (tabId !== undefined) watchdogSeen(tabId);
        return sendResponseMessage(request.id, payload);
      });
    }
    // said 上报(通知式,不等回话):围栏之外的话记进协调者的记录本.
    const said = parseSaidReport(message);
    if (said !== null) {
      void reportSaid(said.text);
      return undefined;
    }
    // 工具目录(隔离世界 60s 来取一次):回话带目录,取不到回 null.
    const toolsRequest = parseToolsRequest(message);
    if (toolsRequest !== null) {
      return serveTools().then((tools) => toolsResponseMessage(tools));
    }
    // ask 上报与清除(#26):都是通知,不等回话,挂"等人回"或清掉它.
    const ask = parseAskReport(message);
    if (ask !== null) {
      void handleAskReport(ask);
      return undefined;
    }
    const cleared = parseAskClearedReport(message);
    if (cleared !== null) {
      void handleAskCleared(cleared);
      return undefined;
    }
    // 续聊到顶停手(页面世界报的):不是故障而是刹车,但同样要留得下来
    // --"怎么忽然不自动往下答了"得有个交代(ADR-0004).
    const stop = parseStopReport(message);
    if (stop !== null) {
      console.log(`[ds-] 页面报停手:${stop.cause}`);
      recordFailure("rounds", describeStop(stop.cause));
      return undefined;
    }
    // 续聊这一跳失败(#51):发不出去,正文换不进去,钥匙不符...此前只有控制台
    // 一行,扩展侧答不出"为什么这轮工具结果没回到模型手上".cause 已是短句,
    // 这里只落痕(正文进不来,ADR-0004).
    const continuationFail = parseContinuationFailReport(message);
    if (continuationFail !== null) {
      console.log(`[ds-] 页面报续聊失败:${continuationFail.cause}`);
      recordFailure("continuation", continuationFail.cause);
      return undefined;
    }
    // 账号处境上报(#2):记下最新值并上屏,悬停才说得出"禁言至何时".
    const accountReport: AccountReport | null = parseAccountReport(message);
    if (accountReport !== null) {
      account = accountReport.account;
      console.log(`[ds-] 账号处境已更新:${account.kind}`);
      void paintIcon();
      return undefined;
    }
    return undefined;
  });

  browser.runtime.onInstalled.addListener(() => {
    console.log("[ds-] installed, first message id:", nextMessageId("install"));
  });

  void syncFromStorage();
});
