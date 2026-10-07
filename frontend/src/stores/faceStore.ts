import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyDataChanged } from '../utils/crossTab';
import { diffFaceFields, type EditableFaceField } from '../utils/faceDiff';
import type { TunnelFace, TunnelFaceDraft } from '../types/face';
import { useGradeStore } from './gradeStore';

interface FaceState {
  items: TunnelFace[];
  loaded: boolean;
}

/** 双方同时改了同一字段且值不一致 */
export interface FaceMergeConflict {
  field: EditableFaceField;
  /** 我这次想保存的值（未写入） */
  mine: unknown;
  /** 对方已保存的现值 */
  theirs: unknown;
}

export interface FaceMergeResult {
  /** 实际写入的我的字段 */
  applied: EditableFaceField[];
  /** 与对方冲突、未覆盖对方值的字段 */
  conflicts: FaceMergeConflict[];
  rev: number;
}

export const useFaceStore = defineStore('face', {
  state: (): FaceState => ({ items: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    latest: (state) =>
      [...state.items].sort((a, b) => b.chainage - a.chainage)[0],
  },
  actions: {
    async load() {
      const rows = await db.faces.toArray();
      rows.sort((a, b) => b.chainage - a.chainage);
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: TunnelFaceDraft) {
      const now = Date.now();
      const record: TunnelFace = { ...toPlain(draft), id: newId('face'), recordedAt: now, rev: 1, updatedAt: now };
      await db.faces.put(toPlain(record));
      this.items = [...this.items, record].sort((a, b) => b.chainage - a.chainage);
      notifyDataChanged();
      return record;
    },
    async update(id: string, patch: Partial<TunnelFace>) {
      const current = await db.faces.get(id);
      if (!current) return;
      const plain = { ...toPlain(patch), rev: current.rev + 1, updatedAt: Date.now() };
      await db.faces.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      await useGradeStore().recalcForFace(id);
      notifyDataChanged();
    },
    /**
     * 字段级合并保存：以打开表单时的快照 base 为基准，
     * 只写"我改过的字段"；对方已先改的字段不覆盖，作为冲突返回，
     * 由界面告知对方刚改过哪里。
     */
    async mergeUpdate(id: string, draft: TunnelFaceDraft, base: TunnelFace): Promise<FaceMergeResult> {
      const current = await db.faces.get(id);
      if (!current) throw new Error('掌子面不存在或已被删除');
      const mine = diffFaceFields(draft, base);
      const theirs = diffFaceFields(current, base);
      const conflicts: FaceMergeConflict[] = [];
      const applicable = mine.filter((field) => {
        if (!theirs.includes(field)) return true;
        // 双方改成同一个值不算冲突
        if (JSON.stringify(draft[field]) === JSON.stringify(current[field])) return true;
        conflicts.push({ field, mine: draft[field], theirs: current[field] });
        return false;
      });
      let rev = current.rev;
      if (applicable.length > 0) {
        const patch: Record<string, unknown> = {};
        for (const field of applicable) patch[field] = toPlain(draft[field]);
        rev = current.rev + 1;
        await db.faces.update(id, { ...patch, rev, updatedAt: Date.now() });
        const fresh = await db.faces.get(id);
        if (fresh) {
          const plain = toPlain(fresh);
          this.items = this.items
            .map((it) => (it.id === id ? plain : it))
            .sort((a, b) => b.chainage - a.chainage);
        }
        await useGradeStore().recalcForFace(id);
        notifyDataChanged();
      }
      return { applied: applicable, conflicts, rev };
    },
    async remove(id: string) {
      await db.faces.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      notifyDataChanged();
    },
    /** 复制上一循环（里程更小的最近一个掌子面）的信息作为草稿 */
    previousDraft(id: string): TunnelFaceDraft | undefined {
      const current = this.items.find((it) => it.id === id);
      if (!current) return undefined;
      const prev = [...this.items]
        .filter((it) => it.chainage < current.chainage)
        .sort((a, b) => b.chainage - a.chainage)[0];
      if (!prev) return undefined;
      const { id: _omit, recordedAt: _omit2, rev: _omit3, updatedAt: _omit4, ...draft } = prev;
      return toPlain(draft);
    },
  },
});
