<script setup lang="ts">
/** 宿主分组：内置与第三方 x- 宿主分区，根与共享根消费关系逐条展示。 */
import { computed } from 'vue';
import type {
  InventoryHostNode,
  InventoryHostRootNode,
  MissingInventoryCopy,
  ReconcileAction,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
} from '@skill-manager/contract';
import {
  nonZeroClassificationEntries,
  roleLabel,
  roleVisualClass,
  rootStateLabel,
  rootStateHint,
  rootStateVisualClass,
} from '../../host-inventory-presentation.ts';
import InventoryCopyDetails from './InventoryCopyDetails.vue';
import { copyKey, isCopySelectable } from '../../inventory-batch.ts';

type RootLike = InventoryHostRootNode;

const props = defineProps<{
  hosts: InventoryHostNode[];
  selectedKeys?: Set<string>;
  showSelection?: boolean;
}>();

const emit = defineEmits<{
  action: [action: ReconcileAction, path: string];
  'toggle-selection': [key: string];
  'toggle-root': [rootId: string, selected: boolean];
}>();

function forwardAction(action: ReconcileAction, path: string): void {
  emit('action', action, path);
}

const builtin = computed(() => props.hosts.filter((host) => host.host_group === 'builtin'));
const thirdParty = computed(() => props.hosts.filter((host) => host.host_group === 'plugin'));

function allCopiesOf(
  node: RootLike,
): Array<ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy> {
  return [...node.copies, ...node.corrupt, ...node.missing];
}

function rootAllSelected(node: RootLike): boolean {
  const selectable = allCopiesOf(node).filter(isCopySelectable);
  if (selectable.length === 0) return false;
  const keys = props.selectedKeys ?? new Set<string>();
  return selectable.every((c) => keys.has(copyKey(c)));
}

function rootSomeSelected(node: RootLike): boolean {
  const keys = props.selectedKeys ?? new Set<string>();
  return allCopiesOf(node)
    .filter(isCopySelectable)
    .some((c) => keys.has(copyKey(c)));
}

function toggleRoot(rootId: string, node: RootLike): void {
  emit('toggle-root', rootId, !rootAllSelected(node));
}

function toggleCopy(key: string): void {
  emit('toggle-selection', key);
}
</script>

