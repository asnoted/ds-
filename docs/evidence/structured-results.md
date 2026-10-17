# 结构化结果的查证与量法

> 这份文件是**来历**: 从旧 `docs/adr/` 的实测段移出(2026-10-17), 内容逐字保留 -- 只改过
> ADR 编号与指向旧篇哪一小节的指路, 后加的注记一律带日期. 当前口径见 [ADR-0012](../adr/0012-tool-calls-and-structured-results.md), 能自己复现的判据见
> 那一篇的 `## 判据`.

## 查证(一手来源)

**协议里就有"专门标记真实 JSON"的机制,而且它是规范级的.** MCP `tools/call` 的结果
里,结构化数据走 `structuredContent`,工具可用 `outputSchema` 声明其形状
(`modelcontextprotocol.io/specification/2026-07-28/server/tools`):

> **Structured** content is returned as a JSON value in the `structuredContent` field of a
> result. This can be any JSON value (object, array, string, number, boolean, or null) that
> conforms to the tool's `outputSchema` if one is defined.
> For backwards compatibility, a tool that returns structured content SHOULD also return the
> serialized JSON in a TextContent block.
>
> 若提供了 output schema:Servers **MUST** provide structured results that conform to this
> schema. Clients **SHOULD** validate structured results against this schema.

**SDK 会自动帮你打这个标记**--FastMCP(`gofastmcp.com/servers/tools`):

> Object-like results (dict, dataclass, or Pydantic model) → **Always become structured
> content** (even without output schema). 没有注解时从**返回类型注解**推出 outputSchema.

所以"标记"对 server 作者常常是免费的:给工具标个返回类型就有.**这条路不嗅,不猜,
而且 `read` 那种逐字读取在结构上永远不会被标记**(它返回 `str`)--ADR-0012 开头那两条里的
**第 2 条**那个取舍(给工具结果建结构化通路)在这里根本不存在.

**本仓现在把它扔了.** `text_of_result` 只读 `content` 里的 text 块,全仓 grep 不到
`structured`.第三方 FastMCP 系 server 现在就在发这个标记,我们在丢.

**现成的同类实现**(供将来参照):Tooner(`chaindead/tooner`,Go,被 TOON 官方 ecosystem
收录)在代理层把 JSON-heavy 输出改写成 TOON;atlassian-labs/mcp-compressor 压的是工具**目录**
的 token;toon-mcp / toon-parse-mcp 把 JSON→TOON 做成**工具**让模型自己调.

**但收益在真实形状上不成立.** 这是本篇最要紧的一条,前后量了两遍:

| 场景                                                       | 今天的形态 | 结构化之后 | 差异              |
| ---------------------------------------------------------- | ---------- | ---------- | ----------------- |
| pretty-print 的 JSON                                       | 366        | 85         | −76%              |
| **真实的 `grep` 5 条命中**                                 | **495**    | **516**    | **−4%(反而更大)** |
| 真实 `grep` 6 个模式 620 条命中                            | 77,992     | 96,203     | **+23.3%**        |
| 同上,表格形**上界**(表头一行,一行一条,Tab 分隔,**不转义**) | 77,992     | 77,474     | **−0.7%**         |

第三,四行是 2026-10-17 用**本仓真实样本**补量的(第二行原先只有 5 条**手造**样例,本篇
未验证项当时就承认了).口径与命令都在 `scripts/measure-result-forms.py`:

    uv run scripts/measure-result-forms.py grep --pattern '续聊' --pattern 'WORK_' \
      --pattern 'send-failed' --pattern 'ADR-[0-9]' --pattern 'def ' --pattern '\.test\.ts'

样本由 **dsb 自己的 `grep`** 在本仓上跑出来,不是照形状手写--模式挑的是本仓会话里真的会
用的那几类(中文领域词 / 常量前缀 / 错误码 / ADR 号 / 语言构造 / 测试文件名).第三,四行
是那一瞬的负载快照,重跑会随本仓变化小幅漂移(这些模式名本身就在仓里);看的是量级.
量的是**字符**:本机没有分词器时脚本只报字符(取法见 `count-tokens.py`),有分词器会自动
补上 token 那一栏.
**连上界都只省 0.7%**,而 14 条命中那个模式(today 2,217 / toon 2,220)**反而更大**:
方向与手造那份一致,只是更靠近零.而协议里那半个字段若真逐条带上键名,是**大 23%**.

