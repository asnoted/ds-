/**
 * 失败帧:发送类失败当场抓的那一帧,和失败痕(ADR-0004)配对存在一起.
 *
 * 为什么另开一个存储键,而不是塞进失败记录里:读取器 `readFailureLog` 只挑它认识的
 * 字段,塞进去的帧会被原样丢掉;而且帧大、记录小,过期纪律也不同源.
 *
 * 帧里是页面像素,也就是**用户的对话内容**--那是 ADR-0004"不记正文"的一处显式例外
 * (见 ADR-0004):只进本地 `storage.local`,没有任何出站路径,随失败记录一起过期.
 * 抓不到就静默降级回纯文字因由,原失败路径一行都不改语义.
 */

/** 存储键:与总开关、失败留痕同在 `storage.local`,各管各的. */
export const FAILURE_FRAME_STORAGE_KEY = "dsb/failure-frames";

/** 留几帧:够看"最近几次红各是什么现场",又不至于把 storage 撑大. */
export const FAILURE_FRAME_CAP = 5;

/**
 * 一帧 dataURL 的字符预算(约 40KB 二进制:base64 每 4 字符带 3 字节).
 * JPEG 一帧整屏通常在 60~200KB,所以 background 那侧得降采样重编码到这条线以内;
 * 压不进来就丢帧留文字--宁可不拍,不要一帧把 ten MB 的配额啃掉一块.
 */
export const FAILURE_FRAME_BUDGET_CHARS = 55_000;

export type FailureFrame = {
  /** 与失败记录配对:同一个 `at` 才认(帧是那一刻的现场,不是抓的那刻). */
  readonly at: number;
  /** JPEG dataURL. */
  readonly dataUrl: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 认得出是张内嵌图就行:帧只由我们自己写,别的一律当坏数据丢掉. */
function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/") && value.length > 0;
}

/**
 * `storage.local` 里那份 → 帧数组.
 *
 * 与失败留痕同一条纪律:存储是外部输入,长得不对的一条条丢掉,不猜也不补.
 */
export function readFailureFrames(raw: unknown): FailureFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: FailureFrame[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const { at, dataUrl } = item;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (!isImageDataUrl(dataUrl)) continue;
    frames.push({ at, dataUrl });
  }
  return frames.slice(0, FAILURE_FRAME_CAP);
}

/** 同一时刻只会有一帧:配对键就是时刻,重复的替换掉而不是并排留两条. */
export function rememberFailureFrame(
  frames: readonly FailureFrame[],
  frame: FailureFrame,
): FailureFrame[] {
  const rest = frames.filter((item) => item.at !== frame.at);
  return [frame, ...rest].slice(0, FAILURE_FRAME_CAP);
}

/**
 * 只留配得上失败记录的帧:记录滚出册子的那些帧一并清掉.
 *
 * 帧随记录过期,不设独立时钟--否则会出现"记录早被挤掉,却还躺着一帧没主"的孤儿,
 * 选项页认不出它属于哪次故障.
 */
export function pruneFailureFrames(
  frames: readonly FailureFrame[],
  records: readonly { at: number }[],
): FailureFrame[] {
  const live = new Set(records.map((record) => record.at));
  const kept = frames.filter((frame) => live.has(frame.at));
  return kept.length === frames.length ? (frames as FailureFrame[]) : kept;
}

/** 配对:最前面那笔失败记录要是正好有帧就给出,配不上就是 null(宁可没有,不能张冠李戴). */
export function frameForHead(
  frames: readonly FailureFrame[],
  records: readonly { at: number }[],
): FailureFrame | null {
  const head = records[0];
  if (head === undefined) return null;
  return frames.find((frame) => frame.at === head.at) ?? null;
}

export type CaptureFailureFrameDeps = {
  /** 抓一张 dataURL;失败就抛(抓不到是常态,不是异常). */
  readonly capture: () => Promise<string>;
  /** 降采样重编码到预算以内;不给就原样用 `capture` 的结果. */
  readonly shrink?: (dataUrl: string) => Promise<string>;
  readonly budgetChars?: number;
};

/**
 * 抓一帧并包成帧记录,任何一步出岔子都回 null(静默降级回纯文字).
 *
 * 编排抽在这里,`capture` / `shrink` 由 background 注入:canvas 那套只在 service
 * worker 里活着,单测里用假的替身,要钉的正是"抓帧失败绝不影响原失败路径"这条红线.
 */
export async function captureFailureFrame(
  at: number,
  deps: CaptureFailureFrameDeps,
): Promise<FailureFrame | null> {
  const budget = deps.budgetChars ?? FAILURE_FRAME_BUDGET_CHARS;
  try {
    const captured = await deps.capture();
    if (!isImageDataUrl(captured)) return null;
    const dataUrl = deps.shrink === undefined ? captured : await deps.shrink(captured);
    if (!isImageDataUrl(dataUrl)) return null;
    if (dataUrl.length > budget) return null;
    return { at, dataUrl };
  } catch {
    return null;
  }
}
