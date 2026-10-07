<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import { useRemoteSync } from '../hooks/useRemoteSync';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import GradeTag from '../components/common/GradeTag.vue';
import FaceEditDialog from '../components/common/FaceEditDialog.vue';
import { GRADE_STATUS_LABEL, GRADE_SUPPORT, type RockMassGrade } from '../types/grade';
import type { TunnelFace } from '../types/face';
import { attitudeText, formatChainage } from '../utils/geoMath';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const liveGrades = computed(() => gradeStore.activeByFace(faceId.value));
const staleGrades = computed(() => gradeStore.staleByFace(faceId.value));
/** 当前级别：只取未失效记录（待复核计入但显著标注），旧失效级别不挂在详情上 */
const latest = computed<RockMassGrade | undefined>(() => liveGrades.value[0]);
const previousGrade = computed<RockMassGrade | undefined>(() => liveGrades.value[1]);
const newestStale = computed<RockMassGrade | undefined>(() => staleGrades.value[0]);
const isPending = computed(() => latest.value?.status === 'pending');
/** 旧判定已失效、尚未重算保存（此时只有 stale 记录） */
const awaitingRecalc = computed(() => !latest.value && !!newestStale.value);

const { result, patch } = useGradeCalc(() => joints.value);
const segmentCount = ref(0);
const editVisible = ref(false);
const editingFace = ref<TunnelFace | null>(null);

/** SketchCanvas 变更回调（用命名函数避免模板内联箭头参数丢类型） */
function onSketchChange(segs: { id: string }[]): void {
  segmentCount.value = segs.length;
}

function openEdit() {
  if (face.value) {
    editingFace.value = JSON.parse(JSON.stringify(face.value)) as TunnelFace;
    editVisible.value = true;
  }
}

/** 与上循环级别比对结论（只比对有效判定） */
const gradeCompare = computed(() => {
  if (!latest.value) return '本掌子面尚无有效级别判定记录';
  if (!previousGrade.value) return `本循环当前判定为 ${latest.value.grade} 级围岩`;
  const order = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const delta = order.indexOf(latest.value.grade) - order.indexOf(previousGrade.value.grade);
  if (delta === 0) return `与上一循环一致（${latest.value.grade} 级）`;
  return delta > 0
    ? `较上一循环变差 ${delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`
    : `较上一循环变好 ${-delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`;
});

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({ rockStrength: face.value.rockStrength, spanWidth: Number(face.value.faceSize.split('×')[0]) || 12 });
  }
});

useRemoteSync();
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面详情 · {{ face?.faceNo ?? '未找到' }}</h2>
      <GradeTag v-if="latest" :grade="latest.grade" />
      <el-tag v-if="isPending" type="warning">待复核</el-tag>
      <el-tag v-else-if="latest" type="success">有效</el-tag>
      <el-tag v-else-if="awaitingRecalc" type="danger">级别已失效 · 待重算</el-tag>
      <el-tag v-else type="info">未判定级别</el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
      <el-button @click="router.push(`/faces/${faceId}/water`)">涌水记录</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
      <el-button @click="openEdit">编辑掌子面</el-button>
      <el-button @click="router.push('/faces')">返回台账</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面（可能已被删除）" />

    <el-alert
      v-if="isPending && latest"
      type="warning"
      :closable="false"
      show-icon
      :title="`当前级别 ${latest.grade} 级为编录改动后自动重算，待地质员复核（${latest.staleReason ?? ''}）`"
      description="旧级别已失效，该重算结果计入台账但标注待复核；请到围岩级别判定页确认后转为有效。"
    >
      <div style="margin-top: 6px">
        <el-button size="small" type="primary" @click="router.push(`/grade/${faceId}`)">前往复核</el-button>
      </div>
    </el-alert>
    <el-alert
      v-else-if="awaitingRecalc"
      type="error"
      :closable="false"
      show-icon
      :title="`编录数据已改动，原 ${newestStale?.grade} 级判定已失效且不计入台账`"
      :description="`失效原因：${newestStale?.staleReason ?? '编录数据变化'}。请重算并保存新级别。`"
    >
      <div style="margin-top: 6px">
        <el-button size="small" type="primary" @click="router.push(`/grade/${faceId}`)">立即重算</el-button>
      </div>
    </el-alert>

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
          </el-descriptions>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>级别与支护</strong>
              <el-tag v-if="isPending" type="warning" size="small">待复核</el-tag>
              <el-tag v-else-if="latest" type="success" size="small">有效</el-tag>
              <el-tag v-else-if="awaitingRecalc" type="danger" size="small">已失效待重算</el-tag>
            </div>
          </template>
          <div v-if="latest" class="grade-box">
            <GradeTag :grade="latest.grade" />
            <span class="muted">[BQ] = {{ latest.correctedBq }}（BQ {{ latest.bqValue }}，修正 {{ latest.correction }}）</span>
            <p class="support">{{ latest.supportSuggestion || GRADE_SUPPORT[latest.grade] }}</p>
            <p class="muted">{{ gradeCompare }}</p>
            <el-divider style="margin: 8px 0" />
            <p class="basis-title">判定依据摘要</p>
            <p class="basis">掌子面：{{ latest.basis.faceSummary }}</p>
            <p class="basis">节理：{{ latest.basis.jointSummary }}</p>
            <p class="basis">涌水：{{ latest.basis.waterSummary }}</p>
            <p class="muted">
              依据指纹 {{ latest.basisFingerprint }} · {{ GRADE_STATUS_LABEL[latest.status] }}
              <template v-if="latest.staleReason">（{{ latest.staleReason }}）</template>
            </p>
          </div>
          <div v-else-if="awaitingRecalc">
            <p class="muted">
              原判定（<span class="stale-grade">{{ newestStale?.grade }} 级</span>，
              {{ newestStale?.supportSuggestion }}）已随编录改动失效，不计入台账。
            </p>
            <p class="muted">按当前参数实时试算（保存前不计入台账）：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
            <el-button size="small" type="primary" @click="router.push(`/grade/${faceId}`)">重算并保存</el-button>
          </div>
          <div v-else>
            <p class="muted">尚未判定级别，按当前参数实时试算：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
        </el-card>

        <el-card v-if="staleGrades.length" shadow="never">
          <template #header><strong>已失效历史判定（{{ staleGrades.length }} 条，不计入台账）</strong></template>
          <el-table :data="staleGrades" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.judgedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="旧级别" width="80">
              <template #default="{ row }"><span class="stale-grade">{{ row.grade }} 级</span></template>
            </el-table-column>
            <el-table-column prop="staleReason" label="失效原因" min-width="220" />
          </el-table>
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

    <FaceEditDialog v-model="editVisible" :face="editingFace" @saved="() => { editVisible = false; }" />
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
.basis-title {
  margin: 0;
  font-weight: 600;
  color: #2f3a46;
  font-size: 13px;
}
.basis {
  margin: 2px 0;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.6;
}
.stale-grade {
  color: #b0b6bf;
  text-decoration: line-through;
}
</style>
