# 控件存证的真机对账

> 这份文件是**来历**: 从旧 `docs/adr/` 的实测段移出(2026-10-17), 内容逐字保留 -- 只改过
> ADR 编号与指向旧篇哪一小节的指路, 后加的注记一律带日期. 当前口径见 [ADR-0006](../adr/0006-controls-are-evidenced-by-code-and-image.md), 能自己复现的判据见
> 那一篇的 `## 判据`.

## 真机对账(2026-10-11): 留档与活页仍逐字一致

`page-action.py evidence` 跑一轮, 对 `protocol/evidence/controls.json` 逐颗比:

```
一致 13 / 未比 6 / 过时 0
```

**过时 0** -- 2026-10-07 留档的控件, 四天后一颗都没漂. 这正是本篇最想要的那句
"站上还是这样": 真机对账那半进不了 CI(要登录 + paced 探针, 见上面的 Bad), 但它
**可以按需手动跑**, 而跑出来的结论是"没有漂".

**未比的 6 颗, 理由各不相同, 没有一颗是"算了当一致"**:

- `sidebar.chat-row` 报"当前态不符": 差异在第 36 个字符, 正是**会话 UUID**
  (`a2190f90-...` vs `d3b6180c-...`). 结构没变, 但工具不认得哪些片段是易变的,
  所以诚实地标**未比**而不是谎称一致.
  (可改进: 把易变片段登记成可忽略的槽位, 但那会让"逐字"这条边界变模糊 --
  留给需要时再定.)
- 4 颗侧栏折叠/展开的控件: 当前页面没有这一颗(probe 返回 null),
  换到有它的页面才能比.

**顺带验到的一件事**: 生成期与空闲期那个圆键的 `d` 分别是
`M2 4.88C2 3.68009 2 3.08...` 与 `M8.3125 0.980206C8.66767...`, 与存证里的
`circle.stop` / `circle.send` 逐字一致 -- 即 ADR-0006 当初记的"class 与
aria-label 一个不换,只有图标 d 不同", 今天在活页上又对了一遍(见 ADR-0003).

## 真机对账(2026-10-18 凌晨): 又跑一轮, 读数同形

`page-action.py evidence` 再跑一轮(留档未动;页面停在一条旧会话上, 站点在独立 profile 里
已登录):

```
一致 13 / 未比 6 / 过时 0
```

**过时 0** -- 2026-10-07 留档的控件, 十一天之后仍一颗都没漂. 未比的 6 颗与上一节**逐颗
同名**, 理由也同形, 没有一颗是"算了当一致":

- `circle.spinner`: 当前态不符 -- 存证抓的是"生成中"那一刻(`ds-loading` 在里面),
  活页此刻是空闲态, 所以比不得.
- `code.block`: 差异在代码块**正文**(存证里是 `{"tool": "ls", "arguments": {}}`, 活页上
  是当前会话里的 `{"tool":"grep",...}`) -- 壳子一样, 内容本来就该不一样.
- `sidebar.chat-row`: 差在会话 UUID(存证 `a2190f90-...`, 活页 `71d535e2-...`).
- 侧栏那两颗折叠态控件: 当前页面没有这一颗(侧栏是展开的), 换到有它的页面才能比.

前两节的"未比不是偷懒"在这里又成立一次: 4 颗消息工具栏按钮(`message.copy` /
`message.like` / `message.dislike` / `message.share`)这次**都进了"一致"** -- 那正是
ADR-0006 开篇说的"同形,无文字,无从分辨"的四颗, 它们对得上账是本篇最想要的那句.

**上午再跑两轮**(闸关着, 页面停在一条旧会话上, 侧栏展开): 读数与上一节同形 -- 一致 13 /
未比 6 / 过时 0, 未比的 6 颗**同名同因**:

- `circle.stop`: 当前态不符(存证长 924 / 活页 808) -- 两边的快照属于不同相位(存证是生成期
  那颗, 活页此刻空闲), 长度本来就对不上.
- `circle.spinner`: 当前态不符(存证 1110 / 活页 808) -- 同一回事: 存证的 DOM 里带着
  `ds-loading`, 活页此刻没有.
- `code.block`: 差在代码块正文(存证是 `{"tool": "ls", ...}`, 活页是当前会话里的那段).
- `sidebar.chat-row`: 差在会话 UUID.
- `sidebar.topbar.collapsed` / `sidebar.toggle.collapsed`: 那一轮探针返回 null(活页侧栏是展开的)
  -- 把它们各自的态调出来再比, 两颗逐字一致, 见下面一段.

**侧栏两态各比一轮**: 收起态那两颗控件只在侧栏收起时存在, 而侧栏是页面状态. 用页面动作把它
收起(`sidebar.set {collapsed:true}`, 写动作, 不进 `speak` 闸), 再跑一轮:

```
一致 13 / 未比 6 / 过时 0
[evidence] sidebar.topbar.collapsed 一致(2026-10-07 留档)
[evidence] sidebar.toggle.collapsed 一致(2026-10-07 留档)
[evidence] sidebar.topbar.expanded 未比(2026-10-07 留档)
[evidence] sidebar.toggle.expanded 未比(2026-10-07 留档)
```

两轮合起来才是这四颗的完整账: **每一颗都在它自己那一态里比过一次, 四颗逐字一致**; 单看任何
一轮, 总有另外两颗"当前页面没有". 跑完把侧栏开回原样. 未比的从此只剩四颗, 而且都不是"找不到
控件", 是同**一颗控件在不同相 / 不同内容**下的快照: `circle.stop` 与 `circle.spinner`(生成期
那两相),`code.block`(代码块正文),`sidebar.chat-row`(会话 UUID).

## 真机截图(2026-10-20): PNG 与存证同 id

