<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import { useRemoteSync } from '../hooks/useRemoteSync';
import GradeTag from '../components/common/GradeTag.vue';
import ConflictDialog from '../components/common/ConflictDialog.vue';
import {
  GRADE_STATUS_LABEL,
  GROUNDWATERS,
  GRADE_SUPPORT,
  ROCK_GRADES,
  type Groundwater,
  type RockGrade,
  type RockMassGrade,
} from '../types/grade';
import { attitudeText, estimateJv, formatChainage } from '../utils/geoMath';
import { basisFingerprint, buildBasis, inferGroundwater } from '../utils/gradeBasis';
import { isConflictError, type ConflictInfo } from '../utils/concurrency';
import type { WaterInflow } from '../types/water';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const gradeStore = useGradeStore();
const jointStore = useJointStore();

const faceId = computed(() => String(route.params.faceId ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const waters = computed<WaterInflow[]>(() => gradeStore.watersByFace(faceId.value));
/** 历史判定（不含已失效），按时间倒序 */
const history = computed(() => gradeStore.activeByFace(faceId.value));
const staleHistory = computed(() => gradeStore.staleByFace(faceId.value));
const latest = computed<RockMassGrade | undefined>(() => history.value[0]);
/** 上一循环（倒数第二条未失效判定） */
const previous = computed<RockMassGrade | undefined>(() => history.value[1]);

const { input, result, patch } = useGradeCalc(() => joints.value);
const manual = ref(false);
const manualGrade = ref<RockGrade>('Ⅲ');

/** 打开页面时的判定基线（乐观锁用）；无判定时为 null */
const baseGrade = ref<RockMassGrade | null>(null);
const conflict = ref<ConflictInfo | null>(null);
const saving = ref(false);

const finalGrade = computed<RockGrade>(() => (manual.value ? manualGrade.value : result.value.grade));
const finalSupport = computed(() => GRADE_SUPPORT[finalGrade.value]);

const isPending = computed(() => latest.value?.status === 'pending');
const isStaleCycle = computed(() => !latest.value && staleHistory.value.length > 0);

/** 当前编录指纹 vs 页面打开时判定依据指纹：true 表示页面打开后编录又被改过 */
const basisChanged = computed(() => {
  if (!face.value) return false;
  const currentFp = basisFingerprint(buildBasis(face.value, joints.value, waters.value));
  return latest.value ? latest.value.basisFingerprint !== currentFp : false;
});

/** 由最新涌水推断的出水状态（供输入框提示） */
const inferredWater = computed<Groundwater>(() =>
  inferGroundwater(waters.value, input.value.groundwater),
);

/** 最新一条涌水摘要 */
const latestWaterText = computed(() => {
  if (waters.value.length === 0) return '';
  const w = [...waters.value].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  return `最新 ${w.position} ${w.type} ${w.estimatedFlow}L/min（${w.changeTrend}）`;
});

const compareText = computed(() => {
  if (!previous.value) return '本掌子面尚无更早的有效判定，保存后将成为当前循环的有效记录';
  const order = ROCK_GRADES;
  const delta = order.indexOf(finalGrade.value) - order.indexOf(previous.value.grade);
  if (delta === 0) return `与上循环级别一致（${previous.value.grade} 级）`;
  return delta > 0
    ? `较上循环变差 ${delta} 级：${previous.value.grade} → ${finalGrade.value}`
    : `较上循环变好 ${-delta} 级：${previous.value.grade} → ${finalGrade.value}`;
});

watch(
  () => result.value.grade,
  (g) => {
    manualGrade.value = g;
  },
  { immediate: true },
);

/** 把某条判定（多为待复核重算值）载入到输入区 */
function loadGradeIntoForm(g: RockMassGrade) {
  patch({
    rqd: g.rqd,
    jv: g.jv,
    kv: g.kv,
    groundwater: g.groundwater,
    spanWidth: g.spanWidth,
    extraCorrection: g.extraCorrection ?? 0,
  });
  if (face.value) {
    patch({
      rockStrength: face.value.rockStrength,
      spanWidth: Number(face.value.faceSize.split('×')[0]) || g.spanWidth,
    });
  }
  manual.value = g.manualAdjusted;
  manualGrade.value = g.grade;
}

async function save() {
  if (!face.value) {
    ElMessage.error('未找到该掌子面');
    return;
  }
  if (basisChanged.value) {
    ElMessage.warning('编录数据在本页打开后又被修改，请以最新实时计算结果核对后再保存');
  }
  saving.value = true;
  try {
    const basis = buildBasis(face.value, joints.value, waters.value);
    const { record, outcome } = await gradeStore.addGrade(
      {
        faceId: face.value.id,
        grade: finalGrade.value,
        bqValue: result.value.bq,
        rqd: input.value.rqd,
        jv: result.value.jv,
        kv: input.value.kv,
        groundwater: input.value.groundwater,
        spanWidth: input.value.spanWidth,
        correction: Number((result.value.k1 + result.value.k2 + input.value.extraCorrection).toFixed(3)),
        correctedBq: result.value.correctedBq,
        extraCorrection: input.value.extraCorrection,
        supportSuggestion: finalSupport.value,
        manualAdjusted: manual.value,
        basis,
        basisFingerprint: basisFingerprint(basis),
        status: 'active',
      },
      { base: baseGrade.value ?? undefined },
    );
    baseGrade.value = JSON.parse(JSON.stringify(record)) as RockMassGrade;
    ElMessage.success(
      outcome === 'merged-pending'
        ? `已确认重算结果并保存为 ${finalGrade.value} 级（待复核已转正）`
        : `已保存 ${finalGrade.value} 级围岩判定`,
    );
  } catch (e) {
    if (isConflictError(e)) {
      conflict.value = e.info;
    } else {
      ElMessage.error(e instanceof Error ? e.message : '保存失败');
    }
  } finally {
    saving.value = false;
  }
}

/** 仅确认待复核结果（不修改任何指标） */
async function confirmOnly() {
  if (!latest.value) return;
  try {
    const updated = await gradeStore.confirmReview(latest.value);
    baseGrade.value = JSON.parse(JSON.stringify(updated)) as RockMassGrade;
    ElMessage.success('待复核判定已确认为有效');
  } catch (e) {
    if (isConflictError(e)) conflict.value = e.info;
    else ElMessage.error(e instanceof Error ? e.message : '确认失败');
  }
}

async function reloadConflict() {
  if (!conflict.value) return;
  await gradeStore.load();
  const fresh = gradeStore.items.find((g) => g.id === conflict.value?.id);
  conflict.value = null;
  if (fresh && fresh.faceId === faceId.value) {
    baseGrade.value = JSON.parse(JSON.stringify(fresh)) as RockMassGrade;
    loadGradeIntoForm(fresh);
    ElMessage.warning('已载入对方刚保存的判定，请在此基础上核对后再保存');
  } else {
    baseGrade.value = null;
    ElMessage.info('对方的判定已不在本掌子面，请按当前实时结果重新保存');
  }
}

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({
      rockStrength: face.value.rockStrength,
      spanWidth: Number(face.value.faceSize.split('×')[0]) || 12,
    });
    // 有待复核/最新判定时，按其保存的输入项还原（涌水状态改用最新涌水推断提示）
    if (latest.value) {
      baseGrade.value = JSON.parse(JSON.stringify(latest.value)) as RockMassGrade;
      loadGradeIntoForm(latest.value);
    }
  }
});

