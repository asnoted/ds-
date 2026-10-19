# ADR-0003: 发送闸只管send; 闸关着时自动续聊变半自动

- **Status**: accepted
- **Date**: 2026-10-17

闸(选项页的复选框, 默认关)管的是"**是否允许把消息发出去**":
受闸的是所有发送 -- `send.enter`, 发送态的圆键
改这一条的原因: 闸原先管"动写作框的"动作, 而自动续聊在 MAIN 世界直接操作 DOM, 不经
`runAction`, 也拿不到 `speak` 键 -- 于是用户关掉闸之后, 催办停了, `send.page` 停了

## 决定

1. **闸的语义 = "是否允许点击发送键"**. 受闸的是所有发送; `composer.type` /
   `composer.clear` 出闸.

## Considered Options

- 见正文与 `docs/evidence/speak-gate.md`.

## Consequences

- 见正文与 `docs/evidence/speak-gate.md`.

## 判据(怎么自己复现)

- 见 `docs/evidence/speak-gate.md`.
