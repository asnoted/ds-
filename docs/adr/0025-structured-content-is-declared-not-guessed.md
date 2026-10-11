# ADR-0025: 结构化结果只认协议标记,不猜;今天不建,落档

- **Status**: accepted
- **Date**: 2026-10-08
- **Supersedes**: none

本篇**不改** ADR-0016(网关截断)与 ADR-0012 / ADR-0024(工作工具与权限层)--那两条
一个字没动.本篇记的是**一次查证的结论**:一个看着优雅的机制,它在链路上找不到入口,
而入口今天不存在,所以**记下来,不建**.

## 问题

起因是一个小请求:"工具调用全用紧凑 JSON,插件转给网页的时候转成 TOON".

第一半干净:围栏正文在转给中继前压成紧凑形态,是个边界上的归一化(#93,已落,见下).
第二半让人不安--**`JSON → TOON` 是个漂亮的纯函数**(无损,确定,更省),但在扩展拿到
东西的那一层,它的输入**不是 JSON**,是一段"可能是 JSON 的文本".真实要做的是
`文本 →(猜)→ JSON → TOON`.

不安的根可以拆成三条,都不是"风险直觉",是可查的事实:

1. **输入在到达之前被销毁了.**"这是一段 JSON 数据"是**结果对象**的属性;
   `text_of_result`(`dsb/gateway.py`)把 `content[]` 拍扁成一个字符串,**拍扁正是抹掉
   这个属性的动作**.纯函数没东西可吃.
2. **那是一次保真换紧凑的交易,而且是无声的.** 对散文,保真本来就免费(文本没什么可省的);
   对数据,省必须靠重编码,而重编码花掉的就是保真--**模型不知道自己收到的是原文的再编码**.
   看得见的交易划算,看不见的交易就是 uneasy 的来源.
3. **它长得不像这套代码库会做的事**(`CODING_STANDARDS` 第一条:判定放知道答案的模块).
   嗅字符串是一个**关于文本的谓词**,不是一个知道答案的 party's 决定.

一句话判据,从这一轮里长出来的:**转换之前,手上那个东西是数据吗?** 是 → 转换是纯函数,
做起来顺;**不是,只是一段文本 → 就没有无损转换可做,只有猜.**

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
而且 `read` 那种逐字读取在结构上永远不会被标记**(它返回 `str`)--第 2 条那个交易在这里
根本不存在.

**本仓现在把它扔了.** `text_of_result` 只读 `content` 里的 text 块,全仓 grep 不到
`structured`.第三方 FastMCP 系 server 现在就在发这个标记,我们在丢.

**现成的同类实现**(供将来参照):Tooner(`chaindead/tooner`,Go,被 TOON 官方 ecosystem
收录)在代理层把 JSON-heavy 输出改写成 TOON;atlassian-labs/mcp-compressor 压的是工具**目录**
的 token;toon-mcp / toon-parse-mcp 把 JSON→TOON 做成**工具**让模型自己调.

**但收益在真实形状上不成立.** 这是本篇最要紧的一条,而且是**实测**:

| 场景                       | 今天的形态 | 结构化之后 | 差异              |
| -------------------------- | ---------- | ---------- | ----------------- |
| pretty-print 的 JSON       | 366        | 85         | −76%              |
| **真实的 `grep` 5 条命中** | **495**    | **516**    | **−4%(反而更大)** |

第一行那个 −76% 曾被拿来当主要论据,**那是坏样本**:本仓没有哪个工具产出 pretty-print
的 JSON,而 pretty JSON 对 TOON 表格是最病态的一种形状(缩进 + 重复大括号 + 引号键名).
真实的 `grep` 输出是 `file:line: text`,本来就压得很紧;TOON 表格省的是**重复的键名**,
而那些键名已经内联进前缀了;反过来 `text` 单元含 `:` 与 `"`,TOON 还得加引号转义.**净负.**

TOON 官方 benchmark 印证了这一点:省得多的是 **uniform tabular**(Top 100 repos −41.7%),
而 eligibility 表里 `deeply nested configuration` 是 **0%**.**省不省由形状决定,不由格式决定.**

**为什么现在没有入口**:这台机器上**没有 `mcp.json`**--网关零个第三方 MCP server,可用的
只有自家五件工作工具与两件 `said_*`,而它们全返回 `{"text": ...}`,**没有一个会发
`structuredContent`**.今天建通路就是死代码.

## 决定

1. **工具调用(页面 → 中继)压成紧凑 JSON**.已落(#93,`3990886`).纯函数
   `compactToolCall` 放在 `fence.ts`,压紧在出口 `detectToolCalls` 一处(夹具
   `fence.json` 的正题仍是"切出哪几块正文",记逐字原文);认不出的形状照原样透传.
   协议说明的示例与 `MALFORMED_CALL_HINT` 一并改成紧凑写法--**教模型的那个例子才是它
   模仿的对象**.
   **收益是线上形态确定,可对拍,不是省 token**:那串正文模型已经付过 token 了,走本机
   socket 过去被 `json.loads`,不会再回灌给模型.
2. **工具结果(中继 → 页面)不建结构化通路.** 记档 + 门槛:**有人声明才建**.
   今天没有那个人,所以今天不建.
3. **将来若建,只认 `structuredContent`,不兜底嗅探.** 不做"text 碰巧是 JSON 也当数据"
   那一层--那正是本篇要否决的东西,不因为将来换了触发器就复活.声明优先,缺席即文本.
4. **"dsb 丢掉了 `structuredContent`"记为已知缺口**,本票**不修**(没有产出方,
   修了也没有读者).将来配了 FastMCP 系 server 时再补,届时只读那个字段,不嗅.
5. **`grep` 换 ripgrep 的方向记档**(下一件的候选),连同两条**已作废**的顾虑(见下).
6. **真缺陷另立**:见下面"12%"那条.**本票不修.**

## 12%:与格式无关的那个窟窿

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

## Considered Options

- **嗅字符串(B-宽,"text 碰巧是 JSON 就当数据")**:否决.赌注的具体后果能点名--
  模型 `read` 一个 `.json` 想逐字看它好照着改,B-宽 嗅出是合法 JSON 就编码成 TOON 表,
  模型接着 `write`/`edit` 改它(`write_text` 逐字写回,`edit` 是
  `content.replace(old_string, new_string)`),**文件被写成 TOON 形状的 `.json`**.
  这条路径在仓库里就摆着:`protocol/fixtures/*.json`,`mcp.json`,`package.json`.
- **请求方标记(调用里带 `as:"json"`,网关按它解析成结构)**:否决.它落在**已知的那条
  通道**(`arguments`)上,比 B-宽 优雅得多;但整个机制的价值**全押在模型记得用它**上,
  而本仓零证据.真要做也不该是它--**产出方声明是对的人**(consumer 自己说的).
- **只认标记,但今天就建**:否决.没有产出方 = 没有读者,`CODING_STANDARDS` 会判它
  "没有真实读者".门在这儿开着,等真有产出方再走.
- **把自家 `ls` / `grep` 变成产出方**:否决(当下).它们确实知道自己吐的是列表,但
  `ls` 的路径列表模型读毫无障碍,换成表格省不了什么;**`read` 永远不能做**--逐字读取
  就是逐字,结构化它等于撒谎.而实测 −4% 说明连 `grep` 也不划算.
- **什么都不记**:否决.这轮查证(spec 原文,SDK 规则,DSH 实现,实测数)只活在会话窗口里,
  一 clear 就归零;下一个人(或未来的我)会把整件事重查一遍.

## Consequences

- **工具调用那条线上形态变了**:转给中继的是紧凑 JSON.围栏夹具的语义明确分工--
  `fence.json` 记逐字原文(正题是"切出哪几块"),`compactToolCall` 的单测钉线上形态,
  `detectToolCalls` 的单测钉"出口拿到的已经是紧凑的".
- **协议说明的示例与 `MALFORMED_CALL_HINT` 改成紧凑写法**:模型模仿的是示例.
- **结构化那半一行代码没建.** 将来配了 FastMCP 系 server 时,入口是第 3,4 条那两句.
- **"dsb 丢 `structuredContent`"是已知缺口**,不是 bug 报告--今天的读者为零.
- **下一件的默认候选变了**:从"结构化"换成"`read` 的形状照 DSH 抄".但**与 #89 的
  保真承诺有张力**(带行号 ≠ 逐字),那是 grilling 时该问清的,不在本篇拍.
- **`grep` 换 rg 会缩方言**(Python `re` → Rust regex).已决定照 DSH 的办法在协议说明里
  **公开声明**,而不是假装没变;`tests/test_work.py` 现在只用了平凡模式
  (`命中` / `needle` / `x`),所以方言这条要单独钉一条测试.

## 未验证项

- **本篇全部结论来自文档与源码阅读,没有一行代码落地,因此没有一个数字是在本仓的真实
  负载上量的.** `12%` 那两个上限(16,000 / 2,000)是从源码读出的**配置值**,不是实测分布.
- **`−4%` 那个数用的是我手造的 5 条 `grep` 样例**,形状照本仓真实输出写,但不是从真机会话
  里抓的.结论(真实形状省不到)我认为成立,但**没有一个真实样本集**支撑.
- **`@vscode/ripgrep` 的二进制在 Python 侧怎么拿,vendored 之后升级路径如何**,未验.
- **带行号的 `read` 与 #89"逐字"的取舍**未决--那不是数据问题,是策略问题,归 grilling.
- **顺带记一条教训**:本篇里那个"省 76%"的数字一度被当成主要论据用了好几轮,而它是
  坏样本.**数字要有代表性**--挑一个病态输入去论证,等于论证了一个不存在的问题.
