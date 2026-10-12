# 房规

## 谁干活

- **与用户会话的 agent 直接实施**:代码,配置,文档,测试都由它写.
- **链子(网页 → 子 agent)能用时走,不等它**.能用的活是问第二双眼,跑大段读 legwork;
  网页被禁言(账号在站点处罚区)时整条链是断的,那时所有活由与用户会话的 agent 直接做.
- 把子 agent 当**小模型**:指令要小,要具体,要能验证,别把开放式的大目标整包丢过去.
- 与用户会话的 agent 只做两件事:**把目标和验收标准交给网页,把链子回来的结果原样喂回去**.
  怎么拆,怎么排围栏,错了怎么修,让**网页**自己想 -- 不替它读文档,不替它诊断,不逐步指派.
- **判断题在 `docs/CODING_STANDARDS.md`**(判定放纯模块,"修订型 ADR" 的写法).那是任何护栏
  替代不了的跨文件一致性:**review 阶段**(`/code-review` 的 Standards 轴,`/implement` 的收尾)
  去读它,写代码时不必.

## 文档布局

- **根目录的 `.md` 只许三个**:`AGENTS.md`(agent 唯一入口)/ `README.md` / `GLOSSARY.md`.
  别的文档一律进 `docs/`,判断类进 `docs/CODING_STANDARDS.md`.
- **`GLOSSARY.md` 必须在根目录**.Matt 的技能按"根目录有没有 `GLOSSARY.md`"判断单上下文还是
  多上下文;挪走它**不报错,而是静默失效**,`/domain-modeling` 还会在根目录懒创建一份空的.
- **别建 `CLAUDE.md` 之类的别名入口**,也别把本文件内容抄到别处.换 harness 时**指过去**,
  不在仓库里落文件.

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

## 浏览器边界

- **禁止用用户的主浏览器 profile**.跑扩展 / 起浏览器一律走独立 `--user-data-dir` 的实例;
  `--load-extension` 不得挂到主 profile 实例上,也不得改写主 profile 的扩展设置.
- **用户正在用浏览器时不许重启它**(不 SIGTERM,不重开窗口).要清 flag,换 profile,装扩展,
  先问现在方不方便,或让用户自己动手.动主 profile 必须用户**明确**点头,含糊点头不算.
- **例外:ds-browser(独立 profile 那个)不用先问,直接做**:
  - `scripts/env-up.sh` 检测到它装的扩展比构建旧会自动重启它
    (SIGTERM 主进程 → 清 SW 脚本缓存 → 重装扩展 → 开会话页);
  - 要带调试口跑真机探针时按 `--debug` 重启,同理;
  - **"在跑却没带 `--load-extension`"用同一个判据** -- 手动开的窗口就是这样
    (进程在,扩展不在,图标找不到),一样自动重启.
  - 登录态在 profile 里不丢,开着的标签页会关.
- **除此之外的浏览器一律不动**(主 profile,别人在用的),要动仍先问.

## 环境准备

**跑 `scripts/env-up.sh`,别现拼命令**.跑完的环境必须全部对应最新代码 -- 构建产物,中继,
浏览器装的扩展,三样旧的都自动换新.

- **末尾判据**:中继自检健康 / `tools/list` 取得到工具表 / 扩展最后探活新鲜 / 会话标签页.
- 起或重启浏览器时**清掉会话恢复,直接带 `chat.deepseek.com` 当首个标签页**;
  浏览器先前就起着时 env-up 不代开,只报.
- 幂等,随时可重跑.`--status` 只读汇总(旧代码会如实报出来,但不动手);`--debug` 带调试口起.
- **换新的代价**:换中继会丢它起的子进程(`mcp.json` 里那批 MCP server 要重拉一遍),
  换浏览器会让开着的标签页关掉.脚本照做不问你 -- 那是为了保证"跑的一定是当前代码";
  登录态在独立 profile 里不丢.

## 真机探针

页面动作没有外露调用面(ADR-0011),真机验一律走 `scripts/page-action.py`:

