<script setup lang="ts">
/** 盘点摘要：用户主计数置顶，系统 / 平台 / 项目分组默认折叠。 */
import type { InventorySummary } from '@skill-manager/contract';
import {
  classificationGroupRows,
  nonZeroClassificationEntries,
  roleFoldNote,
  roleLabel,
  SECONDARY_ROLES,
} from '../../host-inventory-presentation.ts';

defineProps<{ summary: InventorySummary }>();
</script>

<template>
  <div class="panel wide hero" data-testid="inventory-main-count">
    <span class="muted">用户安装（主计数）</span>
    <p class="count-line">
      <strong>{{ summary.main.total_copies }}</strong> 个安装副本
      <span class="divider">/</span>
      <strong>{{ summary.main.unique_skills }}</strong> 个不同技能
    </p>
    <p class="muted hint">
      已按物理路径去重；系统 / 平台 / 项目级副本不计入主计数。本次根
      {{ summary.roots_total }} 个，物理去重移除 {{ summary.duplicates_removed }} 份重复副本。
    </p>
  </div>

  <div class="summary-columns">
    <section class="panel">
      <h2>分类分布</h2>
      <ul class="chips" data-testid="inventory-classification-groups">
        <li
          v-for="row in classificationGroupRows(summary.classification_groups)"
          :key="row.key"
          :data-classification="row.key"
        >
          <span class="tag" :class="row.key">{{ row.label }}</span>
          <strong>{{ row.count }}</strong>
          <span v-if="row.detail" class="muted">{{ row.detail }}</span>
        </li>
      </ul>
    </section>

    <section class="panel" data-testid="inventory-role-groups">
      <h2>按角色分组</h2>
      <div class="role-row" data-role="user">
        <span>{{ roleLabel('user') }}</span>
        <strong>{{ summary.roles.user.total_copies }} 副本</strong>
        <span class="muted">{{ summary.roles.user.unique_skills }} 个不同技能</span>
      </div>
      <details
        v-for="role in SECONDARY_ROLES"
        :key="role"
        class="role-row"
        :data-role="role"
        data-testid="inventory-role-fold"
      >
        <summary>
          <span>{{ roleLabel(role) }}</span>
          <strong>{{ summary.roles[role].total_copies }} 副本</strong>
          <span class="muted">{{ summary.roles[role].unique_skills }} 个不同技能</span>
        </summary>
        <p class="muted note">{{ roleFoldNote(role) }}</p>
        <p v-if="summary.roles[role].corrupt_count > 0" class="warn">
          损坏 / 不可读 {{ summary.roles[role].corrupt_count }} 份
        </p>
        <ul class="minor-chips">
          <li
            v-for="entry in nonZeroClassificationEntries(summary.roles[role].by_classification)"
            :key="entry.key"
          >
            {{ entry.label }} <strong>{{ entry.count }}</strong>
          </li>
        </ul>
      </details>
    </section>
  </div>
</template>

<style scoped>
.hero {
  background: linear-gradient(135deg, var(--accent-soft), var(--surface) 70%);
}

.count-line {
  margin: 0;
  font-size: 22px;
}

.count-line strong {
  font-size: 32px;
  line-height: 1;
}

.divider {
  color: var(--text-muted);
  margin: 0 calc(var(--space));
}

.hint,
.note {
  font-size: 12px;
}

.summary-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: calc(var(--space) * 4);
}

.chips,
.minor-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: calc(var(--space) * 2);
}

.chips li {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
}

.minor-chips {
  font-size: 12px;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
}

.role-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: calc(var(--space) * 2);
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: calc(var(--space) * 1.5) 0;
  width: 100%;
}

details.role-row {
  display: block;
}

details.role-row summary {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: calc(var(--space) * 2);
  align-items: center;
  cursor: pointer;
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

.warn {
  color: var(--warning);
  font-size: 12px;
}
</style>
