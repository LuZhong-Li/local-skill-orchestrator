<script setup lang="ts">
/** 副本 / 损坏 / 缺失明细：只呈现内核结果，不提供任何写动作。 */
import type {
  MissingInventoryCopy,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
  ReconcileAction,
} from '@skill-manager/contract';
import {
  authorityClass,
  authorityLabel,
  classificationKind,
  classificationLabel,
  evidenceText,
  formatLabel,
  ledgerSourceLabel,
  reasonText,
  visibilityLabel,
} from '../../host-inventory-presentation.ts';
import InventoryActionMenu from './InventoryActionMenu.vue';
import { t } from '../../i18n/index.ts';
import { copyKey, isCopySelectable } from '../../inventory-batch.ts';

const emit = defineEmits<{
  action: [action: ReconcileAction, path: string];
  'toggle-selection': [key: string];
  'toggle-all': [selected: boolean];
}>();
function forwardAction(action: ReconcileAction, path: string): void {
  emit('action', action, path);
}

withDefaults(
  defineProps<{
    copies?: ReconciledInventoryCopy[];
    corrupt?: ReconciledInventoryCorruptCopy[];
    missing?: MissingInventoryCopy[];
    testId?: string;
    emptyText?: string;
    // 批量选择：被选中的 key 集合
    selectedKeys?: Set<string>;
    // 是否显示选择列
    showSelection?: boolean;
  }>(),
  {
    copies: () => [],
    corrupt: () => [],
    missing: () => [],
    testId: 'inventory-copies',
    emptyText: () => t('inventory.noCopies'),
    selectedKeys: () => new Set<string>(),
    showSelection: false,
  },
);

function toggleCopy(key: string, selectable: boolean): void {
  if (!selectable) return;
  emit('toggle-selection', key);
}

function toggleAll(
  selectableCopies: Array<
    ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy
  >,
  selected: boolean,
): void {
  // 只翻转可选项
  emit('toggle-all', selected);
}
</script>

