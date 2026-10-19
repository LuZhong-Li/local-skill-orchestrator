<script setup lang="ts">
/** 宿主分组：内置与第三方 x- 宿主分区，根与共享根消费关系逐条展示。 */
import { computed } from 'vue';
import type { InventoryHostNode, ReconcileAction } from '@skill-manager/contract';
import {
  nonZeroClassificationEntries,
  roleLabel,
  rootStateLabel,
} from '../../host-inventory-presentation.ts';
import InventoryCopyDetails from './InventoryCopyDetails.vue';

const props = defineProps<{ hosts: InventoryHostNode[] }>();
const emit = defineEmits<{ action: [action: ReconcileAction, path: string] }>();
function forwardAction(action: ReconcileAction, path: string): void {
  emit('action', action, path);
}

const builtin = computed(() => props.hosts.filter((host) => host.host_group === 'builtin'));
const thirdParty = computed(() => props.hosts.filter((host) => host.host_group === 'plugin'));
</script>

<template>
  <section class="host-section" data-testid="inventory-builtin-hosts">
    <h2>内置宿主</h2>
    <p v-if="builtin.length === 0" class="muted">没有可枚举的内置宿主根。</p>
    <article
      v-for="host in builtin"
      :key="host.host_id"
      class="panel wide host-card"
      :data-inventory-host-id="host.host_id"
    >
      <header class="host-head">
        <div>
          <h3>{{ host.display_name }}</h3>
          <code class="muted">{{ host.host_id }}</code>
        </div>
        <div class="host-counts">
          <strong>{{ host.counts.total_copies }}</strong> 副本
          <span class="muted">{{ host.counts.unique_skills }} 个不同技能</span>
          <span v-if="host.counts.corrupt_count > 0" class="warn">
            损坏 {{ host.counts.corrupt_count }}
          </span>
        </div>
      </header>
      <ul class="minor-chips">
        <li
          v-for="entry in nonZeroClassificationEntries(host.counts.by_classification)"
          :key="entry.key"
        >
          {{ entry.label }} <strong>{{ entry.count }}</strong>
        </li>
      </ul>

      <div
        v-for="node in host.roots"
        :key="node.root.root_id"
        class="root-block"
        :data-root-id="node.root.root_id"
      >
        <div class="root-head">
          <code class="root-path" :title="node.root.path">{{ node.root.path }}</code>
          <span class="tag role">{{ roleLabel(node.root.root_role) }}</span>
          <span class="tag" :class="node.root.state">{{ rootStateLabel(node.root.state) }}</span>
          <span class="muted">{{ node.root.recursive ? '递归' : '顶层' }}</span>
          <span class="muted">
            {{ node.copies.length }} 副本 · {{ node.corrupt.length }} 损坏 ·
            {{ node.missing.length }} 缺失
          </span>
        </div>
        <p class="root-meta muted">
          来源 {{ node.root.origin }}｜形态 {{ node.root.kind }}｜根 {{ node.root.root_id }}
          <span v-if="node.root.pending_verification" class="tag pending">待真机验证</span>
        </p>
        <p
          v-if="node.root.consumed_by.length > 0"
          class="consumers"
          data-testid="inventory-consumed-by"
        >
          消费宿主：
          <code v-for="consumer in node.root.consumed_by" :key="consumer">{{ consumer }}</code>
        </p>
        <p v-if="node.root.platform_notes" class="muted note">{{ node.root.platform_notes }}</p>
        <p v-if="node.root.reason" class="muted note">根状态说明：{{ node.root.reason }}</p>

        <details v-if="node.copies.length > 0" class="copy-fold">
          <summary>副本明细（{{ node.copies.length }}）</summary>
          <InventoryCopyDetails
            :copies="node.copies"
            test-id="inventory-copies"
            @action="forwardAction"
          />
        </details>
        <details v-if="node.corrupt.length > 0" class="copy-fold">
          <summary>损坏 / 不可读（{{ node.corrupt.length }}）</summary>
          <InventoryCopyDetails
            :corrupt="node.corrupt"
            test-id="inventory-root-corrupt"
            @action="forwardAction"
          />
        </details>
        <details v-if="node.missing.length > 0" class="copy-fold">
          <summary>账本记录但副本缺失（{{ node.missing.length }}）</summary>
          <InventoryCopyDetails
            :missing="node.missing"
            test-id="inventory-root-missing"
            @action="forwardAction"
          />
        </details>
      </div>
    </article>
  </section>

  <section class="host-section" data-testid="inventory-third-party-hosts">
    <h2>第三方宿主（x- 命名空间）</h2>
    <p v-if="thirdParty.length === 0" class="muted">
      没有已启用的第三方 x- 宿主；插件管理仍在插件视图中进行。
    </p>
    <article
      v-for="host in thirdParty"
      :key="host.host_id"
      class="panel wide host-card"
      :data-inventory-host-id="host.host_id"
    >
      <header class="host-head">
        <div>
          <h3>{{ host.display_name }}</h3>
          <code class="muted">{{ host.host_id }}</code>
          <span class="tag x-host">x- 宿主</span>
        </div>
        <div class="host-counts">
          <strong>{{ host.counts.total_copies }}</strong> 副本
          <span class="muted">{{ host.counts.unique_skills }} 个不同技能</span>
        </div>
      </header>
      <div
        v-for="node in host.roots"
        :key="node.root.root_id"
        class="root-block"
        :data-root-id="node.root.root_id"
      >
        <div class="root-head">
          <code class="root-path" :title="node.root.path">{{ node.root.path }}</code>
          <span class="tag role">{{ roleLabel(node.root.root_role) }}</span>
          <span class="tag" :class="node.root.state">{{ rootStateLabel(node.root.state) }}</span>
          <span class="muted">{{ node.root.recursive ? '递归' : '顶层' }}</span>
        </div>
        <details v-if="node.copies.length > 0" class="copy-fold">
          <summary>副本明细（{{ node.copies.length }}）</summary>
          <InventoryCopyDetails
            :copies="node.copies"
            test-id="inventory-copies"
            @action="forwardAction"
          />
        </details>
        <details v-if="node.corrupt.length > 0" class="copy-fold">
          <summary>损坏 / 不可读（{{ node.corrupt.length }}）</summary>
          <InventoryCopyDetails
            :corrupt="node.corrupt"
            test-id="inventory-root-corrupt"
            @action="forwardAction"
          />
        </details>
      </div>
    </article>
  </section>
