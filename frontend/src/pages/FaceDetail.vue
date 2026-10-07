<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import GradeTag from '../components/common/GradeTag.vue';
import { attitudeText, formatChainage } from '../utils/geoMath';
import { FACE_FIELD_LABELS, formatFaceField } from '../utils/faceDiff';
import { toPlain } from '../utils/db';
import { GRADE_SUPPORT } from '../types/grade';
import {
  EXCAVATION_METHODS,
  LITHOLOGIES,
  WEATHERINGS,
  type TunnelFace,
  type TunnelFaceDraft,
} from '../types/face';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const grades = computed(() => gradeStore.byFace(faceId.value));
/** 与现编录数据一致的有效判定；失效未重算时为空 */
const current = computed(() => gradeStore.currentByFace(faceId.value));
const latest = computed(() => grades.value[0]);
const previousGrade = computed(() => grades.value[1]);

const { result, patch } = useGradeCalc(() => joints.value);
const segmentCount = ref(0);

/** SketchCanvas 变更回调（用命名函数避免模板内联箭头参数丢类型） */
function onSketchChange(segs: { id: string }[]): void {
  segmentCount.value = segs.length;
}

/** 与上循环级别比对结论 */
const gradeCompare = computed(() => {
  if (!current.value) return '本掌子面尚无有效级别判定';
  if (!previousGrade.value) return `本掌子面首次判定为 ${current.value.grade} 级围岩`;
  const order = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const delta = order.indexOf(current.value.grade) - order.indexOf(previousGrade.value.grade);
  if (delta === 0) return `与上一循环一致（${current.value.grade} 级）`;
  return delta > 0
    ? `较上一循环变差 ${delta} 级：${previousGrade.value.grade} → ${current.value.grade}`
    : `较上一循环变好 ${-delta} 级：${previousGrade.value.grade} → ${current.value.grade}`;
});

async function confirmReview() {
  if (!current.value) return;
  await gradeStore.confirmReview(current.value.id);
  ElMessage.success(`已复核确认 ${current.value.grade} 级判定`);
}

/* ---------- 编辑编录（字段级合并，防并发覆盖） ---------- */

const editVisible = ref(false);
const editError = ref('');
const editForm = reactive<TunnelFaceDraft>({
  faceNo: '',
  chainage: 0,
  mileageRange: [0, 0],
  excavationMethod: '台阶法',
  faceSize: '',
  lithology: '石灰岩',
  weathering: '微风化',
  rockStrength: 55,
  attitude: { strike: 0, dipDirection: 0, dipAngle: 0 },
  geologist: '',
});
/** 打开表单时的快照，作为合并基准 */
let editBase: TunnelFace | null = null;

function openEdit() {
  if (!face.value) return;
  editBase = toPlain(face.value);
  const f = face.value;
  editForm.faceNo = f.faceNo;
  editForm.chainage = f.chainage;
  editForm.mileageRange = [...f.mileageRange];
  editForm.excavationMethod = f.excavationMethod;
  editForm.faceSize = f.faceSize;
  editForm.lithology = f.lithology;
  editForm.weathering = f.weathering;
  editForm.rockStrength = f.rockStrength;
  editForm.attitude = { ...f.attitude };
  editForm.geologist = f.geologist;
  editError.value = '';
  editVisible.value = true;
}

