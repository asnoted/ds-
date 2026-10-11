/**
 * 网页**说给人听**的话:没排围栏的那些 assistant 消息,报给中继
 * (经 background 打 `POST /mcp` 的 `said_add`,见 `entrypoints/background.ts`),
 * 协调者用 `said_read` 来取.
 *
 * 围栏那条路照旧(转给 MCP servers);没有围栏的正常回答不再无声无息地
 * 挂在页面上等人凑巧看到.报不上不改判任何结论--这条只是"让人看见",
 * 不是问答回路.
 *
 * 页面世界(MAIN)碰不到 `browser.runtime`,报话走回灌链的同一条路:
 * `saidMessage` → 隔离世界 → background.
 */

/** 自家工具名:记一段"说给人听"的话(`dsb/said.py` 的 `SaidLog`). */
export const SAID_ADD_TOOL = "said_add";

/**
 * 一条消息里**围栏之外**的部分:所有 ```send 块摘掉,剩下的给协调者看.
 *
 * 一条消息可以既有围栏(转给 MCP servers)又有别的话(说给人)--那些别的话
 * 不能跟着围栏一起被吞掉.摘完是空的就什么都不报.
 */
export function outsideFences(text: string): string {
  return text.replace(/```send[\s\S]*?```/g, "").trim();
}
