<script setup lang="ts">
/** 插件安装弹窗：来源交给内核 install --kind plugin，界面不解析 manifest。 */
import { ref } from 'vue';
import DialogShell from './DialogShell.vue';

const emit = defineEmits<{ close: []; submit: [source: string] }>();
const source = ref('');

function submit(): void {
  const value = source.value.trim();
  if (value !== '') emit('submit', value);
}
</script>

<template>
  <DialogShell
    :title="$t('plugins.installTitle')"
    :subtitle="$t('plugins.installSubtitle')"
    @close="$emit('close')"
  >
    <label>
      <span>{{ $t('plugins.source') }}</span>
      <input
        v-model="source"
        data-testid="plugin-source"
        :placeholder="$t('plugins.placeholder')"
        @keyup.enter="submit"
      />
    </label>
    <p class="muted">
      {{ $t('plugins.manifestOnly') }}
    </p>
    <template #footer>
      <button @click="$emit('close')">{{ $t('common.cancel') }}</button>
      <button class="primary" :disabled="source.trim() === ''" @click="submit">
        {{ $t('plugins.submit') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
label span {
  display: block;
  color: var(--text-muted);
  margin-bottom: calc(var(--space));
}
</style>
