# 当前功能验收地图: 依赖图

> 这是 GitHub map [#109](https://github.com/copytht/dsb/issues/109) 的依赖图与域索引.
> 终点, 判定词, 证据门槛, 修复边界与 out of scope 写在 map 里, 这里不重复.
> Baseline: `fa55d61` (2026-10-20).

## 9 个域

| #   | 域                    | 一句话范围                                              | 判定票 |
| --- | --------------------- | ------------------------------------------------------- | ------ |
| 1   | 开启与续聊            | 启用开关, 围栏续聊, 请求体替换, 轮数/块数上限, 草稿暂存 | #110   |
| 2   | 发言闸与发送限速      | speak 只管发送, 3-15s Beta 限速, 停止不延迟             | #111   |
| 3   | 页面动作与聊天读取    | 动作名册, 选择器, 聊天/侧栏/消息读取, `send.page`       | #112   |
| 4   | 本地工作工具          | `ls/read/grep/write/edit`, 沙箱, 权限, 结果上限         | #113   |
| 5   | said/ask              | ask 围栏角标, 围栏外散文转 `said_add/read`              | #114   |
| 6   | 看门狗                | 静默催办, 会话漂移, 生成中/闸关跳过                     | #115   |
| 7   | 失败留痕与图标/现场帧 | 失败日志, 恢复时间, 图标, 现场帧                        | #116   |
| 8   | MCP 网关              | `/mcp` 端点, 第三方 server 聚合, 超时/配额              | #117   |
| 9   | 存证与真机探针        | 控件原件, 截图, 真机对账, probe                         | #118   |

域 3 的安全子集点击矩阵读数见 [evidence/controls.md](../evidence/controls.md) 的
"真机点击矩阵"节; 有副作用的动作仍未点, 缺口保留.

## 全依赖图

一张图看全: 9 个域 + 域 3 的 34 个动作. 34 个动作收在 6 个组节点里, 避免 43 个节点把图
拉散; 每个动作名都在组节点里, 逐动作的边看下面的动作边表. 组节点按读/写/后台/消息/发送/
等待分组, 并标出 #119 的真机边界.

图的源数据是 [nodes.csv](./nodes.csv) 与 [edges.csv](./edges.csv). `edges.csv` 的
`render=graph` 进图, `render=detail` 是逐动作边, 不画进组图. 改 CSV 后跑
`uv run scripts/wayfinder-graph.py`; `--check` 在 pre-commit 与 CI 拦漂移.

<!-- wayfinder:graph:start -->

```mermaid
flowchart TB
  D1["1 开启与续聊"]
  D2["2 发言闸与发送限速"]
  D3["3 页面动作与聊天读取 (34 动作)"]
  D4["4 本地工作工具"]
  D5["5 said/ask"]
  D6["6 看门狗"]
  D7["7 失败留痕与图标/现场帧"]
  D8["8 MCP 网关"]
  D9["9 存证与真机探针"]
  A_READ["读: 不改页面<br/>page.state [读]<br/>chats.list [读]<br/>messages.list [读]<br/>messages.last [读]<br/>composer.read [读]<br/>think.get [读]<br/>search.get [读]<br/>button.get [读]<br/>sidebar.get [读]"]
  A_WRITE["写: 改页面状态<br/>composer.type [点]<br/>composer.clear [点]<br/>think.set [点]<br/>search.set [点]<br/>sidebar.set [点]<br/>chat.new [点]<br/>chat.switch [点]"]
  A_BG["后台: target=null<br/>tabs.list [后台]<br/>toggle.get [后台]<br/>toggle.set [后台]<br/>storage.get [后台]<br/>storage.set [后台]<br/>storage.remove [后台]"]
  A_MSG["消息/代码控件<br/>message.copy [点]<br/>message.like [未点]<br/>message.dislike [未点]<br/>message.read [未点]<br/>message.share [未点]<br/>code.copy [点]<br/>code.download [未点]"]
  A_SEND["发送<br/>button.click [未点]<br/>send.enter [未点]<br/>message.retry [未点]"]
  A_WAIT["等待<br/>wait.fence [未点]<br/>wait.reply [未点]"]

  D2 --> D3
  D1 --> D2
  D1 --> D3
  D1 --> D8
  D4 --> D3
  D4 --> D8
  D5 --> D1
  D5 --> D3
  D6 --> D1
  D6 --> D2
  D6 --> D3
  D7 --> D3
  D7 --> D8
  D9 -.-> D1
  D9 -.-> D2
  D9 -.-> D3
  D9 -.-> D6
  D9 -.-> D7
  D3 --> A_READ
  D3 --> A_WRITE
  D3 --> A_BG
  D3 --> A_MSG
  D3 --> A_SEND
  D3 --> A_WAIT
  D1 --> A_WRITE
  D1 --> A_SEND
  D4 --> A_WRITE
  D4 --> A_SEND
  D6 --> A_READ
  D6 --> A_WRITE
  D6 --> A_SEND
  D2 --> A_SEND
  A_READ --> A_WRITE
  A_READ --> A_SEND
  A_READ -.-> A_MSG
  A_WRITE --> A_SEND
```

<!-- wayfinder:graph:end -->

## 边读法

域级实线 = 运行时/行为依赖; 域级虚线 = 证据依赖: 9 的真机状态/帧需要这些域先有可复现的现场.
动作级实线 = 调用/先后; 动作级虚线 = 读回对拍或退避探针.

| 边               | 为什么                                            |
| ---------------- | ------------------------------------------------- |
| 1 -> 2           | 续聊发的那一条必须过 speak 闸与唯一限速           |
| 1 -> 3           | 续聊落草稿/发送要用写作框与页面动作               |
| 1 -> 8           | 续聊的工具结果经 MCP 中继回灌                     |
| 2 -> 3           | 限速挂在发送动作上, 闸也读发送动作                |
| 4 -> 3           | `send.page` 是本地工具, 但落点是页面动作          |
| 4 -> 8           | 工作工具由扩展经 MCP 网关调用                     |
| 5 -> 1           | ask 围栏与续聊共用同一套围栏解析/轮次             |
| 5 -> 3           | 角标与 hover 问题挂在聊天消息工具栏上             |
| 6 -> 1           | 催办走续聊那条发送路                              |
| 6 -> 2           | 催办也过闸/限速; 生成中/闸关跳过                  |
| 6 -> 3           | 漂移回退与页面状态读取要页面动作                  |
| 7 -> 3           | 动作失败是失败痕的事件来源之一                    |
| 7 -> 8           | 中继/健康失败也是失败痕的事件来源                 |
| 9 -.-> 1,2,3,6,7 | 截图/帧要对上这些域的真实状态, 状态不出现就补不了 |

### 组边

| 组边         | 聚合了什么                                            |
| ------------ | ----------------------------------------------------- |
| 读 -> 写     | `chats.list` -> `chat.switch`; `page.state` 退避探针  |
| 读 -> 发送   | `button.get` -> `button.click`; `page.state` 退避探针 |
| 读 -.-> 消息 | `page.state` 退避探针                                 |
| 写 -> 发送   | `composer.type` -> `send.enter`                       |

### 动作边

| 边                                                   | 为什么                              |
| ---------------------------------------------------- | ----------------------------------- |
| 1/4/6 -> `composer.type` / `send.enter`              | 续聊落草稿或发送; 催办; `send.page` |
| 6 -> `composer.read` / `button.get`                  | 催办前读草稿; 停下按钮先读再点      |
| 2 -> `send.enter` / `button.click` / `message.retry` | 发送动作过 speak 闸与唯一限速       |
| `chats.list` -> `chat.switch`                        | 先拿会话 id 再切                    |
| `button.get` -> `button.click`                       | 先读按钮意图/状态再点               |
| `composer.type` -> `send.enter`                      | 先落草稿再按发送                    |
| `*.set` -.-> `*.get`                                 | 写完读回, 认页面有没有照做          |
| `composer.type` -.-> `composer.read`                 | 写完读回, 认输入框有没有照做        |
| `page.state` -.-> 写/消息/发送组                     | 退避闸先探账号处境, 再决定放不放行  |

### 动作标记

- `[点]` = #119 真机点过; `[未点]` = #112 仍缺的真机点击; `[读]` / `[后台]` = 只读或
  target=null, 不在点击矩阵里.
- `D5 said/ask` 不直接调用页面动作, 它与消息工具栏共用位置, 域级边仍是 5 -> 3.
- `D3` 指向 6 个组是归属边, 不是调用; 组级箭头是聚合, 逐动作的先后与读回看上面的表.

## 开图顺序

1. 第一批: **3** 与 **8** (根, 可并行).
2. 第二批: **2**, **4**, **7**.
3. 第三批: **1**.
4. 第四批: **5** 与 **6** (可并行).
5. 最后: **9** (汇, 等前面的状态与证据齐).

依赖只决定"什么时候能开", 不决定优先级. 同一批里先开哪张由当次 session 选.

## 不在图里

- 新功能, 重构, 性能, 文案, 体验优化.
- 未来 ADR 与未交付方向.
- 重新启用原生 `chat/continue`; 已决定不用.
- 历史票 #99-#108: 只作为当前行为的来历, 不重开; 判定发现未验项时在新票里记缺口.
