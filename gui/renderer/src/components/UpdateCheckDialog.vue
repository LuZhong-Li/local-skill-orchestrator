<script setup lang="ts">
/** 更新检查结果：四态分组展示；执行按钮只发出请求，确认由 App 的既有确认链路完成。 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import { UPDATE_STATE_LABELS, updateItemView } from '../update-presentation.ts';
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
    label: UPDATE_STATE_LABELS[state],
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
    title="Skill 更新检查"
    subtitle="检查只读；更新只会在你逐项确认后调用既有 update 指令"
    wide
    @close="$emit('close')"
  >
    <div class="summary">
      <span v-for="group in groups" :key="group.state" class="tag state" :class="group.state">
        {{ group.label }} {{ group.items.length }}
      </span>
      <span class="muted">检查时间 {{ report.data.checked_at }}</span>
    </div>

    <div v-if="available.length > 0" class="bulk">
      <p class="muted">
        共 {{ available.length }} 项可更新。「全部更新」会逐项预览并确认；单条失败不会阻断其余条目。
      </p>
      <button class="primary" :disabled="busy" @click="$emit('updateAll')">
        全部更新（逐项确认）
      </button>
    </div>

    <section
      v-for="group in groups"
      :key="group.state"
      class="update-state"
      :class="`state-${group.state}`"
    >
      <h3>{{ group.label }}（{{ group.items.length }}）</h3>
      <p v-if="group.items.length === 0" class="muted">无</p>
      <article v-for="item in group.items" :key="item.id" class="item">
        <div class="item-head">
          <code>{{ item.id }}</code>
          <strong>{{ updateItemView(item).primary }}</strong>
        </div>
        <p>{{ updateItemView(item).detail }}</p>
        <p class="muted source">
          来源 {{ item.provenance.url ?? '未记录' }}｜引用 {{ item.provenance.ref ?? '未记录' }}
          <span v-if="item.checksum">｜校验 {{ item.checksum }}</span>
        </p>
        <p v-if="item.reason" class="muted">原因码：{{ item.reason }}</p>
        <p v-if="item.remedy" class="muted">建议：{{ item.remedy }}</p>
        <p v-if="item.backup_notice">{{ item.backup_notice }}</p>
        <p v-if="resultOf(item)" :class="{ bad: resultOf(item)?.status === 'failed' }">
          本次结果：{{ resultOf(item)?.message }}
        </p>
        <button
          v-if="updateItemView(item).canUpdate"
          class="primary"
          :disabled="busy"
          @click="$emit('update', item.id)"
        >
          {{ updatingId === item.id ? '正在更新…' : '预览并更新' }}
        </button>
      </article>
    </section>

    <template #footer>
      <button :disabled="busy" @click="$emit('retry')">重新检查</button>
      <button @click="$emit('close')">关闭</button>
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