第一行那个 −76% 曾被拿来当主要论据,**那是坏样本**:本仓没有哪个工具产出 pretty-print
的 JSON,而 pretty JSON 对 TOON 表格是最病态的一种形状(缩进 + 重复大括号 + 引号键名).
真实的 `grep` 输出是 `file:line: text`,本来就压得很紧;TOON 表格省的是**重复的键名**,
而那些键名已经内联进前缀了;反过来 `text` 单元含 `:` 与 `"`,TOON 还得加引号转义.**净负.**

TOON 官方 benchmark 印证了这一点:省得多的是 **uniform tabular**(Top 100 repos −41.7%),
而 eligibility 表里 `deeply nested configuration` 是 **0%**.**省不省由形状决定,不由格式决定.**

**为什么现在没有入口**:这台机器上**没有 `mcp.json`**--网关零个第三方 MCP server,可用的
只有自家五件工作工具与两件 `said_*`,而它们全返回 `{"text": ...}`,**没有一个会发
`structuredContent`**.今天建通路就是死代码.

## 12%:与格式无关的那个窟窿

**已落(ADR-0010)**:下面"可抄的形状"那节说的 `offset` / `limit`,正文带行号,
`totalLines` 脚注,以及"单行 / 总量各自独立的上限",`read` 现在就是这么做的;本节的
"下一件该做它"由此兑现(顺带量出:2000 行上限在真实内容上轮不到,是按字节那道先咬).
下面这段留着当当时的判断.

```
read 在 dsb 侧交出   WORK_READ_LIMIT = 16,000 字
回灌正文(每轮)      MAX_RESULT_CHARS = 2,000 字   ← 模型看到 12.5%
翻页能力              没有
```

一次读大文件,**模型看不到其余 87%,而且没有任何办法看到**--再读一遍拿到的还是前
2000 字.而且 2,000 是**每轮总额**不是每个调用:一轮读两个文件,各拿约 1000 字.

这一条**每次读大文件都发生**,比结构化那半(偶发,真实形状净负)大得多.下一件该做它,
形状照 DSH 抄(下面"可抄的形状").

## 可抄的形状(读 DSH 源码得到的,2026-10-08 @ master)

借的是**设计与取舍,不是代码**--DSH 是 245k★ 的 TypeScript Cordis 运行时,我们是
Python + 独立扩展,能抄形状.

**`read`**(`packages/fs/tool-fs/src/read.ts` + `read-render.ts`):

- `offset`(1-based)/ `limit`,**上限 2000 行**(不是 2000 字)
- 每次调用三个独立上限:`limit` 行 / `maxLineLength` 单行 / `maxBytes` 总量
- 大文件(≥10MB)**流式**读,不整份进内存
- 结果带 **`totalLines`**,脚注三种,其中两种直接给出下一步:
  `(Showing lines 1-160 of 843. Use offset=161 to continue.)` / 按字节截时
  `(Output capped. ...)` / 到尾 `(End of file - total 843 lines)`
- **正文带行号**:`1: /** 回灌组装...`

我们的 `read` 给的是**无行号裸文本**,截断了写"已截断:原文 16000 字,这里是前 2000 字"
--模型拿着这句话什么都做不了,只能重读再被截一次.**这一条是那个 12% 问题的完整答案,
且是纯形状改动,不引依赖.** 但注意它与 #89 的保真承诺有张力(带行号就不是逐字了),
那是 grilling 时要单独问的.

**工具结果本来就是结构的**(`read` 的定义里):

```ts
output: {
  schema: { path, offset, lines: [{ number, text }], totalLines },   // 结构化真值
  render: (args, value) => [{ type: 'text', text: formatReadOutput(...) }],  // 文本是投影
  presentationMeta: (args, value) => ({ ... }),                      // 给 UI 的卡片
}
```

