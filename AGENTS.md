# AGENTS.md

根目录 agent 唯一入口.**不落 `CLAUDE.md` 之类别名文件**,换 harness 时指过来.

**本文件只写规则与指针,不写实现细节**:代码里的标识符,storage key,失败码,模块清单,
调用关系一律去看代码或 `docs/` 里的手册 -- 抄进本文件的细节只会跟着代码漂.

## 命令

```sh
scripts/env-up.sh                 # 幂等:起缺的,旧代码自动换,末尾打判据
scripts/env-up.sh --status        # 只读汇总,不动手
scripts/env-up.sh --debug         # 带调试口,真机探针要这个

pnpm quality                      # 唯一质量门:TS + Python + 三道守卫
pnpm test                         # vitest
uv run pytest                     # Python

uv run scripts/page-action.py read    # 真机探针(子命令全表见 docs/probe.md)
uv run scripts/adrs-index.py          # 重生成 docs/adr/README.md
uv run scripts/audit-issues.py        # issue 账面自洽(要 gh + 网络)
```

## 项目概览

DeepSeek 网页版的**浏览器扩展 + 本机 MCP 中继**(`dsb/`).扩展替用户开口,中继把 MCP 工具
接进网页;两边只走线协议,不互调.

| 目录           | 装什么                                           |
| -------------- | ------------------------------------------------ |
| `entrypoints/` | WXT 入口:background,content script,options,popup |
| `src/lib/`     | 扩展纯逻辑层(TS,一模块一 `.test.ts`)             |
| `dsb/`         | 本机中继:MCP 网关(Python)                        |
| `protocol/`    | TS 与 pytest 共读的线协议对拍,页面控件存证       |
| `scripts/`     | 探针与守卫工具,全按可复用写                      |
| `docs/adr/`    | 架构决策记录(`README.md` 是生成索引)             |
| `dsweb/`       | 站点逆向结论(`FINDINGS.md` §6.2 是硬判据)        |

## 文档

- 根目录只许 `AGENTS.md` / `README.md` / `GLOSSARY.md`;别的文档一律进 `docs/`.
- **`GLOSSARY.md` 必须在根目录**:技能按它判断单 / 多上下文,挪走不会报错,而是**静默失效**.
- **判断题在 `docs/CODING_STANDARDS.md`**,review 阶段读(`/code-review` 的 Standards 轴),
  写代码时不必.
- **找决策先看 `docs/adr/README.md` 索引**(生成的,漏了会被 `adrs` 守卫判红),别一篇篇 `ls`.
  **已接受的 ADR 不改**,要推翻就写新篇并在 `Supersedes:` 点名旧篇.
- 输出提到领域概念时用 `GLOSSARY.md` 里的词;与 ADR 冲突要挑明,别默默盖过.

## 真机

细节在 `docs/probe.md`,这里只留判据纪律.

- **验发送路径前先开总开关,并确认钩子真装上了**.不先做这一步,后面全是空跑.
- **DeepSeek 标签页必须在前台**;后台标签页被节流,读到的空不是事实.
- **判据别读页面残留或全局数组**:上一轮的渲染会命中全文搜索,全局值会被后一轮覆盖成
  一个看起来合法的旧值.装观测 → 填 → 发 → 读,闭在同一次调用里.
- **两个观测点只有一个有值,那是观测漏了,不是事实**;"0 帧 / 空"推不出"没发生".
- **不凭印象重实现一个已经在生产里跑的定位器再拿它当真值** -- 去用它.

## 页面动作

判据在 `docs/page-actions.md`,名册与执行器看代码.

- **名册按控件划分,一个按钮只对应一个动作**;站点把多个意图压进同一个 DOM 元素时,
  合并成一个动作 + 一个独立的读动作,不要按图标分家.
- **失败码要分得开**:撞禁言 / 未登录,页面变了,读不完,各自一个码;只有这一跳真的走不通
  才是"找不到标签页".混成一个码,收信那层就分辨不了.

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
- **技能在 `.agents/skills/`**(`skills-lock.json` 记版本).**别手改**(升级会冲掉),
  要调整就在本文件写覆盖规则.
- Issue 在 GitHub Issues `copytht/ds-`,走 `gh`.五个互斥 triage 标签见
  `docs/agents/triage-labels.md`,开 / 关 / 打标签的细则见 `docs/agents/issue-tracker.md`,
  领域文档的消费方式见 `docs/agents/domain.md`.

## 工具指针

| 要干什么          | 去哪儿                             |
| ----------------- | ---------------------------------- |
| 起环境 / 中继运维 | `docs/setup.md`                    |
| 真机验一件动作    | `docs/probe.md`                    |
| 加 / 改页面动作   | `docs/page-actions.md`             |
| 判断题            | `docs/CODING_STANDARDS.md`         |
| 站点逆向结论      | `dsweb/FINDINGS.md`(§6.2 是硬判据) |

## 测试要求

- **`pnpm quality` 是唯一门**,TS 与 Python 两半一起过.
- `src/lib/` 一模块一 `.test.ts`;新写模块先补测试.
- 守卫报红(`punct` / `glyphs` / `adrs`)当场修,别绕过,也别去改守卫.

### IMPORTANT

- **禁止**用用户的主 browser profile;跑扩展 / 起浏览器一律独立 `--user-data-dir` 的实例.
- **禁止**把 `--load-extension` 挂到主 profile 实例上,或改写主 profile 的扩展设置.
- **禁止**在用户正在用浏览器时重启它(ds-browser 例外:`env-up.sh` 检测到它装的扩展比构建
  旧,或在跑却没带 `--load-extension`,都会自动重启;登录态不丢,开着的标签页会关).
- **禁止**在根目录新增 `.md`.
- **禁止**把脚本写成一次性贴进对话的,要放 `scripts/` 按可复用写.
- **禁止**用"读页面 / 读全局数组"当判据(见"真机").
- **禁止**改已接受的 ADR.
- **禁止**改 `src/lib/` 里已经上线的定位器再拿它当新事实 -- 去读生产代码.
