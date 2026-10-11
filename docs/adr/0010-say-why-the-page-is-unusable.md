# 停机要说得出来:写作框不在时,报出账号处境而不是空等

- **Status**: accepted
- **Date**: 2026-10-03
- **Supersedes**: none

页面上找不到写作框时,`page.state` 带一个 `account` 字段说清是哪种处境(`ready` / `muted`(带解封时刻)/ `signed-out` / `unknown`);写动作撞上没有写作框回 `composer-absent`,页面上找不到认得的东西回 `page-changed`,读不完回 `read-failed`--只有这一跳真的走不通才是 `tab-gone`.执行器抛带码的 `PageError`,收信那层(`channel.ts` 的 `failureCode`)才认,且**码必须在册**才认.

依据是 2026-10-02/03 的真机:账号被禁言期间站点**根本不渲染写作框**,扩展此前一声不吭地空等一个永远不会出现的输入框--人在页面上看得见橙条,agent 什么都看不见,只能靠往产物里塞临时诊断表,重启浏览器三轮去猜.

## 判据(照抄站点结构,2026-10-02 从真机页面量的)

- 处罚句只从 `.ds-alert__content` 里认.**会话正文出现"禁言"是常事**--拿全文去搜,等于把用户聊天里的话当成处罚.
- 句子还得同时提到"账号/你"与"禁言/封禁",两头缺一不算(躲开"本周禁言赛制调整"这类公告).
- 解封时刻是正则抠的**纯文本**:真机页面上既没有 `<time>` 也没有 `datetime`.
- 认不出时刻**仍然算 `muted`**,`until` 交 `null`--认不出时间不等于没禁.
- 认不出上面任何一种就交 `unknown`,**不猜**.

## Considered Options

- **在页面上另造一句提示 UI**:这一版重写里没有 chip / 面板可沿用(`src/lib/icon.ts` 只是工具栏图标),造 UI 就是新设计面;而站点自己的橙条已经把人话说全了.押后到真需要时.
- **继续用 `tab-gone` 一码了事**:把"标签页没了""没有写作框""页面结构变了""读不完"四件截然不同的事说成同一句,agent 只能干瞪眼.2026-10-02 为此塞了三轮临时诊断表才定位,代价实测过了.
- **让执行器自由编码**:册子外的词会漏到线上,`dsb/actions.py` 的 `ACTION_ERRORS` 与 TS 侧就对不上了.收信那层认册子,认不出照旧折 `tab-gone`.(**2026-10-04 补记**:`dsb/actions.py` 已随问答后端一起删,Python 侧没有册子了.)

## Consequences

- 查"某动作为什么失败"从此两步:`page.state` 的 `account` 说处境,失败码本身说卡在哪一步.诊断不再需要改产物.
- 三处册子必须同步:`protocol/fixtures/action.json`(TS 与 Python 共读),`dsb/actions.py` 的 `ACTION_ERRORS`,`tests/test_actions.py` 的一致性断言.少改一处门就红.**(2026-10-04 补记:`dsb/actions.py` 与 `tests/test_actions.py` 已删,降为两处--`protocol/fixtures/action.json` 的 `errorCodes` ↔ `src/lib/action.ts` 的 `ACTION_ERROR_*`,对拍在 `action.test.ts` 与 `tests/test_fixtures.py`.)**
- 抛错的原文**只进扩展侧日志**,不进页面,不进对话流(沿用 ADR-0004 的口径).
- **禁言的代价是整条交流线断掉**,不是体验问题:写动作全部无效,队列里的活全都只能干瞪眼.所以出站节奏(ADR-0002)不是次要问题.
