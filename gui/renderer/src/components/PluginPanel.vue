<script setup lang="ts">
/** 插件视图：与 Skill 视图分区；所有数据来自内核 list/scan --kind plugin。 */
import { computed, onMounted, ref, watch } from 'vue';
import { pluginHostGroupLabel, pluginStateLabel } from '../plugin-presentation.ts';
import type { PluginCandidate, PluginHosts, PluginSummary, SkillSummary } from '../types.ts';

const props = defineProps<{
  plugins: PluginSummary[];
  candidates: PluginCandidate[];
  hosts: PluginHosts;
  skills: SkillSummary[];
  loading: boolean;
  message: string;
}>();
const selectedSkill = ref('');
const visibleThirdParty = computed(() =>
  props.hosts.third_party.filter((host) => host.plugin_state === 'enabled'),
);

function resetSkill(): void {
  if (selectedSkill.value === '' || !props.skills.some((item) => item.id === selectedSkill.value)) {
    selectedSkill.value = props.skills[0]?.id ?? '';
  }
}

onMounted(resetSkill);
watch(() => props.skills, resetSkill);

const emit = defineEmits<{
  refresh: [];
  install: [];
  installCandidate: [source: string];
  open: [id: string];
  enable: [id: string];
  disable: [id: string];
  uninstall: [id: string];
  configHint: [hint: string];
  distribute: [hostId: string, skillId: string];
}>();
</script>

<template>
  <section class="content plugin-panel" data-testid="plugin-panel">
    <div class="panel wide">
      <div class="row">
        <div>
          <h2>插件（扩展）</h2>
          <p class="muted">
            插件是能力扩展载体，不是 Skill；插件默认停用，启用后才会提供
            <code>x-</code> 宿主。插件视图不包含更新检查。
          </p>
        </div>
        <div class="actions">
          <button class="primary" :disabled="loading" @click="emit('install')">安装插件</button>
          <button :disabled="loading" @click="emit('refresh')">刷新插件</button>
        </div>
      </div>
      <p v-if="message" class="notice" data-testid="plugin-message">{{ message }}</p>
      <p v-if="loading" class="muted">正在读取插件索引…</p>
      <p v-else-if="plugins.length === 0" class="muted">还没有已登记的插件。</p>
      <table v-else class="plugins">
        <thead>
          <tr>
            <th>插件</th>
            <th>版本</th>
            <th>状态</th>
            <th>宿主数</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="plugin in plugins" :key="plugin.id" :data-plugin-id="plugin.id">
            <td>
              <code>{{ plugin.id }}</code>
            </td>
            <td>{{ plugin.version }}</td>
            <td>
              <span class="tag" :class="plugin.state">{{ pluginStateLabel(plugin.state) }}</span>
            </td>
            <td>{{ plugin.hosts }}</td>
            <td class="actions">
              <button @click="emit('open', plugin.id)">详情</button>
              <button
                v-if="plugin.state !== 'enabled'"
                :disabled="loading"
                @click="emit('enable', plugin.id)"
              >
                启用
              </button>
              <button v-else :disabled="loading" @click="emit('disable', plugin.id)">停用</button>
              <button class="danger" :disabled="loading" @click="emit('uninstall', plugin.id)">
                卸载
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel wide" data-testid="plugin-candidates">
      <h2>未登记候选</h2>
      <p class="muted">扫描只报告候选，不自动登记；安装后默认 disabled。</p>
      <p v-if="candidates.length === 0" class="muted">没有未登记的插件目录。</p>
      <ul v-else>
        <li v-for="candidate in candidates" :key="candidate.path">
          <code>{{ candidate.plugin_id }}</code>
          <span class="muted">{{ candidate.path }}</span>
          <button :disabled="loading" @click="emit('installCandidate', candidate.path)">
            安装候选
          </button>
        </li>
      </ul>
    </div>

    <div class="panel wide" data-testid="plugin-hosts">
      <h2>宿主分发</h2>
      <p class="muted">
        内置宿主与第三方宿主分区显示；停用、失效或未配置 global 根的第三方宿主不可选。
      </p>
      <label class="skill-picker">
        <span>选择要分发的 Skill</span>
        <select v-model="selectedSkill">
          <option v-for="skill in skills" :key="skill.id" :value="skill.id">
            {{ skill.id }}
          </option>
        </select>
      </label>
      <section>
        <h3>{{ pluginHostGroupLabel('builtin') }}</h3>
        <ul class="host-list">
          <li v-for="host in hosts.builtin" :key="host.host_id" :data-host-id="host.host_id">
            <code>{{ host.host_id }}</code>
            <span>{{ host.display_name }}</span>
            <span class="muted">{{ host.selectable ? '可选' : host.reason }}</span>
            <button
              v-if="host.selectable"
              :disabled="loading || selectedSkill === ''"
              @click="emit('distribute', host.host_id, selectedSkill)"
            >
              分发
            </button>
          </li>
        </ul>
      </section>
      <section>
        <h3>{{ pluginHostGroupLabel('plugin') }}</h3>
        <ul v-if="visibleThirdParty.length > 0" class="host-list">
          <li
            v-for="host in visibleThirdParty"
            :key="host.host_id"
            :data-host-id="host.host_id"
            :class="{ dimmed: !host.selectable }"
          >
            <code>{{ host.host_id }}</code>
            <span>{{ host.plugin_name }} / {{ host.display_name }}</span>
            <span class="muted">{{ host.selectable ? '可选' : host.reason }}</span>
            <button
              v-if="host.selectable"
              :disabled="loading || selectedSkill === ''"
              @click="emit('distribute', host.host_id, selectedSkill)"
            >
              分发
            </button>
            <button
              v-for="hint in host.config_hint"
              :key="hint"
              :disabled="loading"
              @click="emit('configHint', hint)"
            >
              {{ hint }}
            </button>
          </li>
        </ul>
        <p v-else class="muted">没有第三方宿主。</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  gap: calc(var(--space) * 3);
  align-items: flex-start;
}

.panel + .panel {
  margin-top: calc(var(--space) * 4);
}

.plugins {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.plugins th,
.plugins td {
  padding: calc(var(--space) * 2);
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.actions {
  display: flex;
  gap: calc(var(--space));
  flex-wrap: wrap;
}

.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
}

.tag.enabled {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}

.tag.disabled {
  color: var(--text-muted);
  background: var(--surface);
}

.tag.invalid {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.host-list {
  display: grid;
  gap: calc(var(--space) * 2);
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.host-list li {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  flex-wrap: wrap;
}

.skill-picker {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  margin-bottom: calc(var(--space) * 3);
  font-size: 13px;
}

.skill-picker span {
  color: var(--text-muted);
}

.dimmed {
  opacity: 0.65;
}

.notice {
  padding: calc(var(--space) * 2);
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  font-size: 13px;
}
</style>
