# dsh-dsb

chat 节奏的 agent loop，`@dsh-agent-loop` 的改版。

分工：网页侧（`/dsh-dsb/*` 路由、令牌保险箱、浏览器登录、`deepseek-web` 模型、通道限速）全部在 [`dsh-dsweb`](../dsweb/README.md)；本包只负责 loop。

## 实现

dsb **继承 host 的 `AgentLoop`**，用同一份模块实例跑 loop 的 turn/step 机器：

- 不能直接 `import '@deepseek-ai/dsh-agent-loop'`：profile 里 linked 的插件解析不到 `@deepseek-ai/dsh-*`（实测 `ERR_MODULE_NOT_FOUND`）。
- 改为从 `process.argv[1]`（dsh bin）向上找 host 安装里的 `dsh-agent-loop/lib/index.js`，用绝对路径 import；Node 返回 host 已加载的同一实例，所以子类和 host 的类/服务是同一份。
- `cordis.patch.yml` 先 `disabled: true` 掉 stock `agent-loop`，再插入 dsb；dsb 的构造函数继承下来，`ctx.agents.setFactory(this)` 注册为唯一 factory。

节奏分工：Step 之间由 host loop 自然让出，模型请求的 3–15 秒 Beta(2,4) 限速在 dsweb 的通道层，loop 不再加第二层。

## 安装与测试

```sh
dsh plugin --profile web add dsh-dsb
```

需要与 `dsh-dsweb` 一起安装。测试：`node ../scripts/run-node-tests.mjs tests`（1 套：host 子类可加载；host 不在时跳过）。

限制：host 路径按 dsh 安装布局查找；跨机器/非标准安装时可能需要 `DSH_AGENT_LOOP` 指到 `dsh-agent-loop/lib/index.js`。目前子类还没有覆盖任何 turn/step 行为——它是后续 chat 节奏改动的接入点。
