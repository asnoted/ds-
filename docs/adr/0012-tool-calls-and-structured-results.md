# ADR-0012: 工具调用压成紧凑 JSON; 工具结果的结构化只认声明, 今天不建

- **Status**: accepted
- **Date**: 2026-10-17

围着"工具调用与工具结果的形状"的两条:

1. **工具调用(页面 → 中继)压成紧凑 JSON**: 围栏正文在转给中继前归一化一次.
   收益是**线上形态确定, 可对拍**, 不是省 token -- 那串正文模型已经付过 token 了, 走本机
   socket 过去被 `json.loads`, 不会再回灌给模型.
2. **工具结果(中继 → 页面)不建结构化通路**: 只认产出方的**声明**(MCP 的
   `structuredContent` 字段 + 工具的 `outputSchema`), **不兜底嗅探**. 今天没有产出方
   (本机零个第三方 MCP server, 自家工具全返回 `{"text": ...}`), 修了也没有读者, 所以**不建**;
   dsb 现在读到 `structuredContent` 会丢掉, 记为已知缺口.

## 决定

1. **紧凑 JSON 落在出口一处**: 纯函数 `compactToolCall`(`src/lib/fence.ts`), 压紧在
   `detectToolCalls` 一处; 认不出的形状**照原样透传**. 夹具 `fence.json` 的正题仍是"切出哪
   几块正文", 记**逐字原文**; 线上形态由 `compactToolCall` 的单测钉住.
2. **协议说明的示例与 `MALFORMED_CALL_HINT` 一并改成紧凑写法** -- **教模型的那个例子才是它
   模仿的对象**.
3. **结果结构化: 门槛是"有人声明才建"**. 今天没有那个人, 所以今天不建.
4. **将来若建, 只认 `structuredContent`, 不兜底嗅探**. 不做"text 碰巧是 JSON 也当数据"那
   一层 -- 不因为将来换了触发器就复活.
5. **`grep` 不换 ripgrep**: 线性时间用十几行标准库就买到了(ADR-0010 的墙钟); 换它要付的是
   二进制分发与方言收窄. 这条候选收掉, 不再挂着.

## 为什么嗅探不行(两条可查的事实)

**输入在到达之前就被销毁了**: "这是一段 JSON 数据"是**结果对象**的属性, 而
`text_of_result`(`dsb/gateway.py`)把 `content[]` 拍扁成一个字符串 -- **拍扁正是抹掉这个属性
的动作**. 于是 `文本 →(猜)→ JSON → TOON` 里的那一步猜, 只能从形状上赌.

**赌错的后果能点名**: 模型 `read` 一个 `.json` 想逐字看它好照着改 -- 嗅出是合法 JSON 就编码
成 TOON 表, 模型接着 `write` / `edit` 改它(`write_text` 逐字写回, `edit` 是
`content.replace(old_string, new_string)`), **文件被写成 TOON 形状的 `.json`**.
这条路径在仓库里就摆着: `protocol/fixtures/*.json`, `mcp.json`, `package.json`.

**收益在真实形状上不成立**(用本仓真实样本量的):

| 场景                                                       | 今天的形态 | 结构化之后 | 差异       |
| ---------------------------------------------------------- | ---------- | ---------- | ---------- |
| pretty-print 的 JSON(坏样本:本仓没有哪个工具产出它)        | 366        | 85         | −76%       |
| 真实的 `grep` 6 个模式 / 620 条命中                        | 77,992     | 96,203     | **+23.3%** |
| 同上, 表格形**上界**(表头一行, 一行一条, Tab 分隔, 不转义) | 77,992     | 77,474     | **−0.7%**  |

真实的 `grep` 输出是 `file:line: text`, 本来就压得很紧; TOON 表格省的是**重复的键名**, 而那
些键名已经内联进前缀了; 反过来 `text` 单元含 `:` 与 `"`, TOON 还得加引号转义. **净负**.
省不省由形状决定, 不由格式决定(官方 benchmark 里省得多的是 uniform tabular, 而
`deeply nested configuration` 是 0%).

## Considered Options

- **嗅字符串**("text 碰巧是 JSON 就当数据"): 见上, 能把 `.json` 文件写成 TOON 形状. 否决.
- **请求方标记**(调用里带 `as:"json"`, 网关按它解析成结构): 它落在已知的那条通道上, 比嗅探
  优雅得多; 但整个机制的价值**全押在模型记得用它**上, 而本仓零证据. 而且真要做, 产出方声明
  才是对的 -- consumer 自己说了不算. 否决.
- **只认标记, 但今天就建**: 没有产出方 = 没有读者; 门在这儿开着, 等真有产出方再走. 否决.
- **把自家 `ls` / `grep` 变成产出方**: 它们确实知道自己吐的是列表, 但实测 +23.3% / −0.7% 说明
  连 `grep` 也不划算; **`read` 永远不能做** -- 逐字读取就是逐字, 结构化它等于撒谎. 否决.
- **什么都不记**: 这轮查证(spec 原文, SDK 规则, 实测数)只活在会话窗口里, 一 clear 就归零;
  下一个人会把整件事重查一遍. 否决.

## Consequences

- **工具调用那条线上形态变了**: 转给中继的是紧凑 JSON, 由 `detectToolCalls` 的单测钉住
  "出口拿到的已经是紧凑的".
- **结构化那半一行代码没建.** 将来配了 FastMCP 系 server 时, 入口是第 3, 4 条那两句.
- **"dsb 丢 `structuredContent`"是已知缺口**, 不是 bug 报告 -- 今天的读者为零.

## 判据(怎么自己复现)

```sh
pnpm vitest run src/lib/fence.test.ts src/lib/fixtures.test.ts
uv run scripts/measure-result-forms.py grep --pattern '续聊' --pattern 'WORK_' \
  --pattern 'send-failed' --pattern 'ADR-[0-9]' --pattern 'def ' --pattern '\.test\.ts'
```

样本由 **dsb 自己的 `grep`** 在本仓上跑出来, 不是照形状手写. 协议规范与 SDK 的原文引用,
以及 TOON 官方 benchmark 的那两行, 见 `docs/evidence/structured-results.md`.

## 已知洞

- **dsb 读到 `structuredContent` 会丢掉**: 今天没有产出方, 所以没有读者; 配了 FastMCP 系
  server 时再补, 届时只读那个字段, 不嗅.
- **紧凑 JSON 的收益没有数字**: 它是"形态确定", 不是省 token -- 别拿它当性能改进.