**结构是内部真值,文本只是投影.** 这比本篇论证的"声明式结构化"更完整,也说明我们纠结
的那半个 TOON 问题**在那种架构里根本不会出现**--它是因为我们的工具**本来只产文本**.

**`grep`**(`packages/fs/tool-fs-search/src/grep.ts` 模块头):

> Execution spawns the **packaged** ripgrep binary (`@vscode/ripgrep`) directly through the
> subprocess seam with a plain argv vector using a fixed line-oriented **`rg --json`** command

- **vendored**(VS Code 同款)→ 不需要用户 brew 装
- **`rg --json`** 出 NDJSON → 拿到的匹配是**权威的**,不是解析文本猜的
  (顺带:rg 对非 UTF-8 发 base64 `bytes` 而不是 `text`,也得处理)
- 方言缩水的解法很漂亮:**工具描述里直接写 `(ripgrep syntax)`**--能力差**公开声明**,
  不是静悄悄发生

**两条已作废的顾虑**(我先前提过,读完源码后撤回):

- "本机没装 rg,得 brew,是负担"→ vendored,没这个问题.
  但**注意 `@vscode/ripgrep` 是 npm 包而 dsb 是 Python**,能借的是那个**二进制**,
  怎么拿(npm pack / release tarball / brew)是个真决定.
- "换 rg 会静悄悄缩能力,测试抓不到"→ 他们把方言写进工具描述;本仓风格天然吃得下
  (协议说明里写清楚).**该钉的是方言声明本身**,不是每个正则特性.

**`fs-sandbox`**(`packages/fs/fs-sandbox/src/containment.ts`):lexical 快路径 + 祖先
`dev`/`ino` 身份比对,与我们 `resolve()` + `_inside(root_real, resolved)` **等价**,无可借.

**不该借的**:DSH 是 agent runtime(`npx @deepseek-ai/dsh web`),借它等于引入本地
agent + API key 这条与本仓前提冲突的依赖;`dsh-harness-mcp-server` 暴露的是
`agent_run` / `task_inbox` / `task_result`(**委托一整个任务**),不是 read/grep/write,
而且它是长在 DSH 里的 Cordis 插件,塞不进 `mcp.json`.

## 未验证项

- **本篇其余结论来自文档与源码阅读,没有一行代码落地,因此没有一个数字是在本仓的真实
  负载上量的**(下一条已补). `12%` 那两个上限(16,000 / 2,000)是从源码读出的
  **配置值**,不是实测分布.
- ~~**`−4%` 那个数用的是我手造的 5 条 `grep` 样例**~~ -- **已用真实样本集补量
  (2026-10-17)**:本仓真实 `grep`,6 个模式 / 620 条命中,today 77,992 字符,
  structured 96,203(**+23.3%**),表格形上界 77,474(**−0.7%**).命令与口径见
  `scripts/measure-result-forms.py`,样本由 dsb 自己的实现跑出来,可复现.结论(真实
  形状省不到)不变,而且比手造那份更靠近零.
- ~~**`@vscode/ripgrep` 的二进制在 Python 侧怎么拿,vendored 之后升级路径如何**,未验.~~
  -- **不用验了(ADR-0010)**:不换 rg,这条路不走;哪天真要搜大仓库的速度再回来.
- ~~**带行号的 `read` 与 #89"逐字"的取舍**未决--那不是数据问题,是策略问题,归 grilling.~~
  -- **已拍(ADR-0010)**: `read` 正文带行号, 把"不带行号"列为否决项; 真机上模型也认那条
  前缀是前缀(见 `docs/evidence/read-pages.md` 的"真机验证(2026-10-17)"节, n=2). 原来"归 grilling"那半句作废.
- **顺带记一条教训**:本篇里那个"省 76%"的数字一度被当成主要论据用了好几轮,而它是
  坏样本.**数字要有代表性**--挑一个病态输入去论证,等于论证了一个不存在的问题.
