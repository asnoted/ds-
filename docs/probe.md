# 真机探针手册

页面动作没有外露调用面(ADR-0002),要真机验就走 `scripts/page-action.py`.
房规与导航在 [`AGENTS.md`](../AGENTS.md);**本文件是用法与判据纪律**.

## 子命令

| 子命令                        | 干什么                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`                        | 列 CDP 目标(只读本地清单,不等限速)                                                                                                                                                                                                   |
| `focus`                       | 把 DeepSeek 标签页置到前台(读页面列表前先来一下;`--ext` 反向:把扩展页置前台,让站点退后台)                                                                                                                                            |
| `read`                        | 读页面状态(含圆键的图标判定)                                                                                                                                                                                                         |
| `send <动作> [--params json]` | 给 DeepSeek 标签页发一件页面动作                                                                                                                                                                                                     |
| `js <表达式>`                 | 页面上下文里跑只读 JS(`--times N --every S` 连读,时间线只打相变)                                                                                                                                                                     |
| `ext-js <表达式>`             | 扩展页(options)上下文里跑只读 JS(`--reload` 先重载这一页再读;连读同 `js`)                                                                                                                                                            |
| `sse`                         | 录一轮 SSE,并按 `finish_reason` 判拒收                                                                                                                                                                                               |
| `stop-test`                   | 端到端:起生成 → 等停止键 → 点 → 等复位                                                                                                                                                                                               |
| `storage get\|set\|remove`    | 读写扩展 storage                                                                                                                                                                                                                     |
| `capture` / `ax`              | 全量证据:HTML / CSS / 资源 / 行快照 / 可访问性树(`--codes` 另存站点脚本)                                                                                                                                                             |
| `visible-capture`             | 验扩展能否抓可见标签页(`--out` 落盘成 JPEG;现场帧的权限/体积判据,ADR-0008)                                                                                                                                                           |
| `frame-fail`                  | 验抓帧失败的负路:站点退后台时报一笔失败--失败痕照落,帧不新增;跑完扳一次总开关对齐内存(#106,ADR-0008 决定 12)                                                                                                                         |
| `send-page`                   | 验本地工具 `send.page` 的两步(`composer.type` → `send.enter`,全走三道闸):闸开着真发一条(要 `--send`),闸关着只落草稿(判据看"对话末行前后对拍");打字前先盯写作框 6 秒(躲开扩展自己的续聊),跑完对账本(多出痕/帧就不算绿)(ADR-0007/0006) |
| `continue-click`              | 点站点自己的"继续生成"并验 `/chat/continue` 真发出去(真鼠标事件;票 #105)                                                                                                                                                             |
| `toggles-off`                 | 测试环境关掉深度思考与智能搜索(`--debug` 会顺带跑)                                                                                                                                                                                   |
| `evidence`                    | 存证对账:留档按钮原件 vs 站点当前(ADR-0013,只读,不进 `pnpm quality`)                                                                                                                                                                 |

独立探针脚本(不走 `page-action.py` 的名册路径):

| 脚本                               | 干什么                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/watchdog-probe.py`        | 看门狗腿:造动静 + 等静默,判催办有没有真发(`silenceMs` 旋钮);`--generating` 那腿验"生成相不插嘴",`--gate` 那腿验"收活后不开口"(任务门,#104)                                                                  |
| `scripts/sw-cdp-probe.py`          | 最小复现:验 SW 的 CDP evaluate 与 console 事件通不通                                                                                                                                                        |
| `scripts/third-party-mcp-probe.py` | 第三方 MCP server 的真机腿:自起一份中继(临时 `mcp.json`,另一个端口,临时工作根),量启动,真卡死(`tool-timeout`),重起,并按"命令行带着临时根却不是中继后代"查有没有留下孤儿(ADR-0003);要网络,不进 `pnpm quality` |

带调试口的环境是 `scripts/env-up.sh --debug`(会顺带跑 `toggles-off`).

两张表都是手维护的, 所以 `tests/test_probe_docs.py` 两头对拍: 子命令表对
`scripts/page-action.py` 的 argparse 定义, 探针脚本表对 `scripts/*probe*.py` 的文件名 --
加了子命令 / 加了探针脚本忘了补表, 或者表里的名字仓里已经没了, 都会红.

## 逆向结论的去处

- **站点自己的上限,配置,请求体长什么样,结论在 [`dsweb/FINDINGS.md`](../dsweb/FINDINGS.md)**.
  测"服务端收没收"先看它 §6.2 的硬判据,别自己搜页面文字.
- 要站点下发的配置(`input_character_limit` 之类),在 `localStorage` 的
  `__ds_remote_feature_store_model` / `__ds_remote_feature_store_provider` /
  `__ds_remote_feature_store` 三个键里 -- **先读配置再猜**.
- 数一段文本几个 token 走 `scripts/count-tokens.py`(分词器取法在
  [`dsweb/README.md`](../dsweb/README.md)).**站点服务端用哪个分词器仍未证实**,
  别把本机口径当定论.

## 探针够不着什么

- **`target: null` 那族走另一条路**:`tabs.list` / `toggle.*` / `storage.*` 由
  **background** 的 `runAction` 就地执行(内容脚本的 `ACTION_ROSTER` 里没有它们),
  `page-action.py` 因此对 `TARGET_NULL_ACTIONS` 那份名单改走 `runtime.sendMessage`
  直送 background;照老路往站点标签页投只会回 `unknown-action` -- **那是路不对,
  不是链子坏了**.
- **本地工具(`send.page` 等)不在名册里**,只能注入 chain 信封触发,写法见
  `scripts/page-action.py` 的文件头.验 `send.page` 那两步用
  `uv run scripts/page-action.py send-page`(它就是那条信封,判据在它手里).
- **人做的有两件**:登录 DeepSeek,以及勾"替人开口".脚本只打印不代劳;没勾闸则写动作回
  `disabled`,属预期,不是故障.
  **跑四条真机回归(完整续聊 / 发一次 / 闸关草稿 / 看门狗)前先对这张单**:
  - [ ] 人已在独立 profile 勾上"替人开口"(`storage get --keys '["speak"]'` 有键且为真)?
        没勾则 `send.page` 投递腿与看门狗催办**必然**回 `disabled` -- 那是闸,不是故障;
        agent 不许自授发言权,标 UNREACHABLE 后照常继续其余场景.
        "发一次"与"闸关草稿"两条都走 `send-page`:闸开着要 `--send` 认下真发一条,
        闸关着它自己只验"草稿留下,没进对话".
  - [ ] 看门狗另有一道:触发时机不是探针能直接造的(名册与 `page-action.py` 子命令都没有
        催办入口),但 `scripts/watchdog-probe.py` 走的是 `watchdog.ts` 明写的 `silenceMs`
        storage 旋钮 + **关开关投一条排坏围栏开活**(先关总开关:自动续聊闭嘴,回灌的
        提示不会替人发出去,活一直开着;造完再开回,闹钟重排第一扫才落在开活之后,
        顺序见探针文件头),然后等静默窗到点(`--generating` 那腿改投 `send.page` 造
        生成相,验"临催读圆键,生成中不插嘴";`--gate` 那腿等催办惹来的回话报收尾,
        验"收活后静默再久也不开口"(任务门,#104) -- 它要模型真回话,换条干净会话跑;
        生成相那腿的扫的相位是探活闹钟排死的,投递前会先读闹钟对表,别干等 --
        相位不对就只能得出"没扫到生成相")
        \--**验完必须把 `ds-/watchdog` 键删掉**(否则 1s 窗口留着,催办会一直刷).

## 开真机前先做这一步

**总开关(`storage.local` 的 `toggle` 键,缺省 `false`)探针自己就能开**:

```sh
uv run scripts/page-action.py --no-pace storage set --data '{"toggle":true}'
```

真源就是 `storage.local`,写入触发 background 的 `storage.onChanged → syncFromStorage`,
与 `toggle.set` 走同一条路(内容脚本随即 `apply(true)` 装上 fetch/XHR 钩子).

**判据别读 storage(那只是真源),读钩子装没装**:

```sh
uv run scripts/page-action.py --no-pace js 'String(window.fetch).includes("native code")'
```

`native code` 在 = 没装 = 链子断.**任何要真机验发送路径的活先做这一步,否则后面全是空跑.**

## 页面必须在前台

- **DeepSeek 标签页必须留在前台**.后台标签页被浏览器节流:虚拟列表不挂行,历史不加载,
  `messages.*` 与按位置点控件会读成空.探针开扩展入口页走后台
  (`open_tab(..., background=True)`).
- 看到"对话区 0 行"先查 `document.visibilityState`,别先怀疑动作.
- **`hidden` 分两种,别混**:标签页被换掉(虚拟列表不挂行,读出来是空)与**窗口被
  别的窗口盖住**(活动标签页没变,`visibilityState` 照样报 `hidden` -- 实测过一次).
  后者不是探针读不到东西,据此去"修选择器"是修错地方.哪一种是它,用
  `ext-js '(async () => (await chrome.tabs.query({active: true}))[0].url)()'` 看活动页
  是不是站点(是 = 遮挡,不是 = 换人了).
- **开了新会话后要读列表,先 `uv run scripts/page-action.py --no-pace focus`**
  (`Page.bringToFront`).新会话在后台时虚拟列表压根不挂行,`messages.*` 恒空;
  而**开着旧会话读得动**极具迷惑性.
- `--no-pace` / `--pace` 抓瞬态时用(生成中,思考期那种几秒的窗口),**必须连读**,
  否则限速下根本抓不到.连读走 `js --times N --every S`(一条连接读完,时间线只打相变),
  别用 shell 循环:那是一拍一个进程加一次握手.放错位置 argparse 会拒绝,报错自己会说该放哪.
  `list` 只读本地目标清单,不等.
- **动作要发真事件**:`continue-click` 走 CDP `Input.dispatchMouseEvent`(按下 + 抬起),
  页面收到的是与用户手点一样的东西(手势判定,`onClick` 都照常走);`js` 仍**只读**,
  不许拿它去点控件或改状态.判据用**两个观测点**:出站请求 URL(CDP `Network` 域)与
  页面行为(按钮消失 / 圆键进生成相);`Network` 域漏抓过,一边没有不当成"没发生".
- **动手等待默认走唯一限速**(Beta(2,4),3~15s,峰在 6s;ADR-0004):探针与扩展的
  发送限速共用同一份规格(`protocol/fixtures/send-pace.json`),`--pace` 只是
  人工排障的口子,`--no-pace` 只准用于只读抓瞬态.
- `send` 遇瞬时失败(`read-failed` / `page-changed` / `no-site-tab` / CDP 超时)不回错误给调用人:
  脚本自己排队,照走限速后重发,`--attempts` 定总次数(默认 5,给 1 即不重发).
  闸类(`disabled` / `backing-off`)**不重发**--那是人在管.

## 判据纪律

- **判据要抗自污染**:
  - **别拿"读页面 / 读全局数组"当判据**.全文搜某词会被上一轮的残留渲染命中;
    `window.__foo` 会被后一轮覆盖,读到旧值时它**看起来是个合法数字**.
    装观测 → 填 → 发 → 读**闭在同一次调用里**(`sse` 就是照这条做的),或读之前先清空.
  - **两个观测点只有一个有值时,那是观测漏了,不是事实**."0 帧 / 空"不能推出"没发生"
    (先把 `net` 的 `[]` 当成"前端拒发",推出了互相矛盾的结论 -- CDP `Network` 域漏抓,
    页内 XHR 钩子同时抓几千帧).
  - **CDP 控制台事件只能靠等回包的 `call()` 顺路吃**(`scripts/watchdog-probe.py` 的
    `Recorder`):`Runtime.consoleAPICalled` 在 enable 后就持续推,若 fire-and-forget
    evaluate 后再单独 pump,那期间的事件已被 CDP 推走丢掉 -- 纯监听模式也录不到一行.
    别把"录到 0 行"读成"没发生",先确认观测路通(`scripts/sw-cdp-probe.py` 有最小复现).
  - **enable 瞬间 CDP 会把 SW 缓冲的 console 整批回放**,一次上千行,跨数小时(实测
    500+ 次探活的历史). **判定只认 enable 之后的行** -- 用 `consoleAPICalled` 的
    `timestamp` 过滤(`watchdog-probe.py` 的 `realtime_lines`). 不过滤就会把历史催办
    当成本轮证据,据此下的诊断是错的(#104 原描述即被它污染,已更正).
- **真机结果只有一半可信时别硬下结论**:能交叉验证(`messages.list` 读角色 + 正文)就验;
  拿不到就在票里写明"间接证据"与"未验证项".
- **站点限速要和链子坏了分清**(实测 2026-10-15):页面成片报"加载失败"/"服务器暂时
  不可用",写作框整个消失时,先 `curl -s -o /dev/null -w '%{http_code}'` 打一眼
  `chat.deepseek.com` -- **回 429 就是被限速了**.停手等窗口过:别当扩展的故障去修,
  更别加大频率"再试一次"(那只会把窗口续上);造生成那条腿
  (`watchdog-probe.py --generating`)在窗口里必然失败,标 UNREACHABLE 等恢复再复跑.
- **不要凭印象重实现一个已经在生产里跑的定位器,再拿它当真值** -- 去用它.
