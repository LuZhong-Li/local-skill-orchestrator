<script setup lang="ts">
/**
 * 全机盘点视图：只读呈现 scan --inventory 结果。
 * 本组件只接收 run 函数，不访问 preload / Node，也不提供任何写动作。
 */
import { computed, onMounted, ref } from 'vue';
import type { InventoryScanData, Result } from '@skill-manager/contract';
import InventorySummary from './host-inventory/InventorySummary.vue';
import InventoryHostGroups from './host-inventory/InventoryHostGroups.vue';
import InventoryCopyDetails from './host-inventory/InventoryCopyDetails.vue';

const props = defineProps<{
  run: (argv: string[]) => Promise<Result<Record<string, unknown>>>;
}>();

const data = ref<InventoryScanData | null>(null);
const loading = ref(false);
const error = ref('');

const untracked = computed(
  () =>
    data.value?.copies.filter((copy) => copy.reconciliation.classification === 'untracked') ?? [],
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.run(['scan', '--inventory']);
    if (!result.ok) {
      error.value =
        result.findings.map((item) => `${item.code}：${item.message}`).join('；') ||
        `盘点失败（退出码 ${result.exit_code}）`;
      return;
    }
    const payload = result.data as unknown as InventoryScanData;
    if (payload?.mode !== 'inventory') {
      error.value = '盘点结果缺少 mode=inventory，界面拒绝按其他结果结构渲染。';
      return;
    }
    data.value = payload;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="content inventory-view" data-testid="host-inventory">
    <div class="panel wide">
      <div class="view-head">
        <div>
          <h2>这台电脑上已安装的 Skill</h2>
          <p class="muted">只读盘点本机宿主目录：不改工作区、不写账本、不安装或卸载任何内容。</p>
        </div>
        <button class="primary" data-testid="inventory-refresh" :disabled="loading" @click="load">
          {{ loading ? '正在盘点…' : '重新盘点' }}
        </button>
      </div>
      <p v-if="error !== ''" class="bad" data-testid="inventory-error">{{ error }}</p>
      <p v-if="loading && data === null" class="muted" data-testid="inventory-loading">
        正在读取宿主根与副本，请稍候…
      </p>
    </div>

    <template v-if="data !== null">
      <div class="panel wide workspace-banner" data-testid="inventory-workspace">
        <p v-if="data.workspace.state === 'uninitialized'">
          <strong>工作区尚未初始化。</strong>
          本次只做宿主清点；没有工作区基线，对账结论标为无法判定 / 未纳管，不判断缺失或漂移。
        </p>
        <p v-else-if="data.workspace.state === 'unreadable'">
          <strong>工作区索引不可读。</strong>
          宿主副本仍会列出，但对账降级为证据不足，界面不会伪造权威结论。
        </p>
        <p v-else>
          <strong>工作区已初始化。</strong>
          对账使用只读索引基线；本视图不会刷新扫描时间或修改索引。
        </p>
        <p class="muted path">{{ data.workspace.root }}</p>
      </div>

      <InventorySummary :summary="data.summary" />

      <section class="panel wide" data-testid="inventory-degradation">
        <h2>账本与降级状态</h2>
        <p class="muted">
          内置宿主账本：{{
            data.degradation.host_landings === 'ok'
              ? '可读'
              : data.degradation.host_landings === 'missing'
                ? '无账本（旧工作区按推断处理）'
                : '不可读（不修复、不覆盖）'
          }}
          ｜插件账本：{{
            data.degradation.plugin_landings === 'ok'
              ? '可读'
              : data.degradation.plugin_landings === 'missing'
                ? '无账本（按推断处理）'
                : '不可读（不伪造权威结论）'
          }}
        </p>
      </section>

      <details class="panel wide untracked" data-testid="inventory-untracked" open>
        <summary>
          <strong>未纳管清单</strong>
          <span class="count">{{ untracked.length }}</span>
        </summary>
        <p class="muted">
          这些副本在磁盘上存在，但没有可用的账本或工作区记录。一期只读展示；
          导入与修复动作留到二期，下方按钮为禁用占位。
        </p>
        <InventoryCopyDetails
          :copies="untracked"
          test-id="inventory-untracked-copies"
          empty-text="没有未纳管的副本。"
        />
        <div class="phase-two">
          <button disabled title="二期功能">导入到工作区（二期）</button>
          <button disabled title="二期功能">修复漂移（二期）</button>
          <span class="muted">一期严格只读</span>
        </div>
      </details>

      <InventoryHostGroups :hosts="data.hosts" />

      <section v-if="data.corrupt.length > 0" class="panel wide" data-testid="inventory-corrupt">
        <h2>损坏 / 不可读副本（{{ data.corrupt.length }}）</h2>
        <p class="muted">损坏副本单独列出，不进入任何有效副本计数。</p>
        <InventoryCopyDetails :corrupt="data.corrupt" test-id="inventory-corrupt-copies" />
      </section>

      <section v-if="data.missing.length > 0" class="panel wide" data-testid="inventory-missing">
        <h2>缺失副本（{{ data.missing.length }}）</h2>
        <p class="muted">账本仍有 active 记录，但物理副本已不存在。</p>
        <InventoryCopyDetails :missing="data.missing" test-id="inventory-missing-copies" />
      </section>
    </template>
  </section>
</template>

<style scoped>
.inventory-view {
  flex: 1;
  overflow: auto;
  padding: calc(var(--space) * 5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.view-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: calc(var(--space) * 3);
  width: 100%;
  flex-wrap: wrap;
}

.workspace-banner p {
  margin: 0;
}

.path {
  font-size: 12px;
  word-break: break-all;
}

.untracked summary {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
  cursor: pointer;
}

.untracked .count {
  border-radius: 999px;
  padding: 0 calc(var(--space) * 2);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  font-size: 12px;
}

.phase-two {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}

.bad {
  color: var(--danger);
}
</style>
