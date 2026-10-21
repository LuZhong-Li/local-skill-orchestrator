<script setup lang="ts">
/**
 * 全机盘点视图：只读呈现 scan --inventory 结果；副本动作先生成预览，
 * 确认后才经 reconcile --apply 写入。本组件不访问 preload / Node。
 */
import { computed, onMounted, ref } from 'vue';
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
const exporting = ref(false);
const exportMessage = ref('');
const exportError = ref('');

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
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function previewAction(nextAction: ReconcileAction, path: string): void {
  action.value = nextAction;
  actionPath.value = path;
  actionOpen.value = true;
}

function closeAction(): void {
  actionOpen.value = false;
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
          @action="previewAction"
        />
        <p class="muted action-hint">{{ $t('inventory.actionHint') }}</p>
      </details>

      <InventoryHostGroups :hosts="data.hosts" @action="previewAction" />

      <section v-if="data.corrupt.length > 0" class="panel wide" data-testid="inventory-corrupt">
        <h2>{{ $t('inventory.corruptTitle', { count: data.corrupt.length }) }}</h2>
        <p class="muted">{{ $t('inventory.corruptHint') }}</p>
        <InventoryCopyDetails
          :corrupt="data.corrupt"
          test-id="inventory-corrupt-copies"
          @action="previewAction"
        />
      </section>

      <section v-if="data.missing.length > 0" class="panel wide" data-testid="inventory-missing">
        <h2>{{ $t('inventory.missingTitle', { count: data.missing.length }) }}</h2>
        <p class="muted">{{ $t('inventory.missingHint') }}</p>
        <InventoryCopyDetails
          :missing="data.missing"
          test-id="inventory-missing-copies"
          @action="previewAction"
        />
      </section>
    </template>

    <InventoryActionDialog
      v-if="actionOpen"
      :action="action"
      :path="actionPath"
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
</style>
