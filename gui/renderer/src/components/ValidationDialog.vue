<script setup lang="ts">
/**
 * 校验报告弹窗：分组与计数全部取自 validate 载荷，错误标红、警告标橙。
 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { KernelResult } from '../types.ts';

const props = defineProps<{ result: KernelResult }>();
defineEmits<{ close: [] }>();

const data = computed(
  () =>
    (props.result.data ?? {}) as {
      passed?: number;
      invalid?: number;
      warnings?: number;
      errors?: number;
      stale?: number;
      code_counts?: Record<string, number>;
      records?: Array<{
        id: string;
        status: string;
        errors: string[];
        warnings: string[];
        stale: boolean;
      }>;
    },
);
const errors = computed(() => props.result.findings.filter((item) => item.severity === 'error'));
const warnings = computed(() =>
  props.result.findings.filter((item) => item.severity === 'warning'),
);
</script>

<template>
  <DialogShell
    title="校验报告"
    :subtitle="`退出码 ${result.exit_code}`"
    wide
    @close="$emit('close')"
  >
    <div class="counters">
      <span class="ok">通过 {{ data.passed ?? 0 }}</span>
      <span class="bad">不通过 {{ data.invalid ?? 0 }}</span>
      <span class="warn">警告 {{ data.warnings ?? 0 }}</span>
      <span class="bad">错误 {{ data.errors ?? 0 }}</span>
      <span class="muted">结论过期 {{ data.stale ?? 0 }}</span>
    </div>

    <section v-if="errors.length > 0">
      <h3 class="bad">错误（{{ errors.length }}）</h3>
      <ul>
        <li v-for="finding in errors" :key="finding.code + finding.target">
          <code>{{ finding.code }}</code>
          <strong>{{ finding.target }}</strong>
          {{ finding.message }}
          <span class="muted">{{ finding.remedy }}</span>
        </li>
      </ul>
    </section>

    <section v-if="warnings.length > 0">
      <h3 class="warn">警告（{{ warnings.length }}）</h3>
      <ul>
        <li v-for="finding in warnings" :key="finding.code + finding.target">
          <code>{{ finding.code }}</code>
          <strong>{{ finding.target }}</strong>
          {{ finding.message }}
          <span class="muted">{{ finding.remedy }}</span>
        </li>
      </ul>
    </section>

    <section v-if="data.code_counts">
      <h3>问题码清单</h3>
      <ul class="codes">
        <li v-for="(count, code) in data.code_counts" :key="code">
          <code>{{ code }}</code> × {{ count }}
        </li>
      </ul>
    </section>

    <p v-if="errors.length === 0 && warnings.length === 0" class="ok">没有发现任何问题</p>

    <template #footer>
      <button class="primary" @click="$emit('close')">关闭</button>
    </template>
  </DialogShell>
</template>

<style scoped>
.counters {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 4);
  padding-bottom: calc(var(--space) * 3);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

section + section {
  margin-top: calc(var(--space) * 4);
}

h3 {
  font-size: 13px;
}

ul {
  margin: calc(var(--space) * 2) 0 0;
  padding-left: calc(var(--space) * 5);
  font-size: 13px;
}

.codes {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 4);
  list-style: none;
  padding-left: 0;
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  margin-right: calc(var(--space) * 2);
}

.ok {
  color: var(--success);
}

.warn {
  color: var(--warning);
}

.bad {
  color: var(--danger);
}
</style>
