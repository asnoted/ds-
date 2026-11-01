# dsh-dsweb

DeepSeek 网页侧。面板半边（客户端 `lib/client.js`、locale、样式令牌）已于 2026-10 删除，现在只有：

- **Host**（`lib/index.js`）：`/dsh-dsb/*` 路由（前缀沿用旧名）、令牌保险箱、浏览器登录、历史缓存、附件代理、`deepseek-web` 模型。

## Host 路由

- `GET /state`、`POST /token`、`POST /token/clear`
- `POST /login/browser`、`GET /login/browser/status`、`POST /login/browser/cancel`
- `GET /sessions`、`GET /messages`、`POST /session/new`
- `POST /chat`（SSE）、`POST /upload`、`GET /files`

浏览器登录用独立 profile（`$DSH_HOME/dsh-dsb/browser-profile`）启动 Chromium，通过 CDP 读取 `localStorage.userToken`；可用 `DSB_BROWSER_PATH` 指定浏览器。令牌只写入 `$DSH_HOME/dsh-dsb/vault.json`（0600）；历史快照、附件 id、会话映射、限速时间戳同目录。所有路由自带回环 / Origin 围栏。

## 作为 DSH 的模型

向 `ctx.llm` 注册 `deepseek-web` provider（模型名同名），供 agent loop 的单步请求使用：每个 DSH session 绑定一个网页会话，首轮发全量 transcript，之后只发增量；上一轮 assistant 的 message id 存进 `$DSH_HOME/dsh-dsb/web-sessions.json`，下一轮作为 `parent_message_id` 续在同一分支上，所以上下文跨进程保留。

网页会话一次只占一个 turn（后来的排队）；自动 turn 之间按 Beta(2,4) 抽 3–15 秒间隔（峰值 6 秒），上次发送时刻记在 `$DSH_HOME/dsh-dsb/pace.json`，DSH 重启后仍然生效。直接走 `/chat` 的手动对话不经过这条限速。工具调用走 `工具名` 围栏，正文是原生 JSON 参数对象；模型只写参数对象、不带工具名时，按唯一匹配的 schema 认领（裸键名也能解析；工具目录随首轮 transcript 一起发），单轮最多执行 99 个，只认目录里存在的工具名；图片附件走上传与 ref_file_ids，上游能读到图片内容，文档一类附件在模型路径只落文件名标记（走 `/upload` + `/chat` 的直连调用才传文档）。

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

需要与 `dsh-dsb` 一起安装（dsb 是 loop）。测试：`node ../scripts/run-node-tests.mjs tests`（14 套；浏览器登录套件没有 Chromium 时会跳过浏览器部分；流回放首次运行会下载固定抓包到 `.cache/`，可用 `DS2API_SAMPLES` 指定已有目录）；真实宿主冒烟：`dsh --profile web` 起来后 `DSH_WEB_URL=… pnpm smoke`。

代码派生自 [HAN-050917/dsh-plugin-dsweb-harness](https://github.com/HAN-050917/dsh-plugin-dsweb-harness)（MIT），见 `LICENSE`；SSE 抓包来自 [CJackHwang/ds2api](https://github.com/CJackHwang/ds2api)（AGPL-3.0，仅测试时下载，不入库）。
