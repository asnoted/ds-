/**
 * 页面控件存证(ADR-0018):`protocol/evidence/controls.json` 的类型与加载器.
 *
 * 存证是**证据**,不是定位判据--真机抓到的按钮原件(`outerHTML` 一字不缩写 + 完整 `svg path`
 * + 真机日期).回归用例用 `evidenceHtml(id)` 取原件,**不许手抄**;扫源码的对拍在
 * `evidence.test.ts`.执行器不读这里,定位仍按 `ds-*` / `role` / `aria-*`.
 */

/** 一颗按钮里的一个内联 `svg`:`viewBox` 与全部 `path` 的 `d` 原文. */
export type EvidenceSvg = {
  readonly viewBox: string | null;
  readonly paths: readonly string[];
};

/** 它所在的那一排:父容器,同排几颗,排第几,从哪颗语义锚数起. */
export type EvidenceRow = {
  readonly container: string;
  readonly siblings: number;
  readonly index: number;
  readonly anchor: string;
};

/**
 * `live`:常驻,真机对账逐字比;`state-bound`:只在某个态出现,对账时只报"当前态不符,未比".
 */
export type EvidenceReconcile = "live" | "state-bound";

export type EvidenceEntry = {
  readonly id: string;
  readonly note?: string;
  /** 真机日期,`YYYY-MM-DD`. */
  readonly capturedOn: string;
  readonly reconcile: EvidenceReconcile;
  /** 单颗控件写 `null`. */
  readonly row: EvidenceRow | null;
  /** 只读 JS 表达式,页面上下文里返回站点当前那一颗的 `outerHTML`(找不到 `null`);只供对账. */
  readonly probe: string;
  readonly outerHTML: string;
  readonly svgs: readonly EvidenceSvg[];
};

export type EvidenceFile = {
  readonly description: string;
  readonly entries: readonly EvidenceEntry[];
};

const MODULES = import.meta.glob<EvidenceFile>("../../protocol/evidence/controls.json", {
  eager: true,
  import: "default",
});

/** 读存证文件;缺文件直接抛,免得测试静默跳过. */
export function evidenceFile(): EvidenceFile {
  const file = Object.values(MODULES)[0];
  if (!file) throw new Error("存证文件缺失:protocol/evidence/controls.json");
  return file;
}

/** 按 id 取一条存证;没有就抛(id 拼错不能静默变成空 HTML). */
export function evidenceEntry(id: string): EvidenceEntry {
  const entry = evidenceFile().entries.find((one) => one.id === id);
  if (!entry) throw new Error(`存证里没有这一条:${id}`);
  return entry;
}

/** 回归用例要的原件:一条存证的真机 `outerHTML`. */
export function evidenceHtml(id: string): string {
  return evidenceEntry(id).outerHTML;
}
