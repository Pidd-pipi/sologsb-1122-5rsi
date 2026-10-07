import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId, round } from '../utils/id';
import { computeGradeBasis } from '../utils/gradeBasis';
import { notifyDataChanged } from '../utils/crossTab';
import { estimateJv } from '../utils/geoMath';
import { GROUNDWATER_K1, gradeFromBq, spanK2 } from '../hooks/useGradeCalc';
import { GRADE_SUPPORT, type RockMassGrade, type RockMassGradeDraft } from '../types/grade';
import type { WaterInflow, WaterInflowDraft } from '../types/water';
import { useFaceStore } from './faceStore';
import { useJointStore } from './jointStore';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
    /**
     * 当前有效的级别判定：依据指纹与现编录数据一致。
     * 掌子面/节理/涌水改动后旧判定立即失配，重算完成前这里返回空，台账不予计入。
     */
    currentByFace: (state) => (faceId: string): RockMassGrade | undefined => {
      const faceStore = useFaceStore();
      const jointStore = useJointStore();
      const face = faceStore.byId(faceId);
      if (!face) return undefined;
      const { hash } = computeGradeBasis(
        face,
        jointStore.byFace(faceId),
        state.waters.filter((w) => w.faceId === faceId),
      );
      return state.items
        .filter((it) => it.faceId === faceId && it.basisHash === hash)
        .sort((a, b) => b.judgedAt - a.judgedAt)[0];
    },
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
    async addGrade(draft: RockMassGradeDraft) {
      const record: RockMassGrade = { ...toPlain(draft), id: newId('grade'), judgedAt: Date.now() };
      await db.grades.put(toPlain(record));
      this.items = [record, ...this.items];
      notifyDataChanged();
      return record;
    },
    /**
     * 编录数据（掌子面/节理/涌水）变化后重算级别：
     * 沿用最近一次判定的 RQD/Kv/出水状态等参数，叠加上新的掌子面强度、
     * 洞跨与节理估算 Jv，生成带新依据指纹的判定；旧记录保留为已失效历史。
     * 人工修正被数据变更冲掉、或原本就待复核的，重算结果继续标待复核。
     */
    async recalcForFace(faceId: string) {
      const faceStore = useFaceStore();
      const jointStore = useJointStore();
      if (!faceStore.loaded) await faceStore.load();
      if (!jointStore.loaded) await jointStore.load();
      if (!this.loaded) await this.load();
      const face = faceStore.byId(faceId);
      if (!face) return undefined;
      const joints = jointStore.byFace(faceId);
      const waters = this.watersByFace(faceId);
      const basis = computeGradeBasis(face, joints, waters);
      const latest = this.latestByFace(faceId);
      if (!latest || latest.basisHash === basis.hash) return undefined;

      const k1 = GROUNDWATER_K1[latest.groundwater] ?? 0;
      const spanWidth = Number(face.faceSize.split('×')[0]) || latest.spanWidth;
      const k2 = spanK2(spanWidth);
      // 从旧记录的修正合计中还原"其它修正系数"
      const extra = Math.max(0, round(latest.correction - k1 - spanK2(latest.spanWidth), 3));
      const jv = joints.length > 0 ? estimateJv(joints) : latest.jv;
      const bq = round(90 + 3 * face.rockStrength + 250 * latest.kv, 1);
      const correction = round(k1 + k2 + extra, 3);
      const correctedBq = round(bq - 100 * correction, 1);
      const grade = gradeFromBq(correctedBq);
      const record: RockMassGrade = {
        id: newId('grade'),
        faceId,
        grade,
        bqValue: bq,
        rqd: latest.rqd,
        jv,
        kv: latest.kv,
        groundwater: latest.groundwater,
        spanWidth,
        correction,
        correctedBq,
        supportSuggestion: GRADE_SUPPORT[grade],
        manualAdjusted: false,
        basisHash: basis.hash,
        basisSummary: basis.summary,
        needsReview: latest.manualAdjusted || latest.needsReview,
        recalculatedFrom: latest.id,
        judgedAt: Date.now(),
      };
      await db.grades.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    /** 人工复核确认：补录/自动重算的判定转为定论 */
    async confirmReview(id: string) {
      await db.grades.update(id, { needsReview: false });
      this.items = this.items.map((it) => (it.id === id ? { ...it, needsReview: false } : it));
      notifyDataChanged();
    },
    async addWater(draft: WaterInflowDraft) {
      const record: WaterInflow = { ...toPlain(draft), id: newId('water'), measuredAt: Date.now() };
      await db.waters.put(toPlain(record));
      this.waters = [...this.waters, record].sort((a, b) => a.chainage - b.chainage);
      await this.recalcForFace(record.faceId);
      notifyDataChanged();
      return record;
    },
    async removeWater(id: string) {
      const target = this.waters.find((it) => it.id === id);
      await db.waters.delete(id);
      this.waters = this.waters.filter((it) => it.id !== id);
      if (target) await this.recalcForFace(target.faceId);
      notifyDataChanged();
    },
  },
});
