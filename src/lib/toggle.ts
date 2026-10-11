/**
 * 总开关:控制扩展是否接管页面的全局闸,默认关(GLOSSARY.md).
 *
 * 站点范围不归它管--那是 manifest 权限的"权限钉死",总开关只决定这一程要不要注入.
 * 状态存在 `browser.storage.local`,缺键即关,所以从不写入默认值,装完就是关着的.
 *
 * 拿存储的是隔离世界的内容脚本,真正包 `fetch`/`XHR` 的人在页面世界里,两边过不去,
 * 只能走一条 `window.postMessage`;信封的形状与认法全在这里,接线不自己猜消息.
 */

/** 总开关在 `browser.storage.local` 里的键. */
export const TOGGLE_STORAGE_KEY = "toggle";

/** 信封标记:页面自己也在 postMessage,认不出这个标记的一律不收. */
export const TOGGLE_MESSAGE_SOURCE = "ds-/toggle";

export type ToggleMessage =
  | {
      readonly source: typeof TOGGLE_MESSAGE_SOURCE;
      readonly kind: "state";
      readonly enabled: boolean;
    }
  | { readonly source: typeof TOGGLE_MESSAGE_SOURCE; readonly kind: "want-state" };

/** 存储里的值 → 总开关状态:只有显式 `true` 才算开,缺键,null,字符串一律按关. */
export function readToggle(raw: unknown): boolean {
  return raw === true;
}

/** 页面世界向隔离世界要一次当前状态. */
export function wantStateMessage(): ToggleMessage {
  return { source: TOGGLE_MESSAGE_SOURCE, kind: "want-state" };
}

/** 隔离世界把当前状态交给页面世界. */
export function stateMessage(enabled: boolean): ToggleMessage {
  return { source: TOGGLE_MESSAGE_SOURCE, kind: "state", enabled };
}

/** 认信封:页面自己 post 的消息,形状不对的消息都返回 null,不猜. */
export function parseToggleMessage(data: unknown): ToggleMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { source?: unknown; kind?: unknown; enabled?: unknown };
  if (message.source !== TOGGLE_MESSAGE_SOURCE) return null;
  if (message.kind === "want-state") return wantStateMessage();
  if (message.kind === "state" && typeof message.enabled === "boolean") {
    return stateMessage(message.enabled);
  }
  return null;
}

/** "代你发言"闸的存储键:与总开关(toggle)分开,默认关. */
export const SPEAK_STORAGE_KEY = "speak";

/** "代你发言"闸:只认显式的 `true`,其它一律当没开(与 readToggle 一个脾气). */
export function readSpeak(stored: unknown): boolean {
  return stored === true;
}
