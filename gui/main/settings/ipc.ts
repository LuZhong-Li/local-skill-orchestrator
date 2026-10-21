import { app, ipcMain } from 'electron';
import type {
  AppSettings,
  LanguageMode,
  SupportedLanguage,
  UpdateSettingsStore,
} from '../updates/settings.ts';

export interface LanguagePatch {
  language: {
    mode: LanguageMode;
    value: SupportedLanguage;
  };
}

function stateOf(store: UpdateSettingsStore) {
  return {
    language: store.read().language,
    system_locale: app.getLocale(),
  };
}

export function registerAppSettingsIpc(store: UpdateSettingsStore): void {
  ipcMain.handle('app-settings:get', () => stateOf(store));
  ipcMain.handle('app-settings:set-language', (_event, patch: LanguagePatch) => {
    store.set({
      ...store.read(),
      language: {
        mode: patch.language.mode === 'manual' ? 'manual' : 'system',
        value: patch.language.value === 'en' ? 'en' : 'zh-CN',
      },
    } satisfies AppSettings);
    return stateOf(store);
  });
}
