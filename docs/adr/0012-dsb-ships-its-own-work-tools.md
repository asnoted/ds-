# dsb 内建五件工作工具:root 钉死的 ls/read/grep/write/edit

- **Status**: accepted
- **Date**: 2026-10-04
- **Supersedes**: none(本篇修订 ADR-0011 的一句,不整体取代它)

给网页模型一套能动手改本机文件的工作面:dsb 内建 `ls` / `read` / `grep` / `write` / `edit`
五件裸名工具,全部钉死在一个可配的**工作文件夹 root** 内(`DSB_WORK_ROOT`,缺省本仓根);
相对路径以 root 为基准,路径 `resolve()` 后越界一律 `out-of-root`--跟符号链接,挡 `..`.
**不给 SHELL**:任意命令天生能越界,与硬边界冲突;探索(列目录/搜索)改由 `ls` / `grep`
承担.写/改只额外拒 `.git/`(`protected-path`),读侧不拦.

依据是网页被当子 agent 用时缺一个能动手改本机文件的工具面(issue #6;其关闭语要求恢复
工具能力时按新形态重问五问--本 ADR 即那五问的答案).原链路(ADR-0011)只让模型排
第三方 MCP 工具,没有文件工具就得每走一步等人喂.用户拍板:**工具内建在 dsb 里**(不另起
stdio server),逻辑解耦成独立模块 `dsb/work.py`(纯函数 + 薄适配),dsb 只在
`build_tools` 一处挂上.

## 本 ADR 显式修订 ADR-0011

ADR-0011 的"**dsb 自己一条工具都不编**(除却 `said_*` 那两件自家小事)"一句**作废**.
ADR-0011 其余全部保留:唯一端点 `POST /mcp`,被动到底,不推送,不轮询,无会话,无状态,
一条 CORS 头都不下发.新工具与第三方工具同走 `tools/call`,dsb 依旧只在本机,只被动答.

## 五件与边界

| 工具    | 入参                             | 成功                           | 错码(工具载荷码,见下)                                                                     |
| ------- | -------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `ls`    | `path?`(默认 `.`)                | 直接子项,目录带尾 `/`,按名排序 | `out-of-root`,`not-found`,`not-a-directory`                                               |
| `read`  | `path`                           | 文件正文(超 16k 截断 + 标注)   | `out-of-root`,`not-found`,`not-a-file`                                                    |
| `grep`  | `pattern`,`path?`                | `相对路径:行号: 行`            | `out-of-root`,`not-found`,`bad-regex`                                                     |
| `write` | `path`,`content`                 | 建/覆盖(自动建父目录),回字节数 | `out-of-root`,`protected-path`,`not-a-file`                                               |
| `edit`  | `path`,`old_string`,`new_string` | 唯一命中才替换,回替换数        | `out-of-root`,`protected-path`,`not-found`,`not-a-file`,`edit-no-match`,`edit-not-unique` |

另有 `bad-path`(参数坏 / root 不存在)与 `io-failed`(读写失败).错码是**工具载荷码**,
与 `dsb/gateway.py` 的三码,`dsb/mcp.py` 的 JSON-RPC 码分属三套,不混;码写进正文
(`out-of-root(路径 ...)`),模型读得到,接得下去,与 `tool-not-running(工具 ...)` 同款.

## Considered Options

- **独立 stdio MCP server**:用户选了内建;解耦由独立模块满足,不必多一个进程,一份配置.
- **直接配现成 server(Desktop Commander 等)**:用户否决--要自家钉死 root 的版本.
- **给 SHELL + `sandbox-exec` 真沙箱**:重度,绑死 macOS;issue #6 当年正为此挂 needs-info.
- **不截断**:`read` 一个万行文件就撑爆对话与 token 预算.
- **root 不存在时拒绝起服务**:会让"没配就整个网关起不来";选择**照常起,调用时才回
  `bad-path`**--与"没配 MCP server 只打印一行"同一口径.
- **读写分档 / 敏感名单**:只立一条结构护栏(拒写 `.git/`),不做内容名单--越做越像沙箱.

## Consequences

- root 由 `DSB_WORK_ROOT`(进程环境变量优先,其次 `.env`,最后本仓根)改;`~` 照展开.
- 解耦:五件逻辑是 `dsb/work.py` 里对 `root: Path` 的纯函数--`resolve_in_root` /
  `list_dir` / `read_text` / `grep_tree` / `write_text` / `edit_text`;MCP 信封只在
  `work_tools(root)` 一层包封.dsb 唯一的耦合点是 `dsb/server.py` 的 `build_tools` 那一行,
  要换实现或挪进程只动它.
- 工具名是**裸名**(第三方恒带 `<server>_` 前缀,正常不撞);注册顺序
  `gateway → work → said`,撞名时自家 `said_*` 最后胜出.
- 扩展侧**零改动**:`serveTools()` 只过滤 `said_` 前缀,五件自动进协议说明(工具目录).
- 上限保护对话与前程:`read` 16k 字符,`ls` 500 项,`grep` 200 命中 / 单行 500 字符 /
  单文件 1MB,二进制文件跳过.
- 无命令执行面:`tools/list` 里不出现任何 shell / exec 类工具.