| 子命令                        | 干什么                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `read`                        | 读页面状态(含圆键的图标判定)                                         |
| `send <动作> [--params json]` | 给 DeepSeek 标签页发一件页面动作                                     |
| `js <表达式>`                 | 页面上下文里跑只读 JS                                                |
| `sse`                         | 录一轮 SSE,并按 `finish_reason` 判拒收                               |
| `stop-test`                   | 端到端:起生成 → 等停止键 → 点 → 等复位                               |
| `storage get\|set\|remove`    | 读写扩展 storage                                                     |
| `capture` / `ax`              | 截图 / 可访问性树                                                    |
| `toggles-off`                 | 测试环境关掉深度思考与智能搜索(`--debug` 会顺带跑)                   |
| `evidence`                    | 存证对账:留档按钮原件 vs 站点当前(ADR-0018,只读,不进 `pnpm quality`) |

### 逆向结论的去处

- **站点自己的上限,配置,请求体长什么样,结论在 [`dsweb/FINDINGS.md`](dsweb/FINDINGS.md)**.
  测"服务端收没收"先看它 §6.2 的硬判据,别自己搜页面文字.
- 要站点下发的配置(`input_character_limit` 之类),在 `localStorage` 的
  `__ds_remote_feature_store_model` / `__ds_remote_feature_store_provider` /
  `__ds_remote_feature_store` 三个键里 -- **先读配置再猜**.
- 数一段文本几个 token 走 `scripts/count-tokens.py`(分词器取法在
  [`dsweb/README.md`](dsweb/README.md)).**站点服务端用哪个分词器仍未证实**,别把本机口径当定论.

### 探针够不着什么

- **`target: null` 那条是产品链路的约定,探针够不着**:`tabs.list` 与 `toggle.*` 由
  **background** 派发(`src/lib/action.ts`),而探针绕开 background 直接投内容脚本,
  内容脚本的 `ACTION_ROSTER`(`entrypoints/content.ts`)里没有这两个.照约定去
  `send toggle.set` 只会回 `unknown-action` -- **那是够不着,不是链子坏了**.
- **本地工具(`send.page` 等)不在名册里**,只能注入 chain 信封触发,写法见
  `scripts/page-action.py` 的文件头.
- **人做的有两件**:登录 DeepSeek,以及勾"替人开口".脚本只打印不代劳;没勾闸则写动作回
  `disabled`,属预期,不是故障.

### 开真机前先做这一步

**总开关(`storage.local` 的 `toggle` 键,缺省 `false`)探针自己就能开**:

```sh
uv run scripts/page-action.py --no-pace storage set --data '{"toggle":true}'
```

真源就是 `storage.local`,写入触发 background 的 `storage.onChanged → syncFromStorage`,
与 `toggle.set` 走同一条路(内容脚本随即 `apply(true)` 装上 fetch/XHR 钩子).

**判据别读 storage(那只是真源),读钩子装没装**:

```sh
uv run scripts/page-action.py --no-pace js 'String(window.fetch).includes("native code")'
```

`native code` 在 = 没装 = 链子断.**任何要真机验发送路径的活先做这一步,否则后面全是空跑.**

### 页面必须在前台

- **DeepSeek 标签页必须留在前台**.后台标签页被浏览器节流:虚拟列表不挂行,历史不加载,
  `messages.*` 与按位置点控件会读成空.探针开扩展入口页走后台
  (`open_tab(..., background=True)`).
- 看到"对话区 0 行"先查 `document.visibilityState`,别先怀疑动作.
- **开了新会话后要读列表,先 `uv run scripts/page-action.py --no-pace focus`**
  (`Page.bringToFront`).新会话在后台时
  虚拟列表压根不挂行,`messages.*` 恒空;而**开着旧会话读得动**极具迷惑性.
- 带调试口起是 `scripts/env-up.sh --debug`(会顺带跑 `toggles-off`).
- `--no-pace` / `--pace` 抓瞬态时用(生成中,思考期那种几秒的窗口),**必须连读**,否则限速下
  根本抓不到.放错位置 argparse 会拒绝,报错自己会说该放哪.`list` 只读本地目标清单,不等.

### 判据纪律

- **判据要抗自污染**:
  - **别拿"读页面 / 读全局数组"当判据**.全文搜某词会被上一轮的残留渲染命中;
    `window.__foo` 会被后一轮覆盖,读到旧值时它**看起来是个合法数字**.
    装观测 → 填 → 发 → 读**闭在同一次调用里**(`sse` 就是照这条做的),或读之前先清空.
  - **两个观测点只有一个有值时,那是观测漏了,不是事实**."0 帧 / 空"不能推出"没发生"
    (先把 `net` 的 `[]` 当成"前端拒发",推出了互相矛盾的结论 -- CDP `Network` 域漏抓,
    页内 XHR 钩子同时抓几千帧).
