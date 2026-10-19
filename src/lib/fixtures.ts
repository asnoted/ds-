/**
 * 共享线协议 fixture 的扩展侧 schema 与加载器.
 * `protocol/fixtures/*.json` 由 vitest 与 pytest 共读,两半各持一份 schema.
 */

import type { ReplyPayload } from "./reply";

export type FixtureFile<T> = {
  readonly description: string;
  readonly cases: readonly T[];
};

/** 围栏解析对拍(`fence.json`). */
export type FenceCase = {
  readonly name: string;
  readonly input: string;
  /** 各块 send 围栏的正文(一段工具调用 JSON 一条),按出现顺序;没排围栏是空数组. */
  readonly expectedCalls: readonly string[];
};

/** 回灌组装对拍(`reply.json`). */
export type ReplyCase = {
  readonly name: string;
  readonly payload: ReplyPayload;
  readonly expectedMessage: string;
};

/** 配置解析对拍(`config.json`). */
export type ConfigCase = {
  readonly name: string;
  readonly kind: string;
  readonly key: string;
  readonly input: string;
  readonly expected: Readonly<Record<string, unknown>>;
};

/** 页面动作的请求体(`action.json`):动作名 + 参数 + 目标标签页(null = 不挑). */
export type ActionRequest = {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly target: string | null;
};

/** 页面动作的响应(`action.json`):成功与失败同构到一条,失败码另在册. */
export type ActionResponse =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };

/** 页面动作对拍(`action.json`). */
export type ActionCase = {
  readonly name: string;
  readonly request: ActionRequest;
  readonly response: ActionResponse;
};

/** 页面动作失败码册子(`action.json`):case 里的 `error` 只能取这里的 `code`. */
export type ActionErrorCode = {
  readonly code: string;
  readonly when: string;
};

export type ActionFixtureFile = FixtureFile<ActionCase> & {
  readonly errorCodes: readonly ActionErrorCode[];
};

/** read 限额对拍(`read.json`)的脚注态:名字 + 模板(占位符 `{start}` / `{end}` / `{total}` / `{end + 1}`). */
export type ReadFootnoteCase = {
  readonly name: string;
  readonly template: string;
};

/** read 限额对拍(`read.json`):两半必须相等的数(单页行数 / 单次字节预算)与脚注三态. */
export type ReadFixtureFile = FixtureFile<ReadFootnoteCase> & {
  readonly readPageLines: number;
  readonly readPageBudget: number;
};

/**
 * 两边的"字数"单位对拍(`result-units.json`):同一段正文,两边各量一遍.
 *
 * `utf16Units` 是扩展那边 JS 的 `.length`(星平面字算两个),`codePoints` 是另一种单位
 * (星平面字算一个)-- 它俩分岔正是这条 fixture 要盯住的事(旧 0010).
 */
export type ResultUnitsCase = {
  readonly name: string;
  readonly text: string;
  readonly utf16Units: number;
  readonly codePoints: number;
};

/** 唯一限速的固定随机源用例(`send-pace.json`):抽样比率 u → 期望间隔. */
export type SendPaceCase = {
  readonly name: string;
  readonly u: number;
  readonly expectedMs: number;
};

/** 唯一限速的间隔规格(`send-pace.json`):全仓一条(ADR-0001),TS 与 Python 共读. */
export type SendPaceFixtureFile = FixtureFile<SendPaceCase> & {
  readonly minMs: number;
  readonly modeMs: number;
  readonly maxMs: number;
  readonly sampleSize: number;
  readonly sampleRank: number;
};

const MODULES = import.meta.glob<FixtureFile<unknown>>("../../protocol/fixtures/*.json", {
  eager: true,
  import: "default",
});

const FILES = new Map<string, FixtureFile<unknown>>(
  Object.entries(MODULES).map(([path, file]) => [path.split("/").pop() ?? path, file]),
);

/** 所有共享 fixture 的文件名(含扩展名),按字典序. */
export const FIXTURE_FILENAMES = [...FILES.keys()].sort();

/** 读一个共享 fixture;缺文件直接抛,免得测试静默跳过. */
export function fixtureFile(filename: string): FixtureFile<unknown> {
  const file = FILES.get(filename);
  if (!file) throw new Error(`共享 fixture 缺失:protocol/fixtures/${filename}`);
  return file;
}

/** 读一个共享 fixture 的 cases,按各自的 schema 断言用. */
export function fixtureCases<T>(filename: string): readonly T[] {
  return fixtureFile(filename).cases as readonly T[];
}

/**
 * 页面动作的失败码册子(`action.json` 的 `errorCodes`)--与 `src/lib/action.ts`
 * 的 `ACTION_ERROR_*` 常量同一份.线上只认册子里的码.
 */
export function actionErrorCodes(): readonly string[] {
  const file = fixtureFile("action.json") as ActionFixtureFile;
  return file.errorCodes.map(({ code }) => code);
}
