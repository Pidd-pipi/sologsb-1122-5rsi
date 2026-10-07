import Dexie, { type Table } from 'dexie';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import { newId } from './id';
import { buildBasis, fingerprintOf, recalcGrade } from './gradeBasis';
import { GRADE_SUPPORT } from '../types/grade';

export const DB_NAME = 'gbtunnelface';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbtunnelface:db-version';

class TunnelFaceDB extends Dexie {
  faces!: Table<TunnelFace, string>;
  joints!: Table<JointSet, string>;
  grades!: Table<RockMassGrade, string>;
  waters!: Table<WaterInflow, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      faces: 'id, faceNo, chainage, lithology, excavationMethod, recordedAt',
      joints: 'id, faceId, setNo, dipDirection, dipAngle',
      grades: 'id, faceId, grade, judgedAt',
      waters: 'id, faceId, chainage, type',
    });
    this.version(2)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial',
        grades: 'id, faceId, grade, judgedAt, bqValue',
        waters: 'id, faceId, chainage, type, changeTrend',
      })
      .upgrade(async (tx) => {
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (!row.attitude) row.attitude = { strike: 0, dipDirection: 0, dipAngle: 0 };
            if (row.mileageRange === undefined) row.mileageRange = [row.chainage ?? 0, row.chainage ?? 0];
          });
        await tx
          .table('grades')
          .toCollection()
          .modify((row: any) => {
            if (row.correctedBq === undefined) row.correctedBq = row.bqValue ?? 0;
            if (row.manualAdjusted === undefined) row.manualAdjusted = false;
          });
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (row.chainage === undefined) row.chainage = 0;
          });
      });
    this.version(3)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial',
        grades: 'id, faceId, grade, judgedAt, bqValue, status',
        waters: 'id, faceId, chainage, type, changeTrend',
      })
      .upgrade(async (tx) => {
        // 乐观锁字段：所有表补 rev / updatedAt
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = row.recordedAt ?? Date.now();
          });
        await tx
          .table('joints')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = Date.now();
          });
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = row.measuredAt ?? Date.now();
          });

        // 老判定：无依据摘要的，按当前掌子面/节理/涌水数据补一份，并标待复核
        const faces = await tx.table<TunnelFace, string>('faces').toArray();
        const joints = await tx.table<JointSet, string>('joints').toArray();
        const waters = await tx.table<WaterInflow, string>('waters').toArray();
        await tx
          .table<RockMassGrade, string>('grades')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = row.judgedAt ?? Date.now();
            if (row.extraCorrection === undefined) row.extraCorrection = 0;

            const face = faces.find((f) => f.id === row.faceId);
            if (face) {
              const faceJoints = joints.filter((j) => j.faceId === face.id);
              const faceWaters = waters.filter((w) => w.faceId === face.id);
              if (!row.basis || !row.basisFingerprint) {
                const recalced = recalcGrade({
                  face,
                  joints: faceJoints,
                  waters: faceWaters,
                  previous: row,
                });
                row.basis = recalced.basis;
                row.basisFingerprint = recalced.basisFingerprint;
                // 级别与指标按现有数据补算，支护建议同步，提示地质员复核
                row.grade = recalced.grade;
                row.bqValue = recalced.bqValue;
                row.correctedBq = recalced.correctedBq;
                row.correction = recalced.correction;
                row.jv = recalced.jv;
                row.groundwater = recalced.groundwater;
                row.spanWidth = recalced.spanWidth;
                row.supportSuggestion = GRADE_SUPPORT[recalced.grade];
                row.status = 'pending';
                row.staleReason = '历史数据补录：按现有节理/涌水数据补算，请复核';
              } else {
                row.status = row.status ?? 'active';
              }
            } else {
              row.status = row.status ?? 'active';
            }
          });
      });
  }
}

export const db = new TunnelFaceDB();

