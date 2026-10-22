/**
 * 危险拦截的例外名单:只读本机文件的工具排进围栏后**自动执行**,不注入 `[执行]` / `[跳过]`.
 *
 * 拦截的本意是"把会改状态的决定权交还给人"(GLOSSARY 的危险拦截):`read` / `glob`
 * 只读工作文件夹,改坏了也伤不到人,每块都要点一下只是把审批点成了机械动作--
 * 点惯了,真该拦的 `write` / `edit` 也就顺手点了.
 *
 * 名单**只认这两件**:名单之外的一律照旧拦,包括将来新增的工具(新增工具默认拦,
 * 要放行得在这里显式加一行).
 */

/** 认出即自动执行的工具名. */
export const AUTO_APPROVED_TOOLS: readonly string[] = ["read", "glob"];

/** 这件工具要不要自动放行(只有名单里的那两件). */
export function isAutoApproved(tool: string): boolean {
  return AUTO_APPROVED_TOOLS.includes(tool);
}
