<script setup lang="ts">
/**
 * 校验报告弹窗：分组与计数全部取自 validate 载荷，错误标红、警告标橙。
 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { KernelResult } from '../types.ts';
import { localizedFindingText } from '../i18n/error-text.ts';

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
    :title="$t('validation.title')"
    :subtitle="$t('validation.exitCode', { code: result.exit_code })"
    wide
    @close="$emit('close')"
  >
    <div class="counters">
      <span class="ok">{{ $t('validation.passedCount', { count: data.passed ?? 0 }) }}</span>
      <span class="bad">{{ $t('validation.invalidCount', { count: data.invalid ?? 0 }) }}</span>
      <span class="warn">{{ $t('validation.warningCount', { count: data.warnings ?? 0 }) }}</span>
      <span class="bad">{{ $t('validation.errorCount', { count: data.errors ?? 0 }) }}</span>
      <span class="muted">{{ $t('validation.staleCount', { count: data.stale ?? 0 }) }}</span>
    </div>

    <section v-if="errors.length > 0">
      <h3 class="bad">{{ $t('validation.errorCount', { count: errors.length }) }}</h3>
      <ul>
        <li v-for="finding in errors" :key="finding.code + finding.target">
          <code>{{ finding.code }}</code>
          <strong>{{ finding.target }}</strong>
          {{ localizedFindingText(finding) }}
          <span class="muted">{{ finding.remedy }}</span>
        </li>
      </ul>
    </section>

    <section v-if="warnings.length > 0">
      <h3 class="warn">{{ $t('validation.warningCount', { count: warnings.length }) }}</h3>
      <ul>
        <li v-for="finding in warnings" :key="finding.code + finding.target">
          <code>{{ finding.code }}</code>
          <strong>{{ finding.target }}</strong>
          {{ localizedFindingText(finding) }}
          <span class="muted">{{ finding.remedy }}</span>
        </li>
      </ul>
    </section>

    <section v-if="data.code_counts">
      <h3>{{ $t('validation.codeList') }}</h3>
      <ul class="codes">
        <li v-for="(count, code) in data.code_counts" :key="code">
          <code>{{ code }}</code> × {{ count }}
        </li>
      </ul>
    </section>

    <p v-if="errors.length === 0 && warnings.length === 0" class="ok">
      {{ $t('validation.noIssues') }}
    </p>

    <template #footer>
      <button class="primary" @click="$emit('close')">{{ $t('common.close') }}</button>
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