ADR-0006 决定 2 要按钮的 PNG. 截图从**当前态逐字一致**的那一颗上取(先按存证 `outerHTML`
逐字找, 不另写选择器):

```sh
uv run scripts/page-action.py evidence --shots
# 默认落 protocol/evidence/shots/<id>.png; --shots DIR 可换目录
```

页签要在前台(后台页的虚拟列表不渲染);消息工具栏只在悬停时现形,所以截图前会把鼠标移到
控件中心(只移,不点),截完不留在页面上做别的动作.

这一轮在真机页面(会话"查看当前目录", 侧栏展开/收起各跑一次)截下 **15/19** 张. 四颗没截
与真机对账"未比"同一个原因, 不是漏了:

- `circle.stop` / `circle.spinner`: 只在生成期出现; 这一轮页面空闲, 不能为了截图去点发送.
- `code.block`: 存证那一块的正文字面是 `{"tool": "ls", "arguments": {}}`; 当前会话的代码块
  正文不同, 按"逐字一致"不截, 免得多一颗内容不同的图冒充原件.
- `sidebar.chat-row`: 存证那条的会话 UUID 是 `a2190f90-...`; probe 取的是侧栏第一条
  **非当前**会话, 这一轮读到另一条, 按"逐字一致"不截.

PNG 的完整性(签名 / IHDR / 宽高 / 文件名必须是存证 id)在 `tests/test_evidence_shots.py`;
它不要求 19 张齐全, 与"未比"同一个口径 -- 缺的那四颗等它们各自的态出现时再截.

## 真机点击矩阵(2026-10-20, #119)

> #112 判定为"带已知缺口", 缺的是**真机点过** -- CI 与 DOM 存证都绿, 但选择器/点击
> 在站点上是不是还活着, 只有点一次才知道. #119 补的是安全子集, 不是重写动作.
> 有副作用的动作仍未点, 名单见本节末, 仍属 #112 的已知缺口.
>
> 跑于 2026-10-20, 站点会话 "查看当前目录"
> (`chat.deepseek.com/a/chat/s/420f4538-...`), Chromium 前台, 总开关开着
> (所有动作未回 `disabled`). 写动作走唯一限速, 读动作走 `--no-pace`.

### 设置与纪律

- 页面必须留在前台. 后台标签页/被别的窗口盖住时 `visibilityState=hidden`, 虚拟列表
  不挂行, 定时器也会节流; 这条对写动作同样成立.
- 每条写动作单独跑, 用 `--pace 3,3` (在 3-15s 的唯一限速内, 不绕过), 不用
  `--attempts` 掩盖一次失败. 开/关各一次, 读数用对应的 `*.get` 对拍, 跑完还原.
- `sidebar.set` 的前两次 `cdp-timeout` 是**假故障**: 页面被窗口盖住,
  `document.visibilityState` 读到 `hidden`. 用 `osascript` 激活 Chromium 再
  `page-action.py focus` 后重跑, 收起/展开一次过. 这不是选择器或点击坏了, 正是
  `docs/probe.md` 里 "hidden 分两种" 那种. 没有据此开修复票.

### 读数

| 动作             | 参数                                 | 结果                                             |
| ---------------- | ------------------------------------ | ------------------------------------------------ |
| `composer.type`  | `{"text":"dsb-click-matrix"}`        | `ok:true`; `composer.read` -> `dsb-click-matrix` |
| `composer.clear` | `{}`                                 | `ok:true`; `composer.read` -> `""`               |
| `think.set`      | `{"enabled":true}`                   | `ok:true`; `think.get` -> `true`                 |
| `think.set`      | `{"enabled":false}`                  | `ok:true`; `think.get` -> `false`                |
| `search.set`     | `{"enabled":true}`                   | `ok:true`; `search.get` -> `true`                |
| `search.set`     | `{"enabled":false}`                  | `ok:true`; `search.get` -> `false`               |
| `sidebar.set`    | `{"collapsed":true}`                 | `ok:true`; `sidebar.get` -> `true` (收起)        |
| `sidebar.set`    | `{"collapsed":false}`                | `ok:true`; `sidebar.get` -> `false` (展开)       |
| `message.copy`   | `{"index":-1}`                       | `ok:true`; 点到最后一条消息的复制键              |
| `code.copy`      | `{"index":-1}`                       | `ok:true`; 点到最后一个代码块的复制键            |
| `chat.new`       | `{}`                                 | `ok:true`; URL 到 `https://chat.deepseek.com/`   |
| `chat.switch`    | `{"id":"420f4538-...-271832959035"}` | `ok:true`; URL 回到原会话                        |

`message.copy` / `code.copy` 的判据是 `ok:true` 与点击事件本身, **没有读剪贴板**
(#119 明确不依赖剪贴板内容). 两个动作只在对应控件存在时点: 本轮末条消息是 assistant,
页面挂载了代码块, 都点到了.

`chat.new` 只开了新会话, 没有发消息; `chat.switch` 按 id 切回原会话, 原对话内容没动.
开新会话后 URL 是站点根路径, 回到原会话后标题与 URL 都复原.

### 页面还原与未点

跑完核对: 当前会话仍是 `420f4538-...`, 写作框为空, 侧栏展开, 深度思考/智能搜索都是
`false`. 没有留下测试草稿或打开着的开关.

按 #119 的边界, 以下动作**没有点**, 仍属 #112 的已知缺口:

- `message.retry`: 会再生成一条回答, 等同发送.
- `message.like` / `message.dislike`: 改账号状态.
- `message.read`: 起 TTS.
- `message.share`: 弹分享框.
- `code.download`: 触发下载.
- `button.click` / `send.enter`: 真发送.
- `wait.*`: 等事件, 不是点击.

要验这些须另开有闸的票, 不在本任务的"顺手点一下"范围.
