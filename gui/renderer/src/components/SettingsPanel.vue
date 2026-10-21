<script setup lang="ts">
/** 设置页：配置读取/写入与更新检查开关；所有写操作经 App 的统一确认流程。 */
import type { KernelResult, UpdateSettings } from '../types.ts';
import type { SupportedLocale } from '../i18n/index.ts';
import type { LanguageMode } from '../i18n/language.ts';
import { localizedFindingsText } from '../i18n/error-text.ts';

const props = defineProps<{
  busy: boolean;
  configResult: KernelResult | null;
  configError: KernelResult | null;
  configKey: string;
  configValue: string;
  updateSettings: UpdateSettings;
  updateError: string;
  languageMode: LanguageMode;
  manualLanguage: SupportedLocale;
  systemLocale: string;
  resolvedLocale: SupportedLocale;
}>();

const emit = defineEmits<{
  loadConfig: [];
  saveConfig: [];
  'update:configKey': [value: string];
  'update:configValue': [value: string];
  togglePeriodic: [enabled: boolean];
  toggleInstant: [enabled: boolean];
  changeLanguage: [mode: LanguageMode, value: SupportedLocale];
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

function onLanguage(event: globalThis.Event): void {
  const value = (event.target as globalThis.HTMLSelectElement | null)?.value ?? 'system';
  if (value === 'system') emit('changeLanguage', 'system', props.manualLanguage);
  else emit('changeLanguage', 'manual', value === 'en' ? 'en' : 'zh-CN');
}
</script>

<template>
  <div class="settings-view">
    <div class="panel">
      <h2>{{ $t('settings.currentConfig') }}</h2>
      <button :disabled="busy" @click="emit('loadConfig')">
        {{ $t('settings.readConfig') }}
      </button>
      <pre v-if="configResult">{{ JSON.stringify(configResult.data, null, 2) }}</pre>
      <p v-if="configError" class="bad settings-error" data-testid="settings-error">
        {{ localizedFindingsText(configError.findings) }}
      </p>
    </div>
    <div class="panel">
      <h2>{{ $t('settings.editConfig') }}</h2>
      <label>
        <span class="muted">{{ $t('settings.configKey') }}</span>
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
        <span class="muted">{{ $t('settings.newValue') }}</span>
        <input :value="configValue" @input="onValue" />
      </label>
      <button class="primary" :disabled="busy" @click="emit('saveConfig')">
        {{ $t('settings.write') }}
      </button>
    </div>
    <div class="panel">
      <h2>{{ $t('settings.language') }}</h2>
      <label>
        <span class="muted">{{ $t('settings.languageMode') }}</span>
        <select
          data-setting="language"
          :value="languageMode === 'system' ? 'system' : manualLanguage"
          @change="onLanguage"
        >
          <option value="system">{{ $t('settings.followSystem') }}</option>
          <option value="zh-CN">{{ $t('settings.chinese') }}</option>
          <option value="en">{{ $t('settings.english') }}</option>
        </select>
      </label>
      <p class="muted">
        {{ $t('settings.systemLocale', { locale: systemLocale || resolvedLocale }) }}
      </p>
    </div>
    <div class="panel">
      <h2>{{ $t('settings.updateChecks') }}</h2>
      <p class="muted">{{ $t('settings.updateIntro') }}</p>
      <label class="toggle">
        <input
          type="checkbox"
          data-setting="periodic"
          :checked="updateSettings.periodic_check_enabled"
          @change="onPeriodic"
        />
        <span>{{ $t('settings.periodic') }}</span>
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          data-setting="instant"
          :checked="updateSettings.instant_check_enabled"
          @change="onInstant"
        />
        <span>{{ $t('settings.instant') }}</span>
      </label>
      <p v-if="updateError" class="bad">
        {{ $t('settings.updateError', { message: updateError }) }}
      </p>
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
