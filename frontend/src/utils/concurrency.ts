/**
 * 乐观并发控制（OCC）与跨标签变更广播。
 *
 * 每条记录带 rev（每次保存 +1）与 updatedAt。保存时把页面打开时记下的
 * baseRev 一并提交：库内 rev 若已大于 baseRev，说明对方先保存过，抛
 * ConcurrentModificationError，并携带字段级差异，由页面展示"对方刚改了哪里"。
 */

/** 单个字段的改动 */
export interface FieldDiff {
  key: string;
  label: string;
  before: unknown;
  after: unknown;
}

/** 并发冲突信息 */
export interface ConflictInfo {
  /** 被修改的实体表 */
  entity: string;
  /** 记录 id */
  id: string;
  /** 冲突时库内最新版本号 */
  currentRev: number;
  /** 提交时依据的版本号 */
  baseRev: number;
  /** 对方最新保存时间 */
  updatedAt: number;
  /** 字段级差异（base → 当前库内值） */
  diffs: FieldDiff[];
}

export class ConcurrentModificationError extends Error {
  info: ConflictInfo;

  constructor(info: ConflictInfo) {
    super(`记录已被他人修改（rev ${info.baseRev} → ${info.currentRev}）`);
    this.name = 'ConcurrentModificationError';
    this.info = info;
  }
}

export function isConflictError(e: unknown): e is ConcurrentModificationError {
  return e instanceof ConcurrentModificationError;
}

/** 值展示用：对象/数组简短 JSON 化，避免 [object Object] */
export function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return String(value);
}

/** 计算两个扁平对象之间的字段差异（嵌套对象按 JSON 比较，整体作为一项） */
export function diffRecords(
  base: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
  labels: Record<string, string>,
): FieldDiff[] {
  const keys = new Set([...(base ? Object.keys(base) : []), ...Object.keys(current)]);
  const diffs: FieldDiff[] = [];
  keys.forEach((key) => {
    if (key === 'rev' || key === 'updatedAt') return;
    const a = base ? base[key] : undefined;
    const b = current[key];
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    diffs.push({ key, label: labels[key] ?? key, before: a, after: b });
  });
  return diffs;
}
