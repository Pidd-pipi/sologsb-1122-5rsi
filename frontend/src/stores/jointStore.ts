import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyDataChanged } from '../utils/crossTab';
import type { JointSet, JointSetDraft } from '../types/joint';
import { useGradeStore } from './gradeStore';

interface JointState {
  items: JointSet[];
  loaded: boolean;
}

export const useJointStore = defineStore('joint', {
  state: (): JointState => ({ items: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => a.setNo - b.setNo),
  },
  actions: {
    async load() {
      const rows = await db.joints.toArray();
      rows.sort((a, b) => a.setNo - b.setNo);
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: JointSetDraft) {
      const record: JointSet = { ...toPlain(draft), id: newId('joint') };
      await db.joints.put(toPlain(record));
      this.items = [...this.items, record];
      await useGradeStore().recalcForFace(record.faceId);
      notifyDataChanged();
      return record;
    },
    async update(id: string, patch: Partial<JointSet>) {
      const plain = toPlain(patch);
      await db.joints.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      const faceId = this.items.find((it) => it.id === id)?.faceId;
      if (faceId) await useGradeStore().recalcForFace(faceId);
      notifyDataChanged();
    },
    async remove(id: string) {
      const target = this.items.find((it) => it.id === id);
      await db.joints.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      if (target) await useGradeStore().recalcForFace(target.faceId);
      notifyDataChanged();
    },
    /** 把同组产状合并到指定组：把被合并组的条数累加到目标组并删除被合并组 */
    async mergeInto(targetId: string, sourceIds: string[]) {
      const target = this.items.find((it) => it.id === targetId);
      if (!target) return;
      const sources = this.items.filter((it) => sourceIds.includes(it.id));
      const extra = sources.reduce((s, j) => s + j.jointCount, 0);
      const jointCount = target.jointCount + extra;
      await db.joints.update(targetId, { jointCount });
      for (const s of sources) {
        await db.joints.delete(s.id);
      }
      const removed = new Set(sources.map((s) => s.id));
      this.items = this.items
        .filter((it) => !removed.has(it.id))
        .map((it) => (it.id === targetId ? { ...it, jointCount } : it));
      // 整组合并完成后统一重算一次级别
      await useGradeStore().recalcForFace(target.faceId);
      notifyDataChanged();
    },
  },
});
