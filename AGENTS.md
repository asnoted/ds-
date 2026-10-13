# AGENTS.md

根目录 agent 唯一入口.**不落 `CLAUDE.md` 之类别名文件**,换 harness 时指过来.

分工:本文件装**规则,命令,入口点**;细节在 `docs/`,见文末"工具指针".

## 命令

```sh
scripts/env-up.sh                 # 幂等:起缺的,旧代码自动换,末尾打判据
scripts/env-up.sh --status        # 只读汇总(旧代码也如实报,但不动手)
scripts/env-up.sh --debug         # 带 --remote-debugging-port,真机探针要这个

pnpm quality                      # 唯一质量门:TS + Python + 三道守卫
pnpm test                         # vitest
uv run pytest                     # Python
uv run ruff check .               # 已含在 pnpm quality
pnpm exec prettier --write .      # 已含在 pre-commit

uv run scripts/page-action.py read                       # 读页面状态(含圆键图标判定)
uv run scripts/page-action.py send button.get            # 发一件页面动作
uv run scripts/page-action.py stop-test                  # 端到端:起生成→点停止→等复位
uv run scripts/page-action.py --no-pace js '<表达式>'     # 页面上下文跑只读 JS
uv run scripts/adrs-index.py                             # 重生成 docs/adr/README.md
uv run scripts/audit-issues.py                           # issue 账面自洽(要 gh + 网络)
```

`pnpm quality` = `check` + `relay:lint` + `relay:test` + `punct`(中文标点守卫)+
`glyphs`(混入别处文字体系守卫)+ `adrs`(ADR 索引守卫).三道守卫只在本地跑,不进 CI.

## 项目概览

DeepSeek 网页版的**浏览器扩展 + 本机 MCP 中继**(`dsb/`).扩展替用户开口(续聊等页面动作),
中继把 MCP 工具接进网页;两边只走线协议,不互调.

| 目录                              | 装什么                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `entrypoints/`                    | WXT 入口:`background.ts` / `content.ts` / `inject.content.ts` / `options` / `popup` |
| `src/lib/`                        | 扩展纯逻辑层(TS,一模块一 `.test.ts`)                                                |
| `dsb/`                            | 本机中继:MCP 网关(Python)                                                           |
| `protocol/fixtures/`              | TS 与 pytest 共读的线协议对拍                                                       |
| `protocol/evidence/controls.json` | 页面控件存证(ADR-0018)                                                              |
| `scripts/`                        | 探针与守卫工具,全按可复用写                                                         |
| `docs/adr/`                       | 架构决策记录(`README.md` 是生成索引)                                                |
| `dsweb/`                          | 站点逆向结论(`FINDINGS.md` §6.2 是硬判据)                                           |

关键入口点:

- `entrypoints/content.ts` 的 `ACTION_ROSTER` -- 内容脚本认得的页面动作名册.
- `src/lib/page.ts` -- 页面动作执行器,抛带码的 `PageError`.
- `src/lib/channel.ts` -- 收信层,`failureCode` 在这里映射成外部可见的码.
- `src/lib/action.ts` -- 扩展自身动作的派发(background),含 `tabs.list` / `toggle.*`.
- `src/lib/gate.ts` / `src/lib/armed.ts` -- 三道闸:"替人开口"的勾选与发送前最后一道.
- `src/lib/toggle.ts` / `src/lib/relay.ts` -- 总开关与中继连接.
- `scripts/page-action.py` -- 真机探针;**绕开 background 直投内容脚本**.

## 状态与配置

- **总开关**:`storage.local` 的 `toggle` 键,缺省 `false`.真源就是 storage;写入触发
  background 的 `storage.onChanged → syncFromStorage`,内容脚本随即 `apply(true)`
  装上 fetch/XHR 钩子.
- **站点下发的配置**:`localStorage` 的 `__ds_remote_feature_store_model` /
  `__ds_remote_feature_store_provider` / `__ds_remote_feature_store` 三个键.先读配置再猜.
- **中继**:`mcp.json` 列 MCP server;`DSB_WORK_ROOT` 改工作目录(缺省本仓根),
  改完**重启中继才生效**.
- **浏览器**:ds-browser 用独立 `--user-data-dir`,登录态在 profile 里,换 profile 会丢.
- **没有 spec 目录**:"必须怎样"由 `GLOSSARY.md`,ADR,测试,`protocol/fixtures/action.json`
  契约样例与 `protocol/evidence/controls.json` 存证承载.

## 扩展架构

页面动作走三层:**名册 → 执行器 → 收信**.

- **名册按控件划分,一个按钮只对应一个动作**.站点把多个意图压进同一个 DOM 元素时
  (生成期圆键原地变停止键,`class` 与 `aria-label` 一个不换,只有图标 `d` 不同),
  **合并成一个动作 + 一个独立的读动作**;不要按图标分家成 `send.click` / `stop.click`,
  那会让两条路对同一元素给出矛盾判断(#32).**图标只出现在读动作的返回里,不参与命中判据.**
- 执行器抛带码的 `PageError`,失败码四档:撞禁言 / 未登录 `composer-absent`(配
  `page.state` 的 `account` 分辨是哪一种),找不到认得的东西 `page-changed`,
  读不完 `read-failed`,**只有这一跳真的走不通才是 `tab-gone`**.
- `tabs.list` 与 `toggle.*` 只在 **background** 的名册里.探针绕开 background,所以
  **够不着**:照约定 `send toggle.set` 回 `unknown-action` 是预期,不是链子坏了.

## 中继 dsb

- 内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),**钉死在工作文件夹 root 内**;
  **不给命令执行**.
