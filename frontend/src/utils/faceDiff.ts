import type { TunnelFace, TunnelFaceDraft } from '../types/face';
import { attitudeText, formatChainage } from './geoMath';

/** 参与编辑与并发合并的掌子面字段 */
export const EDITABLE_FACE_FIELDS = [
  'faceNo',
  'chainage',
  'mileageRange',
  'excavationMethod',
  'faceSize',
  'lithology',
  'weathering',
  'rockStrength',
  'attitude',
  'geologist',
] as const;

export type EditableFaceField = (typeof EDITABLE_FACE_FIELDS)[number];

export const FACE_FIELD_LABELS: Record<EditableFaceField, string> = {
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

type FaceLike = Pick<TunnelFace, EditableFaceField> | TunnelFaceDraft;

/** 两个掌子面快照之间发生变化的字段列表 */
export function diffFaceFields(a: FaceLike, b: FaceLike): EditableFaceField[] {
  return EDITABLE_FACE_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
}

/** 字段值的人读文本，用于冲突提示 */
export function formatFaceField(field: EditableFaceField, value: unknown): string {
  switch (field) {
    case 'chainage':
      return formatChainage(Number(value));
    case 'mileageRange': {
      const range = value as [number, number];
      return `${formatChainage(range[0])} ~ ${formatChainage(range[1])}`;
    }
    case 'attitude': {
      const att = value as TunnelFace['attitude'];
      return `走向 ${att.strike}° · ${attitudeText(att.dipDirection, att.dipAngle)}`;
    }
    case 'rockStrength':
      return `${value} MPa`;
    case 'faceSize':
      return `${value} m`;
    default:
      return String(value ?? '');
  }
}
