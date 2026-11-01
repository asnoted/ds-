# dsb + dsweb

把 **chat.deepseek.com** 的对话同步进 DSH Web，并在 DSH 里直接继续聊天。dsweb 同时把这个账号注册成 DSH 的 `deepseek-web` 模型，agent loop 也能直接用它跑。仓库现在是两个 DSH 插件：

| 包 | 半边 | 职责 |
| --- | --- | --- |
| `dsb` | Agent loop | 继承 host `@dsh-agent-loop`，替换 stock loop（chat 节奏的接入点） |
| `dsweb` | 网页侧 | `/dsh-dsb/*` API、令牌保险箱、浏览器登录、`deepseek-web` 模型 |

两个包要一起装：`dsweb` 提供 API、模型和通道限速；`dsb` 用 subclass 替换 stock `agent-loop`，节奏限速只剩 dsweb 通道层这一层。

## 安装

```sh
pnpm build
# 安装源码
dsh plugin --profile web add "file:$(pwd)/dsweb" "file:$(pwd)/dsb"
# 或发布后
dsh plugin --profile web add dsh-dsb dsh-dsweb
```

更新流程：web profile 以本地 `file:` 路径指向 `dsweb/`、`dsb/`，hmr 监听这两个目录，改完源码会热替换；进程还没重启过时要重启一次。发版或给别人用时 `pnpm build` 只打 `dist/*.tgz`，再 `pnpm deploy:plugins` 装快照（会覆盖本地路径）。host 半边是 ESM。

首次使用“用浏览器登录”（POST `/dsh-dsb/login/browser`）：dsweb 会用独立的 Chromium 配置打开 chat.deepseek.com，登录后自动读回 `localStorage.userToken` 并关闭窗口，捕获过程会先校验令牌再收下——缓存里的陈旧令牌会被丢弃并导航到登录页。配置保存在 `~/.dsh/dsh-dsb/browser-profile`，不碰日常浏览器的 cookie / 历史；令牌只写入 `~/.dsh/dsh-dsb/vault.json`（0600）。需要本机有 Chromium / Chrome / Edge / Brave，找不到时可用 `DSB_BROWSER_PATH` 指定路径；手动粘贴令牌（POST `/dsh-dsb/token`）仍然保留为兜底。

## 作为 DSH 的模型

dsweb 向 `ctx.llm` 注册 `deepseek-web` provider（模型名同名），让 DSH 的 agent loop 直接用这份网页登录态跑：

- 每个 DSH session 绑定一个网页会话：首轮发全量 transcript，之后只发增量；上一轮 assistant 的 message id 作为下一轮的 `parent_message_id`，上下文跨进程保留。
- 网页会话一次只占一个 turn；自动 turn 之间按 Beta(2,4) 抽 3–15 秒间隔（峰值 6 秒），记录在 `~/.dsh/dsh-dsb/pace.json`，DSH 重启后仍然生效。
- 工具调用走 `工具名` 围栏，正文是原生 JSON 参数对象；模型只写参数对象、不带工具名时，按唯一匹配的 schema 认领（裸键名也能解析；工具目录随首轮 transcript 一起发），单轮最多执行 99 个，只认目录里存在的工具名。图片附件走上传与 ref_file_ids，上游能读到图片内容；文档一类附件在模型路径只落文件名标记（走 `/upload` + `/chat` 的直连调用才传文档）。


直接走 `/chat` 的手动对话不经过这条限速。

## 开发

```sh
pnpm install
pnpm test
```

`scripts/run-node-tests.mjs` 顺序执行各包里的 `test-*.mjs`（16 套：dsweb 15 + dsb 1；浏览器登录套件没有 Chromium 时会跳过浏览器部分；流回放首次运行会下载固定抓包到 `.cache/`，可用 `DS2API_SAMPLES` 指定已有目录）。

真实宿主冒烟：`dsh --profile web` 起来后 `DSH_WEB_URL=… pnpm smoke`，检查 `/dsh-dsb/state` 200、`POST /state` 405、浏览器登录状态与会话路由的回答。
