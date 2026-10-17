# ds-

浏览器扩展与配套本机中继的双栈仓库:

- **扩展**:pnpm + WXT + TypeScript,占仓库根目录
- **中继**:uv + Python,包在根目录的 `dsb/`

## 核心链路(ADR-0011)

网页模型把要调的工具排成一个 ```send 围栏,扩展认出围栏,经本机中继
`POST /mcp`(JSON-RPC 2.0)转给 `mcp.json` 配好的 MCP servers,结果按 TOON 回灌进对话:

````
页面模型 → ```send 围栏(工具调用 JSON) → inject.content(MAIN)
        → 隔离世界 → background → POST /mcp → dsb → mcp.json 里的 servers
        → 结果回灌(短标记进对话 + 请求体替换送模型,ADR-0014)
        → 唯一出站口(ADR-0002) → 页面
````

一圈的交互图(archify 生成,源文件在同目录):

![自动续聊:一圈是怎么转的](docs/diagrams/continuation-round.svg)

<sub>可缩放,悬浮看细节的交互版:[HTML](docs/diagrams/continuation-round.html) / [JSON 源文件](docs/diagrams/continuation-round.json)</sub>

中继完全被动:不推送,不轮询,无会话,一条 CORS 头都不下发;只有 background 打网络.

dsb 另外内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),钉死在工作文件夹
root 内(`DSB_WORK_ROOT` 配置,缺省本仓根),不给任何命令执行;见 `docs/adr/0012`.

## 限额与超时

| 项                    | 默认                                                | 落在哪                         |
| --------------------- | --------------------------------------------------- | ------------------------------ |
| 单次结果              | 64K 字(超了截断并写明原长)                          | 网关 `MAX_RESULT_CHARS`        |
| 工作工具一条结果      | 16000 字(超了按整行截断,末行写明怎么续)             | 工作工具 `WORK_RESULT_CHARS`   |
| 单服务工具            | 128 件(超了只注册前 128 件)                         | 网关 `MAX_TOOLS_PER_SERVER`    |
| 一轮围栏              | 8 块(超了剩下的下一轮再排)                          | 扩展 `MAX_CALLS_PER_ROUND`     |
| 自动续聊              | 8 轮(到顶停手,等用户开口)                           | 扩展 `MAX_CONTINUATION_ROUNDS` |
| 给模型看的结果        | 16000 字(超了截断并写明原长)                        | 扩展 `MAX_RESULT_CHARS`        |
| 单条输入的 token 预算 | 900,000 token(实测硬墙约 98 万,差额是余量,ADR-0028) | 扩展 `MAX_SAFE_INPUT_TOKENS`   |
| 握手超时              | 30s(`DSB_CONNECT_TIMEOUT`)                          | 起子进程 + `initialize`        |
| 发现超时              | 20s(`DSB_DISCOVERY_TIMEOUT`)                        | `tools/list`                   |
| 调用超时              | 120s(`DSB_TOOL_TIMEOUT`)                            | 一次 `tools/call`              |
| `grep` 墙钟           | 20s(过线中止,回 `pattern-too-slow`)                 | 工作工具 `WORK_GREP_DEADLINE`  |

三个超时键都认进程环境与 `.env`(认不出或非正数落默认);其余是常量,改常量有测试钉着.
超时之后子进程会被**断掉**(不是晾着它接着转),下一次调用起个新的--重试即恢复,见 ADR-0034.

**表里的数以代码为准**:三处结果上限各管一段,别混(网关那道在 `dsb/gateway.py` 是 64K 字,
管第三方 server 的结果;扩展那道在 `src/lib/continuation.ts` 是 16000 字,管回灌进对话;
自家五件工作工具的整条结果在 `dsb/work.py` 是 16000 字,与 read 的一页同数).
2026-10-11 对过一次账:表里"给模型看的结果"还写着 2000 字,而代码早在 ADR-0027
就改成了 16000 -- 表是人手抄的,抄完就没人回头看. 现在 `tests/test_readme_limits.py`
拿代码当唯一事实源钉着这张表:数值与落点(常量名 / env 键)对不上就红,加一行没接进
守卫也红.

## 结构

```
.
├── entrypoints/        # WXT 入口:background,content script,inject(MAIN)
├── src/                # 扩展的纯逻辑层(TS,可单测)
├── dsb/                # 本机中继:MCP 网关(Python)
├── protocol/fixtures/  # TS 与 pytest 共读的线协议对拍
├── docs/adr/           # 架构决策记录(README.md 是生成的索引)
├── docs/agents/        # issue 追踪 / 分诊标签 / 领域文档的规则(Matt 的技能读)
├── docs/CODING_STANDARDS.md  # 判断题:裁定放纯模块,修订型 ADR 的写法
├── docs/setup.md       # 环境准备的判据与代价(换中继/换浏览器各丢什么)
├── docs/probe.md       # 真机探针手册:子命令表 + 判据纪律
├── docs/page-actions.md # 页面动作的设计判据:失败码分档,名册按控件划分
├── GLOSSARY.md         # 领域词条(必须在根目录,技能按它判断上下文)
├── .agents/skills/     # Matt 的技能(skills-lock.json 记版本)
├── tests/              # Python 测试(pytest)
├── wxt.config.ts       # 扩展构建配置
├── package.json        # pnpm 清单
└── pyproject.toml      # uv 清单
```

## 起环境

```sh
scripts/env-up.sh          # 幂等:起缺的,旧代码自动换,末尾打判据
scripts/env-up.sh --status # 只读汇总(含调试口状态)
scripts/env-up.sh --debug  # 让 ds-browser 带 --remote-debugging-port(开发探针用)
pnpm quality               # TS 与 Python 两半一起过
```

末尾要看到的判据,以及换中继/换浏览器各丢什么,见 [`docs/setup.md`](docs/setup.md).

## 真机探针(开发用)

外部动作口随 ADR-0011 废掉后,页面动作没有外露探针面.要真机验一件动作:

```sh
scripts/env-up.sh --debug                     # 起/换成带调试口的 ds-browser
uv run scripts/page-action.py read            # 读页面状态(含圆键的图标判定)
uv run scripts/page-action.py send button.get # 给 DeepSeek 标签页发一件页面动作
uv run scripts/page-action.py stop-test       # 端到端:起生成→等停止键→点→等复位
```

动作走扩展自己的名册(`ACTION_ROSTER`),绕开 `runAction` 的三道闸;只读页面 DOM 与驱动扩展
自身,不 hook 站点,不碰令牌(issue #31 的硬边界).

子命令全表,开真机前的总开关判据,前台与"观测点"纪律,见
[`docs/probe.md`](docs/probe.md);改名册本身看 [`docs/page-actions.md`](docs/page-actions.md).

## 参考

- [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant):把 MCP 带进网页版 AI
