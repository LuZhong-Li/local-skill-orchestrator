<script setup lang="ts">
/**
 * reconcile 动作对话框：单副本 / 批量共用。
 * - 单副本：path 精确选择，一次预览 + 一次执行。
 * - 批量：多副本 id 选择，一次预览 → 顺序逐 item apply 显示进度。
 * 预览、执行与错误状态都在本组件内闭环，避免父子状态错位。
 */
import { computed, onMounted, ref } from 'vue';
import type {
  Finding,
  ReconcileAction,
  ReconcileApplyData,
  ReconcilePlanItem,
  ReconcilePreviewData,
  ReconcileResultItem,
  Result,
} from '@skill-manager/contract';
import DialogShell from '../DialogShell.vue';

import { inventoryActionLabel } from '../../inventory-actions.ts';
import type { BatchTarget } from '../../inventory-batch.ts';
import {
  adoptPreviewRows as adoptPreviewRowsOf,
  failedReconcileResult,
  filterBulkAdoptPlan,
  mergeBatchPlans as mergePlans,
  planItemSignature,
  skippedReconcileResults,
} from '../../host-inventory-action-plan.ts';
import { localizedFindingsText } from '../../i18n/error-text.ts';
import { t } from '../../i18n/index.ts';

const props = defineProps<{
  action: ReconcileAction;
  path?: string;
  targets?: BatchTarget[];
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
  // 是否为批量模式
  batch?: boolean;
  bulkAdopt?: boolean;
  contextNote?: string;
}>();

const emit = defineEmits<{ close: []; done: [result: ReconcileApplyData | null] }>();

const preview = ref<ReconcilePreviewData | null>(null);
const result = ref<ReconcileApplyData | null>(null);
const findings = ref<Finding[]>([]);
const loading = ref(false);
const executing = ref(false);
const error = ref('');
const confirmed = ref(false);
const cancelRequested = ref(false);
const currentItemIndex = ref(0);

const destructive = computed(() => props.action === 'clean' || props.action === 'accept');

const dialogTitle = computed(() =>
  props.bulkAdopt
    ? t('inventory.unmanagedAdopt.title')
    : t('inventory.actionDialog.title', { action: actionLabel(props.action) }),
);

const dialogSubtitle = computed(() =>
  props.bulkAdopt ? t('inventory.unmanagedAdopt.subtitle') : t('inventory.actionDialog.subtitle'),
);

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

