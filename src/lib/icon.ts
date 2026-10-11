/**
 * 工具栏图标即状态位:三态 -- 关 / 开且中继可达 / 开但中继不可达.
 *
 * 图标由纯函数现画像素(不带图片资源),悬停文案由纯函数现拼,
 * 所以三态长什么样,悬停说不说得出原因与启动命令,都能被单测断言.
 * background 只负责把结果交给 `browser.action`,并把点击接到总开关上.
 */

import { FAILURE_RELAY_UNREACHABLE } from "./relay";
import { failureNotice, RELAY_START_COMMAND, type FailureNotice } from "./reply";
import { ASK_BADGE_TEXT } from "./ask";
import type { AccountState } from "./page";

export type IconState = "off" | "on-reachable" | "on-unreachable";

export const ICON_STATES: readonly IconState[] = ["off", "on-reachable", "on-unreachable"];

/** 图标边长(manifest 图标的常见尺寸). */
export const ICON_SIZE = 16;

/** 三态的底色:灰=关,绿=开且可达,红=开但不可达. */
export const ICON_COLORS: Readonly<Record<IconState, readonly [number, number, number, number]>> = {
  off: [107, 114, 128, 255],
  "on-reachable": [47, 158, 68, 255],
  "on-unreachable": [224, 49, 49, 255],
};

/** 7×7 白色前景图样:横杠 / 对勾 / 叹号. */
const GLYPHS: Readonly<Record<IconState, readonly string[]>> = {
  off: [".......", ".......", ".......", ".#####.", ".#####.", ".......", "......."],
  "on-reachable": [".......", "......#", ".....#.", ".#...#.", "..#.#..", "...#...", "......."],
  "on-unreachable": ["..###..", "..###..", "..###..", "..###..", ".......", "..###..", "......."],
};

/** 角标转速帧:工具调用在途时按这个顺序循环转. */
export const SPIN_FRAMES = ["|", "/", "-", "\\"] as const;

/**
 * 第 `tick` 帧的转速字符(`tick` 从 0 递增).纯函数,帧序与转速都可单测.
 */
export function spinFrame(tick: number): string {
  const frame = SPIN_FRAMES[tick % SPIN_FRAMES.length];
  if (frame === undefined) throw new Error("转速帧还没到场");
  return frame;
}

const CLICK_HINT = "点击打开开关面板.";

/**
 * 角标文字.
 *
 * 关与不可达是**硬状态**,压过一切:像素图标万一画不出来,角标要独自把三态撑住,
 * 所以前两个分支绝不能被在途转框盖掉.开着且可达时,才轮到"等人回"与
 * 调用在途;等人回压过在途--进度是暂时的,人等着是定住的,不看到"人"就没人回.
 *
 * 工具调用在途时(给了转速帧)角标转起来;没传帧的调用方仍拿"调"字作回退.
 */
export function badgeText(
  state: IconState,
  inFlight = false,
  pendingAsk = false,
  spin?: number,
): string {
  if (state === "off") return "关";
  if (state === "on-unreachable") return "!";
  if (pendingAsk) return ASK_BADGE_TEXT;
  if (!inFlight) return "";
  if (spin !== undefined) return spinFrame(spin);
  return "调";
}

/**
 * 账号处境的一句话(#2):禁言带页面上写的解封时刻,未登录指回登录口.
 * `ready` 是常态,`unknown` 是分不清--都不说(不猜).
 */
export function describeAccount(account: AccountState): string {
  if (account.kind === "muted") {
    return account.until === null
      ? "账号被禁言(页面上没写解封时刻),写动作停."
      : `账号禁言至 ${account.until},写动作停.`;
  }
  return account.kind === "signed-out" ? "账号未登录,登录后再用." : "";
}

