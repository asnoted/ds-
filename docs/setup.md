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

## 检出与提交,两处会咬人

本仓现在是一份**纯 git 检出**(没有 `.jj`). 如果哪天 jj 视图并回来, 它看得见 git 的一切,
两个视图会短暂对不上:

- **工作副本落后于分支 ref**:bookmark 前移后,主仓的检出还停在旧 tip -- 此时跑
  质量门,数目是旧代码的账(spec #96 的 retro 候选 1,咬过两次).**用
  `scripts/quality-gate.sh` 代替裸 `pnpm quality:ci`**:它先报"被测的是哪个提交"
  再跑门,对不上一眼可见.只报不跑用 `--quiet`.
- **worktree 是纯 git**:给子代理开的 worktree(`opencode worktree create`)没有 `.jj`,
  jj 命令在那儿跑不了 -- 用 git 提交,主仓 jj 照样看得见分支 ref,不冲突.
  要在 worktree 里用 jj 就 `jj git init --colocate`.

## 换新的代价

- **换中继会丢它起的子进程** -- `mcp.json` 里那批 MCP server 要重拉一遍.
- **换浏览器会让开着的标签页关掉**;登录态在独立 profile 里不丢.
- **改目录名等于换扩展身份**: 未打包扩展的 ID 是**加载路径的 SHA-256**(manifest 里没有
  `key` 时), 路径一改 Chrome 就当它是另一个扩展. 旧 ID 下的 `storage.local` 留在
  `<profile>/Default/Local Extension Settings/<旧 ID>/`, 新 ID 读不到(扩展之间不互通),
  于是一次目录改名会静默丢掉失败痕 / 现场帧 / 等着人回的问题 / 看门狗配置.
  `src/lib/migrate.ts` 的旧键迁移只在**同一个扩展 ID 内**有效, 跨不过这次身份变更 --
  本仓从 `ds-` 改成 `dsb` 时就这么丢过一份. 要保住跨改名的那份状态, 只能别改目录名,
  或在 manifest 里钉一个固定的 `key`(ID 就与路径脱钩了); 后者是一次显式决策, 没有默认做.
  不钉 `key` 的理由: 本仓给子代理开 worktree, 多个副本共用同一个 ds-browser profile; 钉死
  `key` 会让它们撞同一个扩展 ID, 同时只能装一个. 路径推导的 ID 让每个 worktree 各装各的.
  真要救回旧 ID 那份: 停掉 ds-browser, 备份 `<新 ID>/`, 再把 `<旧 ID>/` 下的 LevelDB 文件
  拷进 `<新 ID>/`, 起浏览器 -- 启动时的旧键迁移会按 `src/lib/migrate.ts` 的表把旧键搬成新键.
  搬坏了用备份回退, 别在没有备份时动 profile.

换新不问你,因为脚本要保证"跑的一定是当前代码".

## dsb 的运维点

- 内建五件工作工具(`ls` / `read` / `grep` / `write` / `edit`),**钉死在工作文件夹 root 内**;
  `DSB_WORK_ROOT` 改 root(缺省本仓根),改完**重启中继才生效**.**不给命令执行.**

dsb 的形态与限额见 `README.md` 与 `docs/adr/README.md` 那份索引(ADR-0002 / 0009 / 0003).

## 技能

用 **Matt 的技能**(上游 `mattpocock/skills`,见 ADR-0001).技能在 `.agents/skills/`,
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
