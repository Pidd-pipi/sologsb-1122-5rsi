<script setup lang="ts">
import { computed } from 'vue';
import { formatDiffValue, type ConflictInfo } from '../../utils/concurrency';

const props = defineProps<{
  conflict: ConflictInfo | null;
  /** 实体中文名，如「掌子面」「节理组 J1」 */
  entityLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'reload'): void;
  (e: 'close'): void;
}>();

const visible = computed({
  get: () => props.conflict !== null,
  set: (v: boolean) => {
    if (!v) emit('close');
  },
});

const updatedText = computed(() =>
  props.conflict ? new Date(props.conflict.updatedAt).toLocaleString('zh-CN') : '',
);
</script>

<template>
  <el-dialog
    v-model="visible"
    title="保存冲突：对方刚改过这条记录"
    width="640px"
    :close-on-click-modal="false"
  >
    <el-alert
      type="error"
      :closable="false"
      show-icon
      :title="`${entityLabel ?? '该记录'}已被他人在 ${updatedText} 修改并保存，为避免覆盖对方刚录入的数据，本次保存未写入。`"
      style="margin-bottom: 12px"
    />
    <p class="tip">对方相对你打开页面时的版本改动了以下内容：</p>
    <el-table v-if="conflict && conflict.diffs.length" :data="conflict.diffs" size="small" border max-height="280">
      <el-table-column prop="label" label="字段" width="130" />
      <el-table-column label="你打开时的值" min-width="160">
        <template #default="{ row }">
          <span class="old">{{ formatDiffValue(row.before) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="对方刚保存的值" min-width="160">
        <template #default="{ row }">
          <span class="new">{{ formatDiffValue(row.after) }}</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty
      v-else
      description="对方仅重新保存了一次，字段内容未变"
      :image-size="60"
    />
    <p class="tip muted">
      请点击「载入对方最新数据」在最新版本基础上继续；如确需保留你的改动，请先记下本页内容，载入后再补录。
    </p>
    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" @click="emit('reload')">载入对方最新数据</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tip {
  margin: 6px 0;
  color: #5b6470;
  font-size: 13px;
}
.muted {
  color: #97a0ad;
}
.old {
  color: #97a0ad;
  text-decoration: line-through;
  word-break: break-all;
}
.new {
  color: #1f4f8a;
  font-weight: 600;
  word-break: break-all;
}
</style>
