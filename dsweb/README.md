# dsh-dsweb

DeepSeek 网页侧。一个包两半：

- **客户端**（`lib/client.js`）：会话列表与聊天面板组件的源码保留，但不再向 DSH 注册任何 UI 入口（面板图标、聊天/工作切换、侧边栏 tab 均已移除）；所有 `/dsh-dsb/*` 接口与 `deepseek-web` 模型不变。手写 lazy-CJS bundle，无构建步骤。
- **Host**（`lib/index.js`）：`/dsh-dsb/*` 路由（前缀沿用旧名）、令牌保险箱、浏览器登录、历史缓存、附件代理、`deepseek-web` 模型。

## Host 路由

- `GET /state`、`POST /token`、`POST /token/clear`
- `POST /login/browser`、`GET /login/browser/status`、`POST /login/browser/cancel`
- `GET /sessions`、`GET /messages`、`POST /session/new`
- `POST /chat`（SSE）、`POST /upload`、`GET /files`

浏览器登录用独立 profile（`$DSH_HOME/dsh-dsb/browser-profile`）启动 Chromium，通过 CDP 读取 `localStorage.userToken`；可用 `DSB_BROWSER_PATH` 指定浏览器。令牌只写入 `$DSH_HOME/dsh-dsb/vault.json`（0600）；历史快照、附件 id、会话映射、限速时间戳同目录。所有路由自带回环 / Origin 围栏。

## 作为 DSH 的模型

向 `ctx.llm` 注册 `deepseek-web` provider（模型名同名），供 agent loop 的单步请求使用：每个 DSH session 绑定一个网页会话，首轮发全量 transcript，之后只发增量；上一轮 assistant 的 message id 存进 `$DSH_HOME/dsh-dsb/web-sessions.json`，下一轮作为 `parent_message_id` 续在同一分支上，所以上下文跨进程保留。

网页会话一次只占一个 turn（后来的排队）；自动 turn 之间按 Beta(2,4) 抽 3–15 秒间隔（峰值 6 秒），上次发送时刻记在 `$DSH_HOME/dsh-dsb/pace.json`，DSH 重启后仍然生效。面板的手动 `/chat` 不经过这条限速。工具调用走围栏 JSON（代码块的 info string 是工具名，正文是一个 JSON 对象），单轮最多执行 9 个；解析器仍兼容网页模型偶发吐出的原生 DSML，但提示词只教围栏；只支持文本，不处理图片 / 附件。

要让它成为默认模型，用 overlay 覆盖 `agent-default-model`：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-web
    model: deepseek-web
```

```sh
dsh --profile <profile> --patch ./model.yml "用 read 读 README.md 的第一行"
```

## 安装与测试

```sh
dsh plugin --profile web add dsh-dsb dsh-dsweb
```

需要与 `dsh-dsb` 一起安装（dsb 是 loop）。测试：`node ../scripts/run-node-tests.mjs tests`（23 套；浏览器登录套件没有 Chromium 时会跳过浏览器部分；流回放首次运行会下载固定抓包到 `.cache/`，可用 `DS2API_SAMPLES` 指定已有目录）；真实浏览器冒烟：`DSH_WEB_URL=… pnpm smoke:web`。

代码派生自 [HAN-050917/dsh-plugin-dsweb-harness](https://github.com/HAN-050917/dsh-plugin-dsweb-harness)（MIT），见 `LICENSE`；SSE 抓包来自 [CJackHwang/ds2api](https://github.com/CJackHwang/ds2api)（AGPL-3.0，仅测试时下载，不入库）。
