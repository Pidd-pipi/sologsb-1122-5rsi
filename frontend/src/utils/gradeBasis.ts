import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import { attitudeText } from './geoMath';

/** 判定依据：稳定指纹 + 可读的节理涌水摘要 */
export interface GradeBasis {
  hash: string;
  summary: string;
}

/** cyrb53 哈希，把依据序列化成稳定指纹 */
function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * 计算围岩级别判定依据：把掌子面关键参数、节理组、涌水记录序列化为
 * 稳定指纹，并生成可读的节理涌水摘要。判定时随记录保存；之后掌子面、
 * 节理组或涌水任一改动都会改变指纹，旧判定立即失配失效。
 */
export function computeGradeBasis(face: TunnelFace, joints: JointSet[], waters: WaterInflow[]): GradeBasis {
  const js = [...joints].sort((a, b) => a.setNo - b.setNo || a.dipDirection - b.dipDirection);
  const ws = [...waters].sort((a, b) => a.chainage - b.chainage || a.position.localeCompare(b.position));
  const canonical = {
    face: [
      face.faceNo,
      face.chainage,
      face.mileageRange,
      face.excavationMethod,
      face.faceSize,
      face.lithology,
      face.weathering,
      face.rockStrength,
      face.attitude.strike,
      face.attitude.dipDirection,
      face.attitude.dipAngle,
      face.geologist,
    ],
    joints: js.map((j) => [
      j.setNo,
      j.dipDirection,
      j.dipAngle,
      j.spacing,
      j.persistence,
      j.aperture,
      j.fillMaterial,
      j.roughness,
      j.waterWet,
      j.jointCount,
    ]),
    waters: ws.map((w) => [w.position, w.type, w.estimatedFlow, w.waterTemp, w.waterPressure, w.changeTrend, w.chainage]),
  };

  const faceText = `${face.lithology}（${face.weathering}）Rc ${face.rockStrength} MPa · 断面 ${face.faceSize} m · 产状 ${attitudeText(face.attitude.dipDirection, face.attitude.dipAngle)}`;
  const jointText =
    js.length === 0
      ? '节理 0 组'
      : `节理 ${js.length} 组：${js
          .map((j) => `J${j.setNo} ${attitudeText(j.dipDirection, j.dipAngle)} 间距${j.spacing}cm ${j.jointCount}条 ${j.waterWet}`)
          .join('；')}`;
  let waterText = '涌水 0 条';
  if (ws.length > 0) {
    const total = ws.reduce((s, w) => s + w.estimatedFlow, 0);
    const peak = ws.reduce((m, w) => (w.estimatedFlow > m.estimatedFlow ? w : m), ws[0]);
    waterText = `涌水 ${ws.length} 条合计 ${total} L/min，最大 ${peak.estimatedFlow} L/min（${peak.type}·${peak.position}）`;
  }

  return {
    hash: hashText(JSON.stringify(canonical)),
    summary: `${faceText}｜${jointText}｜${waterText}`,
  };
}
