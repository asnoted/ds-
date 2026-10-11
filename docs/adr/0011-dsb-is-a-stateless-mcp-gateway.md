# dsb 收成无状态 MCP 网关:唯一端点 `POST /mcp`

- **Status**: accepted
- **Date**: 2026-10-04
- **Supersedes**: none(其一句被 ADR-0012 局部修订,见 0012 正文;其余仍有效)

dsb 只干一件事:本机 MCP 网关.JSON-RPC 2.0 从 `POST /mcp` 进来(`initialize` / `ping` /
`tools/list` / `tools/call`),把仓库根 `mcp.json` 配的 MCP servers 启动时 eager 拉起,
汇总成一张工具表替扩展转调用(对外名 `<server>_<tool>`,非字母数字折 `_`),自家只留
`said_add` / `said_read` 两件.**dsb 被动到底**:不推送,不轮询,无会话,无 SSE,
无状态(每次请求独立),一条 CORS 头都不下发;`DELETE /mcp` 回 205(无会话可收,不该
撞 405),别的方法回 405,别的路径回 404,载荷都是在册的
`{"status": "error", "error": "unexpected-response"}`.

网页侧的线协议照旧是 ```send 围栏,围栏里装的换成一段工具调用 JSON
(`{"tool": ..., "arguments": {...}}`);只有 background 打网络,它把围栏正文变成
`tools/call`,结果正文回灌进对话.

依据是 2026-10-03/04 的大砍(问答后端整套,openspec 工作流,文档面,vendor 与脚本):
`/send` `/health` `/status` `/action` `/actions` `/action/result` `/said` 那批 HTTP 路
全废--问句的往返,等待现场,外部动作口都是问答后端的器官,后端没了就没必要留.
核心照 MCP-SuperAssistant 那条线收成一句:**模型排工具调用,扩展转给网关,结果回对话**.

## Considered Options

- **保留 `/send` + `/status` 轮询**:轮询是为了"答复算好后留在中继手里,掉线也能再取"--
  网关无状态之后没有答复要留,dsb 自己也不需要状态;扩展会话的吊命问题改由
  `MCP_CALL_TIMEOUT_MS`(130s)一次 fetch 打到底 + 保活兜着.
- **动作流(ADR-0007)留着当外部动作口**:留着就得养 SSE 断线重连,订阅者册子,
  token 与回传端点--四样全是为"外部 agent 指挥页面"这一件事,砍问答后端时那件事
  一并砍了.页面动作(名册)**没砍**,调用方换成扩展自己:出站与看门狗催办走
  `runAction`,仍然每一跳当场回一个册子里的码(ADR-0010).
- **给 `/mcp` 下 CORS 头,让页面世界直接打**:省掉 background 中转,代价是把本机网关
  暴露给网页跨源读--网页只要知道端口就能读你的工具表,替你调工具.压死预检(一条头都
  不给)比在 dsb 里做来源校验更省心,扩展走 `host_permissions` 本来就不受预检约束.
- **工具表做增量 / ETag**:`tools/list` 是本机一趟往返(10s 预算),60s 才问一次;
  为一张几十行的表立缓存协议不值当,扩展侧缓一份,过期重取就够.

## Consequences

- **载荷口径分两半**:中继有回话就是 `ok`--`tools/call` 的 `result` 与 JSON-RPC 的
  `error` 都是给模型看的正文(它得知道哪一步没成),`isError: true` 的结果同样照原文进
  对话;只有**连不上**(`relay-unreachable`)与**认不出**(`unexpected-response`)才是
  `error` 载荷,那种不进对话流(`isInjectableReply` 挡着),图标翻红 + 失败留痕补一笔.
- **失败码两套,别混**:JSON-RPC 码(`-32601` 之类,`dsb/mcp.py`)由回话正文带进对话;
  工具载荷码(`tool-not-running` / `tool-timeout` / `unexpected-response`,
  `dsb/gateway.py`,`dsb/said.py`)归工具册子.围栏排坏不猜形状,回灌
  `MALFORMED_CALL_HINT` 让模型自己改.
- **超时三档**:`MCP_CALL_TIMEOUT_MS=130_000`(比 dsb 侧 `DSB_TOOL_TIMEOUT` 120s 宽一个
  往返--先到的必须是中继,扩展先 abort 只会报出没信息量的"中继不可达",还白扔一次
  正在跑的调用),`MCP_LIST_TIMEOUT_MS=10_000`,`MCP_PING_TIMEOUT_MS=5_000`.
- **工具目录进协议说明**:background 缓 `tools/list`(`said_*` 是自家的记话工具,不进
  模型的目录),隔离世界 60s 来取一次,拿到就广播给页面世界拼说明;取不到不覆盖上一份,
  说明里写"工具表暂未取到:先别排围栏"--没取到与没有是两句话.
- **只有 background 打网络**:页面世界(MAIN)与隔离世界都不 `fetch` 中继,规避 CORS
  这条路根本不出现.
- **外部探针面没了**:`POST /action` 一废,`scripts/env-up.sh` 从外面探不到扩展,
  判据只验本机这一半(ping + `tools/list`),扩展那一半看图标三态,悬停与 `[ds-]` 控制台行.
- **两处册子必须同步**(原 ADR-0010 的三处已随 `dsb/actions.py` 删成两处):
  `protocol/fixtures/action.json` 的 `errorCodes` ↔ `src/lib/action.ts` 的
  `ACTION_ERROR_*`;少改一处测试门就红.
- 术语**继续叫"中继"**(relay):UI 字符串与 `FAILURE_RELAY_UNREACHABLE` 这类标识符不动,
  换的只是语义与路径--避免一半文档说中继,一半说网关.