const writeItems = computed(() => {
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

const ledgerChanges = computed(() => {
  const items: Array<{
    item_id: string;
    target_path: string;
    changes: { record_key: string; source: string; from_state: string; to_state: string }[];
  }> = [];
  for (const item of preview.value?.items ?? []) {
    if (item.ledger_changes.length > 0) {
      items.push({
        item_id: item.item_id,
        target_path: item.target_path,
        changes: item.ledger_changes,
      });
    }
  }
  return items;
});

const warnings = computed(() => {
  const warnFindings = findings.value.filter((f) => f.severity === 'warning');
  const itemWarnings = (preview.value?.items ?? [])
    .filter((item) => item.status === 'skipped')
    .map((item) => ({
      code: 'SKIPPED',
      target: item.target_path,
      message: item.reason ?? '',
    }));
  return [...warnFindings, ...itemWarnings];
});

const backups = computed(() => [
  ...new Set((preview.value?.items ?? []).flatMap((item) => item.backups)),
]);

const adoptPreviewRows = computed(() => adoptPreviewRowsOf(preview.value));

const canExecute = computed(
  () =>
    !loading.value &&
    !executing.value &&
    preview.value !== null &&
    preview.value.summary.planned > 0 &&
    (!destructive.value || confirmed.value),
);

const progressPercent = computed(() => {
  const planned = preview.value?.summary.planned ?? 0;
  if (planned === 0 || !props.batch) return 0;
  const current = currentItemIndex.value;
  return Math.min(100, Math.round((current / planned) * 100));
});

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function findingsText(items: Finding[]): string {
  return localizedFindingsText(items);
}

function buildPreviewArgv(): string[] {
  const argv = ['reconcile', '--action', props.action];
  if (props.path) {
    argv.push('--path', props.path);
  }
  return argv;
}

function targetArgv(target: BatchTarget): string[] {
  if (target.id !== undefined && target.host !== undefined) {
    return ['--id', target.id, '--host', target.host];
  }
  return ['--path', target.path ?? ''];
}

async function loadBulkAdoptPreview(targets: BatchTarget[]): Promise<ReconcilePreviewData | null> {
  // KernelBridge appends --json to every GUI invocation.
  const response = await props.run(['reconcile', '--action', 'adopt', '--bulk', '--dry-run']);
  findings.value.push(...response.findings);
  const payload = response.data as unknown as ReconcilePreviewData;
  if (!response.ok || payload?.mode !== 'reconcile') {
    error.value =
      findingsText(response.findings) ||
      t('inventory.actionDialog.previewFailed', { code: response.exit_code });
    return null;
  }
  const filtered = filterBulkAdoptPlan(payload, targets);
  if (filtered.items.length === 0) {
    error.value = t('inventory.unmanagedAdopt.noSelection');
    return null;
  }
  return filtered;
}

async function loadBatchPreview(targets: BatchTarget[]): Promise<ReconcilePreviewData | null> {
  if (props.bulkAdopt) return loadBulkAdoptPreview(targets);
  const plans: ReconcilePreviewData[] = [];
  for (const target of targets) {
    const response = await props.run([
      'reconcile',
      '--action',
      props.action,
      ...targetArgv(target),
    ]);
    findings.value.push(...response.findings);
    const payload = response.data as unknown as ReconcilePreviewData;
    if (!response.ok || payload?.mode !== 'reconcile') {
      error.value =
        findingsText(response.findings) ||
        t('inventory.actionDialog.previewFailed', { code: response.exit_code });
      return null;
    }
    plans.push(payload);
  }
  return mergePlans(plans, props.action);
}

function itemSelectionArgv(item: ReconcilePlanItem): string[] {
  if (
    item.before.classification_key === 'not_distributed' &&
    item.skill_id !== undefined &&
    item.host_ids[0] !== undefined
  ) {
    return ['--id', item.skill_id, '--host', item.host_ids[0]];
  }
  return ['--path', item.target_path];
}

function staleFinding(item: ReconcilePlanItem): Finding {
  return {
    code: 'E-RECONCILE-002',
    severity: 'error',
    source: 'reconcile',
    target: item.target_path,
    message: t('inventory.actionDialog.staleItem'),
    remedy: t('inventory.actionDialog.staleRemedy'),
  };
}

async function executeBatch(plan: ReconcilePreviewData): Promise<ReconcileApplyData> {
  const startedAt = Date.now();
  const plannedItems = plan.items.filter((item) => item.status === 'planned');
  const results = skippedReconcileResults(plan);
  let attempted = 0;

  for (const plannedItem of plannedItems) {
    if (cancelRequested.value && attempted > 0) break;
    attempted += 1;
    currentItemIndex.value = attempted;
    results.push(await executeBatchItem(plannedItem));
  }

  const succeeded = results.filter((item) => item.status === 'succeeded').length;
  const failed = results.filter((item) => item.status === 'failed').length;
  const skipped = results.filter((item) => item.status === 'skipped').length;
  const cancelled = Math.max(0, plannedItems.length - attempted);
  return {
    ...plan,
    applied: succeeded > 0,
    results,
    summary: {
      ...plan.summary,
      succeeded,
      failed,
      skipped,
      cancelled,
      duration_ms: Math.max(0, Date.now() - startedAt),
    },
  };
}

async function executeBatchItem(item: ReconcilePlanItem): Promise<ReconcileResultItem> {
  const fresh = await freshBatchPlanItem(item);
  if ('result' in fresh) return fresh.result;
  return applyBatchItem(item);
}

type FreshBatchItem = { item: ReconcilePlanItem } | { result: ReconcileResultItem };

async function freshBatchPlanItem(item: ReconcilePlanItem): Promise<FreshBatchItem> {
  const response = await props.run([
    'reconcile',
    '--action',
    props.action,
    ...itemSelectionArgv(item),
  ]);
  findings.value.push(...response.findings);
  if (!response.ok) return { result: previewFailure(item, response) };

  const plan = response.data as unknown as ReconcilePreviewData;
  const current = plan.items?.find(
    (candidate) => candidate.physical_key === item.physical_key && candidate.status === 'planned',
  );
  if (
    plan.mode !== 'reconcile' ||
    current === undefined ||
    planItemSignature(current) !== planItemSignature(item)
  ) {
    const finding = staleFinding(item);
    return {
      result: failedReconcileResult(item, 'preview', 'plan_stale', finding.message, [finding]),
    };
  }
  return { item: current };
}

function previewFailure(
  item: ReconcilePlanItem,
  response: Result<Record<string, unknown>>,
): ReconcileResultItem {
  return failedReconcileResult(
    item,
    'preview',
    response.findings[0]?.code ?? 'preview_failed',
    findingsText(response.findings) ||
      t('inventory.actionDialog.previewFailed', { code: response.exit_code }),
    response.findings,
  );
}

async function applyBatchItem(item: ReconcilePlanItem): Promise<ReconcileResultItem> {
  const response = await props.run([
    'reconcile',
    '--action',
    props.action,
    ...itemSelectionArgv(item),
    '--apply',
    '--yes',
  ]);
  findings.value.push(...response.findings);
  const applied = response.data as unknown as ReconcileApplyData;
  return (
    applied.results?.find((result) => result.target_path === item.target_path) ??
    failedReconcileResult(
      item,
      'execute',
      'missing_result',
      findingsText(response.findings) ||
        t('inventory.actionDialog.executeFailed', { code: response.exit_code }),
      response.findings,
    )
  );
}

async function loadPreview(): Promise<void> {
  loading.value = true;
  error.value = '';
  findings.value = [];
  preview.value = null;
  result.value = null;
  confirmed.value = false;
  cancelRequested.value = false;
  currentItemIndex.value = 0;
  try {
    preview.value =
      props.batch && props.targets && props.targets.length > 0
        ? await loadBatchPreview(props.targets)
        : await loadSinglePreview();
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    loading.value = false;
  }
}

async function loadSinglePreview(): Promise<ReconcilePreviewData | null> {
  const response = await props.run(buildPreviewArgv());
  findings.value = response.findings;
  const payload = response.data as unknown as ReconcilePreviewData;
  if (!response.ok) {
    error.value =
      findingsText(response.findings) ||
      t('inventory.actionDialog.previewFailed', { code: response.exit_code });
    return null;
  }
  if (payload?.mode !== 'reconcile') {
    error.value = t('inventory.actionDialog.invalidPlan');
    return null;
  }
  return payload;
}

async function execute(): Promise<void> {
  if (!canExecute.value || preview.value === null) return;
  executing.value = true;
  error.value = '';
  cancelRequested.value = false;
  currentItemIndex.value = 0;

  try {
    if (props.batch && props.targets && props.targets.length > 1) {
      result.value = await executeBatch(preview.value);
    } else {
      await executeSingle();
    }
    emit('done', result.value);
  } catch (cause) {
    error.value = messageOf(cause);
  } finally {
    executing.value = false;
    cancelRequested.value = false;
  }
}

async function executeSingle(): Promise<void> {
  const response = await props.run([...buildPreviewArgv(), '--apply', '--yes']);
  findings.value = response.findings;
  const payload = response.data as unknown as ReconcileApplyData;
  if (payload?.mode === 'reconcile') {
    result.value = payload;
    currentItemIndex.value = payload.results.length;
  }
  if (!response.ok) {
    error.value =
      findingsText(response.findings) ||
      t('inventory.actionDialog.executeFailed', { code: response.exit_code });
  }
}

function requestCancel(): void {
  cancelRequested.value = true;
}

function actionLabel(action: ReconcileAction): string {
  return inventoryActionLabel(action);
}

onMounted(loadPreview);
</script>

<template>
  <DialogShell
    :title="dialogTitle"
    :subtitle="dialogSubtitle"
    wide
    data-testid="inventory-action-dialog"
    @close="emit('close')"
  >
    <p v-if="contextNote" class="muted context-note" data-testid="inventory-action-context">
      {{ contextNote }}
    </p>
    <p v-if="path" class="muted action-target">
      {{ $t('inventory.actionDialog.target') }} <code>{{ path }}</code>
    </p>
    <p
      v-if="batch && targets && targets.length > 0"
      class="muted action-target"
      data-testid="batch-selection-count"
    >
      {{
        $t('inventory.actionDialog.batchTarget', {
          count: targets.length,
          action: actionLabel(action),
        })
      }}
    </p>

    <p v-if="loading" class="muted" data-testid="inventory-action-loading">
      {{ $t('inventory.actionDialog.loading') }}
    </p>
    <p v-if="error !== ''" class="bad">{{ error }}</p>

    <template v-if="preview !== null && !loading">
      <section
        v-if="adoptPreviewRows.length > 0"
        data-testid="adopt-preview-items"
        class="adopt-preview"
      >
        <h3>{{ $t('inventory.unmanagedAdopt.previewTitle') }}</h3>
        <article
          v-for="row in adoptPreviewRows"
          :key="row.item_id"
          class="adopt-preview-item"
          :data-testid="`adopt-preview-${row.requested_id}`"
        >
          <div>
            <strong>{{ $t('inventory.unmanagedAdopt.sourcePath') }}</strong>
            <code :title="row.source_path">{{ row.source_path }}</code>
          </div>
          <div>
            <strong>{{ $t('inventory.unmanagedAdopt.target') }}</strong>
            <code :title="row.target_path">{{ row.target_path }}</code>
            <span v-if="row.requested_id !== row.target_id" class="muted">
              {{ row.requested_id }} → {{ row.target_id }}
            </span>
          </div>
          <div>
            <strong>{{ $t('inventory.unmanagedAdopt.frontmatter') }}</strong>
            <span>
              {{
                $t('inventory.unmanagedAdopt.description', {
                  value: row.description || $t('inventory.unmanagedAdopt.missingValue'),
                })
              }}
            </span>
            <span>
              {{
                $t('inventory.unmanagedAdopt.version', {
                  value: row.version ?? $t('inventory.unmanagedAdopt.missingValue'),
                })
              }}
            </span>
          </div>
          <div>
            <strong>{{ $t('inventory.unmanagedAdopt.conflict') }}</strong>
            <span :data-conflict="row.conflict">
              {{ $t(`inventory.unmanagedAdopt.conflictValues.${row.conflict}`) }}
            </span>
          </div>
        </article>
      </section>

      <div
        v-if="shared.length > 0 && preview.transaction_groups.some((g) => g.shared)"
        class="shared-box"
        data-testid="inventory-action-shared"
      >
        <p>
          <strong>{{ $t('inventory.actionDialog.sharedTitle') }}</strong>
        </p>
        <p v-for="group in shared" :key="group.group_id">
          {{
            $t('inventory.actionDialog.sharedImpact', {
              consumers: group.consumers.join(', '),
            })
          }}
        </p>
      </div>

      <div v-if="destructive" class="danger-box" data-testid="inventory-action-destructive">
        <p>
          <strong>
            {{
              action === 'accept'
                ? $t('inventory.actionDialog.overwrite')
                : $t('inventory.actionDialog.destructive')
            }}
          </strong>
        </p>
        <p>
          {{
            action === 'accept'
              ? $t('inventory.actionDialog.overwriteHint')
              : $t('inventory.actionDialog.destructiveHint')
          }}
        </p>
        <label class="confirm-box">
          <input v-model="confirmed" type="checkbox" data-testid="confirm-destructive" />
          {{ $t('inventory.actionDialog.acknowledged') }}
        </label>
      </div>

      <!-- 写入项 -->
      <section data-testid="action-section-writes">
        <h3>
          {{ $t('inventory.actionDialog.writesSection', { count: writeItems.length }) }}
        </h3>
        <ul class="writes">
          <li v-for="write in writeItems" :key="`${write.action}:${write.kind}:${write.path}`">
            <span class="action">{{ write.action }}</span>
            <code>{{ write.path }}</code>
            <span class="muted">（{{ write.kind }}）</span>
          </li>
          <li v-if="writeItems.length === 0" class="muted">
            {{ $t('inventory.actionDialog.noWrites') }}
          </li>
        </ul>
      </section>

      <!-- 账本变更 -->
      <section data-testid="action-section-ledger">
        <h3>{{ $t('inventory.actionDialog.ledgerSection') }}</h3>
        <ul class="ledger">
          <li v-for="group in ledgerChanges" :key="`ledger-${group.item_id}`">
            <code>{{ group.target_path }}</code>
            <span
              v-for="change in group.changes"
              :key="`${group.item_id}-${change.record_key}`"
              class="muted"
            >
              {{ change.source }}：{{ change.from_state }} → {{ change.to_state }}
            </span>
          </li>
          <li v-if="ledgerChanges.length === 0" class="muted">
            {{ $t('inventory.actionDialog.noLedgerChanges') }}
          </li>
          <li v-if="backups.length > 0">
            {{ $t('inventory.actionDialog.backupRoot') }}
            <code>{{ backups.join(', ') }}</code>
          </li>
        </ul>
      </section>

      <!-- 警告 -->
      <section data-testid="action-section-warnings">
        <h3 class="warn">
          {{ $t('inventory.actionDialog.warningsSection', { count: warnings.length }) }}
        </h3>
        <ul class="warnings">
          <li v-if="warnings.length === 0" class="muted">
            {{ $t('inventory.actionDialog.noWarnings') }}
          </li>
          <li v-for="(warning, index) in warnings" :key="index">
            <span v-if="'code' in warning && warning.code !== 'SKIPPED'" class="tag warning">
              {{ warning.code }}
            </span>
            <span v-else class="tag skipped">skipped</span>
            <span v-if="'target' in warning && warning.target" class="muted">
              {{ warning.target }}
            </span>
            <span v-if="'message' in warning && warning.message">
              {{ warning.message }}
            </span>
          </li>
        </ul>
      </section>

      <!-- 计划列表 / 进度 -->
      <section data-testid="action-plan">
        <h3>
          {{
            $t('inventory.actionDialog.planTitle', {
              planned: preview.summary.planned,
              skipped: preview.summary.skipped,
            })
          }}
        </h3>
        <div
          v-if="batch && (executing || result !== null)"
          class="progress-bar"
          data-testid="batch-progress"
        >
          <div class="progress-fill" :style="{ width: `${progressPercent}%` }"></div>
          <span class="progress-text">
            {{
              $t('inventory.actionDialog.progressText', {
                current: currentItemIndex,
                total: preview.summary.planned,
              })
            }}
          </span>
        </div>
      </section>

      <!-- 执行结果 -->
      <section v-if="result !== null" data-testid="inventory-action-results">
        <h3>{{ $t('inventory.actionDialog.resultsSection') }}</h3>
        <p class="result-summary" data-testid="batch-summary">
          {{
            $t('inventory.actionDialog.resultSummary', {
              planned: result.summary.planned,
              succeeded: result.results.filter((r) => r.status === 'succeeded').length,
              failed: result.results.filter((r) => r.status === 'failed').length,
              skipped: result.results.filter((r) => r.status === 'skipped').length,
              cancelled: result.summary.cancelled ?? 0,
            })
          }}
        </p>
        <ul class="results">
          <li v-for="item in result.results" :key="item.item_id">
            <span class="tag" :class="item.status">{{ item.status }}</span>
            <code>{{ item.target_path }}</code>
            <span v-if="item.message" class="muted">{{ item.message }}</span>
            <code v-if="item.reason">{{ item.reason }}</code>
            <span v-if="item.stage" class="muted">
              （{{ $t('inventory.actionDialog.stage', { stage: item.stage }) }}）
            </span>
            <span
              v-for="finding in item.findings ?? []"
              :key="finding.code + finding.target"
              class="bad"
            >
              {{ localizedFindingsText([finding]) }}
            </span>
          </li>
        </ul>
      </section>

      <ul class="findings">
        <li v-for="finding in findings" :key="finding.code + finding.target">
          {{
            $t('inventory.actionDialog.finding', {
              severity: finding.severity === 'error' ? $t('common.error') : $t('common.warning'),
              code: finding.code,
            })
          }}
          {{ localizedFindingsText([finding]) }}
        </li>
      </ul>
    </template>

    <template #footer>
      <button
        data-testid="inventory-action-cancel"
        @click="executing && batch ? requestCancel() : emit('close')"
      >
        {{ executing && batch ? $t('inventory.actionDialog.cancelBatch') : $t('common.cancel') }}
      </button>
      <button
        class="primary"
        :class="{ danger: destructive }"
        data-testid="inventory-action-execute"
        :disabled="!canExecute"
        @click="execute"
      >
        {{
          executing
            ? batch
              ? $t('inventory.actionDialog.executingBatch')
              : $t('inventory.actionDialog.executing')
            : preview !== null && preview.summary.planned === 0
              ? $t('inventory.actionDialog.noExecutable')
              : $t('inventory.actionDialog.confirmExecute')
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

.context-note {
  margin: 0 0 calc(var(--space) * 3);
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-muted);
  font-size: 12px;
}

.adopt-preview {
  display: grid;
  gap: calc(var(--space) * 2);
  margin-bottom: calc(var(--space) * 3);
}

.adopt-preview-item {
  display: grid;
  gap: calc(var(--space) * 1.5);
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-muted);
  font-size: 12px;
}

.adopt-preview-item div {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2);
  align-items: baseline;
}

.adopt-preview-item code {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.writes,
.ledger,
.warnings,
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

.writes li,
.ledger li,
.results li,
.warnings li {
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

.tag.skipped,
.tag.warning {
  color: var(--warning);
}

.warn {
  color: var(--warning);
}

.bad {
  color: var(--danger);
}

button.primary.danger {
  background: var(--danger);
}

.progress-bar {
  position: relative;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-muted);
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}

.progress-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text);
}

.result-summary {
  margin: 0 0 calc(var(--space) * 2);
  font-size: 13px;
  font-weight: 600;
}
</style>
