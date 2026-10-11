# 失败必须留痕:中继一行 stderr,扩展一条 storage

- **Status**: accepted
- **Date**: 2026-09-30
- **Supersedes**: none

图标翻红之后还得查得出**为什么**,**几点红的**,**多久自己绿的**.中继在 stderr 上记一行
带时间戳的业务事件(`dsb/log.py`),扩展把每次翻红写进 `storage.local`(时刻 / 环节 / 原因,
绿了再补恢复时刻),悬停在绿着的时候回看一句.两边都**不记问题与答复正文**.

依据是真机:图标红过又自己绿了,用户问"为什么红"--浏览器控制台没开着就什么都没有,
service worker 一重启,连挂在内存里的原因也蒸发了,中继日志里更是只有一行启动信息.
事后没人答得出,跟没设计日志一样.

## Considered Options

- **只打浏览器控制台**(原状):`entrypoints/` 本来就自由打日志,但 DevTools 不是常开的,
  SW 重启即清;而且 `pingRelay()` 当时是 `catch { return false }`,超时 / 连不上 / 非 2xx
  被折成同一件,连"为什么"都没留下.
- **中继自己写日志文件**:多一个路径,轮转,权限的配置面.stderr 已经能被
  `nohup uv run ds-mcp > /tmp/dsb.log 2>&1` 收下,先用现成的那条路.
- **把失败摆进对话流或弹个提示**:违房规--失败提示只在扩展侧,进度与失败都不进对话流.
- **连正文一起记**:违房规,而且没有诊断价值(要看的是**为什么**失败,不是失败时说了什么).

## Consequences

- **正文进不来靠签名,不靠自觉**:`log_event` 只收具名字段,调用点写不出 `question=`;
  异常只留类型名不带 message(消息里可能嵌着用户的东西).`log_message` 照旧整个关掉.
- **同一次故障只记一笔**:最前面那条还没恢复时,不管这次是哪个环节哪个原因都视为同一段红着
  的时间在延续--否则探活每 30s,轮询每 3s 各失败一次,几秒就能把 20 条配额刷满,真正要看的
  前因后果全被冲掉.留下的是故障**开始**的时刻.
- 事件名固定:中继 `ask-ok` / `ask-fail` / `ask-broke` / `spawn-missing` / `probe-broke` /
  `bad-request` / `slow`;扩展按环节分 `health` / `status` / `ask`.探活与现场轮询超过 1s 才记 `slow`
  (它们各有 5s 预算,慢了就是翻红的前兆).
  **(2026-10-04 补记,随 ADR-0011 换过一轮)**:中继那半现在记
  `bad-request` / `mcp-broke` / `tool-fail` / `tool-slow` / `server-down` / `tool-clash` /
  `config-broke` / `server-start-broke`(`dsb/log.py` 的 `log_event`,仍是具名字段,不带正文);
  扩展的环节只剩 `health`(周期探活)/ `call`(工具调用)/ `watchdog`(看门狗停手)--
  等待现场那条轮询已废,"现场轮询超过 1s 记 slow"不再存在.
- 悬停在**当前红着**时不摆历史--第一句就是原因,重复一遍只是噪音;绿着才回看.
