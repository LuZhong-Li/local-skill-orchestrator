import { ref } from 'vue';
import { normalizeLocale, setLocale, type SupportedLocale } from './index.ts';

export type LanguageMode = 'system' | 'manual';

export interface LanguagePreference {
  mode: LanguageMode;
  value: SupportedLocale;
}

export interface LanguageState {
  language: LanguagePreference;
  system_locale: string;
}

export const languageMode = ref<LanguageMode>('system');
export const manualLanguage = ref<SupportedLocale>('zh-CN');
export const systemLocale = ref('');
export const resolvedLocale = ref<SupportedLocale>('zh-CN');

function applyLanguage(state: LanguageState): void {
  languageMode.value = state.language.mode;
  manualLanguage.value = state.language.value;
  systemLocale.value = state.system_locale;
  resolvedLocale.value =
    state.language.mode === 'manual'
      ? state.language.value
      : normalizeLocale(state.system_locale || globalThis.navigator?.language);
  setLocale(resolvedLocale.value);
}

export async function initializeLanguage(): Promise<void> {
  try {
    const state = (await globalThis.window.skillManager.appSettings.get()) as LanguageState;
    applyLanguage(state);
  } catch {
    resolvedLocale.value = normalizeLocale(globalThis.navigator?.language);
    setLocale(resolvedLocale.value);
  }
}

export async function setLanguagePreference(
  mode: LanguageMode,
  value: SupportedLocale,
): Promise<void> {
  const state = (await globalThis.window.skillManager.appSettings.setLanguage({
    language: { mode, value },
  })) as LanguageState;
  applyLanguage(state);
}