- **真机结果只有一半可信时别硬下结论**:能交叉验证(`messages.list` 读角色 + 正文)就验;
  拿不到就在票里写明"间接证据"与"未验证项".
- **不要凭印象重实现一个已经在生产里跑的定位器,再拿它当真值** -- 去用它.

## 页面动作

- **失败码分得开,别让它们混成一个**:
  - 撞禁言 / 未登录 → `composer-absent`(配 `page.state` 的 `account` 读得清是哪一种)
  - 页面上找不到认得的东西 → `page-changed`
  - 读不完 → `read-failed`
  - 只有这一跳真的走不通才是 `tab-gone`

  执行器要抛带码的 `PageError`,收信那层(`channel.ts` 的 `failureCode`)才认.

- **名册按控件划分,一个按钮只对应一个动作**.站点把多个意图压进同一个 DOM 元素时
  (真机 2026-10-04:圆键生成期原地变停止键,`class` 与 `aria-label` 一个不换,只有图标 `d` 不同),
  **合并成一个动作 + 一个独立的读动作**,不要按图标分家 -- `send.click` / `stop.click`
  那样会让两条路对同一元素给出矛盾判断(#32).**图标只出现在读动作的返回里,不参与命中判据.**

## 脚本

- **所有脚本放 `scripts/`,按可复用写**:一件事一个工具,参数化.别写一次性 `/tmp` 脚本,
  更别把脚本贴进对话就算完.
- 要临时读页面 / 发页面动作 / 跑表达式 / 读写扩展 storage,**走已有工具的入口**
  (`scripts/page-action.py` 的 `read` / `send` / `js` / `stop-test` / `storage`),别另起一个.
- 脚本改动同样过 `pnpm quality`(ruff 会扫 `scripts/`).

## dsb

- 内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),**钉死在工作文件夹 root 内**;
  `DSB_WORK_ROOT` 改 root(缺省本仓根),改完重启中继才生效.**不给命令执行.**
- 换中继会丢它起的子进程 -- 重拉一遍就是 `mcp.json` 里那批 MCP server(见"环境准备").

## Issue tracker

Issues 在 GitHub Issues `copytht/ds-`,走 `gh` CLI.细则见 `docs/agents/issue-tracker.md`.

- issue 与 PR 共用一个编号空间,裸 `#42` 可能是 PR;**PR 不是需求面**(本仓不把外部 PR 当
  feature request 处理).
- **账面自洽跑 `uv run scripts/audit-issues.py`**(只读,不进 `pnpm quality` -- 它要 `gh`
  与网络).它按 `triage-labels.md` 查五件事:开票缺 / 多角色标签,关票还挂 `needs-*`,
  `wontfix` 与 `ready-*` 打架,开票零标签,`needs-info` 正文与评论皆空的僵尸票.
  **手工点票会算错**,所以清点交给它.
- `--trace` 另报关票在提交历史里有无 `#编号` 点名,属信息级 -- 早期提交本就没引用编号的惯例,
  要改是改今后的规矩.

## Triage labels

五个互斥角色,标签字符串等于角色名(`needs-triage` / `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`).见 `docs/agents/triage-labels.md`.

## Domain docs

单上下文:根目录 `GLOSSARY.md` + `docs/adr/`.细则见 `docs/agents/domain.md`.

- **找决策先看 `docs/adr/README.md` 那份索引**(21 篇的标题 / 状态 / 日期 / 谁取代了谁,
  一眼看完),别一篇篇 `ls` 然后读文件名.它是**生成的**:新写一篇 ADR 就跑
  `uv run scripts/adrs-index.py`,漏了会被 `pnpm quality` 的 `adrs` 守卫判红.
- **接受过的 ADR 不改**,要推翻就写新 ADR 并在 `Supersedes:` 点名旧篇.
- 输出提到领域概念时用 `GLOSSARY.md` 里的词;**与 ADR 冲突要挑明**,别默默盖过.
