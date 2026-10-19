import { describe, expect, it } from "vitest";

import { ASKS_STORAGE_KEY } from "./ask";
import { FAILURE_FRAME_STORAGE_KEY } from "./failureframe";
import { FAILURE_LOG_STORAGE_KEY } from "./failurelog";
import {
  isEmptyMigration,
  planStorageMigration,
  RENAMED_STORAGE_KEYS,
  type RenamedStorageKey,
} from "./migrate";
import { WATCHDOG_CONFIG_STORAGE_KEY } from "./watchdog";

const OLD = Object.keys(RENAMED_STORAGE_KEYS) as RenamedStorageKey[];

describe("planStorageMigration", () => {
  it("旧键搬成新键,旧键删掉", () => {
    const plan = planStorageMigration({
      "ds-/watchdog": { silenceMs: 1000 },
      "ds-/asks": { sid: { question: "拍个板", at: 1 } },
    });
    expect(plan.write).toEqual({
      "dsb/watchdog": { silenceMs: 1000 },
      "dsb/asks": { sid: { question: "拍个板", at: 1 } },
    });
    expect([...plan.remove].sort()).toEqual(["ds-/asks", "ds-/watchdog"]);
    expect(isEmptyMigration(plan)).toBe(false);
  });

  it("新键已有值时旧键不覆盖它", () => {
    const plan = planStorageMigration({
      "ds-/watchdog": { silenceMs: 1000 },
      "dsb/watchdog": { silenceMs: 900000 },
    });
    expect(plan.write).toEqual({});
    expect(plan.remove).toEqual([]);
    expect(isEmptyMigration(plan)).toBe(true);
  });

  it("旧键值为假(0 / false / 空串)也照搬,不当缺席", () => {
    const plan = planStorageMigration({ "ds-/failures": [] });
    expect(plan.write).toEqual({ "dsb/failures": [] });
    expect(plan.remove).toEqual(["ds-/failures"]);
  });

  it("什么都不在 = 空迁移", () => {
    const plan = planStorageMigration({ toggle: true, speak: true });
    expect(plan.write).toEqual({});
    expect(plan.remove).toEqual([]);
    expect(isEmptyMigration(plan)).toBe(true);
  });

  it("只搬旧名字那几个,别的键原样不动", () => {
    const plan = planStorageMigration({ "ds-/probe": 1, toggle: true });
    expect(plan.write).toEqual({});
    expect(plan.remove).toEqual([]);
  });
});

describe("RENAMED_STORAGE_KEYS", () => {
  it("新名字与各模块导出的常量一致(改名时两处一起动)", () => {
    expect(RENAMED_STORAGE_KEYS["ds-/asks"]).toBe(ASKS_STORAGE_KEY);
    expect(RENAMED_STORAGE_KEYS["ds-/failure-frames"]).toBe(FAILURE_FRAME_STORAGE_KEY);
    expect(RENAMED_STORAGE_KEYS["ds-/failures"]).toBe(FAILURE_LOG_STORAGE_KEY);
    expect(RENAMED_STORAGE_KEYS["ds-/watchdog"]).toBe(WATCHDOG_CONFIG_STORAGE_KEY);
  });

  it("每个旧键都真的带旧前缀,新键不带", () => {
    for (const oldKey of OLD) {
      expect(oldKey.startsWith("ds-/")).toBe(true);
      expect(RENAMED_STORAGE_KEYS[oldKey].startsWith("dsb/")).toBe(true);
    }
  });
});
