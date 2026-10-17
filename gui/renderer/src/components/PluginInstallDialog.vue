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
    title="安装插件"
    subtitle="本地目录、归档或远端 URL；安装后默认 disabled"
    @close="$emit('close')"
  >
    <label>
      <span>插件来源</span>
      <input
        v-model="source"
        data-testid="plugin-source"
        placeholder="例如 /path/to/plugin 或 https://…/plugin.git"
        @keyup.enter="submit"
      />
    </label>
    <p class="muted">
      插件只允许声明式 manifest，不含代码；安装不会自动启用，也不会写入用户主目录。
    </p>
    <template #footer>
      <button @click="$emit('close')">取消</button>
      <button class="primary" :disabled="source.trim() === ''" @click="submit">安装插件</button>
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
