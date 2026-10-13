# 页面动作的设计判据

改名册与执行器时看这份:`src/lib/registry.ts` 的注册表(一件动作一行,名册与三道闸
名单都从它派生,接线在 `entrypoints/content.ts`),
`src/lib/page.ts` 的执行器,`protocol/fixtures/action.json` 契约样例与测试.
要**真机验**一件动作走 [`docs/probe.md`](probe.md).

## 失败码分得开,别让它们混成一个

| 情形                   | 码                |
| ---------------------- | ----------------- |
| 撞禁言 / 未登录        | `composer-absent` |
| 页面上找不到认得的东西 | `page-changed`    |
| 读不完                 | `read-failed`     |
| 这一跳真的走不通       | `tab-gone`        |

`composer-absent` 配 `page.state` 的 `account` 读得清是哪一种;**只有 `tab-gone`
才是这一跳真的走不通**.执行器要抛带码的 `PageError`,收信那层(`channel.ts` 的
`failureCode`)才认.

## 名册按控件划分,一个按钮只对应一个动作

站点把多个意图压进同一个 DOM 元素时(真机 2026-10-04:圆键生成期原地变停止键,
`class` 与 `aria-label` 一个不换,只有图标 `d` 不同),**合并成一个动作 + 一个独立的读
动作**,不要按图标分家 -- `send.click` / `stop.click` 那样会让两条路对同一元素给出
矛盾判断(#32).

**图标只出现在读动作的返回里,不参与命中判据.**
