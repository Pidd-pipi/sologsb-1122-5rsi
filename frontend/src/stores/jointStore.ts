import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyChange } from '../utils/sync';
import { ConcurrentModificationError, diffRecords } from '../utils/concurrency';
import { useGradeStore } from './gradeStore';
import type { JointSet, JointSetDraft } from '../types/joint';

interface JointState {
  items: JointSet[];
  loaded: boolean;
}

/** 节理组字段中文名（冲突差异展示用） */
export const JOINT_FIELD_LABELS: Record<string, string> = {
  faceId: '所属掌子面',
  setNo: '组号',
  dipDirection: '倾向',
  dipAngle: '倾角',
  spacing: '间距',
  persistence: '延伸长度',
  aperture: '张开度',
  fillMaterial: '充填物',
  roughness: '粗糙度',
  waterWet: '渗水状态',
  jointCount: '条数',
};

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
    async add(draft: JointSetDraft): Promise<JointSet> {
      const record: JointSet = {
        ...toPlain(draft),
        id: newId('joint'),
        rev: 1,
        updatedAt: Date.now(),
      };
      await db.joints.put(toPlain(record));
      await this.load();
      await useGradeStore().invalidateForFace(record.faceId, '节理组改动：新录入节理组，旧级别已失效');
      notifyChange('joints', record.id);
      return record;
    },
    /** 编辑节理组（乐观锁：base 过期则抛并发冲突并带字段差异） */
    async update(id: string, patch: Partial<JointSet>, base?: JointSet): Promise<JointSet> {
      const current = await db.joints.get(id);
      if (!current) throw new Error('节理组不存在或已被删除');
      if (base && current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'joints',
          id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            JOINT_FIELD_LABELS,
          ),
        });
      }
      const plain = toPlain(patch);
      const updated: JointSet = {
        ...toPlain(current),
        ...plain,
        id,
        rev: current.rev + 1,
        updatedAt: Date.now(),
      };
      await db.joints.put(toPlain(updated));
      await this.load();
      await useGradeStore().invalidateForFace(updated.faceId, '节理组改动：节理产状/参数被修正，旧级别已失效');
      notifyChange('joints', id);
      return updated;
    },
    async remove(id: string, base?: JointSet): Promise<void> {
      const current = await db.joints.get(id);
      if (!current) return;
      if (base && current.rev !== base.rev) {
        throw new ConcurrentModificationError({
          entity: 'joints',
          id,
          currentRev: current.rev,
          baseRev: base.rev,
          updatedAt: current.updatedAt,
          diffs: diffRecords(
            toPlain(base) as unknown as Record<string, unknown>,
            toPlain(current) as unknown as Record<string, unknown>,
            JOINT_FIELD_LABELS,
          ),
        });
      }
      const faceId = current.faceId;
      await db.joints.delete(id);
      await this.load();
      await useGradeStore().invalidateForFace(faceId, '节理组改动：节理组被删除，旧级别已失效');
      notifyChange('joints', id, 'remove');
    },
    /** 把同组产状合并到指定组：把被合并组的条数累加到目标组并删除被合并组 */
    async mergeInto(targetId: string, sourceIds: string[]): Promise<void> {
      const target = await db.joints.get(targetId);
      if (!target) return;
      const sources = (await db.joints.bulkGet(sourceIds)).filter((j): j is JointSet => !!j);
      const extra = sources.reduce((s, j) => s + j.jointCount, 0);

      await db.transaction('rw', db.joints, async () => {
        await db.joints.put(
          toPlain({
            ...target,
            jointCount: target.jointCount + extra,
            rev: target.rev + 1,
            updatedAt: Date.now(),
          }),
        );
        await db.joints.bulkDelete(sources.map((s) => s.id));
      });
      await this.load();
      // 合并属于一次编录动作，按最终结果统一让旧级别失效（幂等）
      await useGradeStore().invalidateForFace(target.faceId, '节理组改动：同组产状合并，旧级别已失效');
      notifyChange('joints', targetId);
    },
  },
});
