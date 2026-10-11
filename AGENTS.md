## 开发方式

**与用户会话的 agent 直接实施**(2026-10-03 起,用户点头):代码,配置,文档,
测试都由它写.链子(网页 → 子 agent)**回来后再用,但不等它**--网页被禁言
(账号在站点处罚区)时整条链是断的,等它就干瞪眼.

链子能用的活(问第二双眼,跑大段读 legwork)仍走链子,不绕开它;链子断的活
(禁言期间的全部)由与用户会话的 agent 直接做.

默认把子 agent 当成**小模型 / 能力弱**的模型:给它的指令要小,要具体,要能验证,别把开放式的大
目标整包丢过去.

与用户会话的 agent 只做两件事:**把目标和验收标准交给网页,把链子回来的结果原样喂回去**.
怎么拆,怎么排围栏,错了怎么修,让**网页**自己想--不替它读文档,不替它诊断,不逐步指派.

## 流程与技能

2026-10-07 起用 **Matt 的技能**(上游 `mattpocock/skills`,换掉 OpenSpec,见 ADR-0019).技能在
`.agents/skills/`,`skills-lock.json` 记版本;装 / 更新:`npx skills@latest add mattpocock/skills -a opencode -s '*' -y --copy`
/ `npx skills update`.别手改技能文件(升级会冲掉);想调整就在 `AGENTS.md` 里写覆盖规则.

日常流:想法还不清 → `/grill-with-docs`(边问边补 `GLOSSARY.md` 与 ADR);成型 → `/to-spec`(发成 GitHub issue)
→ `/to-tickets`(拆成 tracer-bullet 票)→ `/implement`(或 `/implement-spec`);坏了 → `/diagnosing-bugs`;
过票 → `/triage`;不知道该用哪个 → `/ask-matt`.**没有 spec 目录**:"必须怎样"由 `GLOSSARY.md`,ADR,测试,
`protocol/fixtures/action.json` 契约样例与 `protocol/evidence/controls.json` 存证承载.

## 浏览器边界

**禁止用用户的主浏览器 profile**:跑扩展 / 起浏览器一律走独立 `--user-data-dir` 的实例,
`--load-extension` 不得挂到主 profile 实例上,也不得改写主 profile 的扩展设置.

**用户正在用浏览器时不许重启它**(不 SIGTERM,不重开窗口).要清 flag,换 profile,装扩展,
先问现在方不方便,或者让用户自己动手;动主 profile 必须用户明确点头,含糊点头不算.

**例外(2026-10-04 用户拍板)**:**ds-browser**(独立 profile 那个)这套动作不用先问,直接做:
`scripts/env-up.sh` 检测到它装的扩展比构建旧会自动重启它(SIGTERM 主进程 → 清 SW 脚本缓存 →
重装扩展 → 开会话页);要带调试口跑真机探针(`scripts/env-up.sh --debug`)时按 `--debug`
重启它也一样.**2026-10-04 追加**:同一个判据也管"在跑却没带 `--load-extension`"--手动开的
窗口就是这样(进程在,扩展不在,图标找不到),一样自动重启.
登录态在 profile 里不丢,开着的标签页会关.**除此之外的浏览器一律不动**
(主 profile,别人在用的),要动仍先问.

## 环境准备

**跑 `scripts/env-up.sh`**,别现拼命令:**跑完的环境必须全部对应最新代码**--构建产物,
中继,浏览器装的扩展,三样旧的都自动换新(2026-10-05 用户定;之前中继只提示"手动 kill",
等于把纪律外包给记性,而浏览器那条早就自动重启了).

末尾判据:中继自检健康 / `tools/list` 取得到工具表 / 扩展最后探活新鲜 / 会话标签页
--env-up 起或重启浏览器时**清掉会话恢复,直接带 `chat.deepseek.com` 当首个标签页**;
浏览器是先前就起着的,env-up 不代开,只报.幂等,随时可重跑;`--status` 只读汇总
(旧代码会如实报出来,但不动手),`--debug` 带调试口起.

**换新的代价要知道**:换中继会丢它起的子进程(`mcp.json` 里起着的 MCP server 要重拉一遍),
换浏览器会让开着的标签页关掉.脚本照做不问你--那是为了保证"跑的一定是当前代码";
登录态在独立 profile 里不丢.

## 真机探针

