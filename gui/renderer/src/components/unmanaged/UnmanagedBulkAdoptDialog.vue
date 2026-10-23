<script setup lang="ts">
import type { ReconcileApplyData, Result } from '@skill-manager/contract';
import InventoryActionDialog from '../host-inventory/InventoryActionDialog.vue';
import type { BatchTarget } from '../../inventory-batch.ts';

defineProps<{
  targets: BatchTarget[];
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
}>();

const emit = defineEmits<{
  close: [];
  done: [result: ReconcileApplyData | null];
}>();

function forwardDone(result: ReconcileApplyData | null): void {
  emit('done', result);
}
</script>

<template>
  <InventoryActionDialog
    action="adopt"
    :targets="targets"
    :batch="true"
    :bulk-adopt="true"
    :context-note="$t('inventory.unmanagedAdopt.policy')"
    :run="run"
    @close="emit('close')"
    @done="forwardDone"
  />
</template>
