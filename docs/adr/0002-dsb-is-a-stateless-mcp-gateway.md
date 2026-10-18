# ADR-0002: dsb 是无状态 MCP 网关:唯一端点 `POST /mcp`

- **Status**: accepted
- **Date**: 2026-10-17

dsb 只干一件事: 本机 MCP 网关. JSON-RPC 2.0 从 `POST /mcp` 进来(`initialize` / `ping` /
`tools/list` / `tools/call`), 把仓库根 `mcp.json` 配的 MCP servers 启动时 eager 拉起,
汇总成一张工具表替扩展转调用(对外名 `<server>_<tool>`, 非字母数字折 `_`); 自家挂在这张表上
的是内建工作工具(ADR-0009)与 `said_add` / `said_read`.

**dsb 被动到底**: 不推送, 不轮询, 无会话, 无 SSE, 无状态(每次请求独立), 一条 CORS 头都
不下发; `DELETE /mcp` 回 205(无会话可收, 不该撞 405), 别的方法回 405, 别的路径回 404,
载荷都是在册的 `{"status": "error", "error": "unexpected-response"}`.

网页侧的线协议照旧是 ```send 围栏(细节见 ADR-0012): 围栏里装的是一段工具调用 JSON
(`{"tool": ..., "arguments": {...}}`); 只有 background 打网络, 它把围栏正文变成
`tools/call`, 结果正文回灌进对话(ADR-0005).

## 决定

1. **唯一端点 `POST /mcp`**, 无状态. 扩展会话的吊命问题由
   `MCP_CALL_TIMEOUT_MS`(130s)一次 fetch 打到底 + 保活兜着, 不靠轮询.
2. **不给 `/mcp` 下任何 CORS 头**. 网页只要知道端口就能读本机工具表, 替你调工具;
   压死预检比在 dsb 里做来源校验省心. 扩展走 `host_permissions`, 本来就不受预检约束.
3. **只有 background 打网络**: 页面世界(MAIN)与隔离世界都不 `fetch` 中继, CORS 这条
   路根本不出现.
4. **载荷口径分两半**: 中继有回话就是 `ok` -- `tools/call` 的 `result` 与 JSON-RPC 的
   `error` 都是给模型看的正文(它得知道哪一步没成), `isError: true` 的结果同样照原文进
   对话; 只有**连不上**(`relay-unreachable`)与**认不出**(`unexpected-response`)才是
   `error` 载荷, 那种不进对话流(`isInjectableReply` 挡着), 图标翻红 + 失败留痕补一笔
   (ADR-0008).
5. **失败码分三套, 别混**: JSON-RPC 码(`dsb/mcp.py`), 工具载荷码
   (`dsb/gateway.py` 的 `tool-not-running` / `tool-timeout` / `unexpected-response`,
   `dsb/said.py`), 页面动作码(`protocol/fixtures/action.json` 的 `errorCodes` ↔
   `src/lib/action.ts` 的 `ACTION_ERROR_*`). 围栏排坏不猜形状, 回灌
   `MALFORMED_CALL_HINT` 让模型自己改.
6. **超时三档**: `MCP_CALL_TIMEOUT_MS = 130_000`(比 dsb 侧 `DSB_TOOL_TIMEOUT` 120s 宽一个
   往返 -- 先到的必须是中继, 扩展先 abort 只会报出没信息量的"中继不可达", 还白扔一次
   正在跑的调用), `MCP_LIST_TIMEOUT_MS = 10_000`, `MCP_PING_TIMEOUT_MS = 5_000`.
7. **工具目录进协议说明**: background 缓 `tools/list`, 隔离世界 60s 来取一次, 拿到就广播给
   页面世界拼说明; 取不到不覆盖上一份, 说明里写"工具表暂未取到: 先别排围栏" -- 没取到与
   没有是两句话. **自家 `said_*` 不进给模型的那份目录**(它在 `build_tools` 里注册, 由扩展
   侧按前缀过滤); 工作工具与第三方工具一样进.
8. **术语继续叫"中继"**(relay): UI 字符串与 `FAILURE_RELAY_UNREACHABLE` 这类标识符不动.
9. **不主动扩大站点动作面**: 页面动作(名册)留着, 但调用方是扩展自己(ADR-0007);
   外部动作口(曾经的 `/action` 与动作流)随问答后端一起废掉, 不回来.

## Considered Options

- **保留 `/send` + `/status` 轮询**: 轮询是为了"答复算好后留在中继手里, 掉线也能再取".
  网关无状态之后没有答复要留, dsb 自己也不需要状态. 否决.
- **留着外部动作流当外部 agent 的指挥口**: 留着就得养 SSE 断线重连, 订阅者册子, token 与
  回传端点 -- 四样全是为"外部 agent 指挥页面"这一件事, 砍问答后端时那件事一并砍了. 否决.
- **给 `/mcp` 下 CORS 头, 让页面世界直接打**: 省掉 background 中转, 代价是把本机网关暴露给
  网页跨源读. 否决.
- **工具表做增量 / ETag**: `tools/list` 是本机一趟往返(10s 预算), 60s 才问一次; 为一张
  几十行的表立缓存协议不值当, 扩展侧缓一份, 过期重取就够. 否决.

## Consequences

- **外部探针面没了**: 一废 `POST /action`, `scripts/env-up.sh` 从外面就探不到扩展, 判据只验
  本机这一半(`ping` + `tools/list`); 扩展那一半看图标三态, 悬停与 `[ds-]` 控制台行.
- **两处册子必须同步**: `protocol/fixtures/action.json` 的 `errorCodes` ↔
  `src/lib/action.ts` 的 `ACTION_ERROR_*`; 少改一处测试门就红.
- **扩展侧对工具目录的处理只有一处过滤**: `serveTools()` 只按 `said_` 前缀过滤, 所以新增
  自家工具(如工作工具)对扩展侧是零改动.
- **第三方 server 的两道闸(结果 64K, 单服务 128 件)与超时后的处置**另开一篇, 见 ADR-0003;
  自家工具不走那道 64K, 见 ADR-0010.

## 判据(怎么自己复现)

```sh
uv run pytest tests/test_mcp_server.py tests/test_gateway.py -q
pnpm relay:test
scripts/env-up.sh --status        # 本机这一半: ping + tools/list

# 红: 把 dsb/mcp.py 的 DEFAULT_PROTOCOL_VERSION 改成一个别的值, 不带参数开口就回默认版本
# 那 1 条当场红(tests/test_mcp_server.py, 51 条里 1 条).
```

真机那一半: 图标三态与悬停(扩展侧无外露探针面).

## 已知洞

- **`tools/list` 的缓存没有过期判据**: 隔离世界 `TOOLS_SYNC_INTERVAL_MS = 60_000` 来取一次是节流, 不是新鲜度承诺;
  本机换工具表后最长 60s 内, 页面模型看到的仍是旧目录.
