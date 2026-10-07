import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyChange } from '../utils/sync';
import { ConcurrentModificationError, diffRecords } from '../utils/concurrency';
import { useGradeStore } from './gradeStore';
import type { TunnelFace, TunnelFaceDraft } from '../types/face';

interface FaceState {
  items: TunnelFace[];
  loaded: boolean;
}

/** 掌子面字段中文名（冲突差异展示用） */
export const FACE_FIELD_LABELS: Record<string, string> = {
  faceNo: '掌子面编号',
  chainage: '里程桩号',
  mileageRange: '编录里程区间',
  excavationMethod: '开挖方式',
  faceSize: '开挖断面尺寸',
  lithology: '岩性',
  weathering: '风化程度',
  rockStrength: '饱和抗压强度',
  attitude: '岩层产状',
  geologist: '地质员',
};

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
    async add(draft: TunnelFaceDraft): Promise<TunnelFace> {
      const now = Date.now();
      const record: TunnelFace = { ...toPlain(draft), id: newId('face'), recordedAt: now, rev: 1, updatedAt: now };
      await db.faces.put(toPlain(record));
      await this.load();
      notifyChange('faces', record.id);
      return record;
    },
    /** 编辑掌子面（乐观锁：base 过期则抛并发冲突并带字段差异），任一字段改动都让旧级别失效 */
    async update(
      id: string,
      patch: Partial<TunnelFace>,
      base?: TunnelFace,
    ): Promise<TunnelFace> {
      const current = await db.faces.get(id);
      if (!current) throw new Error('掌子面不存在或已被删除');
      if (base && current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'faces',
          id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            FACE_FIELD_LABELS,
          ),
        });
      }
      const plain = toPlain(patch);
      const updated: TunnelFace = {
        ...toPlain(current),
        ...plain,
        id,
        rev: current.rev + 1,
        updatedAt: Date.now(),
      };
      await db.faces.put(toPlain(updated));
      await this.load();
      await useGradeStore().invalidateForFace(id, '掌子面改动：编录参数被修正，旧级别已失效');
      notifyChange('faces', id);
      return updated;
    },
    async remove(id: string): Promise<void> {
      await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, async () => {
        await db.faces.delete(id);
        await db.joints.where('faceId').equals(id).delete();
        await db.grades.where('faceId').equals(id).delete();
        await db.waters.where('faceId').equals(id).delete();
      });
      this.items = this.items.filter((it) => it.id !== id);
      notifyChange('faces', id, 'remove');
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
