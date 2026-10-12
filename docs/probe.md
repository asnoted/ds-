# 真机探针手册

页面动作没有外露调用面(ADR-0011),要真机验就走 `scripts/page-action.py`.
房规与导航在 [`AGENTS.md`](../AGENTS.md);**本文件是用法与判据纪律**.

## 子命令

| 子命令                        | 干什么                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `read`                        | 读页面状态(含圆键的图标判定)                                         |
| `send <动作> [--params json]` | 给 DeepSeek 标签页发一件页面动作                                     |
| `js <表达式>`                 | 页面上下文里跑只读 JS                                                |
| `sse`                         | 录一轮 SSE,并按 `finish_reason` 判拒收                               |
| `stop-test`                   | 端到端:起生成 → 等停止键 → 点 → 等复位                               |
| `storage get\|set\|remove`    | 读写扩展 storage                                                     |
| `capture` / `ax`              | 截图 / 可访问性树                                                    |
| `toggles-off`                 | 测试环境关掉深度思考与智能搜索(`--debug` 会顺带跑)                   |
| `evidence`                    | 存证对账:留档按钮原件 vs 站点当前(ADR-0018,只读,不进 `pnpm quality`) |

带调试口的环境是 `scripts/env-up.sh --debug`(会顺带跑 `toggles-off`).

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

- **`target: null` 那条是产品链路的约定,探针够不着**:`tabs.list` 与 `toggle.*` 由
  **background** 派发(`src/lib/action.ts`),而探针绕开 background 直接投内容脚本,
  内容脚本的 `ACTION_ROSTER`(`entrypoints/content.ts`)里没有这两个.照约定去
  `send toggle.set` 只会回 `unknown-action` -- **那是够不着,不是链子坏了**.
- **本地工具(`send.page` 等)不在名册里**,只能注入 chain 信封触发,写法见
  `scripts/page-action.py` 的文件头.
- **人做的有两件**:登录 DeepSeek,以及勾"替人开口".脚本只打印不代劳;没勾闸则写动作回
  `disabled`,属预期,不是故障.

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
- **开了新会话后要读列表,先 `uv run scripts/page-action.py --no-pace focus`**
  (`Page.bringToFront`).新会话在后台时虚拟列表压根不挂行,`messages.*` 恒空;
  而**开着旧会话读得动**极具迷惑性.
- `--no-pace` / `--pace` 抓瞬态时用(生成中,思考期那种几秒的窗口),**必须连读**,
  否则限速下根本抓不到.放错位置 argparse 会拒绝,报错自己会说该放哪.
  `list` 只读本地目标清单,不等.

## 判据纪律

- **判据要抗自污染**:
  - **别拿"读页面 / 读全局数组"当判据**.全文搜某词会被上一轮的残留渲染命中;
    `window.__foo` 会被后一轮覆盖,读到旧值时它**看起来是个合法数字**.
    装观测 → 填 → 发 → 读**闭在同一次调用里**(`sse` 就是照这条做的),或读之前先清空.
  - **两个观测点只有一个有值时,那是观测漏了,不是事实**."0 帧 / 空"不能推出"没发生"
    (先把 `net` 的 `[]` 当成"前端拒发",推出了互相矛盾的结论 -- CDP `Network` 域漏抓,
    页内 XHR 钩子同时抓几千帧).
- **真机结果只有一半可信时别硬下结论**:能交叉验证(`messages.list` 读角色 + 正文)就验;
  拿不到就在票里写明"间接证据"与"未验证项".
- **不要凭印象重实现一个已经在生产里跑的定位器,再拿它当真值** -- 去用它.
