/**
 * 改名留下的旧存储键:把 `ds-` 时代的挂起状态搬到 `dsb/` 名下.
 *
 * 不搬的话,升级那一刻看门狗配置落回默认 15 分钟、挂着的"等人回"消失、失败痕断代 --
 * 而这些键里存的是**跨会话要活下来**的东西(README 之外没有任何提示).
 *
 * 只搬**新键缺席**的那几个:新键一旦有值,说明这份安装已经在用新名字写,旧键就是陈的;
 * 拿它去覆盖会把当前状态换回改名前的快照.
 */

/** 旧键 → 新键. 旧名字只在这张表里出现,别处一律用各模块导出的常量. */
export const RENAMED_STORAGE_KEYS = {
  "ds-/asks": "dsb/asks",
  "ds-/failure-frames": "dsb/failure-frames",
  "ds-/failures": "dsb/failures",
  "ds-/watchdog": "dsb/watchdog",
} as const;

export type RenamedStorageKey = keyof typeof RENAMED_STORAGE_KEYS;

export type Migration = {
  readonly write: Readonly<Record<string, unknown>>;
  readonly remove: readonly string[];
};

/** 从整份 `storage.local` 读出该写什么、该删什么;空迁移 = 没有可搬的. */
export function planStorageMigration(stored: Readonly<Record<string, unknown>>): Migration {
  const write: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [oldKey, newKey] of Object.entries(RENAMED_STORAGE_KEYS)) {
    if (!(oldKey in stored) || newKey in stored) continue;
    write[newKey] = stored[oldKey];
    remove.push(oldKey);
  }
  return { write, remove };
}

/** 迁移是不是空转:调用方据此跳过写入,别为一个空对象惊动 `onChanged`. */
export function isEmptyMigration(migration: Migration): boolean {
  return migration.remove.length === 0;
}
