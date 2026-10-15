<script setup lang="ts">
/**
 * 安装弹窗：来源为工作区内的相对路径（内核按工作区根解析，界面不做路径拼接）。
 * 仅落库方式对应内核的 --library-only，登记状态为已禁用。
 */
import { ref } from 'vue';
import DialogShell from './DialogShell.vue';

const emit = defineEmits<{ close: []; submit: [argv: string[]] }>();

const source = ref('');
const libraryOnly = ref(false);

function submit(): void {
  const value = source.value.trim();
  if (value === '') return;
  emit('submit', ['install', value, ...(libraryOnly.value ? ['--library-only'] : [])]);
}
</script>

<template>
  <DialogShell
    title="安装 Skill"
    subtitle="来源路径相对工作区根目录；执行前会先给出预演结果"
    @close="$emit('close')"
  >
    <label>
      <span>来源路径</span>
      <input v-model="source" placeholder="例如 skills/alpha 或 待安装目录" @keyup.enter="submit" />
    </label>
    <label class="checkbox">
      <input v-model="libraryOnly" type="checkbox" />
      <span>仅落库（只写入中心库并登记，不分发到目标位置）</span>
    </label>
    <template #footer>
      <button @click="$emit('close')">取消</button>
      <button class="primary" :disabled="source.trim() === ''" @click="submit">安装</button>
    </template>
  </DialogShell>
</template>

<style scoped>
label {
  display: block;
  font-size: 13px;
}

label span {
  display: block;
  color: var(--text-muted);
  margin-bottom: calc(var(--space) * 1);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
  margin-top: calc(var(--space) * 4);
}

.checkbox span {
  margin: 0;
  color: inherit;
}

.checkbox input {
  width: auto;
}
</style>