- 换中继会丢它起的子进程,`mcp.json` 里那批 MCP server 要重拉一遍.

## 真机验的规矩

细节在 `docs/probe.md`.几条硬的:

- **总开关自己就能开**:`page-action.py storage set --data '{"toggle":true}'`.
  判据**别读 storage**(那只是真源),读钩子装没装:
  `js 'String(window.fetch).includes("native code")'` -- `native code` 在 = 没装.
  不先做这一步,后面全是空跑.
- **DeepSeek 标签页必须在前台**.后台标签页被节流:虚拟列表不挂行,`messages.*` 与
  按位置点的控件读成空.看到"对话区 0 行"先查 `document.visibilityState`,
  别先怀疑动作.开了新会话要读列表,先 `--no-pace focus`.
- **别拿"读页面 / 读全局数组"当判据**.全文搜会被上一轮残留的渲染命中;
  `window.__foo` 会被后一轮覆盖,读到一个**看起来合法**的旧值.装观测 → 填 → 发 → 读,
  闭在同一次调用里.
- **两个观测点只有一个有值,那是观测漏了,不是事实**;"0 帧 / 空"推不出"没发生".
- **不凭印象重实现一个已经在生产里跑的定位器,再拿它当真值** -- 去用它.

## 流程

| 现状         | 走                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| 想法还不清   | `/grill-with-docs`(边问边补 `GLOSSARY.md` 与 ADR)                                                    |
| 成型了       | `/to-spec`(发成 GitHub issue)→ `/to-tickets`(拆 tracer-bullet 票)→ `/implement` 或 `/implement-spec` |
| 坏了         | `/diagnosing-bugs`                                                                                   |
| 过票         | `/triage`                                                                                            |
| 不知道用哪个 | `/ask-matt`                                                                                          |

- **与用户会话的 agent 直接实施**,代码 / 配置 / 文档 / 测试都由它写.链子(网页 → 子 agent)
  **能用时走,不等它**;网页被禁言(账号在站点处罚区)时整条链是断的,那时直接做.
  把子 agent 当小模型:指令要小,要具体,要能验证.
- 技能在 `.agents/skills/`(`skills-lock.json` 记版本).**别手改**(升级会冲掉),
  要调整就在本文件写覆盖规则.
- **判断题在 `docs/CODING_STANDARDS.md`**,review 阶段读(`/code-review` 的 Standards 轴,
  `/implement` 的收尾),写代码时不必.
- **`docs/adr/README.md` 是 ADR 索引**(生成的,漏了会被 `adrs` 守卫判红):找决策先看它,
  别一篇篇 `ls`.**已接受的 ADR 不改**,要推翻就写新篇并在 `Supersedes:` 点名旧篇.
- Issue 在 GitHub Issues `copytht/ds-`,走 `gh`.五个互斥 triage 标签
  (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`)
  见 `docs/agents/triage-labels.md`,细则见 `docs/agents/issue-tracker.md`.

## 工具指针

| 要干什么            | 去哪儿                             |
| ------------------- | ---------------------------------- |
| 起环境 / dsb 运维   | `docs/setup.md`                    |
| 真机验一件动作      | `docs/probe.md`                    |
| 加 / 改页面动作     | `docs/page-actions.md`             |
| 判断题              | `docs/CODING_STANDARDS.md`         |
| 站点逆向结论        | `dsweb/FINDINGS.md`(§6.2 是硬判据) |
| 领域词汇与 ADR 消费 | `docs/agents/domain.md`            |

## 测试要求

- **`pnpm quality` 是唯一门**,TS 与 Python 两半一起过.
- `src/lib/` 一模块一 `.test.ts`;新写模块先补测试.
- 守卫报红(`punct` / `glyphs` / `adrs`)当场修,别绕过,也别去改守卫.

### IMPORTANT

- **禁止**用用户的主 browser profile;跑扩展 / 起浏览器一律独立 `--user-data-dir` 的实例.
- **禁止**把 `--load-extension` 挂到主 profile 实例上,或改写主 profile 的扩展设置.
- **禁止**在用户正在用浏览器时重启它(ds-browser 例外:`env-up.sh` 检测到它装的扩展比构建
  旧,或在跑却没带 `--load-extension`,都会自动重启;登录态不丢,开着的标签页会关).
- **禁止**在根目录新增 `.md` -- 只许 `AGENTS.md` / `README.md` / `GLOSSARY.md`;
  `GLOSSARY.md` **必须**在根目录(技能按它判断单 / 多上下文,挪走不会报错而是**静默失效**).
- **禁止**改 `src/lib/` 里已经上线的定位器再拿它当新事实 -- 去读生产代码.
- **禁止**把脚本写成一次性贴进对话的,要放 `scripts/` 按可复用写.
- **禁止**用"读页面 / 读全局数组"当判据(见"真机验的规矩").
- **禁止**改已接受的 ADR.
