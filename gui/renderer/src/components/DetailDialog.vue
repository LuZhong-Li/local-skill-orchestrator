<script setup lang="ts">
/**
 * 详情弹窗：数据全部来自 inspect 载荷。
 * 操作按钮只发出意图，是否确认由外面的统一流程决定。
 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { Finding, KernelResult, SkillSummary } from '../types.ts';
import { localizedFindingText } from '../i18n/error-text.ts';

const props = defineProps<{
  record: SkillSummary;
  detail: KernelResult | null;
  loading: boolean;
}>();
defineEmits<{ close: []; action: [argv: string[]]; deps: []; validate: [] }>();

const data = computed(() => (props.detail?.data ?? {}) as Record<string, unknown>);
const meta = computed(() => (data.value['meta'] ?? null) as Record<string, unknown> | null);
const checksum = computed(
  () =>
    (data.value['checksum'] ?? {}) as {
      recorded?: string;
      recomputed?: string;
      match?: boolean | null;
    },
);
const dependencies = computed(
  () => (data.value['dependencies'] ?? null) as Record<string, unknown> | null,
);
const targets = computed(() => (data.value['targets'] ?? []) as Array<Record<string, unknown>>);
const findings = computed<Finding[]>(() => props.detail?.findings ?? []);
</script>

<template>
  <DialogShell :title="record.name" :subtitle="record.id" wide @close="$emit('close')">
    <p v-if="loading" class="muted">{{ $t('detail.loading') }}</p>
    <template v-else>
      <section>
        <h3>{{ $t('detail.basic') }}</h3>
        <dl class="grid">
          <div>
            <dt>{{ $t('detail.version') }}</dt>
            <dd>{{ record.version ?? $t('common.notDeclared') }}</dd>
          </div>
          <div>
            <dt>{{ $t('detail.status') }}</dt>
            <dd>
              {{ record.status === 'enabled' ? $t('common.enabled') : $t('common.disabled') }}
            </dd>
          </div>
          <div>
            <dt>{{ $t('detail.sourceType') }}</dt>
            <dd>{{ record.source_type }}</dd>
          </div>
          <div>
            <dt>{{ $t('detail.targetPath') }}</dt>
            <dd>{{ String(meta?.['path'] ?? $t('common.notDeclared')) }}</dd>
          </div>
          <div>
            <dt>{{ $t('detail.checksum') }}</dt>
            <dd>
              <code>{{ checksum.recorded ?? $t('detail.noChecksum') }}</code>
              <span v-if="checksum.match === true" class="ok">
                {{ $t('detail.matchesDisk') }}
              </span>
              <span v-else-if="checksum.match === false" class="bad">
                {{ $t('detail.mismatchesDisk') }}
              </span>
              <span v-else class="muted">{{ $t('detail.cannotCompare') }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ $t('skill.scanned') }}</dt>
            <dd>{{ record.validation.last_scan_at ?? $t('detail.notScanned') }}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>{{ $t('detail.validationStatus') }}</h3>
        <p v-if="record.validation.status === 'ok'" class="ok">
          {{ $t('detail.validationPassed') }}
        </p>
        <template v-else>
          <p class="bad">{{ $t('detail.validationFailed') }}</p>
          <ul>
            <li v-for="code in record.validation.errors" :key="code">
              <code>{{ code }}</code>
            </li>
          </ul>
        </template>
      </section>

      <section>
        <h3>{{ $t('detail.declaredDependencies') }}</h3>
        <ul v-if="Array.isArray(dependencies?.['skills'])">
          <li v-for="item in dependencies?.['skills'] as string[]" :key="item">{{ item }}</li>
        </ul>
        <p v-else class="muted">{{ $t('detail.noDependencies') }}</p>
        <button @click="$emit('deps')">{{ $t('detail.checkDependencies') }}</button>
      </section>

      <section>
        <h3>{{ $t('detail.mappingTitle') }}</h3>
        <ul>
          <li v-for="(target, index) in targets" :key="index">
            <strong>{{ String(target['target']) }}</strong>
            <span class="muted"
              >（{{ String(target['scope']) }}｜{{ String(target['path']) }}）</span
            >
            <ul>
              <li
                v-for="(dest, source) in target['file_map'] as Record<string, string>"
                :key="source"
              >
                <code>{{ source }} → {{ dest }}</code>
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="targets.length === 0" class="muted">{{ $t('detail.noTargets') }}</p>
      </section>

      <section v-if="findings.length > 0">
        <h3>{{ $t('detail.kernelProblems') }}</h3>
        <ul>
          <li v-for="finding in findings" :key="finding.code + finding.target">
            [{{ finding.severity === 'error' ? $t('common.error') : $t('common.warning') }}]
            <code>{{ finding.code }}</code>
            {{ localizedFindingText(finding) }}
            <span class="muted">{{ finding.remedy }}</span>
          </li>
        </ul>
      </section>
    </template>

    <template #footer>
      <button @click="$emit('validate')">{{ $t('detail.validateSkill') }}</button>
      <button @click="$emit('action', ['enable', record.id])">{{ $t('detail.enable') }}</button>
      <button @click="$emit('action', ['disable', record.id])">{{ $t('detail.disable') }}</button>
      <button @click="$emit('action', ['update', record.id])">{{ $t('detail.refresh') }}</button>
      <button class="danger" @click="$emit('action', ['uninstall', record.id, '--hard'])">
        {{ $t('detail.uninstallHard') }}
      </button>
      <button class="danger" @click="$emit('action', ['uninstall', record.id])">
        {{ $t('detail.uninstall') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
section + section {
  margin-top: calc(var(--space) * 5);
}

h3 {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: calc(var(--space) * 2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  margin: 0;
  font-size: 13px;
}

.grid div {
  display: flex;
  gap: calc(var(--space) * 2);
}

dt {
  color: var(--text-muted);
  min-width: 72px;
}

dd {
  margin: 0;
  word-break: break-all;
}

ul {
  margin: 0;
  padding-left: calc(var(--space) * 5);
  font-size: 13px;
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.ok {
  color: var(--success);
  margin-left: calc(var(--space) * 2);
}

.bad {
  color: var(--danger);
  margin-left: calc(var(--space) * 2);
}
</style>
