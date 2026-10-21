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
    :title="$t('install.title')"
    :subtitle="$t('install.subtitle')"
    @close="$emit('close')"
  >
    <label>
      <span>{{ $t('install.sourcePath') }}</span>
      <input
        v-model="source"
        :placeholder="$t('install.sourcePathPlaceholder')"
        @keyup.enter="submit"
      />
    </label>
    <label class="checkbox">
      <input v-model="libraryOnly" type="checkbox" />
      <span>{{ $t('install.libraryOnly') }}</span>
    </label>
    <template #footer>
      <button @click="$emit('close')">{{ $t('common.cancel') }}</button>
      <button class="primary" :disabled="source.trim() === ''" @click="submit">
        {{ $t('install.install') }}
      </button>
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
