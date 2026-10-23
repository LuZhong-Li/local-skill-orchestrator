<script setup lang="ts">
import { ref } from 'vue';
import type { AuditReportFormat, InventoryExportResult } from '@skill-manager/contract';

type ReportFormat = Exclude<AuditReportFormat, 'json'>;

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ result: [result: InventoryExportResult] }>();
const open = ref(false);
const busy = ref<ReportFormat | null>(null);
async function exportReport(format: ReportFormat): Promise<void> {
  if (props.disabled === true || busy.value !== null) return;
  busy.value = format;
  open.value = false;
  try {
    const result = await globalThis.window.skillManager.audit.export(format);
    emit('result', result);
  } catch (cause) {
    emit('result', {
      canceled: false,
      error: cause instanceof Error ? cause.message : String(cause),
      code: 'E-IO-002',
    });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="export-menu" data-testid="audit-export-menu">
    <button
      class="primary"
      data-testid="audit-export-toggle"
      :disabled="disabled || busy !== null"
      :aria-expanded="open"
      @click="open = !open"
    >
      {{ busy === null ? $t('audit.export.button') : $t('audit.export.exporting') }}
    </button>
    <div v-if="open" class="menu" role="menu">
      <button role="menuitem" data-testid="audit-export-markdown" @click="exportReport('markdown')">
        {{ $t('audit.export.markdown') }}
      </button>
      <button role="menuitem" data-testid="audit-export-html" @click="exportReport('html')">
        {{ $t('audit.export.html') }}
      </button>
      <button role="menuitem" data-testid="audit-export-sarif" @click="exportReport('sarif')">
        {{ $t('audit.export.sarif') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.export-menu {
  position: relative;
}

.menu {
  position: absolute;
  z-index: 10;
  top: calc(100% + var(--space));
  right: 0;
  min-width: 160px;
  padding: var(--space);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.menu button {
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
}

.menu button:hover {
  background: var(--accent-soft);
}
</style>
