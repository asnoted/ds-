# ADR-0009: dsb 内建五件工作工具: root 钉死, 权限规则是数据

- **Status**: accepted
- **Date**: 2026-10-17

给网页模型一套能动手改本机文件的工作面: dsb 内建 `ls` / `read` / `grep` / `write` / `edit`
五件**裸名**工具, 全部钉死在一个可配的**工作文件夹 root** 内(`DSB_WORK_ROOT`, 缺省本仓根);
相对路径以 root 为基准, 路径 `resolve()` 后越界一律 `out-of-root` -- 跟符号链接, 挡 `..`.
**不给 SHELL**: 任意命令天生能越界, 与硬边界冲突; 探索(列目录/搜索)改由 `ls` / `grep` 承担.
写/改另有一层**权限规则表**, 规则是数据不是代码里的名单.

依据: 网页被当子 agent 用时缺一个能动手改本机文件的工具面. 原链路只让模型排第三方 MCP 工具,
没有文件工具就得每走一步等人喂.

## 五件与边界

| 工具    | 入参                               | 成功                             | 错码(工具载荷码, 见下)                                                                         |
| ------- | ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ls`    | `path?`(默认 `.`)                  | 直接子项, 目录带尾 `/`, 按名排序 | `out-of-root`, `not-found`, `not-a-directory`                                                  |
| `read`  | `path`, `offset?`, `limit?`        | 一页(逐行带行号 + 末尾脚注)      | `out-of-root`, `not-found`, `not-a-file`, `bad-range`                                          |
| `grep`  | `pattern`, `path?`                 | `相对路径:行号: 行`              | `out-of-root`, `not-found`, `bad-regex`, `pattern-too-slow`                                    |
| `write` | `path`, `content`                  | 建/覆盖(自动建父目录), 回字节数  | `out-of-root`, `protected-path`, `not-a-file`                                                  |
| `edit`  | `path`, `old_string`, `new_string` | 唯一命中才替换, 回替换数         | `out-of-root`, `protected-path`, `not-found`, `not-a-file`, `edit-no-match`, `edit-not-unique` |

另有 `bad-path`(参数坏 / root 不存在)与 `io-failed`(读写失败). 错码是**工具载荷码**, 与
JSON-RPC 码, 页面动作码分属三套, 不混; 码写进正文(`out-of-root(路径 ...)`), 模型读得到, 接得
下去, 与 `tool-not-running(工具 ...)` 同款.

## 决定

1. **root 钉死并对路径做 `resolve()`**: 相对路径以 root 为基准, 解析后越界回 `out-of-root`.
   root 由 `DSB_WORK_ROOT` 改(进程环境变量优先, 其次 `.env`, 最后本仓根); `~` 照展开.
   **root 不存在时照常起服务**, 调用时才回 `bad-path` -- 与"没配 MCP server 只打印一行"同一
   口径, 不让"没配就整个网关起不来".
2. **逻辑解耦成独立模块**: 五件是 `dsb/work.py` 里对 `root: Path` 的纯函数
   (`resolve_in_root` / `list_dir` / `read_text` / `grep_tree` / `write_text` / `edit_text`),
   MCP 信封只在 `work_tools(root)` 一层包封. dsb 唯一的耦合点是 `dsb/server.py` 的
   `build_tools`; 要换实现或挪进程只动它.
3. **工具名是裸名**(第三方恒带 `<server>_` 前缀, 正常不撞); 注册顺序
   `gateway → work → said`, 撞名时自家 `said_*` 最后胜出.
4. **扩展侧零改动**: `serveTools()` 只过滤 `said_` 前缀, 五件自动进协议说明(工具目录).
5. **件数与行长有上限, 一整条有闸**: 数值与处置见 ADR-0010; 本条只管"边界在哪".
6. **权限规则表是数据**(`dsb/permissions.py`): 按操作分类(`read` = 读内容, `edit` = 写/改),
   每条 `pattern → allow | deny`, 通配符 `*`(零个或多个任意字符, **含 `/`**)与 `?`(恰好一个
   字符), **最后一条命中的规则赢**. 只认 `allow` / `deny` -- dsb 是被动的无状态网关, 没有交互
   面, 逐次确认无处安放.
7. **匹配对象是根相对, POSIX 分隔, `resolve()` 之后**的路径 -- 符号链接与 `..` 因此绕不过去.
   **匹配大小写不敏感**: macOS 文件系统默认大小写不敏感而 `resolve()` **不规范化大小写**,
   `MCP.JSON` 能打开真文件却会躲过字符串匹配(实现期发现的坑).
8. **默认表**:

   | 操作   | 拒                                               |
   | ------ | ------------------------------------------------ |
   | `read` | `*.env`, `*.env.*`, `mcp.json`                   |
   | `edit` | `.git`, `.git/*`, `*.env`, `*.env.*`, `mcp.json` |

   `.env.example` 显式放行(它是给人看的模板, 里面没有真密钥). `.git/` 从"写死的特例"收进这张
   表 -- `.git/hooks` 与 `mcp.json` 是同一类文件(不经人看就会执行), 护栏的理由本来就是一
   样的; 既有 `.git` 行为逐项等价.

9. **第二层: 保护真实生效的那两个文件**. 规则表比的是**名字**; `mcp.json` 可以被
   `DSB_MCP_CONFIG` 指到 root 内别处, `.env` 可以被 `find_dotenv()` 挪到当前目录. 所以除了
   规则表, 还按**实际路径**拦 dsb 真正会读的那两个文件(复用配置模块已有的解析). 落在 root 内
   就读写都拒.
10. **`grep` 对每个文件套读规则**, 命中 deny 就跳过 -- 结果里不能出现那些文件的任何内容, 哪怕
    模式正好命中里面的某行. **`ls` 仍如实列出名字**(只拦内容, 不隐藏存在).
11. **两套错码分工不变**: `out-of-root`(越出 root)与 `protected-path`(root 内但受保护),
    后者语义是"读或写都受保护". 没有新增错码.
12. **不做用户可配**(没有配置面): 表是易扩展的数据结构, 不写在各工具的 `if` 里.

## 为什么默认表里是这两类文件

`mcp.json`: dsb 启动时用 `subprocess.Popen` 直接拉起其中的 `command` + `args`. 模型 `write`
它, **下次中继重启就是任意命令执行**(它被 gitignore, `git diff` 看不到改动). 它的 `env` 里还
可能放着第三方 MCP 服务的 API key, `read` / `grep` 读出来会**随回灌进对话, 也就是发给站点**.

`.env`: 可以改 `DSB_WORK_ROOT`. 模型把 root 改成 `~`, 下次重启沙箱就被它自己撑开.

## Considered Options

- **独立 stdio MCP server**: 解耦由独立模块满足, 不必多一个进程, 一份配置. 否决.
- **直接配现成 server**: 要自家钉死 root 的版本. 否决.
- **给 SHELL + `sandbox-exec` 真沙箱**: 重度, 绑死 macOS. 否决.
- **root 不存在时拒绝起服务**: 会让"没配就整个网关起不来". 否决.
- **读写分档 / 敏感名单**: 只立一条结构护栏, 不做内容名单 -- 越做越像沙箱. (这一条后来由规则表
  兑现: 规则表仍是**名字级**的, 不是内容级.)
- **继续在代码里加两个 `if`**: 下次要加第三个文件, 就是第三次在各个工具里插判断 -- 而 `grep`
  的遍历, `read`, `write`, `edit` 四处都要记得插. 否决.
- **把整个 root 之外的路径都拒**(换个更小的 root): 那要用户自己配目录, 而 `DSB_WORK_ROOT`
  恰恰是可以被模型改的(见 `.env` 那条). 否决.
- **`.env` 只拒不跨目录的精确名**(`.env` 而非 `*.env`): 各处子目录下的 `.env` 同样是真密钥
  来源, 漏一个就是漏. 否决.
- **按绝对路径拦而不是根相对**: 模型能传绝对路径, 按绝对路径写规则表就没法写. 否决.
- **只拦写不拦读**(照旧 `.git` 的做法): `mcp.json` 的 `env` 里可能有 API key, 读出来随回灌
  发给站点 -- 读侧漏了这条比写侧漏了更隐蔽. 否决.
- **做成真正的沙箱**(白名单目录树, 限制编辑范围): 另一个量级的工程, 而"全部动作钉死在一个
  工作文件夹 root 内"已经是边界. 否决.

## Consequences

- **无命令执行面**: `tools/list` 里不出现任何 shell / exec 类工具.
- **`grep` 会跳过比从前更多的文件**(`mcp.json` / `.env` 系, 以及它们的符号链接);
  `ls` 不受影响.
- **规则表是数据**: 将来加一条保护是往 `DEFAULT_RULES` 里加一个 `Rule`, 不是改控制流.
- **根相对路径是判定的唯一依据**, 所以规则表里写的东西都是人可读的名字; 真实路径那层不在表里
  表达, 避免表退化成一张散乱的名字名单.
- **`protected_git` 是 `is_protected(..., "edit")` 的薄壳**; 既有 60 条测试一字未改全过.

## 判据(怎么自己复现)

```sh
uv run pytest tests/test_work.py tests/test_work_permissions.py -q
```

权限那层在测试里用真文件做过一轮(含符号链接与大小写两组绕过), 判据是"临时 root 里带标记串的
假 `mcp.json`, 用 MCP 入口调 `read` / `grep` / `write`, 读不到标记串, 也写不进去".
`read` 与 `grep` 的数值上限与真机读数见 ADR-0010 与 `docs/evidence/read-pages.md`.
