import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UpdateSettings {
  periodic_check_enabled: boolean;
  instant_check_enabled: boolean;
}

export type LanguageMode = 'system' | 'manual';
export type SupportedLanguage = 'en' | 'zh-CN';

export interface AppSettings extends UpdateSettings {
  language: {
    mode: LanguageMode;
    value: SupportedLanguage;
  };
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  periodic_check_enabled: false,
  instant_check_enabled: false,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_UPDATE_SETTINGS,
  language: { mode: 'system', value: 'zh-CN' },
};

export interface UpdateSettingsIo {
  readText: () => string | null;
  writeText: (text: string) => void;
}

function normalizeSettings(value: unknown): AppSettings {
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const language =
    record['language'] !== null &&
    typeof record['language'] === 'object' &&
    !Array.isArray(record['language'])
      ? (record['language'] as Record<string, unknown>)
      : {};
  return {
    periodic_check_enabled: record['periodic_check_enabled'] === true,
    instant_check_enabled: record['instant_check_enabled'] === true,
    language: {
      mode: language['mode'] === 'manual' ? 'manual' : 'system',
      value: language['value'] === 'en' ? 'en' : 'zh-CN',
    },
  };
}

/**
 * 更新设置持久化。
 *
 * 只存两个开关；读取永远不写盘。调用方只在用户切换开关时调用 set。
 * 最近检查时间属于会话状态（check 动作零写入），因此不落入 settings.json。
 */
export class UpdateSettingsStore {
  private readonly file: string;
  private readonly io: UpdateSettingsIo;

  constructor(file: string, io?: UpdateSettingsIo) {
    this.file = file;
    this.io = io ?? {
      readText: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
      writeText: (text: string) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      },
    };
  }

  read(): AppSettings {
    const text = this.io.readText();
    if (text === null)
      return { ...DEFAULT_APP_SETTINGS, language: { ...DEFAULT_APP_SETTINGS.language } };
    try {
      return normalizeSettings(JSON.parse(text));
    } catch {
      return { ...DEFAULT_APP_SETTINGS, language: { ...DEFAULT_APP_SETTINGS.language } };
    }
  }

  set(settings: UpdateSettings | AppSettings): AppSettings {
    const normalized = normalizeSettings({
      ...this.read(),
      ...settings,
      language: 'language' in settings ? settings.language : this.read().language,
    });
    this.io.writeText(`${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }
}
