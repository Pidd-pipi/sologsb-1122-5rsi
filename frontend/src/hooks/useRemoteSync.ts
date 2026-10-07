import { onMounted, onUnmounted } from 'vue';
import { onRemoteChange, type SyncMessage } from '../utils/sync';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';

/**
 * 监听其他标签页的保存/删除广播并重新拉库。
 * 级联失效（改节理→级别失效）会以 grades 广播再次到达，重载是幂等的。
 */
export function useRemoteSync(): void {
  let unsubscribe: (() => void) | undefined;

  onMounted(() => {
    unsubscribe = onRemoteChange((msg: SyncMessage) => {
      const faceStore = useFaceStore();
      const jointStore = useJointStore();
      const gradeStore = useGradeStore();
      if (msg.entity === 'faces') {
        void faceStore.load();
      } else if (msg.entity === 'joints') {
        void jointStore.load();
      } else if (msg.entity === 'grades' || msg.entity === 'waters') {
        // 级别/涌水同处 gradeStore，且级联失效会带动 grades，统一重载
        void gradeStore.load();
      }
    });
  });

  onUnmounted(() => unsubscribe?.());
}
