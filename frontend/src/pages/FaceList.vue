<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useFaceFilter } from '../hooks/useFaceFilter';
import { useRemoteSync } from '../hooks/useRemoteSync';
import FaceCard from '../components/common/FaceCard.vue';
import FaceEditDialog from '../components/common/FaceEditDialog.vue';
import GradeTag from '../components/common/GradeTag.vue';
import { ROCK_GRADES } from '../types/grade';
import type { TunnelFaceDraft } from '../types/face';

const router = useRouter();
const faceStore = useFaceStore();
const gradeStore = useGradeStore();
const jointStore = useJointStore();
const { filters, result, options, gradeDistribution, reset } = useFaceFilter();

const dialogVisible = ref(false);
const initialDraft = ref<TunnelFaceDraft | null>(null);
const maxGradeCount = computed(() => Math.max(1, ...gradeDistribution.value.map((g) => g.count)));

function openDialog() {
  initialDraft.value = null;
  dialogVisible.value = true;
}

/** 复制上一循环（里程更小的最近一个掌子面）的信息 */
function copyPrevious() {
  const latest = faceStore.latest;
  if (!latest) {
    ElMessage.warning('暂无可复制的上一循环');
    return;
  }
  const draft = (faceStore.previousDraft(latest.id) ?? null) as TunnelFaceDraft | null;
  if (draft) {
    draft.chainage = latest.chainage + 3;
    draft.mileageRange = [latest.chainage + 3, latest.chainage + 6];
    draft.faceNo = `${latest.faceNo}-next`;
  }
  initialDraft.value = draft;
  dialogVisible.value = true;
  ElMessage.success(`已复制 ${latest.faceNo} 的编录信息，请修改编号与里程`);
}

onMounted(async () => {
  await faceStore.load();
  await gradeStore.load();
  await jointStore.load();
});

useRemoteSync();
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面台账</h2>
      <el-tag>共 {{ faceStore.items.length }} 个掌子面</el-tag>
      <el-tag type="info" effect="plain">筛选命中 {{ result.length }} 个</el-tag>
      <el-tag type="warning" effect="plain">
        待复核 {{ gradeStore.items.filter((g) => g.status === 'pending').length }} 条
      </el-tag>
      <div class="spacer" />
      <el-button @click="copyPrevious">复制上一循环</el-button>
      <el-button type="primary" @click="openDialog">新建编录</el-button>
    </div>

    <el-card shadow="never">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="里程区间">
          <el-input-number v-model="filters.chainageFrom" :min="0" :max="999999" :step="10" controls-position="right" style="width: 130px" />
          <span style="margin: 0 6px">—</span>
          <el-input-number v-model="filters.chainageTo" :min="0" :max="999999" :step="10" controls-position="right" style="width: 130px" />
        </el-form-item>
        <el-form-item label="岩性">
          <el-select v-model="filters.lithology" style="width: 140px">
            <el-option label="全部" value="all" />
            <el-option v-for="l in options.lithologies" :key="l" :label="l" :value="l" />
          </el-select>
        </el-form-item>
        <el-form-item label="围岩级别">
          <el-select v-model="filters.grade" style="width: 120px">
            <el-option label="全部" value="all" />
            <el-option v-for="g in ROCK_GRADES" :key="g" :label="`${g} 级`" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="开挖方式">
          <el-select v-model="filters.method" style="width: 130px">
            <el-option label="全部" value="all" />
            <el-option v-for="m in options.methods" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" placeholder="编号 / 地质员 / 岩性" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="dist-head">
          <strong>围岩级别分布</strong>
          <span class="muted">仅统计有效判定；待复核计入并单独标注；已失效（编录已改动、未重算）不计入</span>
        </div>
      </template>
      <div class="dist">
        <div v-for="item in gradeDistribution" :key="item.grade" class="dist-row">
          <GradeTag :grade="item.grade" />
          <div class="bar-wrap">
            <div class="bar" :style="{ width: `${(item.count / maxGradeCount) * 100}%` }" />
          </div>
          <span class="count">{{ item.count }} 个</span>
        </div>
      </div>
    </el-card>

    <div v-if="result.length === 0" class="empty">
      <el-empty description="没有符合条件的掌子面" />
    </div>
    <div v-else class="grid">
      <FaceCard
        v-for="row in result"
        :key="row.face.id"
        :face="row.face"
        :grade="row.grade"
        :grade-status="row.gradeStatus"
        :grade-reason="row.gradeReason"
        :joint-count="jointStore.byFace(row.face.id).length"
        :water-count="gradeStore.watersByFace(row.face.id).length"
        :footer="`编录时间 ${new Date(row.lastRecordedAt).toLocaleString('zh-CN')}`"
        @open="(id) => router.push(`/faces/${id}`)"
      />
    </div>

    <FaceEditDialog v-model="dialogVisible" :initial-draft="initialDraft" @saved="() => {}" />
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.empty {
  padding: 30px 0;
}
.dist-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.dist {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dist-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar-wrap {
  flex: 1;
  height: 14px;
  background: #f0f3f6;
  border-radius: 7px;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: linear-gradient(90deg, #7fbf9a, #2f8f5b);
}
.count {
  width: 70px;
  text-align: right;
  color: #5b6470;
  font-size: 13px;
}
.muted {
  color: #97a0ad;
  font-size: 12px;
}
</style>
