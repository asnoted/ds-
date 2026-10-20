# 页面动作真机点击矩阵

> #112 判定为"带已知缺口", 缺的是**真机点过** -- CI 与 DOM 存证都绿, 但选择器/点击
> 在站点上是不是还活着, 只有点一次才知道. #119 补的是安全子集, 不是重写动作.
> 有副作用的动作仍未点, 名单见文末, 仍属 #112 的已知缺口.
>
> 跑于 2026-10-20, 站点会话 "查看当前目录"
> (`chat.deepseek.com/a/chat/s/420f4538-...`), Chromium 前台, 总开关开着
> (所有动作未回 `disabled`). 写动作走唯一限速, 读动作走 `--no-pace`.

## 设置与纪律

- 页面必须留在前台. 后台标签页/被别的窗口盖住时 `visibilityState=hidden`, 虚拟列表
  不挂行, 定时器也会节流; 这条对写动作同样成立.
- 每条写动作单独跑, 用 `--pace 3,3` (在 3-15s 的唯一限速内, 不绕过), 不用
  `--attempts` 掩盖一次失败. 开/关各一次, 读数用对应的 `*.get` 对拍, 跑完还原.
- `sidebar.set` 的前两次 `cdp-timeout` 是**假故障**: 页面被窗口盖住,
  `document.visibilityState` 读到 `hidden`. 用 `osascript` 激活 Chromium 再
  `page-action.py focus` 后重跑, 收起/展开一次过. 这不是选择器或点击坏了, 正是
  `docs/probe.md` 里 "hidden 分两种" 那种. 没有据此开修复票.

## 读数

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

## 页面还原

跑完核对: 当前会话仍是 `420f4538-...`, 写作框为空, 侧栏展开, 深度思考/智能搜索都是
`false`. 没有留下测试草稿或打开着的开关.

## 未点

按 #119 的边界, 以下动作**没有点**, 仍属 #112 的已知缺口:

- `message.retry`: 会再生成一条回答, 等同发送.
- `message.like` / `message.dislike`: 改账号状态.
- `message.read`: 起 TTS.
- `message.share`: 弹分享框.
- `code.download`: 触发下载.
- `button.click` / `send.enter`: 真发送.
- `wait.*`: 等事件, 不是点击.

要验这些须另开有闸的票, 不在本任务的"顺手点一下"范围.
