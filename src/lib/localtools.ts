/**
 * 本地工具:名字在扩展自己的一张名册里,**执行不经过 dsb** 的围栏工具.
 *
 * 为什么在扩展侧:dsb 是被动 MCP 网关(ADR-0011)--只能被调,不能反过来
 * 指挥扩展干活;dsb→扩展 的反向通道已废.所以"组合"只能住扩展侧:网页
 * 模型在围栏里排本地工具名时,background 就地执行(`sendCall` 截获,
 * 不把这一条转发 dsb).
 *
 * v1 只有 `send.page` 一件:**往页面发一条问题**,发完即回确认.
 *
 * 它曾经是四步(发问题 → 等页面模型排围栏 → 等回灌 → 取答复),2026-10-05 缩成两步
 * (ADR-0014 之后那三段各自失联,且"取答复"那段根本做不到--页面动作没有 MCP 工具面,
 * 模型读不到页面消息;详见 issue #47).
 * 两步全走 `runAction`,总开关 / 退避两道闸照拦;失败码全取现成册子,不新增.
 *
 * **"代你发言"闸关着时(#52)**:写步(`composer.type`)放行,发送步(`send.enter`)
 * 被闸拦下,于是这一件回 `disabled`--**那条问题留在输入框里当草稿**,用户自己按发送.
 * 失败码不新增:闸拦下时 `runAction` 本来就回 `disabled`,这套两步步序照走即可.
 */

import { ACTION_ERROR_TAB_GONE, ACTION_ERROR_UNKNOWN, type ActionOutcome } from "./action";
import { errorPayload, okPayload, type ReplyPayload } from "./reply";

/** 本地工具执行时由调用方(background)注入的环境. */
export type LocalToolEnv = {
  /** 围栏来自哪个标签页;消息不带 tab 时 undefined(组合当场回 `tab-gone`). */
  readonly tabId: number | undefined;
  /** 送一件页面动作进页面:background 包好 `runAction` 与 `target` 的口. */
  readonly run: (action: string, params: Record<string, unknown>) => Promise<ActionOutcome>;
};

/** 名册里的一件本地工具:名字 / 说明 / 参数(进协议说明)+ 执行体. */
export type LocalTool = {
  readonly name: string;
  readonly description: string;
  readonly params: readonly string[];
  readonly run: (args: Record<string, unknown>, env: LocalToolEnv) => Promise<ReplyPayload>;
};

/** 组合的两步:动作名 + 入参,顺序即执行顺序. */
function sendPageSteps(question: string): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    ["composer.type", { text: question }],
    ["send.enter", {}],
  ];
}

const SEND_PAGE: LocalTool = {
  name: "send.page",
  description: "往页面发一条问题,发完即回确认.",
  params: ["question"],
  async run(args, env) {
    if (env.tabId === undefined) return errorPayload(ACTION_ERROR_TAB_GONE);
    const question = args["question"];
    if (typeof question !== "string" || question.trim() === "") {
      // 排得不成形:与围栏里 JSON 排坏同一处置(不猜,当场说).
      return errorPayload(ACTION_ERROR_UNKNOWN);
    }
    // 两步依次走;任一步没成就原码回,**不再往下**(前半句没成就不发后半句).
    for (const [action, params] of sendPageSteps(question)) {
      const outcome = await env.run(action, params);
      if (!outcome.ok) return errorPayload(outcome.error);
    }
    // 正文是空的:它不取答复--页面的回答照旧进对话,模型从下一次输入里看到.
    return okPayload("");
  },
};

/** 本地工具名册(v1 只有组合 `send.page`). */
export const LOCAL_TOOLS: readonly LocalTool[] = [SEND_PAGE];

/** 按名字找一件本地工具;不是本地的一律 null(调用方照旧转发 dsb). */
export function findLocalTool(name: string): LocalTool | null {
  return LOCAL_TOOLS.find((tool) => tool.name === name) ?? null;
}