/**
 * 悬停文案:关与可达各自一句话,不可达必须带上原因与启动命令.
 *
 * 第三个参数是**调用在途**:开着且可达时,悬停说一句"工具调用在途",
 * 让用户知道角标为什么在转(进度不上对话流).
 *
 * 第四个参数是**上次故障的一句话**(`describeLastFailure` 产出):红过又自己绿了之后,
 * 原因就不再写在标题里了,只有把历史摆出来,"为什么红过"才查得到.当前正红着时
 * 不摆--那时候第一句就是原因,重复一遍只是噪音.
 *
 * 第五个参数是**等人回的一句话**(`describePendingAsks` 产出,#26):
 * 网页排了 ask 围栏问人,挂在这里,人悬停才知道要回.
 *
 * 第六个参数是**账号处境**(#2):禁言带解封时刻,未登录指回登录口--
 * 禁言期写路径全断,悬停是扩展侧唯一的显式停机说明.
 */
export function iconTitle(
  state: IconState,
  notice?: FailureNotice | null,
  inFlight = false,
  lastFailure?: string | null,
  pendingAsk?: string | null,
  account: AccountState | null = null,
): string {
  if (state === "off") return `ds-:总开关已关,扩展没有接管页面.${CLICK_HINT}`;
  // 在途与等人回只在"开着且可达"时才有意义:不可达时手里没有正经在途的东西.
  const waiting = state === "on-reachable" && inFlight ? "工具调用在途." : "";
  const ask = state === "on-reachable" && pendingAsk ? `${pendingAsk}.` : "";
  const accountLine =
    state === "on-reachable" && account !== null && account.kind !== "ready"
      ? `${describeAccount(account)}.`
      : "";
  if (state === "on-reachable") {
    const history = lastFailure ? `${lastFailure}.` : "";
    return `ds-:总开关已开,中继可达.${accountLine}${waiting}${ask}${history}${CLICK_HINT}`;
  }
  const shown =
    notice ??
    ({
      title: "中继不可达",
      reason: "本机中继 dsb 没有响应.",
      command: RELAY_START_COMMAND,
    } satisfies FailureNotice);
  return `ds-:${shown.title} ${shown.reason} 启动命令:${shown.command}.${CLICK_HINT}`;
}

/**
 * 一次周期探活(JSON-RPC `ping`)之后的状态位:总开关关着就原样不动,
 * 可达就把原因清掉,不可达才挂上原因与启动命令.
 *
 * 探测结果 → 状态的映射放这儿,是为了让"图标该不该翻脸"可被单测断言;
 * background 只管上屏.可达时清空原因,不可达时给出**同一个** notice 对象
 * (`failureNotice` 对在册错误码返回常量),调用方拿引用比较就知道有没有变化.
 */
export function afterHealthProbe(
  state: IconState,
  reachable: boolean,
): { state: IconState; notice: FailureNotice | null } {
  if (state === "off") return { state: "off", notice: null };
  if (reachable) return { state: "on-reachable", notice: null };
  return { state: "on-unreachable", notice: failureNotice(FAILURE_RELAY_UNREACHABLE) };
}

function isInsideRoundedRect(x: number, y: number, size: number, radius: number): boolean {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const nearX = Math.min(cx, size - cx);
  const nearY = Math.min(cy, size - cy);
  if (nearX >= radius || nearY >= radius) return true;
  const dx = radius - nearX;
  const dy = radius - nearY;
  return dx * dx + dy * dy <= radius * radius;
}

/** 画一个状态的图标:圆角方块底色 + 白色图样,输出 RGBA 像素. */
export function renderIcon(state: IconState, size = ICON_SIZE): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const [red, green, blue, alpha] = ICON_COLORS[state];
  const radius = Math.max(1, Math.round(size / 4));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isInsideRoundedRect(x, y, size, radius)) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }

  const glyph = GLYPHS[state];
  const rows = glyph.length;
  const columns = glyph[0]?.length ?? 0;
  const scale = Math.max(1, Math.floor((size - 2) / Math.max(rows, columns)));
  const originX = Math.floor((size - columns * scale) / 2);
  const originY = Math.floor((size - rows * scale) / 2);

  for (let row = 0; row < rows; row += 1) {
    const line = glyph[row] ?? "";
    for (let column = 0; column < columns; column += 1) {
      if (line[column] !== "#") continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = originX + column * scale + dx;
          const y = originY + row * scale + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const offset = (y * size + x) * 4;
          pixels[offset] = 255;
          pixels[offset + 1] = 255;
          pixels[offset + 2] = 255;
          pixels[offset + 3] = 255;
        }
      }
    }
  }

  return pixels;
}