页面动作没有外露调用面(ADR-0011),要真机验就走 `scripts/page-action.py`:
`read`(页面状态)/ `send <动作> [--params json]` / `js <表达式>`(页面上下文里跑只读 JS)/
`stop-test`(端到端)/ `storage get|set|remove` / `capture` / `ax` /
`toggles-off`(测试环境关掉深度思考与智能搜索,`env-up.sh --debug` 会顺带跑)/
`evidence`(存证对账:留档按钮原件 vs 站点当前,ADR-0018,只读,按需本地跑,不进 `pnpm quality`).

- **`target: null` 只有 `tabs.list` 与 `toggle.*` 答得出**.`page.state` / `composer.*` /
  `messages.*` / `chat.new` 要先 `tabs.list` 拿标签页 id 再带上,其余一律落
  `ACTION_ERROR_UNKNOWN`--**那是探针错了,不是链子坏了**,别照着它去修扩展.
- **DeepSeek 标签页必须留在前台**:后台标签页被浏览器节流,虚拟列表不挂行,历史不加载,
  `messages.*` 与按位置点控件会读成空(2026-10-07 踩过,当时前台被探针开的选项页占了).
  探针开扩展入口页走后台(`open_tab(..., background=True)`);若看到"对话区 0 行"先查
  `document.visibilityState`,别先怀疑动作.
- **`--no-pace` / `--pace` 是全局 flag,必须放在子命令前**(`... --no-pace read`,不是
  `... read --no-pace`).碰站点默认等 8–20 秒随机;**抓瞬态**(生成中,思考期那种几秒的窗口)
  必须 `--no-pace` 连读,否则限速下根本抓不到.`list` 只读本地目标清单,不等.
- **本地工具(`send.page` 等)不在 `ACTION_ROSTER` 里**,`send` 调不到.唯一触发办法是用
  `js` 往页面里注入一条 chain 信封,让它走 `content.ts` → background 那条路:

  ```sh
  uv run scripts/page-action.py js 'window.postMessage({source:"ds-/chain",kind:"call",
    id:"probe-1",calls:[JSON.stringify({tool:"send.page",arguments:{question:"..."}})]},"*")'
  ```

  要页面模型**自己**排围栏的路径(如本地工具)只能这么验;不要为了验一个动作去诱导模型排围栏.

- 登录 DeepSeek 与勾"替人开口"是人做的两件,脚本只打印不代劳;没勾闸则写动作回 `disabled`
  属预期,不是故障.
- **真机结果只有一半可信时,别硬下结论**:能用探针交叉验证(`messages.list` 读角色+正文)
  就验,拿不到就在票里写明"间接证据"与"未验证项".

## 页面动作

**动作失败码分得开,别再让它们混成一个**:写动作撞禁言/未登录回 `composer-absent`
(配 `page.state` 的 `account` 读得清是哪一种),页面上找不到认得的东西回 `page-changed`,
读不完回 `read-failed`;只有这一跳真的走不通才是 `tab-gone`.执行器要抛带码的 `PageError`,
收信那层(`channel.ts` 的 `failureCode`)才认.

**名册按控件划分,一个按钮只对应一个动作**:站点把多个意图压进同一个 DOM 元素时(真机
2026-10-04:那个圆键生成期原地变停止键,`class` 与 `aria-label` 一个不换,只有图标 `d` 不同),
**合并成一个动作 + 一个独立的读动作**,不要按图标分家--`send.click`/`stop.click` 那样会让两条
路对同一元素给出矛盾判断(#32).图标只出现在读动作的返回里,**不参与命中判据**.

## 脚本

**所有脚本放 `scripts/`,按可复用写**:一件事一个工具,参数化;别写一次性 `/tmp` 脚本,
更别把脚本贴进对话就算完.要临时读页面 / 发页面动作 / 跑表达式 / 读写扩展 storage,
走已有工具的入口(`scripts/page-action.py` 的 `read` / `send` / `js` / `stop-test` /
`storage`),别另起一个.脚本改动同样过 `pnpm quality`(ruff 会扫 `scripts/`).

## dsb

内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),钉死在工作文件夹 root 内;
`DSB_WORK_ROOT` 改 root(缺省本仓根),改完重启中继才生效.**不给命令执行.**

换中继会丢它起的子进程(见"环境准备")--重拉一遍就是 `mcp.json` 里那批 MCP server.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `copytht/ds-`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.
issue 与 PR 共用一个编号空间,裸 `#42` 可能是 PR;**PR 不是需求面**(本仓不把外部 PR 当 feature request 处理).

### Triage labels

Five canonical roles, label strings equal to the role names (`needs-triage` / `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
接受过的 ADR 不改,要推翻就写新 ADR 并在 `Supersedes:` 点名旧篇.输出提到领域概念时用 `GLOSSARY.md` 里的词;
与 ADR 冲突要挑明,别默默盖过.
