import { GRADE_SUPPORT, type Groundwater, type RockGrade } from '../types/grade';
import { round } from './id';

export interface GradeCalcInput {
  /** 饱和抗压强度 MPa */
  rockStrength: number;
  /** 岩石质量指标 % */
  rqd: number;
  /** 节理体密度 条/m³（可留 0，交由间距估算） */
  jv: number;
  /** 岩体完整性系数 */
  kv: number;
  groundwater: Groundwater;
  /** 洞跨 m */
  spanWidth: number;
  /** 其它修正系数 */
  extraCorrection: number;
}

export interface GradeCalcResult {
  bq: number;
  correctedBq: number;
  kv: number;
  jv: number;
  grade: RockGrade;
  k1: number;
  k2: number;
  support: string;
  explanation: string[];
}

/** 出水状态 → 地下水修正系数 K1（简化取值） */
export const GROUNDWATER_K1: Record<Groundwater, number> = {
  干燥: 0,
  潮湿: 0.05,
  点滴状出水: 0.1,
  线状出水: 0.18,
  涌流状出水: 0.28,
};

/** 洞跨 → 主要软弱结构面修正系数 K2（简化取值） */
export function spanK2(spanWidth: number): number {
  if (spanWidth < 5) return 0;
  if (spanWidth < 10) return 0.03;
  if (spanWidth < 15) return 0.06;
  if (spanWidth < 20) return 0.1;
  return 0.15;
}

/** 由 [BQ] 映射围岩级别 */
export function gradeFromBq(correctedBq: number): RockGrade {
  if (correctedBq > 550) return 'Ⅰ';
  if (correctedBq > 450) return 'Ⅱ';
  if (correctedBq > 350) return 'Ⅲ';
  if (correctedBq > 250) return 'Ⅳ';
  if (correctedBq > 150) return 'Ⅴ';
  return 'Ⅵ';
}

/** 纯计算：BQ / [BQ] / 级别 / 支护建议 / 计算过程 */
export function calcGrade(input: GradeCalcInput, autoJv = 0): GradeCalcResult {
  const { rockStrength, rqd, kv, groundwater, spanWidth, extraCorrection } = input;
  const jv = input.jv > 0 ? input.jv : autoJv;
  // 基本质量指标：BQ = 90 + 3σc + 250Kv
  const bq = round(90 + 3 * rockStrength + 250 * kv, 1);
  const k1 = GROUNDWATER_K1[groundwater] ?? 0;
  const k2 = spanK2(spanWidth);
  const correction = round(k1 + k2 + extraCorrection, 3);
  // [BQ] = BQ - 100(K1 + K2 + K3)
  const correctedBq = round(bq - 100 * correction, 1);
  const grade = gradeFromBq(correctedBq);
  const explanation = [
    `BQ = 90 + 3×${rockStrength} MPa + 250×${kv} = ${bq}`,
    `修正系数 K1（${groundwater}）= ${k1}，K2（洞跨 ${spanWidth} m）= ${k2}，其它 = ${extraCorrection}`,
    `[BQ] = ${bq} − 100×${correction} = ${correctedBq}`,
    `由 [BQ] 区间映射：>550 为 Ⅰ 级，451~550 为 Ⅱ 级，351~450 为 Ⅲ 级，251~350 为 Ⅳ 级，151~250 为 Ⅴ 级，≤150 为 Ⅵ 级`,
    `RQD = ${rqd} %，Jv = ${jv || '—'} 条/m³，Kv = ${kv}`,
  ];
  return { bq, correctedBq, kv, jv, grade, k1, k2, support: GRADE_SUPPORT[grade], explanation };
}
