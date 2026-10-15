<script setup lang="ts">
/**
 * 确认弹窗：内容全部来自内核的预演结果，界面不编造影响范围。
 * 展示退出码与问题码；用户取消时不发任何写请求。
 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { ConfirmRequest } from '../composables/useKernel.ts';

const props = defineProps<{ request: ConfirmRequest }>();
defineEmits<{ answer: [approved: boolean] }>();

/** 预演载荷里的逐文件清单（有则展示）：恢复与安装类操作都会给出 */
const files = computed<string[]>(() => {
  const value = props.request.result.data?.['files'];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
});
</script>

<template>
  <DialogShell
    :title="`确认${request.title}`"
    subtitle="以下影响范围由内核预演给出，尚未写入任何变更"
    @close="$emit('answer', false)"
  >
    <ul class="changes">
      <li v-for="(change, index) in request.result.changes" :key="index">
        <span class="action">{{ change.action }}</span>
        <code>{{ change.path }}</code>
        <span class="muted">（{{ change.kind }}）</span>
      </li>
      <li v-if="request.result.changes.length === 0" class="muted">没有文件或索引变更</li>
    </ul>
    <dl v-if="request.result.data" class="notes">
      <template v-for="(value, key) in request.result.data" :key="key">
        <div v-if="key === 'notes' && Array.isArray(value)">
          <dt>说明</dt>
          <dd>
            <ul>
              <li v-for="(note, index) in value" :key="index">{{ note }}</li>
            </ul>
          </dd>
        </div>
      </template>
    </dl>
    <template v-if="files.length > 0">
      <p class="muted">将写回的文件（{{ files.length }} 项）</p>
      <ul class="files">
        <li v-for="file in files" :key="file">
          <code>{{ file }}</code>
        </li>
      </ul>
    </template>
    <ul class="warnings">
      <li v-for="finding in request.result.findings" :key="finding.code + finding.target">
        [{{ finding.severity === 'error' ? '错误' : '警告' }}] {{ finding.code }}
        {{ finding.message }}
      </li>
    </ul>
    <template #footer>
      <button @click="$emit('answer', false)">取消</button>
      <button class="primary" @click="$emit('answer', true)">确认执行</button>
    </template>
  </DialogShell>
</template>

<style scoped>
.changes {
  list-style: none;
  margin: 0 0 calc(var(--space) * 4);
  padding: 0;
  display: grid;
  gap: calc(var(--space) * 2);
}

.changes li {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: baseline;
  font-size: 13px;
  word-break: break-all;
}

.action {
  color: var(--accent-strong);
  font-weight: 600;
  min-width: 52px;
}

.notes dt {
  color: var(--text-muted);
  font-size: 12px;
}

.notes ul,
.warnings {
  margin: 0;
  padding-left: calc(var(--space) * 5);
  font-size: 13px;
}

.files {
  margin: 0;
  max-height: 168px;
  overflow: auto;
  list-style: none;
  padding-left: 0;
  font-size: 13px;
  word-break: break-all;
}

.warnings {
  color: var(--warning);
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}
</style>
