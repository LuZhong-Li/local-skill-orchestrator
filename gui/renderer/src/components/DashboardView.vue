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
      <h2>工作区尚未初始化</h2>
      <p class="muted">先在当前工作区建立索引与标准目录，然后扫描已有的 Skill。</p>
      <div class="empty-actions">
        <button class="primary" data-testid="dashboard-init" @click="$emit('init')">
          初始化工作区
        </button>
        <button data-testid="open-inventory" @click="$emit('inventory')">
          盘点这台电脑上已安装的 Skill
        </button>
      </div>
      <p class="muted hint">盘点不需要初始化工作区，也不会改动任何目录。</p>
    </div>
    <div v-else-if="records.length === 0" class="empty">
      <h2>还没有已管理的 Skill</h2>
      <p class="muted">执行一次扫描，把工作区里已有的 Skill 登记进来。</p>
      <div class="empty-actions">
        <button class="primary" data-testid="dashboard-scan" @click="$emit('scan')">
          立即扫描
        </button>
        <button data-testid="open-inventory" @click="$emit('inventory')">
          盘点这台电脑上已安装的 Skill
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
