/** 插件视图的纯展示映射；状态含义取自内核插件索引，不在组件内推导。 */
import type { PluginState } from './types.ts';

export function pluginStateLabel(state: PluginState): string {
  if (state === 'enabled') return '已启用';
  if (state === 'disabled') return '已停用';
  return '失效';
}

export function pluginInstallNotice(): string {
  return '插件已登记，默认 disabled；需要手动启用后才会提供宿主。';
}

export function pluginHostGroupLabel(group: 'builtin' | 'plugin'): string {
  return group === 'builtin' ? '内置宿主（不可被第三方覆盖）' : '第三方宿主（x- 命名空间）';
}
