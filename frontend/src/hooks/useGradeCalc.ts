import { computed, ref } from 'vue';
import type { JointSet } from '../types/joint';
import { estimateJv } from '../utils/geoMath';
import { calcGrade, type GradeCalcInput, type GradeCalcResult } from '../utils/gradeCalc';

export type { GradeCalcInput, GradeCalcResult };

/**
 * 按 BQ/RQD/Jv/Kv 与洞跨修正实时算出围岩级别与支护建议。
 * 被围岩级别判定页（/grade/:faceId）消费。纯计算规则在 utils/gradeCalc.ts，
 * store 的自动重算（utils/gradeBasis.ts）共用同一套规则。
 */
export function useGradeCalc(jointsOfFace?: () => JointSet[]) {
  const input = ref<GradeCalcInput>({
    rockStrength: 60,
    rqd: 75,
    jv: 0,
    kv: 0.6,
    groundwater: '潮湿',
    spanWidth: 12,
    extraCorrection: 0,
  });

  const autoJv = computed(() => (jointsOfFace ? estimateJv(jointsOfFace()) : 0));

  const result = computed<GradeCalcResult>(() => calcGrade(input.value, autoJv.value));

  function patch(p: Partial<GradeCalcInput>) {
    input.value = { ...input.value, ...p };
  }

  return { input, result, patch, autoJv };
}
