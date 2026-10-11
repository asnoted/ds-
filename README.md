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

| 项             | 默认                         | 落在哪                         |
| -------------- | ---------------------------- | ------------------------------ |
| 单次结果       | 64K 字(超了截断并写明原长)   | 网关 `MAX_RESULT_CHARS`        |
| 单服务工具     | 128 件(超了只注册前 128 件)  | 网关 `MAX_TOOLS_PER_SERVER`    |
| 一轮围栏       | 8 块(超了剩下的下一轮再排)   | 扩展 `MAX_CALLS_PER_ROUND`     |
| 自动续聊       | 8 轮(到顶停手,等用户开口)    | 扩展 `MAX_CONTINUATION_ROUNDS` |
| 给模型看的结果 | 2000 字(超了截断并写明原长)  | 扩展 `MAX_RESULT_CHARS`        |
| 握手超时       | 30s(`DSB_CONNECT_TIMEOUT`)   | 起子进程 + `initialize`        |
| 发现超时       | 20s(`DSB_DISCOVERY_TIMEOUT`) | `tools/list`                   |
| 调用超时       | 120s(`DSB_TOOL_TIMEOUT`)     | 一次 `tools/call`              |

三个超时键都认进程环境与 `.env`(认不出或非正数落默认);其余是常量,改常量有测试钉着.

## 结构

```
.
├── entrypoints/        # WXT 入口:background,content script,inject(MAIN)
├── src/                # 扩展的纯逻辑层(TS,可单测)
├── dsb/                # 本机中继:MCP 网关(Python)
├── protocol/fixtures/  # TS 与 pytest 共读的线协议对拍
├── docs/adr/           # 架构决策记录
├── docs/agents/        # issue 追踪 / 分诊标签 / 领域文档的规则(Matt 的技能读)
├── GLOSSARY.md         # 领域词条
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

## 参考

- [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant):把 MCP 带进网页版 AI
