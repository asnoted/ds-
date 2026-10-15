# AGENTS.md

Limit the number of comments in code to a strict minimum. You should almost never add comments, except occasionally to non-trivial code, to function definitions whose arguments are not self-explanatory, and to class definitions and their members.

NEVER edit `AGENTS.md`; maintainers only.

## Tools

All new tools go here. Use jj first.

```sh
scripts/env-up.sh                 # 幂等:起缺的,旧代码自动换,末尾打判据
scripts/env-up.sh --status        # 只读汇总,不动手
scripts/env-up.sh --debug         # 带调试口,真机探针要这个

pnpm quality                      # 本地质量门:TS + Python
pnpm quality:ci                   # CI 全量:上面加三道守卫(守卫只在 CI 跑)
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
- 输出提到领域概念时用 `GLOSSARY.md` 里的词;与 ADR 冲突要挑明,别默默盖过.

## Workflow

不知道干什么`/ask-matt`

- **思考问题问网页**

## 测试要求

- 嵌入 pre-commit.

## IMPORTANT

- **本文件不写实现细节**
- **禁止**绕过限速,**应当**走消息流
- **禁止**借用户环境,**应当**统一用env-up
- **禁止**在根目录新增 `.md`.
- **禁止**一次性脚本,**应当**集成到工具链.
