/**
 * 改名留下的旧存储键:把 `ds-` 时代的挂起状态搬到 `dsb/` 名下.
 *
 * 不搬的话,升级那一刻看门狗配置落回默认 15 分钟、挂着的"等人回"消失、失败痕断代 --
 * 而这些键里存的是**跨会话要活下来**的东西(README 之外没有任何提示).
 *
 * 新键缺席才搬值:新键一旦有值,说明这份安装已经在用新名字写,旧键就是陈的,
 * 拿它去覆盖会把当前状态换回改名前的快照.但陈键**照样删** -- 留着它,等新键
 * 日后被清空(问题回了、失败痕清了),下一次 service worker 醒来就会把改名前的
 * 旧快照复活回来.删掉才是一次性、会收敛的迁移.
 */

/** 旧键 → 新键. 旧名字只在这张表里出现,别处一律用各模块导出的常量. */
export const RENAMED_STORAGE_KEYS = {
  "ds-/asks": "dsb/asks",
  "ds-/failure-frames": "dsb/failure-frames",
  "ds-/failures": "dsb/failures",
  "ds-/watchdog": "dsb/watchdog",
} as const;

/** 迁移要读的那几个键:新旧都读,才判得出"新键缺席". 别用 get(null) -- 那会把几帧
 * JPEG 也读进来,而 service worker 每次醒来都跑这一遍. */
export const MIGRATION_KEYS: readonly string[] = [
  ...Object.keys(RENAMED_STORAGE_KEYS),
  ...Object.values(RENAMED_STORAGE_KEYS),
];

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
    if (!(oldKey in stored)) continue;
    remove.push(oldKey);
    if (!(newKey in stored)) write[newKey] = stored[oldKey];
  }
  return { write, remove };
}

/** 迁移是不是空转:调用方据此跳过写入,别为一个空对象惊动 `onChanged`. */
export function isEmptyMigration(migration: Migration): boolean {
  return migration.remove.length === 0;
}
