import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import {
  GROUNDWATERS,
  type GradeBasisSnapshot,
  type GradeBasisSource,
  type Groundwater,
  type RockMassGrade,
  type RockGrade,
} from '../types/grade';
import { attitudeText, estimateJv } from './geoMath';
import { GROUNDWATER_K1, gradeFromBq, spanK2 } from './gradeCalc';

/** 涌水类型/渗水状态 → 判定页使用的出水状态（从严就高映射） */
export function inferGroundwater(waters: WaterInflow[], fallback: Groundwater): Groundwater {
  if (waters.length === 0) return fallback;
  const latest = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  const maxFlow = Math.max(...waters.map((w) => w.estimatedFlow));
  if (latest.type === '股状' || maxFlow >= 60) return '涌流状出水';
  if (latest.type === '线流' || maxFlow >= 20) return '线状出水';
  if (latest.type === '滴水' || maxFlow >= 1) return '点滴状出水';
  return '潮湿';
}

/** 节理组摘要 */
export function jointsSummary(joints: JointSet[]): string {
  if (joints.length === 0) return '无节理组记录';
  return joints
    .map(
      (j) =>
        `J${j.setNo} ${attitudeText(j.dipDirection, j.dipAngle)} 间距${j.spacing}cm ` +
        `${j.waterWet} ${j.jointCount}条`,
    )
    .join('；');
}

/** 涌水摘要 */
export function watersSummary(waters: WaterInflow[]): string {
  if (waters.length === 0) return '无涌水记录';
  const latest = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  const total = waters.reduce((s, w) => s + w.estimatedFlow, 0);
  return `最新 ${latest.position} ${latest.type} ${latest.estimatedFlow}L/min（${latest.changeTrend}）；共 ${waters.length} 条，合计 ${total}L/min`;
}

/** 掌子面参数摘要 */
export function faceSummary(face: TunnelFace): string {
  return `${face.lithology}/${face.weathering}，Rc ${face.rockStrength}MPa，断面 ${face.faceSize}m，产状 ${attitudeText(
    face.attitude.dipDirection,
    face.attitude.dipAngle,
  )}`;
}

/** 组装判定依据快照（摘要 + 指纹源） */
export function buildBasis(face: TunnelFace, joints: JointSet[], waters: WaterInflow[]): GradeBasisSnapshot {
  const source: GradeBasisSource = {
    face: {
      rockStrength: face.rockStrength,
      faceSize: face.faceSize,
      lithology: face.lithology,
      weathering: face.weathering,
      attitude: { ...face.attitude },
    },
    joints: joints.map((j) => ({
      setNo: j.setNo,
      dipDirection: j.dipDirection,
      dipAngle: j.dipAngle,
      spacing: j.spacing,
      persistence: j.persistence,
      aperture: j.aperture,
      fillMaterial: j.fillMaterial,
      roughness: j.roughness,
      waterWet: j.waterWet,
      jointCount: j.jointCount,
    })),
    waters: waters.map((w) => ({
      position: w.position,
      type: w.type,
      estimatedFlow: w.estimatedFlow,
      changeTrend: w.changeTrend,
      chainage: w.chainage,
    })),
  };
  return {
    faceSummary: faceSummary(face),
    jointSummary: jointsSummary(joints),
    waterSummary: watersSummary(waters),
    source,
  };
}

/** djb2 字符串哈希，输出 36 进制指纹 */
export function fingerprintOf(source: GradeBasisSource): string {
  const json = JSON.stringify(source);
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function basisFingerprint(basis: GradeBasisSnapshot): string {
  return fingerprintOf(basis.source);
}

export interface RecalcInput {
  face: TunnelFace;
  joints: JointSet[];
  waters: WaterInflow[];
  /** 被取代的原有效判定（沿用其 RQD/Kv/人工参数，无则给缺省） */
  previous?: RockMassGrade;
}

export interface RecalcResult {
  grade: RockGrade;
  bqValue: number;
  rqd: number;
  jv: number;
  kv: number;
  groundwater: Groundwater;
  spanWidth: number;
  correction: number;
  correctedBq: number;
  extraCorrection: number;
  basis: GradeBasisSnapshot;
  basisFingerprint: string;
}

/**
 * 纯计算：按当前掌子面/节理/涌水数据重算级别指标。
 * RQD/Kv/其它修正无法从编录反推，沿用上一次判定的输入；首次（老库迁移）给缺省。
 * 计算规则与判定页 useGradeCalc 保持一致。
 */
export function recalcGrade(input: RecalcInput): RecalcResult {
  const { face, joints, waters, previous } = input;
  const spanWidth = Number(face.faceSize.split('×')[0]) || previous?.spanWidth || 12;
  const rqd = previous?.rqd ?? 75;
  const kv = previous?.kv ?? 0.6;
  const extraCorrection = previous?.extraCorrection ?? 0;
  const jv = previous && previous.jv > 0 ? previous.jv : estimateJv(joints);
  const groundwater = inferGroundwater(waters, previous?.groundwater ?? '干燥');

  const bq = round1(90 + 3 * face.rockStrength + 250 * kv);
  const k1 = GROUNDWATER_K1[groundwater];
  const k2 = spanK2(spanWidth);
  const correction = round3(k1 + k2 + extraCorrection);
  const correctedBq = round1(bq - 100 * correction);
  const basis = buildBasis(face, joints, waters);

  return {
    grade: gradeFromBq(correctedBq),
    bqValue: bq,
    rqd,
    jv,
    kv,
    groundwater,
    spanWidth,
    correction,
    correctedBq,
    extraCorrection,
    basis,
    basisFingerprint: fingerprintOf(basis.source),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 判定页用：出水状态下拉里的合法值兜底 */
export function normalizeGroundwater(value: unknown): Groundwater {
  return GROUNDWATERS.includes(value as Groundwater) ? (value as Groundwater) : '干燥';
}
