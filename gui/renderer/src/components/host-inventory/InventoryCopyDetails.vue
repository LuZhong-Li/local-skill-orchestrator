<script setup lang="ts">
/** 副本 / 损坏 / 缺失明细：只呈现内核结果，不提供任何写动作。 */
import type {
  MissingInventoryCopy,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
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

withDefaults(
  defineProps<{
    copies?: ReconciledInventoryCopy[];
    corrupt?: ReconciledInventoryCorruptCopy[];
    missing?: MissingInventoryCopy[];
    testId?: string;
    emptyText?: string;
  }>(),
  {
    copies: () => [],
    corrupt: () => [],
    missing: () => [],
    testId: 'inventory-copies',
    emptyText: '没有可展示的副本。',
  },
);
</script>

<template>
  <div class="copy-block" :data-testid="testId">
    <div v-if="copies.length > 0" class="table-scroll">
      <table class="copy-table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>版本</th>
            <th>路径</th>
            <th>可见性</th>
            <th>分类</th>
            <th>权威</th>
            <th>判定依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="copy in copies" :key="copy.physical_key">
            <td>
              <code>{{ copy.skill_id ?? '（未解析）' }}</code>
              <span class="muted host">{{ copy.host_id }}</span>
            </td>
            <td>{{ copy.version ?? '—' }}</td>
            <td class="path" :title="copy.path">
              <code>{{ copy.path }}</code>
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
              {{ reasonText(copy.reconciliation) }}
              <span class="muted evidence">{{ evidenceText(copy.reconciliation.evidence) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="corrupt.length > 0" class="table-scroll">
      <table class="copy-table corrupt-table">
        <thead>
          <tr>
            <th>损坏副本</th>
            <th>路径</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="copy in corrupt" :key="`corrupt-${copy.physical_key}`">
            <td>
              <code>{{ copy.skill_id ?? '（未解析）' }}</code>
              <span class="muted host">{{ copy.host_id }}</span>
            </td>
            <td class="path" :title="copy.path">
              <code>{{ copy.path }}</code>
            </td>
            <td class="reason">{{ copy.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="missing.length > 0" class="table-scroll">
      <table class="copy-table missing-table">
        <thead>
          <tr>
            <th>缺失副本</th>
            <th>路径</th>
            <th>账本</th>
            <th>权威</th>
            <th>判定依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="copy in missing" :key="`missing-${copy.host_id}-${copy.target_path}`">
            <td>
              <code>{{ copy.skill_id ?? '（未解析）' }}</code>
              <span class="muted host">{{ copy.host_id }}</span>
            </td>
            <td class="path" :title="copy.target_path">
              <code>{{ copy.target_path }}</code>
            </td>
            <td>{{ ledgerSourceLabel(copy.ledger_source) }}</td>
            <td>
              <span class="authority" :class="authorityClass(copy.authority)">
                {{ authorityLabel(copy.authority) }}
              </span>
            </td>
            <td class="reason">{{ reasonText(copy) }}</td>
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
  word-break: break-all;
}

.host,
.source,
.evidence {
  display: block;
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
</style>
