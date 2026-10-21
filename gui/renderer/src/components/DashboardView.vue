<script setup lang="ts">
/** 仪表盘：空工作区引导、未管理引导与 Skill 卡片列表。 */
import SkillCard from './SkillCard.vue';
import type { SkillSummary } from '../types.ts';

defineProps<{
  initialized: boolean;
  records: SkillSummary[];
}>();

defineEmits<{
  init: [];
  scan: [];
  inventory: [];
  open: [record: SkillSummary];
}>();
</script>

<template>
  <section class="content" data-testid="dashboard-view">
    <div v-if="!initialized" class="empty">
      <h2>{{ $t('dashboard.uninitializedTitle') }}</h2>
      <p class="muted">{{ $t('dashboard.uninitializedBody') }}</p>
      <div class="empty-actions">
        <button class="primary" data-testid="dashboard-init" @click="$emit('init')">
          {{ $t('dashboard.initialize') }}
        </button>
        <button data-testid="open-inventory" @click="$emit('inventory')">
          {{ $t('dashboard.inventoryInstalled') }}
        </button>
      </div>
      <p class="muted hint">{{ $t('dashboard.inventoryHint') }}</p>
    </div>
    <div v-else-if="records.length === 0" class="empty">
      <h2>{{ $t('dashboard.emptyTitle') }}</h2>
      <p class="muted">{{ $t('dashboard.emptyBody') }}</p>
      <div class="empty-actions">
        <button class="primary" data-testid="dashboard-scan" @click="$emit('scan')">
          {{ $t('dashboard.scanNow') }}
        </button>
        <button data-testid="open-inventory" @click="$emit('inventory')">
          {{ $t('dashboard.inventoryInstalled') }}
        </button>
      </div>
    </div>
    <div v-else class="grid">
      <SkillCard
        v-for="record in records"
        :key="record.id"
        :record="record"
        @open="$emit('open', record)"
      />
    </div>
  </section>
</template>

<style scoped>
.content {
  flex: 1;
  overflow: auto;
  padding: calc(var(--space) * 5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
  gap: calc(var(--space) * 4);
}

.empty {
  margin: auto;
  text-align: center;
  display: grid;
  gap: calc(var(--space) * 3);
  justify-items: center;
  max-width: 460px;
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2);
  justify-content: center;
}

.hint {
  font-size: 12px;
}
</style>
