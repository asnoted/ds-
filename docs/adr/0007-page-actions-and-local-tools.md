# ADR-0007: 页面动作要说得清卡在哪一步; 组合工具住扩展侧

- **Status**: accepted
- **Date**: 2026-10-17

页面动作(名册里那一件件最小的事)**没有外部调用面**, 调用方是扩展自己; 所以失败必须自己
说得清: `page.state` 报出**账号处境**, 每一跳当场回一个**册子里的码**. 而"组合"这类要串几步
的工具住**扩展侧**, 不转发 dsb.

依据是 2026-10-02/03 的真机: 账号被禁言期间站点**根本不渲染写作框**, 扩展此前一声不吭地
空等一个永远不会出现的输入框 -- 人在页面上看得见橙条, agent 什么都看不见, 只能靠往产物里塞
临时诊断表, 重启浏览器三轮去猜.

## 决定

### 处境与失败码

1. **`page.state` 带 `account` 字段**说清是哪种处境: `ready` / `muted`(带解封时刻) /
   `signed-out` / `unknown`.
2. **失败码各说一件事**: 写动作撞上没有写作框回 `composer-absent`, 页面上找不到认得的东西回
   `page-changed`, 读不完回 `read-failed` -- 只有这一跳真的走不通才是 `tab-gone`. 把四件
   截然不同的事说成同一句, agent 只能干瞪眼.
3. **执行器抛带码的 `PageError`**, 收信那层(`src/lib/channel.ts` 的 `failureCode`)才认, 且
   **码必须在册**才认; 册子外的词照旧折 `tab-gone`.
4. **两处册子必须同步**: `protocol/fixtures/action.json` 的 `errorCodes` ↔
   `src/lib/action.ts` 的 `ACTION_ERROR_*`; 少改一处测试门就红.
5. **抛错的原文只进扩展侧日志**, 不进页面, 不进对话流(与 ADR-0008 同一口径).

### 认处罚的判据(照抄站点结构)

- 处罚句只从 `.ds-alert__content` 里认. **会话正文出现"禁言"是常事** -- 拿全文去搜, 等于把
  用户聊天里的话当成处罚.
- 句子还得同时提到"账号/你"与"禁言/封禁", 两头缺一不算(躲开"本周禁言赛制调整"这类公告).
- 解封时刻是正则抠的**纯文本**: 真机页面上既没有 `<time>` 也没有 `datetime`.
- 认不出时刻**仍然算 `muted`**, `until` 交 `null` -- 认不出时间不等于没禁.
- 认不出上面任何一种就交 `unknown`, **不猜**.

### 本地工具(组合)住扩展侧

6. 扩展持一小张**本地工具名册**(`src/lib/localtools.ts`): 网页模型在围栏里排 `send.page` 时,
   background 认出后**就地执行**(`composer.type` → `send.enter` 两步, 全走 `runAction` 三道
   闸), **不把这一条转发 dsb**; 结果按回灌口径回页面, dsb 保持被动.
7. 名册是**扩展自己的**, 不占 dsb 的 `tools/list`; 协议说明(`instructions.ts`)另列一段
   "本地工具"告诉模型可以排哪些名字.
8. 本地工具名在 `sendCall` 里截获: 命中就地跑, 未命中照旧转发 dsb -- 普通工具路径一字不改.
   处置抽在 `src/lib/fenceround.ts`(带注入口的 module), background 只剩 storage / alarms /
   browser 接线.
9. 组合失败以 `errorPayload` 返回, 不进对话流(与 dsb 传输 / 闸失败同口径).

## Considered Options

- **在页面上另造一句提示 UI**: 这一版重写里没有 chip / 面板可沿用, 造 UI 就是新设计面; 而
  站点自己的橙条已经把人话说全了. 否决.
- **继续用 `tab-gone` 一码了事**: 四件事说成一句, 诊断只能靠临时表. 实测付过代价. 否决.
- **让执行器自由编码**: 册子外的词会漏到线上, 收信那层与册子对不上. 否决.
- **组合放 dsb 侧**(issue #23 的字面要求): dsb 是被动 MCP 网关, 要让它在组合里指挥扩展打字 /
  发送, 就得重开一条 dsb → 扩展的反向通道(ADR-0002 刚废掉的那些). 否决.
- **外部 agent 直呼页面动作**: 整个动作名册本就没有外露入口, 现状不是回退; 要重开双向通道是
  另一件事, 另开任务.

## Consequences

- **查"某动作为什么失败"从两步起**: `page.state` 的 `account` 说处境, 失败码本身说卡在哪一步;
  诊断不再需要改产物.
- **禁言的代价是整条交流线断掉**, 不是体验问题: 写动作全部无效, 队列里的活全都只能干瞪眼.
  所以出站节奏(ADR-0004)不是次要问题.
- **`send.page` 只做"往页面发一条问题"这一件**: 它最早画的是四步(打字 → 发送 → 等围栏 → 等
  回灌), 后两步在工具结果改成"请求体替换 + 短标记"(ADR-0005)之后根本做不到 -- 页面动作没有
  MCP 工具面, 模型读不到页面消息. 于是缩成前两步, 协议说明里那个"返回答复正文"的假承诺一并
  删掉.
- **issue #23 的原始需求仍未满足**: 它要的是"组合在 dsb 侧, 任何 agent 开箱即用", 而本决定改
  住扩展侧之后**只对围栏里的页面模型生效**. `send.page` 不是 #23 的答案, 它是落空的产物;
  真要满足 #23, 得重开 dsb → 扩展的双向通道 -- 另一件事, 另开任务.

## 判据(怎么自己复现)

```sh
pnpm vitest run src/lib/action.test.ts src/lib/page.test.ts src/lib/localtools.test.ts \
  src/lib/fenceround.test.ts src/lib/fixtures.test.ts
uv run pytest tests/test_fixtures.py -q

# 红: 把 protocol/fixtures/action.json 里一条错误码改一个字符(`page-changed` 改成 page_changed),
# fixtures.test.ts 那条"失败带册子上的码"与 pytest 那条"用例自洽"同时红(15 条里 1 条); 反过来
# 只改 src/lib/action.ts 里那个常量值, 那条"TS 的值就是册子里那八条(两向)"当场红 -- 这条两向
# 对拍是 2026-10-18 补的: 补之前改常量值全仓 818 条照旧绿, 而 channel.ts 那句
# `actionErrorCodes().includes(error.code)` 会当场认不出那个码.
```

`send.page` 两步序与闸关着那一半的真机读数见 `docs/evidence/speak-gate.md`.
