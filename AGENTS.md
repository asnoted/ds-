# 房规

## 谁干活

- **与用户会话的 agent 直接实施**:代码,配置,文档,测试都由它写.
- **链子(网页 → 子 agent)能用时走,不等它**.能用的活是问第二双眼,跑大段读 legwork;
  网页被禁言(账号在站点处罚区)时整条链是断的,那时所有活由与用户会话的 agent 直接做.
- 把子 agent 当**小模型**:指令要小,要具体,要能验证,别把开放式的大目标整包丢过去.
- 与用户会话的 agent 只做两件事:**把目标和验收标准交给网页,把链子回来的结果原样喂回去**.
  怎么拆,怎么排围栏,错了怎么修,让**网页**自己想 -- 不替它读文档,不替它诊断,不逐步指派.

## 文档布局

- **根目录的 `.md` 只许三个**:`AGENTS.md`(agent 唯一入口)/ `README.md` / `GLOSSARY.md`.
  别的文档一律进 `docs/`.
- **`GLOSSARY.md` 必须在根目录**.Matt 的技能按"根目录有没有 `GLOSSARY.md`"判断单上下文还是
  多上下文;挪走它**不报错,而是静默失效**,`/domain-modeling` 还会在根目录懒创建一份空的.
- **别建 `CLAUDE.md` 之类的别名入口**,也别把本文件内容抄到别处.换 harness 时**指过去**,
  不在仓库里落文件.

## 工具指针

| 要干什么                               | 去哪儿                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 判断题(裁定放纯模块,修订型 ADR 的写法) | `docs/CODING_STANDARDS.md` -- **review 阶段**读(`/code-review` 的 Standards 轴,`/implement` 的收尾),写代码时不必 |
| 起环境 / dsb 的运维点                  | `docs/setup.md`(命令在 `README.md` 的"起环境")                                                                   |
| 真机验一件页面动作                     | `docs/probe.md`(子命令表 + 判据纪律)                                                                             |
| 加 / 改页面动作                        | `docs/page-actions.md`(失败码分档,名册按控件划分)                                                                |
| 站点逆向结论                           | `dsweb/FINDINGS.md`(硬判据在它的 §6.2)                                                                           |
| 找一个架构决策                         | `docs/adr/README.md` 索引(生成的,漏了会被守卫判红)                                                               |
| issue 怎么开/关/打标签                 | `docs/agents/issue-tracker.md` + `docs/agents/triage-labels.md`                                                  |
| 领域词汇与 ADR 的消费方式              | `docs/agents/domain.md`                                                                                          |

## 起环境

**跑 `scripts/env-up.sh`,别现拼命令**(幂等,且保证跑完的环境全部对应最新代码).
判据与代价见 [`docs/setup.md`](docs/setup.md).

## 浏览器边界

- **禁止用用户的主 browser profile**.跑扩展 / 起浏览器一律走独立 `--user-data-dir` 的实例;
  `--load-extension` 不得挂到主 profile 实例上,也不得改写主 profile 的扩展设置.
- **用户正在用浏览器时不许重启它**(不 SIGTERM,不重开窗口).要清 flag,换 profile,装扩展,
  先问现在方不方便,或让用户自己动手.动主 profile 必须用户**明确**点头,含糊点头不算.
- **例外:ds-browser(独立 profile 那个)不用先问,直接做** -- `scripts/env-up.sh` 检测到它
  装的扩展比构建旧,或**在跑却没带 `--load-extension`**(手动开的窗口就是这样:进程在,
  扩展不在,图标找不到),都会自动重启它.登录态不丢,开着的标签页会关.
- **除此之外的浏览器一律不动**(主 profile,别人在用的),要动仍先问.

## 技能

用 **Matt 的技能**(上游 `mattpocock/skills`,换掉 OpenSpec,见 ADR-0019).技能在
`.agents/skills/`,`skills-lock.json` 记版本.

```sh
npx skills@latest add mattpocock/skills -a opencode -s '*' -y --copy  # 装
npx skills update                                                     # 升级
```

- **别手改技能文件**(升级会冲掉).要调整就在本文件里写覆盖规则.
- **别的技能库同理**(archify 等):`npm` 装技能要走代理 7897,且**装完先审内容再用** --
  技能以完整 agent 权限运行.
- **`.agents/` 已在 `eslint.config.js` 与 `.prettierignore` 里排除**.新增别的 vendored
  目录要一并加,否则 `pnpm quality` 会冒出上百条与本仓无关的错.

## 流程

| 现状         | 走                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| 想法还不清   | `/grill-with-docs`(边问边补 `GLOSSARY.md` 与 ADR)                                                    |
| 成型了       | `/to-spec`(发成 GitHub issue)→ `/to-tickets`(拆 tracer-bullet 票)→ `/implement` 或 `/implement-spec` |
| 坏了         | `/diagnosing-bugs`                                                                                   |
| 过票         | `/triage`                                                                                            |
| 不知道用哪个 | `/ask-matt`                                                                                          |

**没有 spec 目录**:"必须怎样"由 `GLOSSARY.md`,ADR,测试,`protocol/fixtures/action.json`
契约样例与 `protocol/evidence/controls.json` 存证承载.

## 脚本

- **所有脚本放 `scripts/`,按可复用写**:一件事一个工具,参数化.别写一次性 `/tmp` 脚本,
  更别把脚本贴进对话就算完.
- 要临时读页面 / 发页面动作 / 跑表达式 / 读写扩展 storage,**走已有工具的入口**
  (`scripts/page-action.py`),别另起一个.用法见 [`docs/probe.md`](docs/probe.md).
- 脚本改动同样过 `pnpm quality`(ruff 会扫 `scripts/`).

## Issue tracker

Issues 在 GitHub Issues `copytht/ds-`,走 `gh` CLI.细则见 `docs/agents/issue-tracker.md`.

- issue 与 PR 共用一个编号空间,裸 `#42` 可能是 PR;**PR 不是需求面**(本仓不把外部 PR 当
  feature request 处理).
- **账面自洽跑 `uv run scripts/audit-issues.py`**(只读,不进 `pnpm quality` -- 它要 `gh`
  与网络).它按 `triage-labels.md` 查五件事:开票缺 / 多角色标签,关票还挂 `needs-*`,
  `wontfix` 与 `ready-*` 打架,开票零标签,`needs-info` 正文与评论皆空的僵尸票.
- `--trace` 另报关票在提交历史里有无 `#编号` 点名(信息级,不进账面判据).

## Triage labels

五个互斥角色,标签字符串等于角色名(`needs-triage` / `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`).见 `docs/agents/triage-labels.md`.

## Domain docs

单上下文:根目录 `GLOSSARY.md` + `docs/adr/`.细则见 `docs/agents/domain.md`.

- **找决策先看 `docs/adr/README.md` 那份索引**(标题 / 状态 / 日期 / 谁取代了谁),
  别一篇篇 `ls` 然后读文件名.它是**生成的**:新写一篇 ADR 就跑
  `uv run scripts/adrs-index.py`,漏了会被 `pnpm quality` 的 `adrs` 守卫判红.
- **接受过的 ADR 不改**,要推翻就写新 ADR 并在 `Supersedes:` 点名旧篇.
- 输出提到领域概念时用 `GLOSSARY.md` 里的词;**与 ADR 冲突要挑明**,别默默盖过.
