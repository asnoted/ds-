# 环境准备 runbook

起环境的四条命令在 [`README.md`](../README.md) 的"起环境";**本文件是判据与代价**.

## 跑 `scripts/env-up.sh`,别现拼命令

跑完的环境必须全部对应最新代码 -- 构建产物,中继,浏览器装的扩展,三样旧的都自动换新.

- 幂等,随时可重跑.
- `--status` 只读汇总(旧代码会如实报出来,但不动手).
- `--debug` 带调试口起(跑真机探针要这个,见 [`docs/probe.md`](probe.md)).

## 末尾判据

env-up 跑完要看到这四条都过:

- 中继自检健康
- `tools/list` 取得到工具表
- 扩展最后探活新鲜
- 会话标签页

起或重启浏览器时**清掉会话恢复,直接带 `chat.deepseek.com` 当首个标签页**;
浏览器先前就起着时 env-up 不代开,只报.

## 浏览器边界

- **禁止用用户的主 browser profile**.跑扩展 / 起浏览器一律走独立 `--user-data-dir` 的实例;
  `--load-extension` 不得挂到主 profile 实例上,也不得改写主 profile 的扩展设置.
- **用户正在用浏览器时不许重启它**(不 SIGTERM,不重开窗口).要清 flag,换 profile,装扩展,
  先问现在方不方便,或让用户自己动手.动主 profile 必须用户**明确**点头,含糊点头不算.
- **例外:ds-browser(独立 profile 那个)不用先问,直接做** -- `scripts/env-up.sh` 检测到它
  装的扩展比构建旧,或**在跑却没带 `--load-extension`**(手动开的窗口就是这样:进程在,
  扩展不在,图标找不到),都会自动重启它.登录态不丢,开着的标签页会关.
- **除此之外的浏览器一律不动**(主 profile,别人在用的),要动仍先问.

## 换新的代价

- **换中继会丢它起的子进程** -- `mcp.json` 里那批 MCP server 要重拉一遍.
- **换浏览器会让开着的标签页关掉**;登录态在独立 profile 里不丢.

换新不问你,因为脚本要保证"跑的一定是当前代码".

## dsb 的运维点

- 内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),**钉死在工作文件夹 root 内**;
  `DSB_WORK_ROOT` 改 root(缺省本仓根),改完**重启中继才生效**.**不给命令执行.**

dsb 的形态与限额见 `README.md` 与 `docs/adr/README.md` 那份索引(ADR-0011 / 0012 / 0016).

## 技能

用 **Matt 的技能**(上游 `mattpocock/skills`,见 ADR-0019).技能在 `.agents/skills/`,
`skills-lock.json` 记版本.

```sh
npx skills@latest add mattpocock/skills -a opencode -s '*' -y --copy  # 装
npx skills update                                                     # 升级
```

- **别手改技能文件**(升级会冲掉).要调整就写成规则,不要改技能本体.
- **别的技能库同理**:`npm` 装技能要走代理 7897,且**装完先审内容再用** -- 技能以完整
  agent 权限运行.
- **`.agents/` 已在 `eslint.config.js` 与 `.prettierignore` 里排除**.新增别的 vendored
  目录要一并加,否则 `pnpm quality` 会冒出上百条与本仓无关的错.