useRemoteSync();
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>围岩级别判定 · {{ face?.faceNo ?? '未知' }}</h2>
      <GradeTag :grade="latest ? latest.grade : finalGrade" />
      <el-tag v-if="isPending" type="warning">待复核</el-tag>
      <el-tag v-else-if="latest" type="success">有效</el-tag>
      <el-tag v-else-if="isStaleCycle" type="danger">旧判定已失效 · 待重算</el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组 · 自动 Jv {{ estimateJv(joints) }}</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/faces/${faceId}`)">返回掌子面详情</el-button>
      <el-button @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面" />

    <el-alert
      v-if="isPending && latest"
      type="warning"
      :closable="false"
      show-icon
      :title="`该级别是编录改动后按新数据自动重算的（${latest.staleReason ?? '待复核'}），未经地质员确认前仅作参考`"
      description="请核对左侧指标与下方判定依据，确认无误后点「确认重算结果」；如需调整参数，修改后点「保存判定结果」即转正。"
    />
    <el-alert
      v-else-if="isStaleCycle"
      type="error"
      :closable="false"
      show-icon
      :title="`掌子面/节理/涌水已改动，旧级别（${staleHistory[0].grade} 级）已失效且不计入台账`"
      :description="`失效原因：${staleHistory[0].staleReason ?? '编录数据变化'}。请按下方实时结果重算并保存。`"
    />
    <el-alert
      v-if="basisChanged"
      type="info"
      :closable="false"
      show-icon
      title="本页打开后编录数据又被他人/其他页面修改，实时计算结果已更新，请核对后保存"
      style="margin-top: 8px"
    />

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>逐项指标输入</strong></template>
        <el-form label-width="150px">
          <el-form-item label="饱和抗压强度 Rc">
            <el-input-number v-model="input.rockStrength" :min="1" :max="300" :step="1" />
            <span class="hint">MPa</span>
          </el-form-item>
          <el-form-item label="岩石质量指标 RQD">
            <el-slider v-model="input.rqd" :min="0" :max="100" :step="1" style="width: 240px" />
            <span class="hint">{{ input.rqd }} %</span>
          </el-form-item>
          <el-form-item label="节理体密度 Jv">
            <el-input-number v-model="input.jv" :min="0" :max="60" :step="0.1" :precision="1" />
            <span class="hint">条/m³（0 表示按节理间距自动估算 {{ estimateJv(joints) }}）</span>
          </el-form-item>
          <el-form-item label="岩体完整性系数 Kv">
            <el-slider v-model="input.kv" :min="0" :max="1" :step="0.01" style="width: 240px" />
            <span class="hint">{{ input.kv }}</span>
          </el-form-item>
          <el-form-item label="出水状态">
            <el-select v-model="input.groundwater" style="width: 200px">
              <el-option v-for="g in GROUNDWATERS" :key="g" :label="g" :value="g" />
            </el-select>
            <span v-if="waters.length" class="hint">按最新涌水推断：{{ inferredWater }}</span>
          </el-form-item>
          <el-form-item label="洞跨">
            <el-input-number v-model="input.spanWidth" :min="1" :max="60" :step="0.5" />
            <span class="hint">m</span>
          </el-form-item>
          <el-form-item label="其它修正系数">
            <el-input-number v-model="input.extraCorrection" :min="0" :max="1" :step="0.01" :precision="2" />
          </el-form-item>
        </el-form>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>实时算得的级别与支护建议</strong></template>
          <div class="result">
            <GradeTag :grade="finalGrade" />
            <span class="muted">BQ = {{ result.bq }} · [BQ] = {{ result.correctedBq }}</span>
            <el-tag v-if="manual" type="warning" size="small">人工修正</el-tag>
          </div>
          <p class="support">{{ finalSupport }}</p>
          <el-checkbox v-model="manual">启用人工修正级别</el-checkbox>
          <el-radio-group v-if="manual" v-model="manualGrade" style="margin-top: 8px">
            <el-radio-button v-for="g in ROCK_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
          <el-divider />
          <p class="muted">{{ compareText }}</p>
          <el-button type="primary" :loading="saving" @click="save">保存判定结果</el-button>
          <el-button v-if="isPending" @click="confirmOnly">确认重算结果（转正）</el-button>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>判定依据摘要（节理 / 涌水 / 掌子面）</strong></template>
          <el-descriptions :column="1" border size="small" v-if="face">
            <el-descriptions-item label="掌子面">
              {{ face.faceNo }} · {{ formatChainage(face.chainage) }} ·
              {{ face.lithology }}/{{ face.weathering }} · Rc {{ face.rockStrength }} MPa ·
              断面 {{ face.faceSize }} m · {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="节理组（{{ joints.length }} 组）">
              {{ joints.length ? joints.map((j) => `J${j.setNo} ${attitudeText(j.dipDirection, j.dipAngle)} 间距${j.spacing}cm ${j.jointCount}条`).join('；') : '无节理组记录' }}
            </el-descriptions-item>
            <el-descriptions-item label="涌水（{{ waters.length }} 条）">
              {{ waters.length ? latestWaterText : '无涌水记录' }}
            </el-descriptions-item>
          </el-descriptions>
          <el-divider />
          <template v-if="latest">
            <p class="muted"><strong>本次已保存判定记录的依据：</strong></p>
            <p class="basis">掌子面：{{ latest.basis.faceSummary }}</p>
            <p class="basis">节理：{{ latest.basis.jointSummary }}</p>
            <p class="basis">涌水：{{ latest.basis.waterSummary }}</p>
            <p class="muted">依据指纹 {{ latest.basisFingerprint }} · 状态：{{ GRADE_STATUS_LABEL[latest.status] }}{{ latest.staleReason ? `（${latest.staleReason}）` : '' }}</p>
          </template>
          <p v-else class="muted">尚无保存过的判定；保存时将按当前编录生成依据摘要与指纹。</p>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>计算过程</strong></template>
          <ol class="steps">
            <li v-for="(line, i) in result.explanation" :key="i">{{ line }}</li>
          </ol>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>本掌子面历史判定（已失效不参与比对/台账）</strong></template>
          <el-table :data="history" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.judgedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="级别" width="80">
              <template #default="{ row }"><GradeTag :grade="row.grade" /></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'pending' ? 'warning' : 'success'" size="small">
                  {{ GRADE_STATUS_LABEL[row.status as 'pending' | 'active'] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="bqValue" label="BQ" width="80" />
            <el-table-column prop="correctedBq" label="[BQ]" width="80" />
            <el-table-column prop="groundwater" label="出水" width="110" />
            <el-table-column label="修正" width="70">
              <template #default="{ row }">{{ row.manualAdjusted ? '人工' : '自动' }}</template>
            </el-table-column>
            <el-table-column prop="staleReason" label="备注" min-width="180" />
          </el-table>
          <el-table v-if="staleHistory.length" :data="staleHistory" size="small" border style="margin-top: 8px">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.judgedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="旧级别" width="80">
              <template #default="{ row }"><span class="stale-grade">{{ row.grade }} 级</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default>
                <el-tag type="danger" size="small">已失效</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="staleReason" label="失效原因" min-width="220" />
          </el-table>
          <el-empty v-if="history.length === 0 && staleHistory.length === 0" description="尚无历史判定" :image-size="60" />
        </el-card>
      </div>
    </div>

    <ConflictDialog
      :conflict="conflict"
      entity-label="该掌子面的围岩级别判定"
      @reload="reloadConflict"
      @close="conflict = null"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 520px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.result {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.support {
  color: #2f3a46;
  margin: 6px 0;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.basis {
  margin: 4px 0;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.7;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
.steps {
  margin: 0;
  padding-left: 18px;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.9;
}
.stale-grade {
  color: #b0b6bf;
  text-decoration: line-through;
}
</style>