/**
 * 把 Vue 响应式代理转成可结构化克隆的普通对象。
 * IndexedDB 的 put/add 无法克隆 Proxy，否则抛 DataCloneError。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入灌入示范掌子面数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.faces.count();
  if (count > 0) return;

  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const face1 = newId('face');
  const face2 = newId('face');

  const faces: TunnelFace[] = [
    {
      id: face1,
      faceNo: 'ZK-102',
      chainage: 12480,
      mileageRange: [12480, 12483],
      excavationMethod: '台阶法',
      faceSize: '12.6×9.8',
      lithology: '石灰岩',
      weathering: '微风化',
      rockStrength: 62,
      attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
      recordedAt: now - 2 * day,
      geologist: '岑柏川',
      rev: 1,
      updatedAt: now - 2 * day,
    },
    {
      id: face2,
      faceNo: 'ZK-103',
      chainage: 12483,
      mileageRange: [12483, 12486],
      excavationMethod: '台阶法',
      faceSize: '12.6×9.8',
      lithology: '泥岩',
      weathering: '强风化',
      rockStrength: 18,
      attitude: { strike: 48, dipDirection: 138, dipAngle: 28 },
      recordedAt: now - 6 * hour,
      geologist: '岑柏川',
      rev: 1,
      updatedAt: now - 6 * hour,
    },
  ];

  const joints: JointSet[] = [
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 1,
      dipDirection: 128,
      dipAngle: 72,
      spacing: 42,
      persistence: 3.6,
      aperture: 1.2,
      fillMaterial: '方解石',
      roughness: '粗糙',
      waterWet: '潮湿',
      jointCount: 9,
      rev: 1,
      updatedAt: now - 2 * day,
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 2,
      dipDirection: 216,
      dipAngle: 46,
      spacing: 68,
      persistence: 2.4,
      aperture: 0.6,
      fillMaterial: '泥质',
      roughness: '平整',
      waterWet: '滴水',
      jointCount: 5,
      rev: 1,
      updatedAt: now - 2 * day,
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 3,
      dipDirection: 312,
      dipAngle: 84,
      spacing: 25,
      persistence: 4.1,
      aperture: 2.4,
      fillMaterial: '无',
      roughness: '起伏粗糙',
      waterWet: '干燥',
      jointCount: 12,
      rev: 1,
      updatedAt: now - 2 * day,
    },
    {
      id: newId('joint'),
      faceId: face2,
      setNo: 1,
      dipDirection: 140,
      dipAngle: 22,
      spacing: 120,
      persistence: 5.2,
      aperture: 3.1,
      fillMaterial: '泥质',
      roughness: '平直光滑',
      waterWet: '线流',
      jointCount: 4,
      rev: 1,
      updatedAt: now - 6 * hour,
    },
  ];

  const waters: WaterInflow[] = [
    {
      id: newId('water'),
      faceId: face1,
      position: '拱顶右侧 3 m',
      type: '滴水',
      estimatedFlow: 6,
      waterTemp: 14,
      waterPressure: 0.12,
      changeTrend: '稳定',
      measuredAt: now - 2 * day,
      chainage: 12478,
      rev: 1,
      updatedAt: now - 2 * day,
    },
    {
      id: newId('water'),
      faceId: face1,
      position: '拱腰右侧',
      type: '线流',
      estimatedFlow: 22,
      waterTemp: 15,
      waterPressure: 0.32,
      changeTrend: '增大',
      measuredAt: now - day,
      chainage: 12481,
      rev: 1,
      updatedAt: now - day,
    },
    {
      id: newId('water'),
      faceId: face1,
      position: '拱脚左侧',
      type: '股状',
      estimatedFlow: 68,
      waterTemp: 16,
      waterPressure: 0.58,
      changeTrend: '突增',
      measuredAt: now - 4 * hour,
      chainage: 12484,
      rev: 1,
      updatedAt: now - 4 * hour,
    },
  ];

  // 示范判定按当前掌子面/节理/涌水生成依据摘要，保证级别随编录可校验
  const face1Joints = joints.filter((j) => j.faceId === face1);
  const face1Waters = waters.filter((w) => w.faceId === face1);
  const basis = buildBasis(faces[0], face1Joints, face1Waters);
  const grades: RockMassGrade[] = [
    {
      id: newId('grade'),
      faceId: face1,
      grade: 'Ⅳ',
      bqValue: 428.5,
      rqd: 78,
      jv: 2.6,
      kv: 0.61,
      groundwater: '涌流状出水',
      spanWidth: 12.6,
      correction: 0.34,
      correctedBq: 394.5,
      extraCorrection: 0,
      supportSuggestion: GRADE_SUPPORT['Ⅳ'],
      manualAdjusted: false,
      judgedAt: now - 4 * hour,
      basis,
      basisFingerprint: fingerprintOf(basis.source),
      status: 'pending',
      staleReason: '示范数据：按最新涌水（股状 68 L/min）自动重算，请复核',
      recalculatedFromId: undefined,
      rev: 1,
      updatedAt: now - 4 * hour,
    },
  ];

  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, async () => {
    await db.faces.bulkPut(faces);
    await db.joints.bulkPut(joints);
    await db.grades.bulkPut(grades);
    await db.waters.bulkPut(waters);
  });
}
