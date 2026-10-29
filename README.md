# dsb + dsweb

把 **chat.deepseek.com** 的对话同步进 DSH Web，并在 DSH 里直接继续聊天。dsweb 同时把这个账号注册成 DSH 的 `deepseek-web` 模型，agent loop 也能直接用它跑。仓库现在是两个 DSH 插件：

| 包 | 半边 | 职责 |
| --- | --- | --- |
| `dsb` | Agent loop | 继承 host `@dsh-agent-loop`，替换 stock loop（chat 节奏的接入点） |
| `dsweb` | 网页侧 | 聊天面板、`/dsh-dsb/*` API、令牌保险箱、浏览器登录、`deepseek-web` 模型 |

两个包要一起装：`dsweb` 提供面板、API、模型和通道限速；`dsb` 用 subclass 替换 stock `agent-loop`，Step 之间让出通道。

## 安装

装的是打好的 tarball 快照，不是工作区软链——改源码本身不会影响正在运行的 DSH，`pnpm build` 才会同步。

```sh
# 打两个插件包的快照并同步进 web profile
pnpm build
# 只打快照，不安装
pnpm package:plugins
# 或发布后
dsh plugin --profile web add dsh-dsb dsh-dsweb
```

更新流程：改源码 → `pnpm build`。build 用 `add --force` 覆盖同版本快照，不先卸载；DSH 会尝试热应用，日志提示 restart required 时再重启。运行中的进程只读 profile 里解包后的拷贝，不读工作区。客户端 `lib/client.js` 是手写 lazy-CJS bundle，没有构建步骤；host 半边是 ESM。

首次打开面板点“用浏览器登录”：dsweb 会用独立的 Chromium 配置打开 chat.deepseek.com，登录后自动读回 `localStorage.userToken` 并关闭窗口。配置保存在 `~/.dsh/dsh-dsb/browser-profile`，不碰日常浏览器的 cookie / 历史；令牌只写入 `~/.dsh/dsh-dsb/vault.json`（0600）。需要本机有 Chromium / Chrome / Edge / Brave，找不到时可用 `DSB_BROWSER_PATH` 指定路径；手动粘贴令牌仍然保留为兜底。令牌失效时面板会先用同一配置无头重读一次，真退出登录才弹出窗口。

## 作为 DSH 的模型

dsweb 向 `ctx.llm` 注册 `deepseek-web` provider（模型名同名），让 DSH 的 agent loop 直接用这份网页登录态跑：

- 每个 DSH session 绑定一个网页会话：首轮发全量 transcript，之后只发增量；上一轮 assistant 的 message id 作为下一轮的 `parent_message_id`，上下文跨进程保留。
- 网页会话一次只占一个 turn；自动 turn 之间按 Beta(2,4) 抽 3–15 秒间隔（峰值 6 秒），记录在 `~/.dsh/dsh-dsb/pace.json`，DSH 重启后仍然生效。
- 工具调用走 `tool` 围栏：正文是 `{工具名: 参数}`，参数是原始文本不是 JSON（提示词只教这一种；工具目录随首轮 transcript 一起发），单轮最多执行 9 个，只认目录里存在的工具名。只支持文本，不处理图片 / 附件。

模型选择器暂时还没有 `deepseek-web`，用 overlay 指定：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-web
    model: deepseek-web
```

```sh
dsh --profile <profile> --patch ./model.yml "用 read 读 README.md 的第一行"
```

面板的手动 `/chat` 不经过这条限速，人点发送仍即时发出。

## 开发

```sh
pnpm install
pnpm test                 # dsb 1 套 + dsweb 23 套 + legacy Vitest/pytest（含 3 套上游抓包回放）
pnpm test:plugins         # 只跑 dsb / dsweb
pnpm smoke:web            # 真实浏览器冒烟，见下
```

`scripts/run-node-tests.mjs` 顺序执行各包里的 `test-*.mjs`；legacy 仍用 Vitest。

流回放套件首次运行会从 [CJackHwang/ds2api](https://github.com/CJackHwang/ds2api) 的固定 commit 下载一份真实 SSE 抓包到 `.cache/ds2api-samples`（AGPL 测试数据，不入库）；已有抓包时设 `DS2API_SAMPLES=<父目录>`。

真实浏览器冒烟需要先起 DSH，再把带令牌的地址交给脚本：

```sh
dsh web --no-open --port 18787
DSH_WEB_URL='http://127.0.0.1:18787/?token=…' pnpm smoke:web
```

它会检查聊天/工作开关、面板打开、`/dsh-dsb/state` 返回 200，以及页面无 console 错误。

## 许可

`dsb` / `dsweb` 的 host/client 代码派生自 [HAN-050917/dsh-plugin-dsweb-harness](https://github.com/HAN-050917/dsh-plugin-dsweb-harness)（MIT），许可证见各包的 `LICENSE`。
