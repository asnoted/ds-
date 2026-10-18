# ADR-0003: 第三方 server 的三道闸: 结果 64K 字, 单服务 128 件, 超时即换孩子

- **Status**: accepted
- **Date**: 2026-10-17

`mcp.json` 里那些第三方 MCP server, 结果是**照原文交给模型**的(不猜不丢). 代价是没有上限:
一条失控结果(几十兆的目录树, 整份日志)会同时灌满对话, 扩展的内存与 `storage`; 一张塞了
上千件工具的表会把协议说明撑爆. 而超时原先只是"判一个码", 判完那个还在转的孩子原样留着,
于是卡死期间**每一件工具都排在它后面**.

三条闸, 加上一句收场纪律:

## 决定

1. **单次结果封顶 `MAX_RESULT_CHARS = 64 * 1024` 字**(按字符, 不按字节 -- 切在多字节字符
   中间对谁都没好处). 超了截断并在尾巴上写明 `原文 N 字, 这里是前 64K 字`, 记一笔
   `result-capped tool=... chars=...`. 这道闸**只管第三方 server 那条路**
   (`Gateway._handler` 一处调用 `cap_result`); 自家工作工具不走它, 见 ADR-0010.
2. **单服务工具数封顶 `MAX_TOOLS_PER_SERVER = 128`**, 超了只注册前 128 件, 记一笔
   `tools-capped tool=... count=...`(记的是**原文件数**, 人看得出被砍了多少).
3. **三档超时各是各的**: 握手 `DSB_CONNECT_TIMEOUT`(默认 30s -- `npx` 首次下载要时间),
   发现 `DSB_DISCOVERY_TIMEOUT`(默认 20s, 一次就够), 调用 `DSB_TOOL_TIMEOUT`(默认 120s).
   三个键都认进程环境与 `.env`, 认不出或非正数落默认.
4. **限额打给启动日志看**: `server.py` 起服务时打一行"限额: 结果 ... 字, 单服务工具 ...
   件, 工具调用 ...s", 生效值一眼可查.
5. **过了调用时限就断掉那个孩子**: `_request` 摘掉待收的队列项之后调
   `self.stop(grace=0)`, 再抛 `tool-timeout`. `grace=0` 是"不等它体面退"(先断 stdin,
   再立刻收尸 -- 收的是**整间会话**: `npx` 系 server 的直接孩子只是壳, 真在跑的是它的
   孙子, 只杀壳等于没杀, 见 `docs/evidence/gateway-timeouts.md`) -- 卡住的孩子没在读
   stdin, 默认那 3 秒(`STOP_GRACE`)是白等, 还算在用户头上. 重启不用新代码: `call_tool`
   那句"死了先试着重起一次"自然接上.
6. **不新增码, 不新增上报面**: 模型看到的还是 `tool-timeout`; 日志记一笔
   `server-down tool=... error=tool-timeout`(`dsb/log.py` 的册子里本来就有 `server-down`).

## Considered Options

- **继续不加限**: 一条结果就能把扩展的内存与存储打满, 而风控与配额都跟"量"有关. 否决.
- **调用档也收到 60s**: 120s 是有意的(长工具循环要跑得住); 要收紧走 `DSB_TOOL_TIMEOUT`,
  不改默认值. 否决.
- **发现继续借握手那档**: 一次发现没必要给 30s; 分开才看得出慢在哪一档. 否决.
- **按字节截断**: 多字节字符会被切两半, 接在后面的正文就成了乱码. 否决.
- **留着卡住的孩子等它自己转完**(旧做法): "慢"能自愈, "卡死"不能 -- 而这两者从外面看
  一模一样, 都只是"没在时限内答上来", 所以也判不出该留还是该断. 否决.
- **只在同一个孩子连着两次超时才断**(想给暖状态留一手): 第二次也可能只是慢, 判据写不出来;
  早断一次的成本是重起一次握手, 晚断的成本是工具面哑着. 否决.
