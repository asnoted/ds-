# 旧编号到新编号: 2026-10-17 那次语料重写(28 篇并 13 篇)

> 这份文件是**来历**: 2026-10-17 把 `docs/adr/` 从 28 篇重写成 13 篇 -- 旧规则(已接受即
> 不可变, 改动靠新篇写 `Supersedes:` 点名)作废, 换成活文档(当前口径见
> [ADR-0001](../adr/0001-adrs-are-living-documents.md)). 旧篇直接删, 历史留 git; 这张表
> 是那次合并的完整映射.
>
> 它给谁用: **仓外**那些引用旧号的地方 -- GitHub 票的正文与评论是当时的记录, 按 ADR-0001
> 决定 4 的口径**不替它改号**, 所以读到票上的旧号(那儿是连着 `ADR-` 前缀写的), 来这张表
> 查它现在在哪篇. `uv run scripts/audit-issues.py --citations` 会把还牵着旧号的票列出来
> (信息级).
>
> 表里的旧号**故意不带 `ADR-` 前缀**: 带上就成了对当前语料的引用, 而那 28 篇已经不在了,
> 引用守卫(`tests/test_adr_corpus.py`)会正确地判它悬空. 只看第一列的数字就行.

| 旧编号 | 旧篇讲什么                      | 现在在哪篇                                                          |
| ------ | ------------------------------- | ------------------------------------------------------------------- |
| 0002   | 出站经唯一口, 开窗 3~5 秒       | [ADR-0004](../adr/0004-outbound-through-a-single-gate.md)           |
| 0004   | 失败留痕(不记正文)              | [ADR-0008](../adr/0008-failures-leave-a-trace.md)                   |
| 0010   | 停机要说得出来(账号处境)        | [ADR-0007](../adr/0007-page-actions-and-local-tools.md)             |
| 0011   | dsb 是无状态 MCP 网关           | [ADR-0002](../adr/0002-dsb-is-a-stateless-mcp-gateway.md)           |
| 0012   | dsb 内建五件工作工具            | [ADR-0009](../adr/0009-in-house-work-tools-and-permissions.md)      |
| 0013   | 组合工具住扩展侧                | [ADR-0007](../adr/0007-page-actions-and-local-tools.md)             |
| 0014   | 续聊走请求体替换                | [ADR-0005](../adr/0005-continuation-through-the-request-body.md)    |
| 0015   | 一次回答可以排多块围栏          | [ADR-0005](../adr/0005-continuation-through-the-request-body.md)    |
| 0016   | 网关给交出去的东西加上限        | [ADR-0003](../adr/0003-third-party-servers-have-their-own-caps.md)  |
| 0017   | ADR 与 `openspec/` 平级         | [ADR-0001](../adr/0001-adrs-are-living-documents.md)                |
| 0018   | 最小单元保留原件                | [ADR-0013](../adr/0013-controls-are-evidenced-by-code-and-image.md) |
| 0019   | 换回 Matt 技能流程              | [ADR-0001](../adr/0001-adrs-are-living-documents.md)                |
| 0020   | 替换的钥匙是短标记本身          | [ADR-0005](../adr/0005-continuation-through-the-request-body.md)    |
| 0021   | 续聊失败留痕                    | [ADR-0008](../adr/0008-failures-leave-a-trace.md)                   |
| 0022   | 发送原语全局限速                | [ADR-0004](../adr/0004-outbound-through-a-single-gate.md)           |
| 0023   | 代你发言闸只管发送              | [ADR-0006](../adr/0006-the-speak-gate-governs-sending-only.md)      |
| 0024   | 工作工具的权限规则层            | [ADR-0009](../adr/0009-in-house-work-tools-and-permissions.md)      |
| 0025   | 结构化结果只认声明              | [ADR-0012](../adr/0012-tool-calls-and-structured-results.md)        |
| 0026   | `read` 按行翻页                 | [ADR-0010](../adr/0010-work-tool-results-are-paged-and-capped.md)   |
| 0027   | `read` 上限的实测结论           | [ADR-0010](../adr/0010-work-tool-results-are-paged-and-capped.md)   |
| 0028   | 网页输入上限按 token 计         | [ADR-0011](../adr/0011-web-input-limit-is-a-token-budget.md)        |
| 0029   | 发送间隔改 Beta(2,4)            | [ADR-0004](../adr/0004-outbound-through-a-single-gate.md)           |
| 0030   | 失败当场留一帧                  | [ADR-0008](../adr/0008-failures-leave-a-trace.md)                   |
| 0031   | 站点原生的 `chat/continue` 不用 | [ADR-0005](../adr/0005-continuation-through-the-request-body.md)    |
| 0032   | 自家工具补上整条结果的闸        | [ADR-0010](../adr/0010-work-tool-results-are-paged-and-capped.md)   |
| 0033   | 模型给的正则要有墙钟            | [ADR-0010](../adr/0010-work-tool-results-are-paged-and-capped.md)   |
| 0034   | 过了时限换一个干净的孩子        | [ADR-0003](../adr/0003-third-party-servers-have-their-own-caps.md)  |
| 0035   | 额度要连末尾那句一起算          | [ADR-0010](../adr/0010-work-tool-results-are-paged-and-capped.md)   |

28 篇全在这张表里, 没有"没去处"的篇(篇没了 = 那一主题不存在了, 那是 ADR-0001 决定 1 允许的
删法; 这次合并没有发生这种). 新编号 `0001..0013` 与旧编号**不是**单调对应. 旧编号里有**七个
空号**(0001 / 0003 / 0005 / 0006 / 0007 / 0008 / 0009): 旧语料里没有对应的篇, 所以拿这几个号
来这张表里查会查不到 -- 它们本来就不指任何一篇. 其中两个**被人引过**(悬空引用), 重编号时按
主题重指了: "动作流"那处(旧文写 0007)改指 ADR-0002, "CDP 不上"那处(旧文也写 0007)改指
ADR-0008. 另一个 0001 只出现在 `scripts/audit-issues.py` 的一句旧注释里(记的是 #7 那张票的
处置), 那句现在已按新口径重写.