async function submitEdit() {
  editError.value = '';
  if (!face.value || !editBase) return;
  if (!editForm.faceNo.trim()) {
    editError.value = '掌子面编号必填';
    return;
  }
  if (faceStore.items.some((it) => it.id !== face.value!.id && it.faceNo === editForm.faceNo.trim())) {
    editError.value = '掌子面编号已被其它掌子面使用';
    return;
  }
  if (editForm.mileageRange[1] < editForm.mileageRange[0]) {
    editError.value = '编录里程区间终点不能小于起点';
    return;
  }
  if (editForm.rockStrength <= 0 || editForm.rockStrength > 300) {
    editError.value = '饱和抗压强度需在 0 ~ 300 MPa 之间';
    return;
  }
  const res = await faceStore.mergeUpdate(face.value.id, toPlain(editForm), editBase);
  editVisible.value = false;
  const appliedText = res.applied.map((f) => FACE_FIELD_LABELS[f]).join('、');
  if (res.conflicts.length > 0) {
    // 对方先保存了同一掌子面：逐字段告知对方刚改过哪里，且未覆盖对方数据
    const lines = res.conflicts.map(
      (c) =>
        `<b>${FACE_FIELD_LABELS[c.field]}</b>：对方已改为「${formatFaceField(c.field, c.theirs)}」，` +
        `你填的「${formatFaceField(c.field, c.mine)}」未保存`,
    );
    await ElMessageBox.alert(lines.join('<br/>'), '对方刚修改过该掌子面，以下字段未覆盖', {
      type: 'warning',
      dangerouslyUseHTMLString: true,
      confirmButtonText: '知道了',
    }).catch(() => {});
    if (res.applied.length > 0) ElMessage.success(`已保存你的修改：${appliedText}`);
  } else if (res.applied.length > 0) {
    ElMessage.success(`已保存修改：${appliedText}`);
  } else {
    ElMessage.info('没有需要保存的修改');
  }
}

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({ rockStrength: face.value.rockStrength, spanWidth: Number(face.value.faceSize.split('×')[0]) || 12 });
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面详情 · {{ face?.faceNo ?? '未找到' }}</h2>
      <GradeTag v-if="current" :grade="current.grade" />
      <el-tag v-else-if="latest" type="warning">级别已失效，待重算</el-tag>
      <el-tag v-else type="info">未判定级别</el-tag>
      <el-tag v-if="current?.needsReview" type="warning" effect="plain">待复核</el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openEdit">编辑编录</el-button>
      <el-button @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
      <el-button @click="router.push(`/faces/${faceId}/water`)">涌水记录</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
      <el-button @click="router.push('/faces')">返回台账</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面（可能已被删除）" />

    <div v-if="face" class="grid">
      <div class="left">
        <el-card shadow="never">
          <template #header><strong>基本信息</strong></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="掌子面编号">{{ face.faceNo }}</el-descriptions-item>
            <el-descriptions-item label="里程桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="编录里程区间">
              {{ formatChainage(face.mileageRange[0]) }} ~ {{ formatChainage(face.mileageRange[1]) }}
            </el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="开挖断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩性 / 风化">{{ face.lithology }} / {{ face.weathering }}</el-descriptions-item>
            <el-descriptions-item label="饱和抗压强度">{{ face.rockStrength }} MPa</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              走向 {{ face.attitude.strike }}° · {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
            <el-descriptions-item label="编录时间">
              {{ new Date(face.recordedAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="数据版本">
              rev.{{ face.rev }} · 更新于 {{ new Date(face.updatedAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>级别与支护</strong></template>
          <div v-if="current" class="grade-box">
            <div class="grade-line">
              <GradeTag :grade="current.grade" />
              <el-tag v-if="current.needsReview" type="warning" size="small">待复核</el-tag>
              <el-tag v-if="current.recalculatedFrom" type="primary" effect="plain" size="small">自动重算</el-tag>
              <el-button v-if="current.needsReview" size="small" type="warning" @click="confirmReview">
                复核确认
              </el-button>
            </div>
            <span class="muted">[BQ] = {{ current.correctedBq }}（BQ {{ current.bqValue }}，修正 {{ current.correction }}）</span>
            <p class="support">{{ current.supportSuggestion || GRADE_SUPPORT[current.grade] }}</p>
            <p class="muted">{{ gradeCompare }}</p>
            <el-tooltip :content="current.basisSummary" placement="top" :show-after="200">
              <p class="basis">判定依据：{{ current.basisSummary }}</p>
            </el-tooltip>
          </div>
          <div v-else-if="latest">
            <el-alert
              type="warning"
              :closable="false"
              show-icon
              title="编录数据已变化，原级别判定失效"
              description="重算完成前该掌子面级别不计入台账；以下为按当前参数实时试算。"
            />
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
          <div v-else>
            <p class="muted">尚未判定级别，按当前参数实时试算：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>节理组列表（{{ joints.length }} 组）</strong></template>
          <el-table :data="joints" size="small" border>
            <el-table-column label="组号" width="70">
              <template #default="{ row }">J{{ row.setNo }}</template>
            </el-table-column>
            <el-table-column label="产状" width="140">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column prop="spacing" label="间距 cm" width="90" />
            <el-table-column prop="persistence" label="延伸 m" width="90" />
            <el-table-column prop="aperture" label="张开 mm" width="90" />
            <el-table-column prop="fillMaterial" label="充填" width="90" />
            <el-table-column prop="waterWet" label="渗水" width="90" />
            <el-table-column prop="jointCount" label="条数" width="80" />
          </el-table>
          <el-empty v-if="joints.length === 0" description="暂无节理组记录" :image-size="60" />
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>岩性素描图</strong>
            <span class="muted">已布置 {{ segmentCount }} 条结构面线段（自动保存在浏览器本地）</span>
          </div>
        </template>
        <SketchCanvas
          :face-id="face.id"
          :lithology="face.lithology"
          :attitude="face.attitude"
          @change="onSketchChange"
        />
      </el-card>
    </div>

    <el-dialog v-model="editVisible" title="编辑掌子面编录" width="700px">
      <el-alert v-if="editError" :title="editError" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="字段级合并保存：若他人同时修改了同一掌子面，只写入你改过的字段，不覆盖对方数据"
        style="margin-bottom: 10px"
      />
      <el-form :model="editForm" label-width="120px">
        <el-form-item label="掌子面编号" required>
          <el-input v-model="editForm.faceNo" />
        </el-form-item>
        <el-form-item label="里程桩号 m">
          <el-input-number v-model="editForm.chainage" :min="0" :max="999999" :step="1" />
          <span class="hint">{{ formatChainage(editForm.chainage) }}</span>
        </el-form-item>
        <el-form-item label="编录里程区间 m">
          <el-input-number v-model="editForm.mileageRange[0]" :min="0" :max="999999" />
          <span style="margin: 0 6px">—</span>
          <el-input-number v-model="editForm.mileageRange[1]" :min="0" :max="999999" />
        </el-form-item>
        <el-form-item label="开挖方式">
          <el-select v-model="editForm.excavationMethod">
            <el-option v-for="m in EXCAVATION_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="开挖断面尺寸 m">
          <el-input v-model="editForm.faceSize" placeholder="宽×高，如 12.6×9.8" />
        </el-form-item>
        <el-form-item label="岩性">
          <el-select v-model="editForm.lithology">
            <el-option v-for="l in LITHOLOGIES" :key="l" :label="l" :value="l" />
          </el-select>
        </el-form-item>
        <el-form-item label="风化程度">
          <el-select v-model="editForm.weathering">
            <el-option v-for="w in WEATHERINGS" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="饱和抗压强度">
          <el-input-number v-model="editForm.rockStrength" :min="1" :max="300" :step="1" />
          <span class="hint">MPa</span>
        </el-form-item>
        <el-form-item label="岩层产状">
          <span class="hint">走向</span>
          <el-input-number v-model="editForm.attitude.strike" :min="0" :max="360" />
          <span class="hint">倾向</span>
          <el-input-number v-model="editForm.attitude.dipDirection" :min="0" :max="360" />
          <span class="hint">倾角</span>
          <el-input-number v-model="editForm.attitude.dipAngle" :min="0" :max="90" />
        </el-form-item>
        <el-form-item label="地质员">
          <el-input v-model="editForm.geologist" style="width: 200px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存编录</el-button>
      </template>
    </el-dialog>
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
  grid-template-columns: 620px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.support {
  margin: 8px 0;
  color: #2f3a46;
}
.grade-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grade-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.basis {
  margin: 4px 0 0;
  color: #97a0ad;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
</style>