<template>
  <section class="host-section" data-testid="inventory-builtin-hosts">
    <h2>{{ $t('plugins.builtinHosts') }}</h2>
    <p v-if="builtin.length === 0" class="muted">{{ $t('inventory.noBuiltinRoots') }}</p>
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
          <strong>{{ host.counts.total_copies }}</strong>
          <span class="muted">
            {{ $t('inventory.copies', { count: '' }).trim() }} /
            {{ $t('inventory.uniqueSkills', { count: host.counts.unique_skills }) }}
          </span>
          <span v-if="host.counts.corrupt_count > 0" class="warn">
            {{ $t('inventory.corruptCount', { count: host.counts.corrupt_count }) }}
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
        :class="roleVisualClass(node.root.root_role)"
        :data-root-id="node.root.root_id"
      >
        <div class="root-head">
          <label
            v-if="showSelection"
            class="root-select"
            :class="{ 'has-selection': rootSomeSelected(node) }"
          >
            <input
              type="checkbox"
              :data-testid="`select-root-${node.root.root_id}`"
              :checked="rootAllSelected(node)"
              :indeterminate.prop="rootSomeSelected(node) && !rootAllSelected(node)"
              :disabled="
                [...node.copies, ...node.corrupt, ...node.missing].filter((c) =>
                  isCopySelectable(c),
                ).length === 0
              "
              @change="toggleRoot(node.root.root_id, node)"
            />
          </label>
          <code class="root-path" :title="node.root.path">{{ node.root.path }}</code>
          <span
            class="tag role-tag"
            :class="roleVisualClass(node.root.root_role)"
            data-testid="root-role-tag"
          >
            {{ roleLabel(node.root.root_role) }}
          </span>
          <span
            class="tag root-state-tag"
            :class="rootStateVisualClass(node.root.state)"
            data-testid="root-state-tag"
          >
            {{ rootStateLabel(node.root.state) }}
          </span>
          <span class="muted">
            {{ node.root.recursive ? $t('inventory.recursive') : $t('inventory.topLevel') }}
          </span>
          <span class="muted">
            {{
              $t('inventory.copyCorruptMissing', {
                copies: node.copies.length,
                corrupt: node.corrupt.length,
                missing: node.missing.length,
              })
            }}
          </span>
        </div>
        <p class="root-meta muted">
          {{
            $t('inventory.sourceFormRoot', {
              origin: node.root.origin,
              kind: node.root.kind,
              root: node.root.root_id,
            })
          }}
          <span v-if="node.root.pending_verification" class="tag pending">
            {{ $t('inventory.pendingVerification') }}
          </span>
        </p>
        <p
          v-if="node.root.consumed_by.length > 0"
          class="consumers"
          data-testid="inventory-consumed-by"
        >
          {{ $t('inventory.consumers') }}
          <code v-for="consumer in node.root.consumed_by" :key="consumer">{{ consumer }}</code>
        </p>
        <p v-if="node.root.platform_notes" class="muted note">{{ node.root.platform_notes }}</p>
        <p v-if="node.root.reason" class="muted note">
          {{ $t('inventory.rootReason', { reason: node.root.reason }) }}
        </p>
        <p
          v-if="allCopiesOf(node).length === 0 && node.root.state !== 'ok'"
          class="root-empty-state"
          data-testid="root-empty-state"
        >
          {{ rootStateHint(node.root.state) }}
        </p>

        <details v-if="node.copies.length > 0" class="copy-fold">
          <summary>{{ $t('inventory.copyDetails', { count: node.copies.length }) }}</summary>
          <InventoryCopyDetails
            :copies="node.copies"
            test-id="inventory-copies"
            :selected-keys="selectedKeys ?? new Set()"
            :show-selection="showSelection"
            @action="forwardAction"
            @toggle-selection="toggleCopy"
          />
        </details>
        <details v-if="node.corrupt.length > 0" class="copy-fold">
          <summary>{{ $t('inventory.corruptDetails', { count: node.corrupt.length }) }}</summary>
          <InventoryCopyDetails
            :corrupt="node.corrupt"
            test-id="inventory-root-corrupt"
            :selected-keys="selectedKeys ?? new Set()"
            :show-selection="showSelection"
            @action="forwardAction"
            @toggle-selection="toggleCopy"
          />
        </details>
        <details v-if="node.missing.length > 0" class="copy-fold">
          <summary>{{ $t('inventory.missingDetails', { count: node.missing.length }) }}</summary>
          <InventoryCopyDetails
            :missing="node.missing"
            test-id="inventory-root-missing"
            :selected-keys="selectedKeys ?? new Set()"
            :show-selection="showSelection"
            @action="forwardAction"
            @toggle-selection="toggleCopy"
          />
        </details>
      </div>
    </article>
  </section>

  <section class="host-section" data-testid="inventory-third-party-hosts">
    <h2>{{ $t('plugins.thirdPartyHosts') }}</h2>
    <p v-if="thirdParty.length === 0" class="muted">
      {{ $t('inventory.noThirdPartyHosts') }}
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
          <span class="tag x-host">{{ $t('inventory.xHost') }}</span>
        </div>
        <div class="host-counts">
          <strong>{{ host.counts.total_copies }}</strong>
          <span class="muted">
            {{ $t('inventory.copies', { count: '' }).trim() }} /
            {{ $t('inventory.uniqueSkills', { count: host.counts.unique_skills }) }}
          </span>
        </div>
      </header>
      <div
        v-for="node in host.roots"
        :key="node.root.root_id"
        class="root-block"
        :class="roleVisualClass(node.root.root_role)"
        :data-root-id="node.root.root_id"
      >
        <div class="root-head">
          <label
            v-if="showSelection"
            class="root-select"
            :class="{ 'has-selection': rootSomeSelected(node) }"
          >
            <input
              type="checkbox"
              :checked="rootAllSelected(node)"
              :indeterminate.prop="rootSomeSelected(node) && !rootAllSelected(node)"
              :disabled="
                [...node.copies, ...node.corrupt, ...node.missing].filter((c) =>
                  isCopySelectable(c),
                ).length === 0
              "
              @change="toggleRoot(node.root.root_id, node)"
            />
          </label>
          <code class="root-path" :title="node.root.path">{{ node.root.path }}</code>
          <span
            class="tag role-tag"
            :class="roleVisualClass(node.root.root_role)"
            data-testid="root-role-tag"
          >
            {{ roleLabel(node.root.root_role) }}
          </span>
          <span
            class="tag root-state-tag"
            :class="rootStateVisualClass(node.root.state)"
            data-testid="root-state-tag"
          >
            {{ rootStateLabel(node.root.state) }}
          </span>
          <span class="muted">
            {{ node.root.recursive ? $t('inventory.recursive') : $t('inventory.topLevel') }}
          </span>
        </div>
        <p
          v-if="allCopiesOf(node).length === 0 && node.root.state !== 'ok'"
          class="root-empty-state"
          data-testid="root-empty-state"
        >
          {{ rootStateHint(node.root.state) }}
        </p>
        <details v-if="node.copies.length > 0" class="copy-fold">
          <summary>{{ $t('inventory.copyDetails', { count: node.copies.length }) }}</summary>
          <InventoryCopyDetails
            :copies="node.copies"
            test-id="inventory-copies"
            :selected-keys="selectedKeys ?? new Set()"
            :show-selection="showSelection"
            @action="forwardAction"
            @toggle-selection="toggleCopy"
          />
        </details>
        <details v-if="node.corrupt.length > 0" class="copy-fold">
          <summary>{{ $t('inventory.corruptDetails', { count: node.corrupt.length }) }}</summary>
          <InventoryCopyDetails
            :corrupt="node.corrupt"
            test-id="inventory-root-corrupt"
            :selected-keys="selectedKeys ?? new Set()"
            :show-selection="showSelection"
            @action="forwardAction"
            @toggle-selection="toggleCopy"
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
  border-left: 3px solid var(--root-role-color, var(--border));
  padding: calc(var(--space) * 3) 0 calc(var(--space) * 2) calc(var(--space) * 3);
  display: grid;
  gap: calc(var(--space) * 1.5);
}