</template>

<style scoped>
.host-section {
  display: grid;
  gap: calc(var(--space) * 3);
}

.host-card {
  justify-items: stretch;
}

.host-head {
  display: flex;
  justify-content: space-between;
  gap: calc(var(--space) * 3);
  align-items: baseline;
  flex-wrap: wrap;
}

.host-head h3 {
  font-size: 15px;
}

.host-counts {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: baseline;
}

.minor-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2);
  font-size: 12px;
}

.root-block {
  border-top: 1px solid var(--border);
  padding-top: calc(var(--space) * 3);
  display: grid;
  gap: calc(var(--space) * 1.5);
}

.root-head {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: baseline;
  flex-wrap: wrap;
}

.root-path {
  word-break: break-all;
  font-size: 12px;
}

.root-meta,
.consumers,
.note {
  margin: 0;
  font-size: 12px;
}

.consumers {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: calc(var(--space) * 1.5);
}

.copy-fold {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: calc(var(--space) * 2);
  background: var(--surface-muted);
}

.copy-fold summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
}

.tag.role {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--surface);
}

.tag.ok,
.tag.empty {
  color: var(--success);
  border-color: #cfe0cf;
  background: #f2f7f2;
}

.tag.missing,
.tag.unreadable {
  color: var(--danger);
  border-color: #eccbc8;
  background: #fbeceb;
}

.tag.unconfigured,
.tag.not_applicable {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--surface-muted);
}

.tag.pending,
.tag.x-host {
  color: var(--warning);
  border-color: #ecdcc1;
  background: #fbf6ea;
}

.warn {
  color: var(--warning);
  font-size: 12px;
}
</style>
