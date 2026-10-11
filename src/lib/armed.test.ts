import { describe, expect, it } from "vitest";

import {
  ARMED_TTL_MS,
  arm,
  armedBody,
  claimArmed,
  disarm,
  expireIfStale,
  idleArmed,
  isPendingBody,
  matchesMarker,
  pend,
  planContinuation,
  settleArmedAfterSend,
} from "./armed";
import { CONTINUATION_MARKER } from "./continuation";

const BODY = "agent:\nstatus: ok\nanswer[1]{text}:\n  入口在 dsb/server.py.";

describe("matchesMarker / 钥匙", () => {
  it("认短标记本身(含首尾空白与 CRLF 的写法)", () => {
    expect(matchesMarker(CONTINUATION_MARKER)).toBe(true);
    expect(matchesMarker(`  ${CONTINUATION_MARKER}  `)).toBe(true);
    expect(matchesMarker(CONTINUATION_MARKER.replace(/\n/g, "\r\n"))).toBe(true);
    expect(matchesMarker("agent:\r\n继续")).toBe(true);
  });

  it("认不出用户自己写的话(#49 的核心:手打的消息永远不等于标记)", () => {
    expect(matchesMarker("你好")).toBe(false);
    expect(matchesMarker("agent: 继续")).toBe(false); // 空格不是换行
    expect(matchesMarker("agent:\n继续\n")).toBe(true); // 只差首尾空白仍算同一句
    expect(matchesMarker("agent:\n继续 帮我看看 README")).toBe(false); // 多了一句就不算
    expect(matchesMarker("agent:")).toBe(false); // 只半句
    expect(matchesMarker(BODY)).toBe(false); // 工具结果正文本身不是标记
    expect(matchesMarker("")).toBe(false);
  });
});

describe("arm / pend / disarm / armedBody / isPendingBody", () => {
  it("idle 时没有正文等着", () => {
    expect(isPendingBody(idleArmed())).toBe(false);
    expect(armedBody(idleArmed())).toBeNull();
  });

  it("arm 挂上正文,pend 也挂上(无 TTL),两者 armedBody 都是它", () => {
    expect(armedBody(arm(BODY, 1000))).toBe(BODY);
    expect(armedBody(pend(BODY))).toBe(BODY);
    expect(isPendingBody(arm(BODY, 1000))).toBe(true);
    expect(isPendingBody(pend(BODY))).toBe(true);
  });

  it("disarm 回到 idle(发送失败,形状认不出,闸被关)", () => {
    expect(disarm(arm(BODY, 1000))).toEqual({ phase: "idle" });
    expect(disarm(pend(BODY))).toEqual({ phase: "idle" });
    expect(disarm(idleArmed())).toEqual({ phase: "idle" });
  });
});

describe("expireIfStale / armed 的 TTL", () => {
  it("TTL 之内原样返回(同一引用),过期限就作废", () => {
    const state = arm(BODY, 1000);
    expect(expireIfStale(state, 1000 + ARMED_TTL_MS)).toBe(state);
    expect(expireIfStale(state, 1000 + ARMED_TTL_MS + 1)).toEqual({ phase: "idle" });
  });

  it("TTL 是 10 秒(#49:从 30s 收紧)", () => {
    expect(ARMED_TTL_MS).toBe(10_000);
  });

  it('pending 态不看时间:挂到天荒地老也还在(#52 的"等你按发送")', () => {
    const state = pend(BODY);
    expect(expireIfStale(state, 1000 + ARMED_TTL_MS * 1000)).toBe(state);
  });
});

