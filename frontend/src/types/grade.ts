/** 围岩级别 Ⅰ ~ Ⅵ */
export type RockGrade = 'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | 'Ⅴ' | 'Ⅵ';

export const ROCK_GRADES: RockGrade[] = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];

/** 出水状态 */
export type Groundwater = '干燥' | '潮湿' | '点滴状出水' | '线状出水' | '涌流状出水';

export const GROUNDWATERS: Groundwater[] = ['干燥', '潮湿', '点滴状出水', '线状出水', '涌流状出水'];

/**
 * 判定状态：
 * - active  有效（编录未变，级别仍可入账）
 * - pending 待复核：按新编录自动重算但尚未经地质员确认；计入台账但显著标注
 * - stale   已失效：编录已改动且尚未重算，旧级别与支护建议一律不计入台账
 */
export type GradeStatus = 'active' | 'pending' | 'stale';

export const GRADE_STATUS_LABEL: Record<GradeStatus, string> = {
  active: '有效',
  pending: '待复核',
  stale: '已失效',
};

/** 围岩级别判定记录 */
export interface RockMassGrade {
  id: string;
  faceId: string;
  grade: RockGrade;
  /** 基本质量指标 BQ */
  bqValue: number;
  /** 岩石质量指标 % */
  rqd: number;
  /** 节理体密度 条/m³ */
  jv: number;
  /** 岩体完整性系数 */
  kv: number;
  groundwater: Groundwater;
  /** 洞跨 m */
  spanWidth: number;
  /** 修正系数合计 */
  correction: number;
  /** 修正后的 [BQ] */
  correctedBq: number;
  /** 其它修正系数（人工在判定页填写的 K3） */
  extraCorrection: number;
  /** 支护建议 */
  supportSuggestion: string;
  /** 是否人工修正级别 */
  manualAdjusted: boolean;
  judgedAt: number;
  /** 判定时依据的节理/涌水/掌子面摘要 */
  basis: GradeBasisSnapshot;
  /** 判定时编录数据指纹；指纹变化即说明依据已变 */
  basisFingerprint: string;
  status: GradeStatus;
  /** 失效原因（status=stale 时填写，如「节理组改动」「涌水记录改动」） */
  staleReason?: string;
  /** 待复核/已失效判定由哪条有效判定重算而来 */
  recalculatedFromId?: string;
  /** 乐观锁版本号，每次保存 +1 */
  rev: number;
  /** 最近一次保存时间 */
  updatedAt: number;
}

export type RockMassGradeDraft = Omit<
  RockMassGrade,
  'id' | 'judgedAt' | 'rev' | 'updatedAt'
>;

/** 判定所依据的编录数据快照（摘要 + 指纹源） */
export interface GradeBasisSnapshot {
  /** 掌子面关键参数摘要 */
  faceSummary: string;
  /** 节理组摘要，如「J1 128°∠72° 间距42cm 9条；…」 */
  jointSummary: string;
  /** 涌水摘要，如「最新 拱脚左侧 股状 68 L/min（突增）；共 3 条」 */
  waterSummary: string;
  /** 指纹用的结构化源数据（不展示，用于比对） */
  source: GradeBasisSource;
}

/** 参与指纹计算的编录源数据：掌子面/节理/涌水任一变化都会改变指纹 */
export interface GradeBasisSource {
  face: {
    rockStrength: number;
    faceSize: string;
    lithology: string;
    weathering: string;
    attitude: { strike: number; dipDirection: number; dipAngle: number };
  };
  joints: Array<{
    setNo: number;
    dipDirection: number;
    dipAngle: number;
    spacing: number;
    persistence: number;
    aperture: number;
    fillMaterial: string;
    roughness: string;
    waterWet: string;
    jointCount: number;
  }>;
  waters: Array<{
    position: string;
    type: string;
    estimatedFlow: number;
    changeTrend: string;
    chainage: number;
  }>;
}

/** 级别色带（用于 <GradeTag>） */
export const GRADE_COLOR: Record<RockGrade, string> = {
  'Ⅰ': '#1f7a4d',
  'Ⅱ': '#3f9e63',
  'Ⅲ': '#c9a227',
  'Ⅳ': '#e08b2f',
  'Ⅴ': '#d3542f',
  'Ⅵ': '#a02622',
};

/** 等级对应的支护建议 */
export const GRADE_SUPPORT: Record<RockGrade, string> = {
  'Ⅰ': '局部锚杆（φ22，L=2.0 m，间距 1.5 m），喷射混凝土 5 cm',
  'Ⅱ': '系统锚杆（φ22，L=2.5 m，间距 1.2 m）+ 喷射混凝土 8 cm',
  'Ⅲ': '系统锚杆（φ25，L=3.0 m，间距 1.0 m）+ 喷射混凝土 12 cm + 钢筋网',
  'Ⅳ': '钢拱架（I16，间距 1.0 m）+ 系统锚杆（φ25，L=3.5 m）+ 喷射混凝土 20 cm',
  'Ⅴ': '超前小导管（φ42，L=4.5 m，环向间距 0.4 m）+ 钢拱架（I18，间距 0.75 m）+ 喷射混凝土 25 cm',
  'Ⅵ': '超前管棚（φ108，L=20 m）+ 钢拱架（I20b，间距 0.5 m）+ 双层钢筋网 + 喷射混凝土 30 cm，必要时超前预注浆',
};

/** 由涌水量与出水状态给出建议措施 */
export function waterMeasure(flow: number, type: string): string {
  if (flow >= 60 || type === '股状' || type === '涌流状出水') {
    return '立即停止掌子面作业，实施超前预注浆 + 径向注浆封堵，加强排水与监测';
  }
  if (flow >= 20) return '布设环向排水盲管 + 局部注浆堵水，加密涌水量监测频次';
  if (flow >= 5) return '设置纵向排水沟与集水坑，记录变化趋势，待喷锚后复测';
  return '常规排水，保持观察并纳入日常编录';
}
