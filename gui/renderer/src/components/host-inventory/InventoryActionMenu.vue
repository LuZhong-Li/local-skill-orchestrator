<script setup lang="ts">
/** 单个盘点副本的动作入口；按钮只发起预览，不直接执行。 */
import { computed } from 'vue';
import type { ReconcileAction } from '@skill-manager/contract';
import {
  inventoryActionPath,
  inventoryActionsFor,
  type InventoryCopyLike,
} from '../../inventory-actions.ts';

const props = defineProps<{ copy: InventoryCopyLike }>();
const emit = defineEmits<{ action: [action: ReconcileAction, path: string] }>();
const actions = computed(() => inventoryActionsFor(props.copy));
const path = computed(() => inventoryActionPath(props.copy));
</script>

<template>
  <span v-if="actions.length === 0" class="muted">无可用动作</span>
  <span v-else class="action-menu">
    <button
      v-for="option in actions"
      :key="option.action"
      class="action-button"
      :class="{ danger: option.destructive }"
      :data-testid="`inventory-action-${option.action}`"
      :data-path="path"
      :disabled="option.disabled"
      :title="option.reason ?? '先预览影响范围，确认后才写入'"
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
</style>
