/**
 * 页面控件存证的对拍(ADR-0018):
 * 完整性--缩写与改写在这里红;不许手抄--回归用例的源码里出现存证 `path` 原文就红.
 * pytest 那半在 `tests/test_evidence.py`,用标准库独立实现同一判据.
 */

import { describe, expect, it } from "vitest";

import {
  evidenceEntry,
  evidenceFile,
  evidenceHtml,
  type EvidenceEntry,
  type EvidenceSvg,
} from "./evidence";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDERS = ["...", "...", "<!--"];

/** 从 `outerHTML` 里独立解析出每个内联 `svg` 的 `viewBox` 与全部 `path`. */
function parseSvgs(html: string): EvidenceSvg[] {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  return [...holder.content.querySelectorAll("svg")].map((svg) => ({
    viewBox: svg.getAttribute("viewBox"),
    paths: [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? ""),
  }));
}

/** 解析再序列化是否原样:缩写出来的断头 tag 在这里露馅. */
function roundTrips(html: string): boolean {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  return holder.innerHTML === html;
}

/** 一条存证有什么问题(空数组 = 完整). */
function entryProblems(entry: EvidenceEntry): string[] {
  const problems: string[] = [];
  if (typeof entry.id !== "string" || entry.id === "") problems.push("缺 id");
  if (typeof entry.capturedOn !== "string" || !DATE_SHAPE.test(entry.capturedOn)) {
    problems.push("capturedOn 不是 YYYY-MM-DD");
  } else {
    const day = new Date(`${entry.capturedOn}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== entry.capturedOn) {
      problems.push("capturedOn 不是真实日期");
    } else if (day.getTime() > Date.now() + 24 * 3600 * 1000) {
      problems.push("capturedOn 在未来");
    }
  }
  if (entry.reconcile !== "live" && entry.reconcile !== "state-bound") {
    problems.push("reconcile 只能是 live / state-bound");
  }
  if (typeof entry.probe !== "string" || entry.probe.trim() === "") problems.push("缺 probe");
  if (entry.row !== null) {
    const row = entry.row;
    const complete =
      typeof row === "object" &&
      typeof row.container === "string" &&
      row.container !== "" &&
      Number.isInteger(row.siblings) &&
      Number.isInteger(row.index) &&
      typeof row.anchor === "string" &&
      row.anchor !== "";
    if (!complete) problems.push("row 不完整(container / siblings / index / anchor)");
  }
  if (typeof entry.outerHTML !== "string" || entry.outerHTML === "") {
    problems.push("缺 outerHTML");
    return problems;
  }
  for (const marker of PLACEHOLDERS) {
    if (entry.outerHTML.includes(marker)) problems.push(`outerHTML 含占位 ${marker}`);
  }
  if (!roundTrips(entry.outerHTML))
    problems.push("outerHTML 解析再序列化不原样(tag 不成对 / 被缩写)");
  const parsed = parseSvgs(entry.outerHTML);
  if (JSON.stringify(parsed) !== JSON.stringify(entry.svgs)) {
    problems.push("svgs 与 outerHTML 里解析出的 svg 不一致");
  }
  return problems;
}

describe("存证文件完整性", () => {
  const file = evidenceFile();

  it("有说明与非空 entries", () => {
    expect(file.description.length).toBeGreaterThan(0);
    expect(file.entries.length).toBeGreaterThan(0);
  });

  it("id 不重样", () => {
    const ids = file.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(file.entries.map((entry) => [entry.id, entry] as const))(
    "%s:字段齐,svg 与 outerHTML 对得上,原样可往返",
    (_id, entry) => {
      expect(entryProblems(entry)).toEqual([]);
    },
  );

  it("evidenceHtml 取得到原件,取不到的 id 抛", () => {
    const first = file.entries[0] as EvidenceEntry;
    expect(evidenceHtml(first.id)).toBe(first.outerHTML);
    expect(() => evidenceEntry("no.such.control")).toThrow(/没有这一条/);
  });
});

describe("完整性判据真的会红", () => {
  const sample = (): EvidenceEntry => {
    const found = evidenceFile().entries.find((entry) =>
      entry.svgs.some((s) => s.paths.length > 0),
    );
    if (!found) throw new Error("存证里没有带 svg path 的条目,没法造坏样本");
    return found;
  };

  it("缺 capturedOn", () => {
    const bad = { ...sample(), capturedOn: "" };
    expect(entryProblems(bad)).toContain("capturedOn 不是 YYYY-MM-DD");
  });

  it("svgs 少一条 path", () => {
    const good = sample();
    const bad = {
      ...good,
      svgs: good.svgs.map((svg) => ({ ...svg, paths: svg.paths.slice(0, -1) })),
    };
    expect(entryProblems(bad)).toContain("svgs 与 outerHTML 里解析出的 svg 不一致");
  });

  it("path 被改一个字", () => {
    const good = sample();
    const svgs = good.svgs.map((svg) => ({
      ...svg,
      paths: svg.paths.map((path, index) => (index === 0 ? `${path}0` : path)),
    }));
    expect(entryProblems({ ...good, svgs })).toContain("svgs 与 outerHTML 里解析出的 svg 不一致");
  });

  it("outerHTML 被缩写成省略号 / 断头 tag", () => {
    const good = sample();
    expect(entryProblems({ ...good, outerHTML: `${good.outerHTML.slice(0, 40)}...` })).not.toEqual(
      [],
    );
    expect(entryProblems({ ...good, outerHTML: good.outerHTML.slice(0, 60) })).toContain(
      "outerHTML 解析再序列化不原样(tag 不成对 / 被缩写)",
    );
  });
});

describe("回归用例不许手抄原件", () => {
  const SOURCES = import.meta.glob(
    ["./**/*.test.ts", "../../entrypoints/**/*.test.ts", "../../native/**/*.test.ts"],
    { eager: true, query: "?raw", import: "default" },
  ) as Record<string, string>;

  const allPaths = evidenceFile().entries.flatMap((entry) =>
    entry.svgs.flatMap((svg) => svg.paths.map((path) => [entry.id, path] as const)),
  );

  it("扫得到测试源码(栅栏没空转)", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(5);
  });

  it("没有任何 *.test.ts 的源码含存证里整条 path 原文", () => {
    const hits: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const [id, path] of allPaths) {
        if (path.length >= 8 && text.includes(path)) hits.push(`${file} 手抄了 ${id}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
