import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyChange } from '../utils/sync';
import {
  ConcurrentModificationError,
  diffRecords,
  type FieldDiff,
} from '../utils/concurrency';
import { basisFingerprint, buildBasis, recalcGrade } from '../utils/gradeBasis';
import { GRADE_SUPPORT, type RockMassGrade, type RockMassGradeDraft } from '../types/grade';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow, WaterInflowDraft } from '../types/water';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export interface SaveGradeOptions {
  /** 打开判定页时依据的记录（带 rev）；提供即开启乐观锁与字段级冲突差异 */
  base?: RockMassGrade;
}

export interface SaveGradeResult {
  record: RockMassGrade;
  /** 'merged-pending' 表示覆盖更新了原待复核记录；'created' 表示新增判定 */
  outcome: 'merged-pending' | 'created';
}

/** 涌水记录字段中文名（冲突差异展示用） */
export const WATER_FIELD_LABELS: Record<string, string> = {
  position: '出水部位',
  type: '出水类型',
  estimatedFlow: '估算涌水量',
  waterTemp: '水温',
  waterPressure: '水压',
  changeTrend: '变化趋势',
  chainage: '里程位置',
  faceId: '所属掌子面',
};

/** 级别判定字段中文名（冲突差异展示用） */
export const GRADE_FIELD_LABELS: Record<string, string> = {
  grade: '围岩级别',
  bqValue: 'BQ',
  correctedBq: '[BQ]',
  rqd: 'RQD',
  jv: 'Jv',
  kv: 'Kv',
  groundwater: '出水状态',
  spanWidth: '洞跨',
  correction: '修正系数',
  extraCorrection: '其它修正',
  supportSuggestion: '支护建议',
  manualAdjusted: '人工修正',
  status: '判定状态',
  basis: '判定依据摘要',
  staleReason: '失效/复核原因',
};

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    /** 未失效判定（有效 + 待复核），待复核计入台账但需显著标注 */
    activeByFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId && it.status !== 'stale')
        .sort((a, b) => b.judgedAt - a.judgedAt),
    /** 台账/详情使用的当前级别：失效记录一律不计 */
    latestByFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId && it.status !== 'stale')
        .sort((a, b) => b.judgedAt - a.judgedAt)[0],
    /** 失效记录（旧级别与旧支护建议），仅作历史留档 */
    staleByFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId && it.status === 'stale')
        .sort((a, b) => b.judgedAt - a.judgedAt),
    watersByFace: (state) => (faceId: string) =>
      state.waters.filter((it) => it.faceId === faceId).sort((a, b) => a.chainage - b.chainage),
  },
  actions: {
    async load() {
      const grades = await db.grades.toArray();
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt);
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage);
      this.loaded = true;
    },

    /**
     * 保存判定：记录判定所依据的节理/涌水/掌子面摘要与指纹。
     * 若 baseRev 对应记录已被对方先保存，抛并发冲突并带字段差异。
     */
    async addGrade(draft: RockMassGradeDraft, options: SaveGradeOptions = {}): Promise<SaveGradeResult> {
      const now = Date.now();
      let outcome: SaveGradeResult['outcome'] = 'created';

      const saved = await db.transaction('rw', db.grades, async () => {
        const face = await db.faces.get(draft.faceId);
        if (!face) throw new Error('未找到该掌子面');

        // 乐观锁：打开页面时那条依据记录若已被对方改过，拒绝覆盖
        const base = options.base;
        if (base) {
          const fresh = await db.grades.get(base.id);
          if (fresh && fresh.rev !== base.rev) {
            throw new ConcurrentModificationError({
              entity: 'grades',
              id: fresh.id,
              currentRev: fresh.rev,
              baseRev: base.rev,
              updatedAt: fresh.updatedAt,
              diffs: diffRecords(
                toPlain(base) as unknown as Record<string, unknown>,
                toPlain(fresh) as unknown as Record<string, unknown>,
                GRADE_FIELD_LABELS,
              ),
            });
          }
        }

        const existing = await db.grades
          .where('faceId')
          .equals(draft.faceId)
          .filter((g) => g.status !== 'stale')
          .toArray();
        const pending = existing.find((g) => g.status === 'pending');
        const actives = existing.filter((g) => g.status === 'active');

        let record: RockMassGrade;

        // 待复核记录就地更新（折叠重算，避免一循环堆积多条）
        if (pending) {
          const updated: RockMassGrade = {
            ...toPlain(pending),
            ...toPlain(draft),
            id: pending.id,
            judgedAt: pending.judgedAt,
            status: 'active',
            staleReason: undefined,
            recalculatedFromId: pending.recalculatedFromId,
            rev: pending.rev + 1,
            updatedAt: now,
          };
          await db.grades.put(toPlain(updated));
          record = updated;
          outcome = 'merged-pending';
        } else {
          record = {
            ...toPlain(draft),
            id: newId('grade'),
            judgedAt: now,
            status: 'active',
            rev: 1,
            updatedAt: now,
          };
          await db.grades.put(toPlain(record));
        }

        // 原有效判定被本次人工/确认判定取代，标记失效并留档
        const toSupersede = actives.filter((g) => g.id !== record.id);
        if (toSupersede.length > 0) {
          for (const g of toSupersede) {
            await db.grades.put(
              toPlain({
                ...g,
                status: 'stale',
                staleReason: `被 ${new Date(now).toLocaleString('zh-CN')} 的新判定取代`,
                rev: g.rev + 1,
                updatedAt: now,
              }),
            );
          }
        }
        return record;
      });

      await this.load();
      notifyChange('grades', saved.id);
      return { record: saved, outcome };
    },

    /** 待复核判定确认通过（不改动数据，只转正） */
    async confirmReview(base: RockMassGrade): Promise<RockMassGrade> {
      const current = await db.grades.get(base.id);
      if (!current) throw new Error('判定记录不存在');
      if (current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'grades',
          id: current.id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            GRADE_FIELD_LABELS,
          ),
        });
      }
      const updated: RockMassGrade = {
        ...toPlain(current),
        status: 'active',
        staleReason: undefined,
        rev: current.rev + 1,
        updatedAt: Date.now(),
      };
      await db.grades.put(toPlain(updated));
      await this.load();
      notifyChange('grades', current.id);
      return updated;
    },

    /**
     * 编录改动后的级联失效 + 自动重算（掌子面/节理/涌水任一改动都调它）。
     * - 当前无有效/待复核判定：无需处理
     * - 指纹未变：忽略（幂等）
     * - 已有待复核记录：就地按新数据重算，仍为待复核
     * - 有有效判定：旧判定立即置 stale（不计台账），生成一条待复核新判定
     * 返回 true 表示本次确实让旧级别失效了（页面据此提示）。
     */
    async invalidateForFace(faceId: string, reason: string): Promise<boolean> {
      const face = await db.faces.get(faceId);
      if (!face) return false;
      const joints = await db.joints.where('faceId').equals(faceId).toArray();
      const waters = await db.waters.where('faceId').equals(faceId).toArray();
      const basis = buildBasis(face, joints, waters);
      const fingerprint = basisFingerprint(basis);

      const live = await db.grades
        .where('faceId')
        .equals(faceId)
        .filter((g) => g.status !== 'stale')
        .toArray();
      if (live.length === 0) return false;

      const latest = [...live].sort((a, b) => b.judgedAt - a.judgedAt)[0];
      if (latest.basisFingerprint === fingerprint) return false;

      const now = Date.now();
      const recalced = recalcGrade({ face, joints, waters, previous: latest });

      await db.transaction('rw', db.grades, async () => {
        const pending = live.find((g) => g.status === 'pending');
        if (pending) {
          // 待复核记录随新数据继续重算，就地更新
          const updated: RockMassGrade = {
            ...toPlain(pending),
            grade: recalced.grade,
            bqValue: recalced.bqValue,
            rqd: recalced.rqd,
            jv: recalced.jv,
            kv: recalced.kv,
            groundwater: recalced.groundwater,
            spanWidth: recalced.spanWidth,
            correction: recalced.correction,
            correctedBq: recalced.correctedBq,
            extraCorrection: recalced.extraCorrection,
            supportSuggestion: GRADE_SUPPORT[recalced.grade],
            basis: recalced.basis,
            basisFingerprint: recalced.basisFingerprint,
            status: 'pending',
            staleReason: reason,
            rev: pending.rev + 1,
            updatedAt: now,
          };
          await db.grades.put(toPlain(updated));
        } else {
          // 有效判定全部立即失效（同循环一般只有一条），再生成待复核新判定
          for (const g of live) {
            await db.grades.put(
              toPlain({
                ...g,
                status: 'stale',
                staleReason: reason,
                rev: g.rev + 1,
                updatedAt: now,
              }),
            );
          }
          const record: RockMassGrade = {
            id: newId('grade'),
            faceId,
            grade: recalced.grade,
            bqValue: recalced.bqValue,
            rqd: recalced.rqd,
            jv: recalced.jv,
            kv: recalced.kv,
            groundwater: recalced.groundwater,
            spanWidth: recalced.spanWidth,
            correction: recalced.correction,
            correctedBq: recalced.correctedBq,
            extraCorrection: recalced.extraCorrection,
            supportSuggestion: GRADE_SUPPORT[recalced.grade],
            manualAdjusted: false,
            judgedAt: now,
            basis: recalced.basis,
            basisFingerprint: recalced.basisFingerprint,
            status: 'pending',
            staleReason: reason,
            recalculatedFromId: latest.id,
            rev: 1,
            updatedAt: now,
          };
          await db.grades.put(toPlain(record));
        }
      });

      await this.load();
      notifyChange('grades', faceId);
      return true;
    },

    async addWater(draft: WaterInflowDraft): Promise<WaterInflow> {
      const record: WaterInflow = {
        ...toPlain(draft),
        id: newId('water'),
        measuredAt: Date.now(),
        rev: 1,
        updatedAt: Date.now(),
      };
      await db.waters.put(toPlain(record));
      await this.invalidateForFace(record.faceId, '涌水记录改动：新录入涌水，旧级别已失效');
      await this.load();
      notifyChange('waters', record.id);
      return record;
    },

    /** 编辑涌水记录（乐观锁：base 过期则抛并发冲突并带字段差异） */
    async updateWater(
      id: string,
      patch: Partial<WaterInflow>,
      base?: WaterInflow,
    ): Promise<WaterInflow> {
      const current = await db.waters.get(id);
      if (!current) throw new Error('涌水记录不存在或已被删除');
      if (base && current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'waters',
          id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            WATER_FIELD_LABELS,
          ),
        });
      }
      const updated: WaterInflow = {
        ...toPlain(current),
        ...toPlain(patch),
        id,
        rev: current.rev + 1,
        updatedAt: Date.now(),
      };
      await db.waters.put(toPlain(updated));
      await this.invalidateForFace(updated.faceId, '涌水记录改动：涌水被修正，旧级别已失效');
      await this.load();
      notifyChange('waters', id);
      return updated;
    },

    async removeWater(id: string, base?: WaterInflow): Promise<void> {
      const current = await db.waters.get(id);
      if (!current) return;
      if (base && current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'waters',
          id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            WATER_FIELD_LABELS,
          ),
        });
      }
      const faceId = current.faceId;
      await db.waters.delete(id);
      await this.invalidateForFace(faceId, '涌水记录改动：涌水记录被删除，旧级别已失效');
      await this.load();
      notifyChange('waters', id, 'remove');
    },
  },
});
