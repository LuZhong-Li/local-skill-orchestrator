<script setup lang="ts">
/** 单个盘点副本的动作入口；按钮只发起预览，不直接执行。 */
import { computed } from 'vue';
import type { ReconcileAction } from '@skill-manager/contract';
import {
  inventoryActionPath,
  inventoryActionsFor,
  isUserWritableCopy,
  type InventoryCopyLike,
} from '../../inventory-actions.ts';

const props = defineProps<{ copy: InventoryCopyLike }>();
const emit = defineEmits<{ action: [action: ReconcileAction, path: string] }>();
const actions = computed(() => inventoryActionsFor(props.copy));
const path = computed(() => inventoryActionPath(props.copy));
const managedByTool = computed(() => !isUserWritableCopy(props.copy));
</script>

<template>
  <span v-if="managedByTool" class="muted managed-by-tool">
    {{ $t('inventory.action.managedByTool') }}
  </span>
  <span v-else-if="actions.length === 0" class="muted">{{ $t('inventory.action.noActions') }}</span>
  <span v-else class="action-menu">
    <button
      v-for="option in actions"
      :key="option.action"
      class="action-button"
      :class="{ danger: option.destructive }"
      :data-testid="`inventory-action-${option.action}`"
      :data-path="path"
      :disabled="option.disabled"
      :title="option.reason ?? $t('inventory.action.previewHint')"
      @click="emit('action', option.action, path)"
    >
      {{ option.label }}
    </button>
  </span>
</template>

<style scoped>
.action-menu {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 1.5);
}

.action-button {
  font-size: 11px;
  padding: calc(var(--space) * 0.75) calc(var(--space) * 1.5);
}

.action-button.danger {
  color: var(--danger);
  border-color: #eccbc8;
}

.managed-by-tool {
  font-size: 11px;
}
</style>
