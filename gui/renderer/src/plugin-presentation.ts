/** 插件视图的纯展示映射；状态含义取自内核插件索引，不在组件内推导。 */
import type { PluginState } from './types.ts';
import { t } from './i18n/index.ts';

export function pluginStateLabel(state: PluginState): string {
  if (state === 'enabled') return t('plugins.statusEnabled');
  if (state === 'disabled') return t('plugins.statusDisabled');
  return t('plugins.statusInvalid');
}

export function pluginInstallNotice(): string {
  return t('plugins.installedNotice');
}

export function pluginHostGroupLabel(group: 'builtin' | 'plugin'): string {
  return group === 'builtin' ? t('plugins.builtinHosts') : t('plugins.thirdPartyHosts');
}