<template>
  <div class="copy-block" :data-testid="testId">
    <div v-if="copies.length > 0" class="table-scroll">
      <table class="copy-table">
        <thead>
          <tr>
            <th v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                data-testid="select-all-copies"
                :checked="
                  copies.filter((c) => isCopySelectable(c)).length > 0 &&
                  copies
                    .filter((c) => isCopySelectable(c))
                    .every((c) => selectedKeys.has(copyKey(c)))
                "
                :indeterminate.prop="
                  copies
                    .filter((c) => isCopySelectable(c))
                    .some((c) => selectedKeys.has(copyKey(c))) &&
                  !copies
                    .filter((c) => isCopySelectable(c))
                    .every((c) => selectedKeys.has(copyKey(c)))
                "
                :disabled="copies.filter((c) => isCopySelectable(c)).length === 0"
                @change="
                  toggleAll(
                    copies,
                    !copies
                      .filter((c) => isCopySelectable(c))
                      .every((c) => selectedKeys.has(copyKey(c))),
                  )
                "
              />
            </th>
            <th>Skill</th>
            <th>{{ $t('inventory.columns.version') }}</th>
            <th>{{ $t('inventory.columns.path') }}</th>
            <th>{{ $t('inventory.columns.visibility') }}</th>
            <th>{{ $t('inventory.columns.classification') }}</th>
            <th>{{ $t('inventory.columns.authority') }}</th>
            <th>{{ $t('inventory.columns.evidence') }}</th>
            <th>{{ $t('inventory.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="copy in copies"
            :key="copy.physical_key"
            :class="{ 'row-selected': showSelection && selectedKeys.has(copyKey(copy)) }"
          >
            <td v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                :data-testid="`select-copy-${copy.physical_key}`"
                :data-path="copy.path"
                :checked="selectedKeys.has(copyKey(copy))"
                :disabled="!isCopySelectable(copy)"
                @change="toggleCopy(copyKey(copy), isCopySelectable(copy))"
              />
            </td>
            <td>
              <code class="skill-id" :title="copy.skill_id ?? $t('inventory.unresolved')">
                {{ copy.skill_id ?? $t('inventory.unresolved') }}
              </code>
              <span class="muted host" :title="copy.host_id">{{ copy.host_id }}</span>
            </td>
            <td>{{ copy.version ?? '—' }}</td>
            <td class="path" :title="copy.path">
              <code class="path-text" :title="copy.path">{{ copy.path }}</code>
              <span class="muted">{{ formatLabel(copy.format) }}</span>
            </td>
            <td>{{ visibilityLabel(copy.visibility) }}</td>
            <td>
              <span class="tag" :class="classificationKind(copy.reconciliation.classification)">
                {{ classificationLabel(copy.reconciliation.classification) }}
              </span>
            </td>
            <td>
              <span
                class="authority"
                :class="authorityClass(copy.reconciliation.authority)"
                :title="evidenceText(copy.reconciliation.evidence)"
              >
                {{ authorityLabel(copy.reconciliation.authority) }}
              </span>
              <span class="muted source">{{
                ledgerSourceLabel(copy.reconciliation.ledger_source)
              }}</span>
            </td>
            <td class="reason">
              <span class="reason-text" :title="reasonText(copy.reconciliation)">
                {{ reasonText(copy.reconciliation) }}
              </span>
              <span class="muted evidence">{{ evidenceText(copy.reconciliation.evidence) }}</span>
            </td>
            <td>
              <InventoryActionMenu :copy="copy" @action="forwardAction" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="corrupt.length > 0" class="table-scroll">
      <table class="copy-table corrupt-table">
        <thead>
          <tr>
            <th v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                data-testid="select-all-corrupt"
                :checked="
                  corrupt.filter((c) => isCopySelectable(c)).length > 0 &&
                  corrupt
                    .filter((c) => isCopySelectable(c))
                    .every((c) => selectedKeys.has(copyKey(c)))
                "
                :disabled="corrupt.filter((c) => isCopySelectable(c)).length === 0"
                @change="
                  toggleAll(
                    corrupt,
                    !corrupt
                      .filter((c) => isCopySelectable(c))
                      .every((c) => selectedKeys.has(copyKey(c))),
                  )
                "
              />
            </th>
            <th>{{ $t('inventory.columns.corruptCopy') }}</th>
            <th>{{ $t('inventory.columns.path') }}</th>
            <th>{{ $t('inventory.columns.reason') }}</th>
            <th>{{ $t('inventory.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="copy in corrupt"
            :key="`corrupt-${copy.physical_key}`"
            :class="{ 'row-selected': showSelection && selectedKeys.has(copyKey(copy)) }"
          >
            <td v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                :data-path="copy.path"
                :checked="selectedKeys.has(copyKey(copy))"
                :disabled="!isCopySelectable(copy)"
                @change="toggleCopy(copyKey(copy), isCopySelectable(copy))"
              />
            </td>
            <td>
              <code class="skill-id" :title="copy.skill_id ?? $t('inventory.unresolved')">
                {{ copy.skill_id ?? $t('inventory.unresolved') }}
              </code>
              <span class="muted host" :title="copy.host_id">{{ copy.host_id }}</span>
            </td>
            <td class="path" :title="copy.path">
              <code class="path-text" :title="copy.path">{{ copy.path }}</code>
            </td>
            <td class="reason">
              <span class="reason-text" :title="copy.reason">{{ copy.reason }}</span>
            </td>
            <td>
              <InventoryActionMenu :copy="copy" @action="forwardAction" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="missing.length > 0" class="table-scroll">
      <table class="copy-table missing-table">
        <thead>
          <tr>
            <th v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                data-testid="select-all-missing"
                :checked="
                  missing.filter((c) => isCopySelectable(c)).length > 0 &&
                  missing
                    .filter((c) => isCopySelectable(c))
                    .every((c) => selectedKeys.has(copyKey(c)))
                "
                :disabled="missing.filter((c) => isCopySelectable(c)).length === 0"
                @change="
                  toggleAll(
                    missing,
                    !missing
                      .filter((c) => isCopySelectable(c))
                      .every((c) => selectedKeys.has(copyKey(c))),
                  )
                "
              />
            </th>
            <th>{{ $t('inventory.columns.missingCopy') }}</th>
            <th>{{ $t('inventory.columns.path') }}</th>
            <th>{{ $t('inventory.columns.ledger') }}</th>
            <th>{{ $t('inventory.columns.authority') }}</th>
            <th>{{ $t('inventory.columns.evidence') }}</th>
            <th>{{ $t('inventory.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="copy in missing"
            :key="`missing-${copy.host_id}-${copy.target_path}`"
            :class="{ 'row-selected': showSelection && selectedKeys.has(copyKey(copy)) }"
          >
            <td v-if="showSelection" class="col-select">
              <input
                type="checkbox"
                :data-path="copy.target_path"
                :checked="selectedKeys.has(copyKey(copy))"
                :disabled="!isCopySelectable(copy)"
                @change="toggleCopy(copyKey(copy), isCopySelectable(copy))"
              />
            </td>
            <td>
              <code class="skill-id" :title="copy.skill_id ?? $t('inventory.unresolved')">
                {{ copy.skill_id ?? $t('inventory.unresolved') }}
              </code>
              <span class="muted host" :title="copy.host_id">{{ copy.host_id }}</span>
            </td>
            <td class="path" :title="copy.target_path">
              <code class="path-text" :title="copy.target_path">{{ copy.target_path }}</code>
            </td>
            <td>{{ ledgerSourceLabel(copy.ledger_source) }}</td>
            <td>
              <span class="authority" :class="authorityClass(copy.authority)">
                {{ authorityLabel(copy.authority) }}
              </span>
            </td>
            <td class="reason">
              <span class="reason-text" :title="reasonText(copy)">{{ reasonText(copy) }}</span>
            </td>
            <td>
              <InventoryActionMenu :copy="copy" @action="forwardAction" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="copies.length === 0 && corrupt.length === 0 && missing.length === 0" class="muted">
      {{ emptyText }}
    </p>
  </div>
</template>

<style scoped>
.copy-block {
  display: grid;
  gap: calc(var(--space) * 3);
  width: 100%;
}

.table-scroll {
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

table {
  width: 100%;
  min-width: 980px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}

th,
td {
  text-align: left;
  padding: calc(var(--space) * 1.5) calc(var(--space) * 2);
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

th {
  position: sticky;
  top: 0;
  background: var(--surface-muted);
  z-index: 1;
}

.path,
.reason {
  max-width: 420px;
  overflow: hidden;
}

.skill-id,
.path-text,
.reason-text,
.host {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host,
.source,
.evidence {
  font-size: 11px;
}

.authority {
  display: inline-block;
  border-radius: 999px;
  padding: 0 calc(var(--space) * 1.5);
  font-size: 11px;
  border: 1px solid transparent;
}

.authority-authoritative {
  color: var(--success);
  border-color: #cfe0cf;
  background: #f2f7f2;
}

.authority-inferred {
  color: var(--warning);
  border-color: #ecdcc1;
  background: #fbf6ea;
}

.authority-insufficient {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--surface-muted);
}

.tag.managed {
  color: var(--success);
  border-color: #cfe0cf;
  background: #f2f7f2;
}

.tag.drift {
  color: var(--warning);
  border-color: #ecdcc1;
  background: #fbf6ea;
}

.tag.missing {
  color: var(--danger);
  border-color: #eccbc8;
  background: #fbeceb;
}

.tag.untracked,
.tag.other {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--surface-muted);
}

.col-select {
  width: 32px;
  padding-left: calc(var(--space) * 1.5);
  padding-right: calc(var(--space) * 1.5);
}

.row-selected {
  background: var(--accent-soft);
}
</style>
