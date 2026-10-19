<script setup lang="ts">
/** 设置页：配置读取/写入与更新检查开关；所有写操作经 App 的统一确认流程。 */
import type { KernelResult, UpdateSettings } from '../types.ts';

defineProps<{
  busy: boolean;
  configResult: KernelResult | null;
  configKey: string;
  configValue: string;
  updateSettings: UpdateSettings;
  updateError: string;
}>();

const emit = defineEmits<{
  loadConfig: [];
  saveConfig: [];
  'update:configKey': [value: string];
  'update:configValue': [value: string];
  togglePeriodic: [enabled: boolean];
  toggleInstant: [enabled: boolean];
}>();

function onKey(event: globalThis.Event): void {
  emit('update:configKey', (event.target as globalThis.HTMLSelectElement | null)?.value ?? '');
}

function onValue(event: globalThis.Event): void {
  emit('update:configValue', (event.target as globalThis.HTMLInputElement | null)?.value ?? '');
}

function onPeriodic(event: globalThis.Event): void {
  emit('togglePeriodic', (event.target as globalThis.HTMLInputElement | null)?.checked === true);
}

function onInstant(event: globalThis.Event): void {
  emit('toggleInstant', (event.target as globalThis.HTMLInputElement | null)?.checked === true);
}
</script>

<template>
  <div class="settings-view">
    <div class="panel">
      <h2>当前配置</h2>
      <button :disabled="busy" @click="emit('loadConfig')">读取配置</button>
      <pre v-if="configResult">{{ JSON.stringify(configResult.data, null, 2) }}</pre>
    </div>
    <div class="panel">
      <h2>修改配置</h2>
      <label>
        <span class="muted">配置键</span>
        <select :value="configKey" @change="onKey">
          <option value="default_target">default_target</option>
          <option value="default_mode">default_mode</option>
          <option value="skill_roots">skill_roots</option>
          <option
            v-if="!['default_target', 'default_mode', 'skill_roots'].includes(configKey)"
            :value="configKey"
          >
            {{ configKey }}
          </option>
        </select>
      </label>
      <label>
        <span class="muted">新的取值</span>
        <input :value="configValue" @input="onValue" />
      </label>
      <button class="primary" :disabled="busy" @click="emit('saveConfig')">写入</button>
    </div>
    <div class="panel">
      <h2>更新检查</h2>
      <p class="muted">
        手动检查始终可用。定期与即时检查默认关闭；定期检查固定至少 6
        小时，只在应用运行期间生效，且只提示、不执行更新。
      </p>
      <label class="toggle">
        <input
          type="checkbox"
          data-setting="periodic"
          :checked="updateSettings.periodic_check_enabled"
          @change="onPeriodic"
        />
        <span>定期检查（6 小时，仅应用运行期间，只提示）</span>
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          data-setting="instant"
          :checked="updateSettings.instant_check_enabled"
          @change="onInstant"
        />
        <span>立即检查（启动后执行一次只读检查）</span>
      </label>
      <p v-if="updateError" class="bad">更新设置或检查失败：{{ updateError }}</p>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: calc(var(--space) * 5);
  display: grid;
  gap: calc(var(--space) * 3);
  justify-items: start;
}

.panel h2 {
  font-size: 14px;
}

pre {
  margin: 0;
  max-width: 100%;
  overflow: auto;
  font-size: 12px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
}

.bad {
  color: var(--danger);
}
</style>
