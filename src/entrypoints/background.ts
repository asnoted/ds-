import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import {
  isDeepSeekUrl,
  runAction,
  sendMessageSendToTab,
  type ActionContext,
  type ActionFrame,
} from "../lib/action";
import { readBackoff, BACKOFF_STORAGE_KEY } from "../lib/backoff";
import { describeStop } from "../lib/continuation";
import {
  actionRequestMessage,
  parseAccountReport,
  parseActionRequest,
  parseAskClearedReport,
  parseAskReport,
  parseStopReport,
  parseEndTaskReport,
  parseContinuationFailReport,
  parseSendRequest,
  parseSaidReport,
  parseToolsRequest,
  parseTrackingdiffRequest,
  sendResponseMessage,
  trackingdiffResponseMessage,
  toolsResponseMessage,
  type AccountReport,
  type AskClearedReport,
  type AskReport,
} from "../lib/channel";
import {
  FAILURE_LOG_STORAGE_KEY,
  describeLastFailure,
  markLastFailureRecovered,
  readFailureLog,
  rememberFailure,
  type FailureRecord,
  type FailureWhere,
} from "../lib/failurelog";
import {
  FAILURE_FRAME_BUDGET_CHARS,
  FAILURE_FRAME_STORAGE_KEY,
  captureFailureFrame,
  pruneFailureFrames,
  readFailureFrames,
  rememberFailureFrame,
  type FailureFrame,
} from "../lib/failureframe";
import {
  createFenceRound,
  type FenceRoundEffect,
  type FenceRoundPhase,
  type RelayAnswer,
} from "../lib/fenceround";
import {
  afterHealthProbe,
  badgeText,
  iconTitle,
  ICON_COLORS,
  ICON_SIZE,
  renderIcon,
  type IconState,
} from "../lib/icon";
import { nextMessageId } from "../lib/id";
import type { LocalTool, LocalToolEnv } from "../lib/localtools";
import { type AccountState, hasForeignDraft, isGenerating } from "../lib/page";
import {
  FAILURE_RELAY_UNREACHABLE,
  MCP_CALL_TIMEOUT_MS,
  MCP_LIST_TIMEOUT_MS,
  MCP_PING_TIMEOUT_MS,
  callToolBody,
  describeBadResponse,
  describeFetchFailure,
  listToolsBody,
  parseMcpPing,
  parseMcpResponse,
  parseToolsList,
  pingBody,
  relayMcpUrl,
  type ToolCall,
  type ToolInfo,
} from "../lib/relay";
import {
  errorPayload,
  failureNotice,
  type FailureNotice,
  type ReplyPayload,
} from "../lib/reply";
import { SAID_ADD_TOOL } from "../lib/said";
import { isEmptyMigration, MIGRATION_KEYS, planStorageMigration } from "../lib/migrate";
import { readSpeak, readToggle, SPEAK_STORAGE_KEY, TOGGLE_STORAGE_KEY } from "../lib/toggle";
import {
  ASKS_STORAGE_KEY,
  clearPendingAsk,
  describePendingAsks,
  hasPendingAsk,
  readPendingAsks,
  recordPendingAsk,
  type PendingAsks,
} from "../lib/ask";
import {
  INITIAL_WATCHDOG_STATE,
  WATCHDOG_CONFIG_STORAGE_KEY,
  readWatchdogConfig,
  watchdogDecision,
  watchdogNudged,
  observedOutput,
  watchdogSeenActivity,
  watchdogSeenPassing,
  watchdogTaskClosed,
  type WatchdogState,
} from "../lib/watchdog";

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
 * 一轮围栏的处置(截断 / 坏围栏提示 / 本地截获 / 整轮作废 / 重入护栏)抽在
 * `src/lib/fenceround.ts`,这一层只把中继调用 / 本地工具 / 保活 / 时钟与效果出口注进去.
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

  /**
   * 模型目录里不列的自家工具:trackingdiff 由扩展自动拉取(见 fetchTrackingdiff).
   * track_file / untrack_file 已从 dsb 侧注销(git 覆盖全部改动,那两个是死接口).
   */
  const HIDDEN_MODEL_TOOLS = new Set(["trackingdiff"]);

  /** 图标三态. */
  let state: IconState = "off";
  /**
   * 总开关每动一次就 +1: 探活开跑时记下这一代, 回话时发现换了就作废--
   * "关掉又打开"之后, 上一代晚到的回话不许再把刚探绿的图标按红.
   */
  let switchEpoch = 0;
  /** 看门狗同一时刻只扫一遍: 闹钟 30s 一拍, 带催办的一扫可能更久, 叠起来会催同一页两次. */
  let sweeping = false;
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
   * 失败帧(#106):发送类失败当场抓的那一帧,按 `at` 与留痕配对,新的在最前.
   * 与留痕同一条过期纪律:配不上记录的帧清掉(见 `pruneFailureFrames`).
   */
  let failureFrames: FailureFrame[] = [];
  /**
   * 网页挂着"等人回"的分表(#26):页面会话 id → 问题.启动时从
   * `storage.local` 载入--挂着的"等人回"可能等几小时,只放内存的话,
   * service worker 一收走就没人知道网页在等谁.
   */
  let pendingAsks: PendingAsks = {};
  /** 往 storage 写留痕的串行队列:探活每 30s 失败一次,并发的读改写会互相踩. */
  let persistQueue: Promise<unknown> = Promise.resolve();
  /** 往 storage 写帧的串行队列:抓帧是异步回写,与留痕那份各排各的. */
  let persistFramesQueue: Promise<unknown> = Promise.resolve();
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

  function persistFailureFrames(): void {
    persistFramesQueue = persistFramesQueue
      .then(() => browser.storage.local.set({ [FAILURE_FRAME_STORAGE_KEY]: failureFrames }))
      .catch(() => undefined); // 帧写不进去不该把图标也拖死
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
   *
   * 真落了新记录就回那一刻的时刻(`at`),没落回 null:抓帧那边要靠它认"这一笔是新的",
   * 同一次红的延续不重复拍(省帧,也省那一瞬的可见闪烁).
   */
  function recordFailure(where: FailureWhere, cause: string): number | null {
    const at = Date.now();
    const next = rememberFailure(failureLog, { at, where, cause });
    if (next === failureLog) return null;
    failureLog = next;
    persistFailureLog();
    return at;
  }

  /**
   * 把整屏 JPEG 压进预算:先按质量压,还大就逐步降采样(整屏 JPEG 常在几十上百 KB).
   *
   * 用的是 `OffscreenCanvas`(MV3 service worker 里没有 DOM canvas,但 canvas 这套 API
   * 在 worker 里以 OffscreenCanvas 的形式在).压不进预算就回压剩的那个--丢不丢由
   * `captureFailureFrame` 按预算判.
   */
  async function shrinkFrame(dataUrl: string, budgetChars: number): Promise<string> {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    let scale = 1;
    let quality = 0.6;
    let last = dataUrl;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const ctx = canvas.getContext("2d");
      if (ctx === null) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      last = `data:image/jpeg;base64,${btoa(binary)}`;
      if (last.length <= budgetChars) return last;
      scale *= 0.7;
      quality = Math.max(0.3, quality - 0.1);
    }
    return last;
  }

  /**
   * 抓一帧存进留痕(#106):发送类失败当场的那一屏.
   *
   * 只在**报上来的那个标签页此刻就是前台活动标签页**时抓:窗口活动页是别的页时
   * `captureVisibleTab` 拍的是别人(可能是任意站点),那既拍错了对象,又抓了不相干的内容.
   * 后台页不抢前台,留纯文字;整条 fire-and-forget,失败静默走掉(红线:抓帧绝不影响
   * 原失败路径).
   */
  async function captureFailureFrameFor(
    tab: { id?: number; windowId?: number } | undefined,
    at: number,
  ): Promise<void> {
    const tabId = tab?.id;
    const windowId = tab?.windowId;
    if (tabId === undefined || windowId === undefined) return;
    const frame = await captureFailureFrame(at, {
      capture: async () => {
        const target = await browser.tabs.get(tabId);
        if (target.active !== true) throw new Error("报上来的标签页不在前台");
        const [active] = await browser.tabs.query({ windowId, active: true });
        if (active?.id !== tabId) throw new Error("活动标签页已经换人");
        return await browser.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 });
      },
      shrink: (dataUrl) => shrinkFrame(dataUrl, FAILURE_FRAME_BUDGET_CHARS),
      budgetChars: FAILURE_FRAME_BUDGET_CHARS,
    });
    if (frame === null) return;
    failureFrames = pruneFailureFrames(rememberFailureFrame(failureFrames, frame), failureLog);
    persistFailureFrames();
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
      console.log("[dsb] 图标像素画不出来,退回角标", error);
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
      console.log(`[dsb] 工具调用没成(${payload.error}),已记一笔:${cause ?? notice.reason}`);
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
    const epoch = switchEpoch;
    const probe = await pingRelay();
    // 探的这几秒里被关掉:这趟作废,不记账也不翻红(与 `applyOutcome` 同一口径).
    if (state === "off") return;
    // 关掉又打开也算换了一代: 上一代的回话不许把刚探绿的图标按红.
    if (epoch !== switchEpoch) return;
    const next = afterHealthProbe(state, probe.reachable);
    const flipped = next.state !== state || next.notice !== notice;
    console.log(
      `[dsb] 周期探活:中继${probe.reachable ? "可达" : `不可达(${probe.cause ?? "原因不详"})`},` +
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
    // 带催办的一扫可能比一拍久(判读几拍 + 限速窗口): 上一扫没完就跳过这一拍.
    if (!sweeping) {
      sweeping = true;
      void watchdogSweep().finally(() => {
        sweeping = false;
      });
    }
  });

  /**
   * MV3 的 service worker 闲置 30 秒就会被收走,而工具调用这一趟可能更久
   * (`MCP_CALL_TIMEOUT_MS` 是 170s);在途时点一下扩展 API 把它按住,
   * 不改任何业务行为.
   */
  function keepAliveWhileSending(): () => void {
    const timer = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);
    return () => clearInterval(timer);
  }

  /**
   * 围栏动静落地(时刻由围栏处置 module 的时钟带进来):**答复落地**(`land`)
   * = 回灌把结果交到模型手上,开一笔活(还没开就从这里开,预算归零);
   * **围栏出门 / 整轮作废**(`out` / `void`)只顺延静默窗口,活与预算原样.
   */
  function watchdogSeen(tabId: number, now: number, phase: FenceRoundPhase): void {
    const before = watches.get(tabId) ?? INITIAL_WATCHDOG_STATE;
    watches.set(
      tabId,
      phase === "land" ? watchdogSeenActivity(before, now) : watchdogSeenPassing(before, now),
    );
  }

  /**
   * 收活:内容脚本报"这轮答复没有围栏"(模型干净收尾),或续聊到顶停手--
   * 结账:本笔活的连催与停手清零,这笔回催过就给连续笔数记一笔;
   * 连续两笔都靠催办推进就封掉本武装期(#104),封的那一下照 ADR-0004
   * 留一笔(环节 `watchdog`).没开过的活收到收尾是重复的,幂等.
   */
  function closeWatchdogTask(tabId: number, why: string): void {
    const before = watches.get(tabId);
    if (before === undefined) return;
    const after = watchdogTaskClosed(before);
    if (after === before) return;
    watches.set(tabId, after);
    console.log(`[dsb] 看门狗:${why},本笔活收尾`);
    if (!before.sealed && after.sealed) {
      recordFailure("watchdog", `连续 ${after.nudgedTasks} 笔活靠催办推进,本武装期停手`);
      console.log(`[dsb] 看门狗:连续 ${after.nudgedTasks} 笔活都靠催办推进,封手到总开关关一次`);
    }
  }

  /**
   * 催办投递:固定正文打进取页作框并发送.两步都走同一套执行门
   * (`runAction`)--总开关 / 退避照拦,拦着就回 false(不算催,下扫再试);
   * 前半句没成就不发后半句,免得空消息上屏.
   *
   * **"代你发言"闸关着时整个跳过**(#52):催办是"写 + 发"成对的动作,只写不发
   * 会在用户的输入框里留下半截"继续".跳过即不算催(计数不动),下扫再试.
   * 写步本身现在不受 speak 闸管(#52:只管发),所以这个判断必须在这里显式做.
   *
   * **框里有别人正在打的字时也整个跳过**(#93 顶草稿的落点,与落草稿那一支同一条
   * 原则):催办是自动的,没人按着它,没理由替人吃掉打到一半的话.写步
   * (`composer.type`)本身就会覆盖草稿--这是它的明写取舍,所以挡在这里.
   */
  async function deliverNudge(
    tabId: number,
    text: string,
    context: ActionContext,
  ): Promise<boolean> {
    if (!context.speak) {
      console.log('[dsb] "代你发言"闸关着,这次催办整个跳过(不留半截在输入框里)');
      return false;
    }
    const frame = (action: string, params: Record<string, unknown>): ActionFrame => ({
      type: "action",
      id: nextMessageId("watchdog"),
      action,
      params,
      target: String(tabId),
    });
    const draft = await runAction(frame("composer.read", {}), context);
    if (!draft.ok) return false;
    if (hasForeignDraft(draft.result, text)) {
      console.log("[dsb] 看门狗:写作框里有人正在打的东西,这一催跳过(不覆盖草稿)");
      return false;
    }
    if (!(await runAction(frame("composer.type", { text }), context)).ok) {
      return false;
    }
    return (await runAction(frame("send.enter", {}), context)).ok;
  }

  /**
   * 催办前的那道判读(#104):页面正在生成(圆键在"停止"相)就先别插嘴.
   * `button.get` 是只读动作,不进 speak 闸;读不出来(键认不出 / 标签页
   * 答不上)按"没观测到输出"处理,催办照旧走--看不见不等于它在说话.
   * 单拍不够:生成相会在停止/发送两相之间抖,`observedOutput` 连看几拍再定.
   */
  function pageIsGenerating(tabId: number, context: ActionContext): Promise<boolean> {
    return runAction(
      {
        type: "action",
        id: nextMessageId("watchdog"),
        action: "button.get",
        params: {},
        target: String(tabId),
      },
      context,
    ).then((outcome) => outcome.ok && isGenerating(outcome.result));
  }

  /** 观察窗的拍间隔计时(只在临催这条路用,等的就是拍与拍之间那一段). */
  function nap(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      const now = Date.now();
      const { act, next } = watchdogDecision(
        before,
        {
          tabUrl: tab.url,
          now,
        },
        config,
      );
      watches.set(tab.id, next);
      if (act.kind === "navigate-back") {
        console.log(`[dsb] 看门狗:标签页 ${tab.id} 离开了会话,导航回去`);
        try {
          await browser.tabs.update(tab.id, { url: act.url });
        } catch (error) {
          console.log("[dsb] 看门狗:导航回去没成", error);
        }
      } else if (act.kind === "nudge") {
        const tabId = tab.id;
        const context = await actionContext();
        const generating = await observedOutput(() => pageIsGenerating(tabId, context), nap);
        // 判读这几秒里总开关可能关过:那笔账已经清了,这一趟不再归本轮--既不催,也不写回.
        const tracked = watches.get(tabId);
        if (tracked === undefined) {
          console.log(`[dsb] 看门狗:标签页 ${tabId} 的账在判读期间被清了,本轮不催`);
          continue;
        }
        if (generating) {
          // 判读那几拍只顺延窗口,活与预算原样(这几拍里可能刚好收活,
          // 别把旧账写回去):输出多半是催办惹来的回复,连预算一起清就成了
          // 催办喂活自己的动静源(#104).
          watches.set(tabId, watchdogSeenPassing(tracked, Date.now()));
          console.log(`[dsb] 看门狗:标签页 ${tabId} 正在生成,本轮不催,静默窗口顺延`);
          continue;
        }
        // 判读那几秒里可能有新动静(回灌落地 / 围栏出门)或收了活:按当下的账再判一次,
        // 仍该催才催--新动静只顺延窗口不收活,只看 taskOpen 会把"刚有动静"当"该催"(#104).
        if (
          watchdogDecision(tracked, { tabUrl: tab.url, now: Date.now() }, config).act.kind !==
          "nudge"
        ) {
          console.log(`[dsb] 看门狗:标签页 ${tabId} 判读期间状态变了,本轮不催`);
          continue;
        }
        // 判读那几秒里闸也可能被关:投递前现读一次,别拿旧 context 替人开口.
        const delivered = await deliverNudge(tabId, act.text, await actionContext());
        // 计数只认送出去的:闸拦着(退避中 / 没开替人发言)不算催.
        // 投递途中可能刚好收活 / 关开关,按当下的账记,别把已清掉的账写回来.
        const latest = watches.get(tabId);
        if (latest !== undefined) {
          watches.set(
            tabId,
            delivered && latest.taskOpen ? watchdogNudged(latest, Date.now()) : latest,
          );
        }
        console.log(
          delivered
            ? `[dsb] 看门狗:距上次动静超 ${config.silenceMs / 1000}s,催办已发`
            : "[dsb] 看门狗:催办没送出去(闸拦着或标签页答不上),不算催",
        );
      } else if (act.kind === "stand-down") {
        console.log(`[dsb] 看门狗:本笔活连催 ${config.maxNudges} 次无动静,停手`);
        recordFailure("watchdog", `本笔活连催 ${config.maxNudges} 次无动静`);
      }
    }
    // 关掉 / 离开本站的标签页不再扫:状态跟着标签页走,不留僵尸.
    for (const tabId of watches.keys()) {
      if (!alive.has(tabId)) watches.delete(tabId);
    }
  }

  /**
   * 本地工具就地跑的接线半边:组合内部的页面动作各走一遍 `runAction`,所以
   * 总开关 / 替人发言 / 退避三道闸照拦;失败码是现成册子里的,不编新码.
   *
   * **不碰中继图标**:本地工具一次 fetch 都没打,它的成败证明不了中继健不健康--闸关着
   * 回 `disabled` 是你自己关的,不是中继坏了.与 `deliverNudge` 同一口径:失败只进控制台,
   * 不翻红,不留失败痕(效果由处置 module 声明:角标 / 保活照配对,图标结论一条不发).
   * 重入护栏(同一标签页一次只跑一个)也在处置 module 的 `sendCall` 里
   * --截获点由 旧 0007 与已退役的 `local-tools` 契约点名(去处见 旧 0001 决定 6),见它的注释.
   *
   * 组合不该抛(内部把失败都折成载荷);真抛了是 bug,交给内容脚本那层既有的兜底.
   */
  async function runLocalTool(
    tool: LocalTool,
    args: Record<string, unknown>,
    tabId: number | undefined,
  ): Promise<ReplyPayload> {
    const context = await actionContext();
    const env: LocalToolEnv = {
      tabId,
      run: (action, params) =>
        runAction(
          { type: "action", id: nextMessageId("local"), action, params, target: String(tabId) },
          context,
        ),
    };
    return tool.run(args, env);
  }

  /**
   * 打中继:一段围栏正文 → 一次 `tools/call`,一次 fetch 打到底.
   *
   * 不轮询,不重试:dsb 是本机服务,答不上来是"连不上 / 认不出"这两件有信息量的事,
   * 中间态不存在;正在跑的调用也不该再发第二个请求去问它(同一 id 只起一份活,
   * 但扩展先 abort 报出来的只会是没信息量的"中继不可达",还会白扔一次调用).
   *
   * 在途角标与保活的按住 / 松手由处置 module 配对(`fenceround` 的效果清单),
   * 这里只负责发请求与把回话折成载荷 + cause(图标结论的"为什么").
   *
   * 本地工具(`findLocalTool` 命中)不走这里:见 `runLocalTool`.
   */
  async function sendOneCall(toolCall: ToolCall): Promise<RelayAnswer> {
    const id = nextMessageId("call");
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), MCP_CALL_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callToolBody(id, toolCall.tool, toolCall.arguments),
      });
      const text = await response.text();
      const payload = parseMcpResponse(response.status, text, id);
      return {
        payload,
        cause: payload.status === "error" ? describeBadResponse(response.status, text) : null,
      };
    } catch (error) {
      const cause = describeFetchFailure(error, MCP_CALL_TIMEOUT_MS);
      console.log(`[dsb] 工具调用没连上(${cause})`);
      return { payload: errorPayload(FAILURE_RELAY_UNREACHABLE), cause };
    }
  }

  /**
   * 保活的按住计数:几块围栏并发在途,最后一个松手才真松(定时器只排一份).
   *
   * 计数留在接线侧:处置 module 只按块声明"按住 / 松手"这对效果,而唯一的那个定时器
   * 是接线侧握着的资源,开与停都属效果的执行(`docs/CODING_STANDARDS.md` 第 1 条的
   * 不适用).
   */
  let keepAliveHolds = 0;
  let releaseKeepAlive: (() => void) | undefined;

  /** 处置 module 的效果出口:角标转速、保活、图标结论、看门狗记忆、控制台,全在这儿落地. */
  function applyFenceEffect(effect: FenceRoundEffect): void {
    switch (effect.kind) {
      case "in-flight":
        setInFlight(effect.on);
        return;
      case "keep-alive":
        if (effect.on) {
          if (keepAliveHolds === 0) releaseKeepAlive = keepAliveWhileSending();
          keepAliveHolds += 1;
        } else {
          keepAliveHolds = Math.max(0, keepAliveHolds - 1);
          if (keepAliveHolds === 0) {
            releaseKeepAlive?.();
            releaseKeepAlive = undefined;
          }
        }
        return;
      case "icon":
        applyOutcome(effect.payload, effect.cause);
        return;
      case "watchdog":
        if (effect.tabId !== undefined) watchdogSeen(effect.tabId, effect.now, effect.phase);
        return;
      case "log":
        console.log(`[dsb] ${effect.note}`);
        return;
    }
  }

  /**
   * 一轮围栏的处置:五条语义(超 8 块截断、坏围栏提示、本地工具就地跑不碰图标、
   * 非 injectable 整轮作废、同标签页重入护栏)全在 `src/lib/fenceround.ts`,
   * 这里只把中继调用、本地工具、保活、时钟与效果出口注进去(入口文件只剩接线).
   */
  const fenceRound = createFenceRound({
    callRelay: sendOneCall,
    runLocal: runLocalTool,
    now: Date.now,
    apply: applyFenceEffect,
  });

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
      const visible = tools.filter(
        (tool) => !tool.name.startsWith("said_") && !HIDDEN_MODEL_TOOLS.has(tool.name),
      );
      toolsCache = { at: Date.now(), tools: visible };
      return visible;
    } catch (error) {
      console.log("[dsb] 工具表没取到", describeFetchFailure(error, MCP_LIST_TIMEOUT_MS));
      return toolsCache?.tools ?? null;
    }
  }

  /**
   * 拉一次 tracked diff:直连中继的 `tools/call trackingdiff`.
   *
   * 不走 `sendOneCall`--那不是围栏,也不该翻图标 / 显示"调"角标 / 触发看门狗.
   * 短超时(10s):本地工具,几十毫秒该回;超了就当作没变更,下一轮再试.
   * 失败静默:拉不到只是这次没注入 diff,不是故障.
   */
  const TRACKINGDIFF_TIMEOUT_MS = 10_000;
  async function fetchTrackingdiff(consume: boolean): Promise<string> {
    const id = nextMessageId("tracked");
    try {
      const response = await fetchWithTimeout(relayMcpUrl(), TRACKINGDIFF_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callToolBody(id, "trackingdiff", { consume }),
      });
      const payload = parseMcpResponse(response.status, await response.text(), id);
      if (payload.status !== "ok") return "";
      return payload.answer === "(无变更)" ? "" : payload.answer;
    } catch {
      return "";
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
      if (payload.status === "error") console.log(`[dsb] said 没报上去(${payload.error})`);
    } catch (error) {
      console.log("[dsb] said 没报上去", describeFetchFailure(error, MCP_LIST_TIMEOUT_MS));
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
      // storage.local 读写口:探针走消息流取持久态,不再自己捅 storage.
      storage: {
        get: async (keys) => await browser.storage.local.get([...keys]),
        set: async (data) => {
          await browser.storage.local.set({ ...data });
        },
        remove: async (keys) => {
          await browser.storage.local.remove([...keys]);
        },
      },
      // 带 target 的动作投进那个标签页:帧裹一层 dsb/action 送过去;
      // 标签页没了 / 内容脚本没注入(sendMessage 抛错)都折成 tab-gone,不冒泡.
      sendToTab: sendMessageSendToTab((tabId, frameToTab) =>
        browser.tabs.sendMessage(tabId, actionRequestMessage(frameToTab)),
      ),
    };
  }

  /** 总开关变了就跟图标:关了即"关",开了先按可达摆,再探一次中继. */
  async function syncFromStorage(): Promise<void> {
    switchEpoch += 1; // 这一代之前的探活回话一律作废(关掉又打开也算)
    const epoch = switchEpoch;
    const stored = await browser.storage.local.get([
      TOGGLE_STORAGE_KEY,
      FAILURE_LOG_STORAGE_KEY,
      ASKS_STORAGE_KEY,
      FAILURE_FRAME_STORAGE_KEY,
    ]);
    // 读盘期间来了新的一代(关掉又打开):这份旧快照一个字都不许落,否则会把"关"盖回"开".
    if (epoch !== switchEpoch) return;
    const enabled = readToggle(stored[TOGGLE_STORAGE_KEY]);
    failureLog = readFailureLog(stored[FAILURE_LOG_STORAGE_KEY]); // 留痕先上手,标题才拼得出历史
    pendingAsks = readPendingAsks(stored[ASKS_STORAGE_KEY]); // 等人回先上手,角标与悬停才拼得出
    // 帧跟着留痕走:载入时就按当下的册子过一遍,孤儿帧(记录已滚出)当场清掉并落盘.
    const loadedFrames = readFailureFrames(stored[FAILURE_FRAME_STORAGE_KEY]);
    failureFrames = pruneFailureFrames(loadedFrames, failureLog);
    if (failureFrames !== loadedFrames) persistFailureFrames();
    await syncHealthAlarm(enabled); // 排班先跟着开关走,图标再跟着探测结果走
    if (epoch !== switchEpoch) return; // 等排班期间换了代:别拿旧开关值改状态
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
    if (epoch !== switchEpoch) return; // 画图标期间换了代:这一趟探活也不用发了

    const probe = await pingRelay();
    if (epoch !== switchEpoch) return; // 回话落地时已经不是这一代:不改状态,不记账
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

  /** 把 `ds-` 时代留下的挂起状态搬到 `dsb/` 名下,只搬一次(搬完旧键就删). */
  async function migrateLegacyStorage(): Promise<void> {
    const plan = planStorageMigration(await browser.storage.local.get([...MIGRATION_KEYS]));
    if (isEmptyMigration(plan)) return;
    await browser.storage.local.set({ ...plan.write });
    await browser.storage.local.remove([...plan.remove]);
    console.log(`[dsb] 清掉 ${plan.remove.length} 个旧存储键:${plan.remove.join(", ")}`);
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!(TOGGLE_STORAGE_KEY in changes)) return;
    // 留一行痕:闹钟排没排、活清没清,看这行就知道跟着开关走了没有.
    console.log(
      `[dsb] 开关变了:排班与图标跟着走(${
        readToggle(changes[TOGGLE_STORAGE_KEY].newValue) ? "开" : "关"
      })`,
    );
    void syncFromStorage();
  });

  // 隔离世界送来的围栏:打中继,把同构载荷原路交回.
  browser.runtime.onMessage.addListener((message, sender) => {
    // 动作帧走 runtime 通道进来(探针 / 扩展页入口):`target: null` 那族(tabs.list /
    // toggle.* / storage.*)只能在这儿就地执行,内容脚本的名册里没有它们.三道闸照走
    // --`storage.*` 与 `toggle.*` 行上自带总开关豁免,读写退避现值不受开关自己挡.
    const action = parseActionRequest(message);
    if (action !== null) {
      return actionContext().then((context) => runAction(action.frame, context));
    }
    const request = parseSendRequest(message);
    if (request !== null) {
      // 围栏进来的动静、在途角标、图标结论、看门狗的落地动静全由处置 module 声明,
      // 接线侧照效果清单做;答复(或整轮作废的失败载荷)原路交回.
      const tabId = sender.tab?.id;
      return fenceRound
        .handle(request.calls, tabId)
        .then(({ payload }) => sendResponseMessage(request.id, payload));
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
    const trackingdiffRequest = parseTrackingdiffRequest(message);
    if (trackingdiffRequest !== null) {
      return fetchTrackingdiff(trackingdiffRequest.consume).then((diff) =>
        trackingdiffResponseMessage(diff),
      );
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
    // --"怎么忽然不自动往下答了"得有个交代(ADR-0004).停手也意味着我们
    // 这一侧的参与到头了,看门狗那笔活一并收掉,别再往死里催(#104 任务门).
    const stop = parseStopReport(message);
    if (stop !== null) {
      console.log(`[dsb] 页面报停手:${stop.cause}`);
      recordFailure("rounds", describeStop(stop.cause));
      const stopTabId = sender.tab?.id;
      if (stopTabId !== undefined) closeWatchdogTask(stopTabId, "续聊到顶停手");
      return undefined;
    }
    // 任务收尾(页面世界报的:这轮答复没有围栏 = 模型自己收了尾):给看门狗
    // 结账--收活、记连续笔数,连续两笔都靠催办推进就封手(#104 任务门).
    const ended = parseEndTaskReport(message);
    if (ended !== null) {
      const endedTabId = sender.tab?.id;
      if (endedTabId !== undefined) closeWatchdogTask(endedTabId, "模型干净收尾");
      return undefined;
    }
    // 续聊这一跳失败(#51):发不出去,正文换不进去,钥匙不符...此前只有控制台
    // 一行,扩展侧答不出"为什么这轮工具结果没回到模型手上".cause 已是短句,
    // 这里只落痕(正文进不来,ADR-0004).
    const continuationFail = parseContinuationFailReport(message);
    if (continuationFail !== null) {
      console.log(`[dsb] 页面报续聊失败:${continuationFail.cause}`);
      const reportedAt = recordFailure("continuation", continuationFail.cause);
      // 只在**真的落了新记录**时抓一帧(#106):同一段红着的延续不重复拍.
      // fire-and-forget:抓帧那一路自己吞掉所有失败,原失败路径不等它,也不看它.
      if (reportedAt !== null) void captureFailureFrameFor(sender.tab, reportedAt);
      return undefined;
    }
    // 账号处境上报(#2):记下最新值并上屏,悬停才说得出"禁言至何时".
    const accountReport: AccountReport | null = parseAccountReport(message);
    if (accountReport !== null) {
      account = accountReport.account;
      console.log(`[dsb] 账号处境已更新:${account.kind}`);
      void paintIcon();
      return undefined;
    }
    return undefined;
  });

  browser.runtime.onInstalled.addListener(() => {
    console.log("[dsb] installed, first message id:", nextMessageId("install"));
    void migrateLegacyStorage();
  });

  void migrateLegacyStorage().then(() => syncFromStorage());
});
