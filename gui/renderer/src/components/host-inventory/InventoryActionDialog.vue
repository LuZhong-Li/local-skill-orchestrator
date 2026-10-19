<script setup lang="ts">
/**
 * reconcile 动作事务：挂载即只读预览，用户确认后本组件发 --apply。
 * 预览、执行与错误状态都在本组件内闭环，避免父子状态错位。
 */
import { computed, onMounted, ref } from 'vue';
import type {
  Finding,
  ReconcileAction,
  ReconcileApplyData,
  ReconcilePreviewData,
  Result,
} from '@skill-manager/contract';
import DialogShell from '../DialogShell.vue';
import {
  classificationLabel,
  authorityLabel,
  formatLabel,
} from '../../host-inventory-presentation.ts';
import { inventoryActionLabel } from '../../inventory-actions.ts';

const props = defineProps<{
  action: ReconcileAction;
  path: string;
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
}>();
const emit = defineEmits<{ close: []; done: [] }>();

const preview = ref<ReconcilePreviewData | null>(null);
const result = ref<ReconcileApplyData | null>(null);
const findings = ref<Finding[]>([]);
const loading = ref(false);
const executing = ref(false);
const error = ref('');
const confirmed = ref(false);

const destructive = computed(() => props.action === 'clean' || props.action === 'accept');
const shared = computed(() =>
  (preview.value?.transaction_groups ?? [])
    .filter((group) => group.shared)
    .map((group) => ({
      ...group,
      consumers: [
        ...new Set(
          (preview.value?.items ?? [])
            .filter((item) => item.transaction_group === group.group_id)
            .flatMap((item) => (item.consumed_by.length > 0 ? item.consumed_by : item.host_ids)),
        ),
      ],
    })),
);
const writes = computed(() => {
  const seen = new Set<string>();
  return (preview.value?.items ?? []).flatMap((item) =>
    item.writes.filter((write) => {
      const key = `${write.action}\0${write.kind}\0${write.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
});
const backups = computed(() => [
  ...new Set((preview.value?.items ?? []).flatMap((item) => item.backups)),
]);
const canExecute = computed(
  () =>
    !loading.value &&
    !executing.value &&
    preview.value !== null &&
    preview.value.summary.planned > 0 &&
    (!destructive.value || confirmed.value),
);

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function findingsText(items: Finding[]): string {
  return items.map((item) => `${item.code}：${item.message}`).join('；');
}

async function loadPreview(): Promise<void> {
  loading.value = true;
  error.value = '';
  findings.value = [];
  preview.value = null;
  result.value = null;
  confirmed.value = false;
  try {
    const response = await props.run(['reconcile', '--action', props.action, '--path', props.path]);
    findings.value = response.findings;
    const payload = response.data as unknown as ReconcilePreviewData;
    if (payload?.mode === 'reconcile') {
      preview.value = payload;
    } else if (response.ok) {
      error.value = '内核没有返回 reconcile 计划结构，界面拒绝猜测影响范围。';
    }
    if (!response.ok) {
      error.value = findingsText(response.findings) || `预览失败（退出码 ${response.exit_code}）`;
    }
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

async function execute(): Promise<void> {
  if (!canExecute.value || preview.value === null) return;
  executing.value = true;
  error.value = '';
  try {
    const response = await props.run([
      'reconcile',
      '--action',
      props.action,
      '--path',
      props.path,
      '--apply',
      '--yes',
    ]);
    findings.value = response.findings;
    const payload = response.data as unknown as ReconcileApplyData;
    if (payload?.mode === 'reconcile') result.value = payload;
    if (!response.ok) {
      error.value = findingsText(response.findings) || `执行失败（退出码 ${response.exit_code}）`;
    }
    emit('done');
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    executing.value = false;
  }
}

function actionLabel(action: ReconcileAction): string {
  return inventoryActionLabel(action);
}

onMounted(loadPreview);
</script>

<template>
  <DialogShell
    :title="`预览：${actionLabel(action)}`"
    subtitle="以下计划由内核只读生成；尚未写入任何文件"
    wide
    data-testid="inventory-action-dialog"
    @close="emit('close')"
  >
    <p class="muted action-target">
      目标副本：<code>{{ path }}</code>
    </p>
    <p v-if="loading" class="muted" data-testid="inventory-action-loading">正在生成动作计划…</p>
    <p v-if="error !== ''" class="bad" data-testid="inventory-action-error">{{ error }}</p>

    <template v-if="preview !== null">
      <div v-if="destructive" class="danger-box" data-testid="inventory-action-destructive">
        <strong>{{ action === 'clean' ? '破坏性操作：' : '覆盖性操作：' }}</strong>
        {{
          action === 'clean'
            ? '这会删除无消费者需要的宿主副本。'
            : '这会用宿主的本地内容覆盖工作区中心库。'
        }}
        <label class="confirm-box">
          <input v-model="confirmed" type="checkbox" data-testid="confirm-destructive" />
          我了解影响范围，确认执行
        </label>
      </div>

      <div v-if="shared.length > 0" class="shared-box" data-testid="inventory-action-shared">
        <strong>共享根影响多个宿主</strong>
        <p v-for="group in shared" :key="group.group_id">
          <code>{{ group.physical_path }}</code>
          影响 {{ group.consumers.join(' / ') }}
        </p>
      </div>

      <section>
        <h3>动作计划（{{ preview.summary.planned }} 项，跳过 {{ preview.summary.skipped }} 项）</h3>
        <ul class="items">
          <li v-for="item in preview.items" :key="item.item_id">
            <strong>{{ item.skill_id ?? item.target_path }}</strong>
            <code>{{ item.target_path }}</code>
            <span class="tag">{{ item.status }}</span>
            <span v-if="item.reason" class="muted">{{ item.reason }}</span>
            <span class="muted">
              执行后：{{ classificationLabel(item.after.classification) }} /
              {{ authorityLabel(item.after.authority) }}
            </span>
            <span class="muted">
              宿主 {{ item.host_ids.join(', ') || '—' }}；形态 {{ formatLabel(item.format) }}
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h3>将写入（{{ writes.length }} 项）</h3>
        <ul class="writes">
          <li v-for="write in writes" :key="`${write.action}:${write.kind}:${write.path}`">
            <span class="action">{{ write.action }}</span>
            <code>{{ write.path }}</code>
            <span class="muted">（{{ write.kind }}）</span>
          </li>
          <li v-if="writes.length === 0" class="muted">没有计划写入。</li>
        </ul>
      </section>

      <section>
        <h3>账本与备份</h3>
        <ul class="ledger">
          <li v-for="item in preview.items" :key="`ledger-${item.item_id}`">
            <span v-for="change in item.ledger_changes" :key="change.record_key">
              {{ change.source }}：{{ change.from_state }} → {{ change.to_state }}
            </span>
          </li>
          <li v-if="backups.length > 0">
            备份根：<code>{{ backups.join(', ') }}</code>
          </li>
        </ul>
      </section>

      <section v-if="result !== null" data-testid="inventory-action-results">
        <h3>执行结果</h3>
        <ul class="results">
          <li v-for="item in result.results" :key="item.item_id">
            <span class="tag" :class="item.status">{{ item.status }}</span>
            <code>{{ item.target_path }}</code>
            <span v-if="item.message" class="muted">{{ item.message }}</span>
            <span
              v-for="finding in item.findings ?? []"
              :key="finding.code + finding.target"
              class="bad"
            >
              {{ finding.code }} {{ finding.message }}
            </span>
          </li>
        </ul>
      </section>

      <ul class="findings">
        <li v-for="finding in findings" :key="finding.code + finding.target">
          [{{ finding.severity === 'error' ? '错误' : '警告' }}] {{ finding.code }}
          {{ finding.message }}
        </li>
      </ul>
    </template>

    <template #footer>
      <button data-testid="inventory-action-cancel" @click="emit('close')">取消</button>
      <button
        class="primary"
        :class="{ danger: destructive }"
        data-testid="inventory-action-execute"
        :disabled="!canExecute"
        @click="execute"
      >
        {{
          executing
            ? '执行中…'
            : preview !== null && preview.summary.planned === 0
              ? '无可执行项'
              : '确认执行'
        }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.danger-box,
.shared-box {
  border-radius: 8px;
  padding: calc(var(--space) * 3);
  margin-bottom: calc(var(--space) * 3);
  font-size: 12px;
}

.action-target {
  margin: 0 0 calc(var(--space) * 2);
  font-size: 12px;
  word-break: break-all;
}

.danger-box {
  border: 1px solid #eccbc8;
  background: #fbeceb;
  color: var(--danger);
}

.shared-box {
  border: 1px solid #ecdcc1;
  background: #fbf6ea;
}

.shared-box p {
  margin: calc(var(--space)) 0 0;
  word-break: break-all;
}

.confirm-box {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  margin-top: calc(var(--space) * 2);
}

.items,
.writes,
.ledger,
.results,
.findings {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: calc(var(--space) * 2);
  font-size: 12px;
  word-break: break-all;
}

.items li {
  display: grid;
  gap: calc(var(--space) / 2);
}

.writes li,
.results li {
  display: flex;
  gap: calc(var(--space) * 2);
  flex-wrap: wrap;
  align-items: baseline;
}

.action {
  color: var(--accent-strong);
  font-weight: 600;
}

.tag.succeeded {
  color: var(--success);
}

.tag.failed {
  color: var(--danger);
}

.bad {
  color: var(--danger);
}

button.primary.danger {
  background: var(--danger);
}
</style>