- **顺手把"答不成样"(`unexpected-response`)那条路也断掉**: 它至少还答了, 不是卡住. 不做.

## Consequences

- **重试即恢复**: 模型拿着 `tool-timeout` 再打一次就落在新孩子上(替身 server 实测:
  卡住期间重试由"再等一个超时"变成 0.0s 拿到答复).
- **代价: 子 server 的暖状态丢掉** -- 下一次调用要重新握手. 对 `npx` 系 server 就是再起一次
  进程(包已缓存; 真机上量到 1.7s), 对"手里有会话"的 server 是它自己的事(它反正没在时限内
  答上来).
- **代价: 同一 server 上别的在飞请求会被一起叫醒成 `tool-not-running`**(`_fail_all` 的既有
  语义). 扩展是一趟一块地打(ADR-0005), 这种并发本来罕见.
- **截断处写着原长**: 模型知道自己看的是前多少字, 会改问法, 而不是拿半截正文当全貌.
- **限额是常量, 不当配置项**: 要调就改常量(有测试钉着), 免得一份 `.env` 把它们改成 0.

## 判据(怎么自己复现)

```sh
# 绿: 超时那条码 + "重试落在新孩子上"(替身 server 的 hang 岔路是睡 60s 不答)
uv run pytest tests/test_gateway.py -q -k 'hanging'

# 绿: "永不回头"那一种(不答 + 无视 SIGTERM)也要真被 kill 收尸(替身写下自己的 pid)
uv run pytest tests/test_gateway.py -q -k 'deadlocked'

# 绿: 收摊收的是整间会话 -- 替身挂的那个孙子(壳死了它也没爹)也一起没(真机那笔的回归)
uv run pytest tests/test_gateway.py -q -k 'grandchild'

# 红(它真是这条决定撑着的): 把 dsb/gateway.py 里那句 `self.stop(grace=0)` 拿掉,
# 上面那两条当场变红 -- 重试自己也会超时, 死锁那个孩子也还赖在进程表上.
# 红(收摊那道 `os.killpg`): 把 `_kill_tree` 换回 `proc.kill()`, 第三条变红(孙子留下来).
```

限额那三条在 `tests/test_gateway.py` 与 `dsb/server.py` 的启动日志里; 60s 替身与逐刻读数见
`docs/evidence/gateway-timeouts.md`.

## 未验证项

- ~~**真机上没制造过第三方 MCP server 卡死**: 这条是在替身 server 上量的. 真配着 `npx` 系
  server 卡住时会怎样(重启要多久, 包里有没有要重下的东西)没量.~~ -- **已量(2026-10-18)**:
  真配 `npx -y @modelcontextprotocol/server-filesystem` 一回(另指一份 `mcp.json`, 另起在
  8799, 不动 env-up 那份): 冷启动 3.9s / 暖启动 1.7s(握手那档 30s 够用), 真卡死 20.02s 回
  `tool-timeout`, 掐掉之后再要 1.70s 拿到答复(**包没重下**). 同一轮还揪出一个洞: 只杀直接
  孩子会把 `node <包>` 那个孙子留在进程表上 -- 已改成收整间会话; 逐刻读数与那次进程表见
  `docs/evidence/gateway-timeouts.md`.
- **"并发那条代价"只在代码上读出来**: 扩展一趟一块地打, 造不出"别的在飞请求被一起打断"的
  现场, 所以那条是读代码得出的, 不是实测.
- ~~**"永不回头"没构造出来**: 替身是"睡 6 秒", 能自愈; 真正死锁的孩子没有替身.~~
  -- **已构造(2026-10-17)**: 替身多一条 `stuck` 岔路(不答, 还把自己收到的 `SIGTERM` 设成
  忽略, 同时写下自己的 pid), 于是"断掉"与"等它自己好"分得开; 判据是
  `tests/test_gateway.py::test_a_deadlocked_child_is_killed_not_left_behind`(超时那一刻
  那个 pid 从进程表上消失). 把 `self.stop(grace=0)` 拿掉, 它当场变红.
