<script setup lang="ts">
/** 更新检查结果：四态分组展示；执行按钮只发出请求，确认由 App 的既有确认链路完成。 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import { updateItemView, updateStateLabel } from '../update-presentation.ts';
import { formatDateTime } from '../i18n/index.ts';
import type { UpdateRunResult } from '../update-runner.ts';
import type { UpdateCheckItem, UpdateCheckReport, UpdateCheckState } from '../types.ts';

const props = defineProps<{
  report: UpdateCheckReport;
  busy: boolean;
  updatingId: string | null;
  results: Record<string, UpdateRunResult>;
}>();
defineEmits<{
  close: [];
  retry: [];
  update: [id: string];
  updateAll: [];
}>();

const order: UpdateCheckState[] = ['update-available', 'up-to-date', 'not-checkable', 'failed'];
const groups = computed(() =>
  order.map((state) => ({
    state,
    label: updateStateLabel(state),
    items: props.report.data.items.filter((item) => item.state === state),
  })),
);
const available = computed(() =>
  props.report.data.items.filter((item) => item.state === 'update-available'),
);

function resultOf(item: UpdateCheckItem): UpdateRunResult | undefined {
  return props.results[item.id];
}
</script>

<template>
  <DialogShell
    :title="$t('updates.title')"
    :subtitle="$t('updates.subtitle')"
    wide
    @close="$emit('close')"
  >
    <div class="summary">
      <span v-for="group in groups" :key="group.state" class="tag state" :class="group.state">
        {{ group.label }} {{ group.items.length }}
      </span>
      <span class="muted">
        {{ $t('updates.checkedAt', { time: formatDateTime(report.data.checked_at) }) }}
      </span>
    </div>

    <div v-if="available.length > 0" class="bulk">
      <p class="muted">{{ $t('updates.availableCount', { count: available.length }) }}</p>
      <button class="primary" :disabled="busy" @click="$emit('updateAll')">
        {{ $t('updates.updateAll') }}
      </button>
    </div>

    <section
      v-for="group in groups"
      :key="group.state"
      class="update-state"
      :class="`state-${group.state}`"
    >
      <h3>{{ group.label }}（{{ group.items.length }}）</h3>
      <p v-if="group.items.length === 0" class="muted">{{ $t('updates.emptyGroup') }}</p>
      <article v-for="item in group.items" :key="item.id" class="item">
        <div class="item-head">
          <code>{{ item.id }}</code>
          <strong>{{ updateItemView(item).primary }}</strong>
        </div>
        <p>{{ updateItemView(item).detail }}</p>
        <p class="muted source">
          {{ $t('updates.source', { value: item.provenance.url ?? $t('common.unknown') }) }} |
          {{ $t('updates.reference', { value: item.provenance.ref ?? $t('common.unknown') }) }}
          <span v-if="item.checksum">| {{ $t('updates.checksum', { value: item.checksum }) }}</span>
        </p>
        <p v-if="item.reason" class="muted">{{ $t('updates.reason', { reason: item.reason }) }}</p>
        <p v-if="item.remedy" class="muted">{{ $t('updates.remedy', { remedy: item.remedy }) }}</p>
        <p v-if="item.backup_notice">{{ item.backup_notice }}</p>
        <p v-if="resultOf(item)" :class="{ bad: resultOf(item)?.status === 'failed' }">
          {{ $t('updates.result', { message: resultOf(item)?.message }) }}
        </p>
        <button
          v-if="updateItemView(item).canUpdate"
          class="primary"
          :disabled="busy"
          @click="$emit('update', item.id)"
        >
          {{ updatingId === item.id ? $t('updates.updating') : $t('updates.previewUpdate') }}
        </button>
      </article>
    </section>

    <template #footer>
      <button :disabled="busy" @click="$emit('retry')">{{ $t('common.retry') }}</button>
      <button @click="$emit('close')">{{ $t('common.close') }}</button>
    </template>
  </DialogShell>
</template>

<style scoped>
.summary {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
  flex-wrap: wrap;
  margin-bottom: calc(var(--space) * 4);
}

.tag.state {
  border-color: var(--border);
  background: var(--surface-muted);
}

.tag.state.update-available {
  color: var(--success);
  border-color: #cfe0cf;
  background: #f2f7f2;
}

.tag.state.failed {
  color: var(--danger);
  border-color: #eccbc8;
  background: #fbeceb;
}

.bulk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--space) * 3);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: calc(var(--space) * 3);
  margin-bottom: calc(var(--space) * 4);
}

.bulk p {
  margin: 0;
  font-size: 13px;
}

.update-state {
  border-top: 1px solid var(--border);
  padding-top: calc(var(--space) * 3);
  margin-top: calc(var(--space) * 3);
}

.update-state h3 {
  font-size: 13px;
  margin-bottom: calc(var(--space) * 2);
}

.item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: calc(var(--space) * 3);
  display: grid;
  gap: calc(var(--space) * 2);
  margin-bottom: calc(var(--space) * 2);
}

.item p {
  margin: 0;
  font-size: 13px;
}

.item-head {
  display: flex;
  justify-content: space-between;
  gap: calc(var(--space) * 3);
}

.source {
  font-size: 12px;
  word-break: break-all;
}

.bad {
  color: var(--danger);
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}
</style>
