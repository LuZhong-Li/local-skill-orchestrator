<script setup lang="ts">
/**
 * 全机盘点视图：只读呈现 scan --inventory 结果；副本动作先生成预览，
 * 确认后才经 reconcile --apply 写入。支持单副本与批量动作。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  InventoryExportResult,
  InventoryScanData,
  ReconcileAction,
  Result,
} from '@skill-manager/contract';
import InventorySummary from './host-inventory/InventorySummary.vue';
import InventoryHostGroups from './host-inventory/InventoryHostGroups.vue';
import InventoryCopyDetails from './host-inventory/InventoryCopyDetails.vue';
import InventoryActionDialog from './host-inventory/InventoryActionDialog.vue';
import { localizedFindingsText } from '../i18n/error-text.ts';
import { t } from '../i18n/index.ts';
import {
  availableBatchActions,
  batchTargetOf,
  collectAllCopiesFromData,
  copyKey,
  isCopySelectable,
  type BatchSelectionState,
  type BatchTarget,
} from '../inventory-batch.ts';
import type { InventoryCopyLike } from '../inventory-actions.ts';

const props = defineProps<{
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
  exportInventory: (data: InventoryScanData) => Promise<InventoryExportResult>;
}>();

const data = ref<InventoryScanData | null>(null);
const loading = ref(false);
const error = ref('');
const actionOpen = ref(false);
const action = ref<ReconcileAction>('adopt');
const actionPath = ref('');
const actionTargets = ref<BatchTarget[]>([]);
const actionBatch = ref(false);
const exporting = ref(false);
const exportMessage = ref('');
const exportError = ref('');

const selection = reactive<BatchSelectionState>({
  selected: new Set<string>(),
});

const allCopies = computed(() => (data.value !== null ? collectAllCopiesFromData(data.value) : []));

const batchActions = computed(() => availableBatchActions(selection, allCopies.value));

const selectedCount = computed(() => {
  let count = 0;
  for (const copy of allCopies.value) {
    if (selection.selected.has(copyKey(copy))) count += 1;
  }
  return count;
});

const untracked = computed(
  () =>
    data.value?.copies.filter(
      (copy) => copy.root_role === 'user' && copy.reconciliation.classification === 'untracked',
    ) ?? [],
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.run(['scan', '--inventory']);
    if (!result.ok) {
      error.value =
        localizedFindingsText(result.findings) ||
        t('inventory.loadFailed', { code: result.exit_code });
      return;
    }
    const payload = result.data as unknown as InventoryScanData;
    if (payload?.mode !== 'inventory') {
      error.value = t('inventory.invalidPayload');
      return;
    }
    data.value = payload;
    // 加载新数据后清空选择
    selection.selected.clear();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function previewAction(nextAction: ReconcileAction, path: string): void {
  action.value = nextAction;
  actionPath.value = path;
  actionBatch.value = false;
  actionTargets.value = [];
  actionOpen.value = true;
}

function previewBatchAction(nextAction: ReconcileAction): void {
  const targets = allCopies.value
    .filter((copy) => selection.selected.has(copyKey(copy)))
    .map(batchTargetOf);
  if (targets.length === 0) return;
  action.value = nextAction;
  actionBatch.value = true;
  actionTargets.value = targets;
  actionPath.value = '';
  actionOpen.value = true;
}

function closeAction(): void {
  actionOpen.value = false;
}

function toggleSelection(key: string): void {
  if (selection.selected.has(key)) selection.selected.delete(key);
  else selection.selected.add(key);
  // 触发响应式更新
  selection.selected = new Set(selection.selected);
}

function toggleAllInDetails(copies: InventoryCopyLike[], selected: boolean): void {
  for (const copy of copies) {
    if (!isCopySelectable(copy)) continue;
    if (selected) selection.selected.add(copyKey(copy));
    else selection.selected.delete(copyKey(copy));
  }
  selection.selected = new Set(selection.selected);
}

function toggleRoot(rootId: string, selected: boolean): void {
  // 找到对应根节点，切换里面所有可选项
  if (data.value === null) return;
  for (const host of data.value.hosts) {
    for (const node of host.roots) {
      if (node.root.root_id !== rootId) continue;
      const all = [...node.copies, ...node.corrupt, ...node.missing];
      for (const copy of all) {
        if (!isCopySelectable(copy)) continue;
        if (selected) selection.selected.add(copyKey(copy));
        else selection.selected.delete(copyKey(copy));
      }
    }
  }
  selection.selected = new Set(selection.selected);
}

function clearSelection(): void {
  selection.selected.clear();
  selection.selected = new Set(selection.selected);
}

async function exportResult(): Promise<void> {
  if (data.value === null || exporting.value) return;
  exporting.value = true;
  exportMessage.value = '';
  exportError.value = '';
  try {
    const result = await props.exportInventory(data.value);
    if (result.canceled) {
      exportMessage.value = t('inventory.exportCanceled');
    } else if (result.error !== undefined && result.error !== '') {
      exportError.value = t('inventory.exportFailed', { message: result.error });
    } else {
      exportMessage.value = t('inventory.exported', { path: result.path ?? '' });
    }
  } catch (cause) {
    exportError.value = t('inventory.exportFailed', {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="content inventory-view" data-testid="host-inventory">
    <div class="panel wide">
      <div class="view-head">
        <div>
          <h2>{{ $t('inventory.viewTitle') }}</h2>
          <p class="muted">{{ $t('inventory.intro') }}</p>
        </div>
        <div class="view-actions">
          <button
            data-testid="inventory-export"
            :disabled="loading || exporting || data === null"
            @click="exportResult"
          >
            {{ exporting ? $t('inventory.exporting') : $t('common.export') }}
          </button>
          <button class="primary" data-testid="inventory-refresh" :disabled="loading" @click="load">
            {{ loading ? $t('inventory.refreshing') : $t('toolbar.rescan') }}
          </button>
        </div>
      </div>

      <!-- 批量动作栏 -->
      <div
        v-if="data !== null && selectedCount > 0"
        class="batch-bar"
        data-testid="batch-action-bar"
      >
        <span class="batch-count" data-testid="batch-selected-count">
          {{ $t('inventory.batch.selected', { count: selectedCount }) }}
        </span>
        <div class="batch-actions">
          <button
            v-for="opt in batchActions"
            :key="opt.action"
            :class="{ 'primary danger': opt.destructive, primary: !opt.destructive }"
            :data-testid="`batch-action-${opt.action}`"
            @click="previewBatchAction(opt.action)"
          >
            {{ opt.label }}
          </button>
        </div>
        <button class="ghost" data-testid="batch-clear" @click="clearSelection">
          {{ $t('inventory.batch.clear') }}
        </button>
      </div>

      <p v-if="error !== ''" class="bad" data-testid="inventory-error">{{ error }}</p>
      <p v-if="exportMessage !== ''" class="export-ok" data-testid="inventory-export-message">
        {{ exportMessage }}
      </p>
      <p v-if="exportError !== ''" class="bad" data-testid="inventory-export-error">
        {{ exportError }}
      </p>
      <p v-if="loading && data === null" class="muted" data-testid="inventory-loading">
        {{ $t('inventory.loadingBody') }}
      </p>
    </div>

    <template v-if="data !== null">
      <div class="panel wide workspace-banner" data-testid="inventory-workspace">
        <p v-if="data.workspace.state === 'uninitialized'">
          <strong>{{ $t('inventory.workspaceUninitializedTitle') }}</strong>
          {{ $t('inventory.workspaceUninitializedBody') }}
        </p>
        <p v-else-if="data.workspace.state === 'unreadable'">
          <strong>{{ $t('inventory.workspaceUnreadableTitle') }}</strong>
          {{ $t('inventory.workspaceUnreadableBody') }}
        </p>
        <p v-else>
          <strong>{{ $t('inventory.workspaceInitializedTitle') }}</strong>
          {{ $t('inventory.workspaceInitializedBody') }}
        </p>
        <p class="muted path">{{ data.workspace.root }}</p>
      </div>

      <InventorySummary :summary="data.summary" />

      <section class="panel wide" data-testid="inventory-degradation">
        <h2>{{ $t('inventory.ledgerTitle') }}</h2>
        <p class="muted">
          {{
            $t('inventory.hostLedger', {
              state:
                data.degradation.host_landings === 'ok'
                  ? $t('inventory.ledgerOk')
                  : data.degradation.host_landings === 'missing'
                    ? $t('inventory.ledgerMissing')
                    : $t('inventory.ledgerUnreadable'),
            })
          }}
          |
          {{
            $t('inventory.pluginLedger', {
              state:
                data.degradation.plugin_landings === 'ok'
                  ? $t('inventory.ledgerOk')
                  : data.degradation.plugin_landings === 'missing'
                    ? $t('inventory.ledgerMissing')
                    : $t('inventory.ledgerUnreadable'),
            })
          }}
        </p>
      </section>

      <details class="panel wide untracked" data-testid="inventory-untracked" open>
        <summary>
          <strong>{{ $t('inventory.untrackedTitle') }}</strong>
          <span class="count">{{ untracked.length }}</span>
        </summary>
        <p class="muted">{{ $t('inventory.untrackedHint') }}</p>
        <InventoryCopyDetails
          :copies="untracked"
          test-id="inventory-untracked-copies"
          :empty-text="$t('inventory.untrackedEmpty')"
          :selected-keys="selection.selected"
          :show-selection="true"
          @action="previewAction"
          @toggle-selection="toggleSelection"
          @toggle-all="(selected) => toggleAllInDetails(untracked, selected)"
        />
        <p class="muted action-hint">{{ $t('inventory.actionHint') }}</p>
      </details>

      <InventoryHostGroups
        :hosts="data.hosts"
        :selected-keys="selection.selected"
        :show-selection="true"
        @action="previewAction"
        @toggle-selection="toggleSelection"
        @toggle-root="toggleRoot"
      />

      <section v-if="data.corrupt.length > 0" class="panel wide" data-testid="inventory-corrupt">
        <h2>{{ $t('inventory.corruptTitle', { count: data.corrupt.length }) }}</h2>
        <p class="muted">{{ $t('inventory.corruptHint') }}</p>
        <InventoryCopyDetails
          :corrupt="data.corrupt"
          test-id="inventory-corrupt-copies"
          :selected-keys="selection.selected"
          :show-selection="true"
          @action="previewAction"
          @toggle-selection="toggleSelection"
          @toggle-all="(selected) => toggleAllInDetails(data!.corrupt, selected)"
        />
      </section>

      <section v-if="data.missing.length > 0" class="panel wide" data-testid="inventory-missing">
        <h2>{{ $t('inventory.missingTitle', { count: data.missing.length }) }}</h2>
        <p class="muted">{{ $t('inventory.missingHint') }}</p>
        <InventoryCopyDetails
          :missing="data.missing"
          test-id="inventory-missing-copies"
          :selected-keys="selection.selected"
          :show-selection="true"
          @action="previewAction"
          @toggle-selection="toggleSelection"
          @toggle-all="(selected) => toggleAllInDetails(data!.missing, selected)"
        />
      </section>
    </template>

    <InventoryActionDialog
      v-if="actionOpen"
      :action="action"
      :path="actionPath"
      :targets="actionTargets"
      :batch="actionBatch"
      :run="run"
      @close="closeAction"
      @done="load"
    />
  </section>
</template>

<style scoped>
.inventory-view {
  flex: 1;
  overflow: auto;
  padding: calc(var(--space) * 5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.view-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: calc(var(--space) * 3);
  width: 100%;
  flex-wrap: wrap;
}

.view-actions {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
}

.workspace-banner p {
  margin: 0;
}

.path {
  font-size: 12px;
  word-break: break-all;
}

.untracked summary {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
  cursor: pointer;
}

.untracked .count {
  border-radius: 999px;
  padding: 0 calc(var(--space) * 2);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  font-size: 12px;
}

.action-hint {
  margin: 0;
  font-size: 12px;
}

.export-ok {
  color: var(--success);
}

.bad {
  color: var(--danger);
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 3);
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  margin-top: calc(var(--space) * 3);
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--accent-soft);
  flex-wrap: wrap;
}

.batch-count {
  font-weight: 600;
  font-size: 13px;
}

.batch-actions {
  display: flex;
  gap: calc(var(--space) * 2);
  flex-wrap: wrap;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  margin-left: auto;
}

button.primary.danger {
  background: var(--danger);
}
</style>
