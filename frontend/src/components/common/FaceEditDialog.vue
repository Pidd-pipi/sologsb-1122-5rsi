<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../../stores/faceStore';
import { isConflictError, type ConflictInfo } from '../../utils/concurrency';
import {
  EXCAVATION_METHODS,
  LITHOLOGIES,
  WEATHERINGS,
  type TunnelFace,
  type TunnelFaceDraft,
} from '../../types/face';
import { formatChainage } from '../../utils/geoMath';
import ConflictDialog from './ConflictDialog.vue';

const props = defineProps<{
  modelValue: boolean;
  /** 传入掌子面为编辑模式，否则为新建 */
  face?: TunnelFace | null;
  /** 新建时的初始草稿（复制上一循环） */
  initialDraft?: TunnelFaceDraft | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved', record: TunnelFace): void;
}>();

const faceStore = useFaceStore();
const error = ref('');
const base = ref<TunnelFace | null>(null);
const conflict = ref<ConflictInfo | null>(null);

const emptyDraft = (): TunnelFaceDraft => ({
  faceNo: '',
  chainage: 12486,
  mileageRange: [12486, 12489],
  excavationMethod: '台阶法',
  faceSize: '12.6×9.8',
  lithology: '石灰岩',
  weathering: '微风化',
  rockStrength: 55,
  attitude: { strike: 45, dipDirection: 135, dipAngle: 30 },
  geologist: '',
});

const form = reactive<TunnelFaceDraft>(emptyDraft());

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    error.value = '';
    conflict.value = null;
    if (props.face) {
      // 编辑：记下打开时的完整快照作为乐观锁基线
      base.value = JSON.parse(JSON.stringify(props.face)) as TunnelFace;
      Object.assign(form, {
        faceNo: props.face.faceNo,
        chainage: props.face.chainage,
        mileageRange: [...props.face.mileageRange] as [number, number],
        excavationMethod: props.face.excavationMethod,
        faceSize: props.face.faceSize,
        lithology: props.face.lithology,
        weathering: props.face.weathering,
        rockStrength: props.face.rockStrength,
        attitude: { ...props.face.attitude },
        geologist: props.face.geologist,
      });
    } else {
      base.value = null;
      Object.assign(form, emptyDraft());
      if (props.initialDraft) {
        Object.assign(form, JSON.parse(JSON.stringify(props.initialDraft)) as TunnelFaceDraft);
      }
    }
  },
);

function close() {
  emit('update:modelValue', false);
}

async function submit() {
  error.value = '';
  if (!form.faceNo.trim()) {
    error.value = '掌子面编号必填';
    return;
  }
  const duplicate = faceStore.items.find(
    (it) => it.faceNo === form.faceNo.trim() && it.id !== base.value?.id,
  );
  if (duplicate) {
    error.value = '掌子面编号已存在，请更换';
    return;
  }
  if (form.mileageRange[1] < form.mileageRange[0]) {
    error.value = '编录里程区间终点不能小于起点';
    return;
  }
  if (form.rockStrength <= 0 || form.rockStrength > 300) {
    error.value = '饱和抗压强度需在 0 ~ 300 MPa 之间';
    return;
  }

  try {
    let saved: TunnelFace;
    if (base.value) {
      saved = await faceStore.update(
        base.value.id,
        { ...form, faceNo: form.faceNo.trim() },
        base.value,
      );
      ElMessage.success(`已保存掌子面「${saved.faceNo}」的修改`);
    } else {
      saved = await faceStore.add({ ...form, faceNo: form.faceNo.trim() });
      ElMessage.success(`已建立掌子面「${saved.faceNo}」`);
    }
    emit('saved', saved);
    close();
  } catch (e) {
    if (isConflictError(e)) {
      conflict.value = e.info;
    } else {
      error.value = e instanceof Error ? e.message : '保存失败';
    }
  }
}

