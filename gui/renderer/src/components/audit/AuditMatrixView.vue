<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type {
  InventoryAuditData,
  InventoryAuditRow,
  InventoryExportResult,
  InventoryScanData,
  Result,
} from '@skill-manager/contract';
import AuditExportMenu from './AuditExportMenu.vue';
import { auditStatusKey, buildAuditMatrix } from '../../audit-matrix.ts';
import { localizedFindingsText } from '../../i18n/error-text.ts';
import { formatNumber, t } from '../../i18n/index.ts';

const props = defineProps<{
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
}>();

const audit = ref<InventoryAuditData | null>(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');

const matrix = computed(() => (audit.value === null ? null : buildAuditMatrix(audit.value)));

const totals = computed(() => {
  if (audit.value === null) return [];
  const summary = audit.value.summary;
  return [
    ['declared', summary.declared],
    ['distributed', summary.distributed],
    ['missing', summary.missing],
    ['frontmatterDrift', summary.drift_by_subtype?.frontmatter ?? 0],
    ['versionDrift', summary.drift_by_subtype?.version ?? 0],
    ['checksumDrift', summary.drift_by_subtype?.checksum ?? 0],
    ['visibilityMismatch', summary.visibility_mismatch],
    ['undeclared', summary.undeclared],
    ['insufficient', summary.insufficient],
  ] as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await props.run(['scan', '--inventory', '--audit']);
    if (!result.ok) {
      error.value =
        localizedFindingsText(result.findings) || t('audit.loadFailed', { code: result.exit_code });
      return;
    }
    const data = result.data as unknown as InventoryScanData;
    if (data.audit === undefined) {
      error.value = t('audit.invalidPayload');
      return;
    }
    audit.value = data.audit;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function statusesOf(rows: InventoryAuditRow[]): InventoryAuditRow[] {
  return [...rows].sort((left, right) => {
    const byStatus = left.status.localeCompare(right.status);
    return byStatus === 0 ? left.scope.localeCompare(right.scope) : byStatus;
  });
}

function exportResult(result: InventoryExportResult): void {
  notice.value = '';
  error.value = '';
  if (result.canceled) {
    notice.value = t('audit.export.canceled');
  } else if (result.error !== undefined && result.error !== '') {
    error.value = result.code
      ? t('audit.export.failedWithCode', { code: result.code, message: result.error })
      : t('audit.export.failed', { message: result.error });
  } else {
    notice.value = t('audit.export.succeeded', { path: result.path ?? '' });
  }
}

onMounted(load);
</script>

<template>
  <section class="audit-matrix-view" data-testid="audit-matrix">
    <div class="audit-head panel wide">
      <div>
        <h2>{{ $t('audit.title') }}</h2>
        <p class="muted">{{ $t('audit.intro') }}</p>
      </div>
      <div class="audit-actions">
        <AuditExportMenu :disabled="loading || audit === null" @result="exportResult" />
        <button data-testid="audit-refresh" :disabled="loading" @click="load">
          {{ loading ? $t('audit.loadingShort') : $t('common.refresh') }}
        </button>
      </div>
    </div>

    <p v-if="error !== ''" class="bad" data-testid="audit-error">{{ error }}</p>
    <p v-if="notice !== ''" class="ok" data-testid="audit-export-message">{{ notice }}</p>
    <p v-if="loading && audit === null" class="muted" data-testid="audit-loading">
      {{ $t('audit.loading') }}
    </p>
    <p v-else-if="audit === null" class="muted">{{ $t('audit.empty') }}</p>

    <template v-else>
      <div class="audit-summary" data-testid="audit-summary">
        <div v-for="[key, value] in totals" :key="key" class="summary-item">
          <span>{{ $t(`audit.summary.${key}`) }}</span>
          <strong>{{ formatNumber(value) }}</strong>
        </div>
      </div>

      <section class="panel wide">
        <div class="table-scroll">
          <table class="audit-table">
            <thead>
              <tr>
                <th class="skill-column">{{ $t('audit.columns.skill') }}</th>
                <th v-for="host in matrix?.hosts ?? []" :key="host">
                  <code>{{ host }}</code>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="skill in matrix?.skills ?? []" :key="skill.skill_id">
                <th>
                  <code :title="skill.skill_id">{{ skill.skill_id }}</code>
                </th>
                <td
                  v-for="host in matrix?.hosts ?? []"
                  :key="host"
                  :data-testid="`audit-cell-${skill.skill_id}-${host}`"
                >
                  <div v-if="(skill.cells[host] ?? []).length > 0" class="status-stack">
                    <span
                      v-for="row in statusesOf(skill.cells[host] ?? [])"
                      :key="`${row.scope}-${row.status}-${row.drift_subtype ?? ''}`"
                      class="status-tag"
                      :class="`status-${row.status}`"
                      :title="row.reasons.join(', ')"
                    >
                      {{ $t(auditStatusKey(row.status)) }}
                    </span>
                  </div>
                  <span v-else class="muted">{{ $t('common.none') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="(matrix?.skills.length ?? 0) === 0" class="muted">{{ $t('audit.noRows') }}</p>
      </section>

      <section
        v-if="(matrix?.driftDetails.length ?? 0) > 0"
        class="panel wide"
        data-testid="audit-drift-details"
      >
        <h2>{{ $t('audit.driftDetails') }}</h2>
        <details
          v-for="detail in matrix?.driftDetails ?? []"
          :key="`${detail.skill_id}-${detail.host}-${detail.scope}-${detail.subtype}`"
          class="drift-detail"
        >
          <summary>
            <code>{{ detail.skill_id }}</code>
            <span>{{ detail.host }}</span>
            <span class="status-tag status-drift">
              {{ $t(`audit.driftSubtype.${detail.subtype}`) }}
            </span>
          </summary>
          <div v-if="detail.fields.length > 0" class="field-diffs">
            <div v-for="field in detail.fields" :key="field.field" class="field-diff">
              <strong>{{ field.field }}</strong>
              <ul>
                <li v-for="value in field.values" :key="`${value.host}-${value.role}`">
                  <code>{{ value.host }}</code>
                  <span class="muted">{{ value.role }}</span>
                  <span>{{ value.value ?? $t('audit.missingValue') }}</span>
                </li>
              </ul>
            </div>
          </div>
          <div v-if="detail.version" class="field-diffs">
            <div class="field-diff">
              <strong>version</strong>
              <ul>
                <li v-for="value in detail.version.values" :key="`${value.host}-${value.role}`">
                  <code>{{ value.host }}</code>
                  <span class="muted">{{ value.role }}</span>
                  <span>{{ value.version ?? $t('audit.missingValue') }}</span>
                </li>
              </ul>
            </div>
          </div>
        </details>
      </section>
    </template>
  </section>
</template>

<style scoped>
.audit-matrix-view {
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.audit-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: calc(var(--space) * 3);
  flex-wrap: wrap;
}

.audit-head h2,
.audit-head p {
  margin: 0;
}

.audit-actions {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
}

.audit-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: calc(var(--space) * 2);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: var(--space);
  padding: calc(var(--space) * 2);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.summary-item span {
  color: var(--muted);
  font-size: 12px;
}

.summary-item strong {
  font-size: 22px;
}

.table-scroll {
  overflow-x: auto;
}

.audit-table {
  width: 100%;
  border-collapse: collapse;
}

.audit-table th,
.audit-table td {
  min-width: 130px;
  padding: calc(var(--space) * 2);
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.audit-table .skill-column,
.audit-table tbody th {
  min-width: 180px;
  max-width: 260px;
}

.audit-table code {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space);
  align-items: flex-start;
}

.status-tag {
  display: inline-flex;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.status-distributed {
  color: var(--success);
  border-color: var(--success);
}

.status-missing,
.status-drift,
.status-visibility_mismatch {
  color: var(--danger);
  border-color: var(--danger);
}

.status-undeclared,
.status-insufficient {
  color: var(--warning);
  border-color: var(--warning);
}

.drift-detail {
  padding: calc(var(--space) * 2) 0;
  border-top: 1px solid var(--border);
}

.drift-detail summary {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  cursor: pointer;
}

.field-diffs {
  display: grid;
  gap: calc(var(--space) * 2);
  margin-top: calc(var(--space) * 2);
}

.field-diff ul {
  margin: var(--space) 0 0;
  padding-left: calc(var(--space) * 4);
}

.field-diff li {
  display: flex;
  gap: calc(var(--space) * 2);
  padding: var(--space) 0;
}

.ok {
  color: var(--success);
}

.bad {
  color: var(--danger);
}
</style>
