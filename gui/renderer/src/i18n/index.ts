import { createI18n } from 'vue-i18n';
import en from './locales/en.ts';
import zhCN from './locales/zh-CN.ts';

export type SupportedLocale = 'en' | 'zh-CN';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['en', 'zh-CN'];

export function normalizeLocale(value: string | undefined): SupportedLocale {
  return value?.toLowerCase().startsWith('zh') === true ? 'zh-CN' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'zh-CN',
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN },
});

export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value === 'en' ? 'en' : 'zh-CN';
}

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
}

export function t(key: string, named?: Record<string, unknown>): string {
  return String(i18n.global.t(key, named ?? {}));
}

export function formatDateTime(value: string, locale = currentLocale()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

export function formatNumber(value: number, locale = currentLocale()): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatTime(value: Date, locale = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}
