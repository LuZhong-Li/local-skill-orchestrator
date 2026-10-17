<script setup lang="ts">
/** 插件详情：manifest、canonical 宿主、校验结论与 landings 账本均来自内核。 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { Finding, KernelResult, PluginSummary } from '../types.ts';
import { pluginStateLabel } from '../plugin-presentation.ts';

const props = defineProps<{
  plugin: PluginSummary;
  detail: KernelResult | null;
  loading: boolean;
}>();
const emit = defineEmits<{
  close: [];
  enable: [id: string];
  disable: [id: string];
  uninstall: [id: string];
}>();

const data = computed(() => (props.detail?.data ?? {}) as Record<string, unknown>);
const record = computed(() => (data.value['plugin'] ?? {}) as Record<string, unknown>);
const manifest = computed(() => (data.value['manifest'] ?? null) as Record<string, unknown> | null);
const hosts = computed(() => (record.value['hosts'] ?? []) as Array<Record<string, unknown>>);
const landings = computed(() => (data.value['landings'] ?? []) as Array<Record<string, unknown>>);
const rootConfig = computed(
  () => (data.value['root_config'] ?? []) as Array<Record<string, unknown>>,
);
const findings = computed<Finding[]>(() => props.detail?.findings ?? []);
</script>

<template>
  <DialogShell :title="plugin.id" subtitle="插件详情（第三方扩展）" wide @close="$emit('close')">
    <p v-if="loading" class="muted">正在读取内核输出…</p>
    <template v-else>
      <section>
        <h3>状态与 manifest 摘要</h3>
        <dl class="grid">
          <div>
            <dt>状态</dt>
            <dd>{{ pluginStateLabel(plugin.state) }}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{{ plugin.version }}</dd>
          </div>
          <div>
            <dt>manifest 哈希</dt>
            <dd>
              <code>{{ String(data['manifest_hash'] ?? '不可读') }}</code>
            </dd>
          </div>
          <div>
            <dt>capabilities</dt>
            <dd>{{ String((manifest?.['capabilities'] as unknown[])?.join(', ') ?? '未读取') }}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>canonical 宿主</h3>
        <ul>
          <li v-for="host in hosts" :key="String(host['host_id'])">
            <code>{{ String(host['host_id']) }}</code>
            <span class="muted"
              >{{ String(host['display_name'] ?? '') }} / {{ String(host['form'] ?? '') }}</span
            >
          </li>
        </ul>
        <p v-if="hosts.length === 0" class="muted">没有可用的宿主 profile。</p>
      </section>

      <section>
        <h3>校验结论</h3>
        <p v-if="plugin.validation.status === 'ok'" class="ok">通过</p>
        <p v-else class="bad">未通过：{{ plugin.validation.errors.join('、') }}</p>
        <ul>
          <li v-for="finding in findings" :key="finding.code + finding.target">
            <code>{{ finding.code }}</code> {{ finding.message }}
          </li>
        </ul>
      </section>

      <section>
        <h3>landings 副本账本</h3>
        <ul>
          <li
            v-for="landing in landings"
            :key="String(landing['target_path'])"
            :data-landing="landing['target_path']"
          >
            <code>{{ String(landing['target_path']) }}</code>
            <span class="muted"
              >{{ String(landing['state']) }}｜{{ String(landing['skill_id']) }}</span
            >
          </li>
        </ul>
        <p v-if="landings.length === 0" class="muted">尚无插件宿主落位记录。</p>
      </section>

      <section>
        <h3>根配置来源</h3>
        <ul>
          <li v-for="host in rootConfig" :key="String(host['host_id'])">
            <code>{{ String(host['host_id']) }}</code>
            <span
              v-for="key in host['keys'] as Array<Record<string, unknown>>"
              :key="String(key['key'])"
            >
              {{ String(key['key']) }}={{ String(key['value'] ?? '未配置') }}
            </span>
          </li>
        </ul>
      </section>
    </template>

    <template #footer>
      <button v-if="plugin.state !== 'enabled'" @click="emit('enable', plugin.id)">启用</button>
      <button v-else @click="emit('disable', plugin.id)">停用</button>
      <button class="danger" @click="emit('uninstall', plugin.id)">卸载插件</button>
    </template>
  </DialogShell>
</template>

<style scoped>
section + section {
  margin-top: calc(var(--space) * 5);
}

h3 {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: calc(var(--space) * 2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  margin: 0;
  font-size: 13px;
}

.grid div {
  display: flex;
  gap: calc(var(--space) * 2);
}

dt {
  color: var(--text-muted);
  min-width: 72px;
}

dd {
  margin: 0;
  word-break: break-all;
}

ul {
  margin: 0;
  padding-left: calc(var(--space) * 5);
  font-size: 13px;
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.ok {
  color: var(--success);
}

.bad {
  color: var(--danger);
}
</style>