.root-block.role-user,
.role-tag.role-user {
  --root-role-color: var(--accent);
  --root-role-bg: var(--accent-soft);
}

.root-block.role-system,
.role-tag.role-system {
  --root-role-color: var(--text-muted);
  --root-role-bg: var(--surface-muted);
}

.root-block.role-platform,
.role-tag.role-platform {
  --root-role-color: var(--warning);
  --root-role-bg: #fbf6ea;
}

.root-block.role-project,
.role-tag.role-project {
  --root-role-color: var(--success);
  --root-role-bg: #f2f7f2;
}

.root-head {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: baseline;
  flex-wrap: wrap;
}

.root-path {
  display: block;
  flex: 1 1 360px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.role-tag {
  color: var(--text);
  border-color: var(--root-role-color);
  background: var(--root-role-bg);
}

.root-state-tag.root-state-ok,
.root-state-tag.root-state-empty {
  color: var(--success);
  border-color: #cfe0cf;
  background: #f2f7f2;
}

.root-state-tag.root-state-missing,
.root-state-tag.root-state-unreadable {
  color: var(--danger);
  border-color: #eccbc8;
  background: #fbeceb;
}

.root-state-tag.root-state-unconfigured,
.root-state-tag.root-state-not-applicable {
  color: var(--text-muted);
  border-color: var(--border);
  background: var(--surface-muted);
}

.root-empty-state {
  margin: 0;
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--surface-muted);
  color: var(--text-muted);
  font-size: 12px;
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

.root-select {
  display: inline-flex;
  align-items: center;
}
</style>