describe("claimArmed / 认领一条出站请求", () => {
  it("正文逐字等于标记:认领走,换成工具结果,武装清空", () => {
    const outcome = claimArmed(arm(BODY, 1000), CONTINUATION_MARKER, true);
    expect(outcome.claimed).toBe(true);
    expect(outcome.replacement).toBe(BODY);
    expect(outcome.state).toEqual({ phase: "idle" });
  });

  it("pending 态同样按钥匙认领(用户自己按了发送)", () => {
    const outcome = claimArmed(pend(BODY), CONTINUATION_MARKER, true);
    expect(outcome.claimed).toBe(true);
    expect(outcome.replacement).toBe(BODY);
  });

  it("正文是用户手打的话:原样放行(replacement null),且撤销武装(#49 的核心)", () => {
    const outcome = claimArmed(arm(BODY, 1000), "帮我看看 README", true);
    expect(outcome.claimed).toBe(false);
    expect(outcome.replacement).toBeNull();
    expect(outcome.state).toEqual({ phase: "idle" });
  });

  it("形状认不出(shapeOk=false):即便正文等于标记也不替换,但认领走了", () => {
    const outcome = claimArmed(arm(BODY, 1000), CONTINUATION_MARKER, false);
    expect(outcome.claimed).toBe(true);
    expect(outcome.replacement).toBeNull();
    expect(outcome.state).toEqual({ phase: "idle" });
  });

  it("没有正文等着(idle):不认领,不替换,武装原样", () => {
    const outcome = claimArmed(idleArmed(), CONTINUATION_MARKER, true);
    expect(outcome.claimed).toBe(false);
    expect(outcome.replacement).toBeNull();
    expect(outcome.state).toEqual({ phase: "idle" });
  });

  it("body 为 null(取不出待发那条):当钥匙不符处理,原样放行并撤销", () => {
    const outcome = claimArmed(arm(BODY, 1000), null, true);
    expect(outcome.claimed).toBe(false);
    expect(outcome.state).toEqual({ phase: "idle" });
  });

  it("一次就作废:认领走之后再撞一条同样等于标记的请求,不再替换", () => {
    const first = claimArmed(arm(BODY, 1000), CONTINUATION_MARKER, true);
    expect(first.replacement).toBe(BODY);
    // 武装已清空:第二次撞同样的正文,不再替换(避免重复把工具结果送两遍)
    const second = claimArmed(first.state, CONTINUATION_MARKER, true);
    expect(second.claimed).toBe(false);
    expect(second.replacement).toBeNull();
  });

  it("待发的那条(pending)被消费后不重复替换(用户只按一次发送)", () => {
    const outcome = claimArmed(pend(BODY), CONTINUATION_MARKER, true);
    expect(outcome.replacement).toBe(BODY);
    expect(claimArmed(outcome.state, CONTINUATION_MARKER, true).replacement).toBeNull();
  });

  it("待发挂着时用户改了内容再发:原样放行并撤销(他发的是自己的话)", () => {
    const outcome = claimArmed(pend(BODY), "agent:\n继续\n再加一句", true);
    expect(outcome.claimed).toBe(false);
    expect(outcome.replacement).toBeNull();
    expect(outcome.state).toEqual({ phase: "idle" });
  });
});

describe("planContinuation / 一趟续聊的走向(#52 的 AC 首条)", () => {
  it("闸开着:arm-and-send(照旧自动发)", () => {
    expect(planContinuation(true)).toEqual({ action: "arm-and-send" });
  });

  it("闸关着:stage-only -- **没有发送步骤**,接线层因此碰不到 Enter", () => {
    const plan = planContinuation(false);
    expect(plan).toEqual({ action: "stage-only" });
    // 这一支的结构里压根没有"发"这个动作:早先接线层挂完 pending 仍往下走
    // sendToPage,闸就形同虚设(#52 的 AC"不按 Enter,不点发送键"失效).
    expect(Object.keys(plan)).toEqual(["action"]);
    expect(plan.action).not.toContain("send");
  });
});

describe("settleArmedAfterSend / 发送回来后武装怎么落(#49 的 AC)", () => {
  it("发出去:武装留着,等站点的出站请求拿钥匙来认领", () => {
    const state = arm(BODY, 1000);
    expect(settleArmedAfterSend(state, true)).toBe(state);
  });

  it("sendToPage 返回 false:立刻撤(下一个出站就是用户自己发的消息)", () => {
    expect(settleArmedAfterSend(arm(BODY, 1000), false)).toEqual({ phase: "idle" });
  });

  it("sendToPage 抛错:同样立刻撤(接线层把 catch 也走这条)", () => {
    expect(settleArmedAfterSend(arm(BODY, 1000), false)).toEqual({ phase: "idle" });
    // pending 态也一样:等用户按发送那条发不出去时不能留着
    expect(settleArmedAfterSend(pend(BODY), false)).toEqual({ phase: "idle" });
  });

  it("本来就是 idle:原样返回(不制造新对象)", () => {
    const idle = idleArmed();
    expect(settleArmedAfterSend(idle, true)).toBe(idle);
    expect(settleArmedAfterSend(idle, false)).toBe(idle);
  });
});