async function reloadConflict() {
  if (!conflict.value) return;
  await faceStore.load();
  const fresh = faceStore.byId(conflict.value.id);
  conflict.value = null;
  if (fresh) {
    // 以对方最新数据替换基线与表单，用户在最新版本上继续编辑
    base.value = JSON.parse(JSON.stringify(fresh)) as TunnelFace;
    Object.assign(form, {
      faceNo: fresh.faceNo,
      chainage: fresh.chainage,
      mileageRange: [...fresh.mileageRange] as [number, number],
      excavationMethod: fresh.excavationMethod,
      faceSize: fresh.faceSize,
      lithology: fresh.lithology,
      weathering: fresh.weathering,
      rockStrength: fresh.rockStrength,
      attitude: { ...fresh.attitude },
      geologist: fresh.geologist,
    });
    ElMessage.warning('已载入对方最新数据，请在此基础上核对后再保存');
  } else {
    ElMessage.error('该掌子面已被对方删除');
    close();
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="face ? `编辑掌子面 · ${face.faceNo}` : '新建掌子面编录'"
    width="700px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
    <el-alert
      v-if="face"
      type="info"
      :closable="false"
      show-icon
      title="编辑保存后，该掌子面的既有围岩级别将立即失效并按新数据重算（待复核）"
      style="margin-bottom: 10px"
    />
    <el-form :model="form" label-width="120px">
      <el-form-item label="掌子面编号" required>
        <el-input v-model="form.faceNo" placeholder="如 ZK-104" />
      </el-form-item>
      <el-form-item label="里程桩号 m">
        <el-input-number v-model="form.chainage" :min="0" :max="999999" :step="1" />
        <span class="hint">{{ formatChainage(form.chainage) }}</span>
      </el-form-item>
      <el-form-item label="编录里程区间 m">
        <el-input-number v-model="form.mileageRange[0]" :min="0" :max="999999" />
        <span style="margin: 0 6px">—</span>
        <el-input-number v-model="form.mileageRange[1]" :min="0" :max="999999" />
      </el-form-item>
      <el-form-item label="开挖方式">
        <el-select v-model="form.excavationMethod">
          <el-option v-for="m in EXCAVATION_METHODS" :key="m" :label="m" :value="m" />
        </el-select>
      </el-form-item>
      <el-form-item label="开挖断面尺寸 m">
        <el-input v-model="form.faceSize" placeholder="宽×高，如 12.6×9.8" />
      </el-form-item>
      <el-form-item label="岩性">
        <el-select v-model="form.lithology">
          <el-option v-for="l in LITHOLOGIES" :key="l" :label="l" :value="l" />
        </el-select>
      </el-form-item>
      <el-form-item label="风化程度">
        <el-select v-model="form.weathering">
          <el-option v-for="w in WEATHERINGS" :key="w" :label="w" :value="w" />
        </el-select>
      </el-form-item>
      <el-form-item label="饱和抗压强度">
        <el-input-number v-model="form.rockStrength" :min="1" :max="300" :step="1" />
        <span class="hint">MPa</span>
      </el-form-item>
      <el-form-item label="岩层产状">
        <span class="hint">走向</span>
        <el-input-number v-model="form.attitude.strike" :min="0" :max="360" />
        <span class="hint">倾向</span>
        <el-input-number v-model="form.attitude.dipDirection" :min="0" :max="360" />
        <span class="hint">倾角</span>
        <el-input-number v-model="form.attitude.dipAngle" :min="0" :max="90" />
      </el-form-item>
      <el-form-item label="地质员">
        <el-input v-model="form.geologist" style="width: 200px" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" @click="submit">{{ face ? '保存修改' : '保存编录' }}</el-button>
    </template>

    <ConflictDialog :conflict="conflict" entity-label="掌子面" @reload="reloadConflict" @close="conflict = null" />
  </el-dialog>
</template>

<style scoped>
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
</style>
