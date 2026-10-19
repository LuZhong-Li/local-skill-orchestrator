/** 卸载闭环的纯数据操作：统一两本账本、按物理副本分组、孤儿化与清理。 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type {
  HostLanding,
  HostLandingIndex,
  PluginIndex,
  PluginLanding,
} from '@skill-manager/contract';

export type UnifiedLedgerSource = 'host_landings' | 'plugin_landings';
export type UnifiedFormat = 'skill' | 'rules' | 'unknown';

export interface UnifiedLanding {
  ledger_source: UnifiedLedgerSource;
  skill_id: string;
  host_id: string;
  host_key?: string;
  plugin_id?: string;
  ledger_target_path: string;
  physical_path: string;
  format: UnifiedFormat;
  state: 'active' | 'orphaned';
  record: HostLanding | PluginLanding;
}

/** 插件账本没有 format 字段，按落位文件名推断；无法判断时保留 unknown。 */
function pluginPhysical(record: PluginLanding): {
  physical_path: string;
  format: UnifiedFormat;
} {
  const name = basename(record.target_path);
  if (name === 'SKILL.md' || name === 'SKILL.md.disabled') {
    return { physical_path: dirname(record.target_path), format: 'skill' };
  }
  if (name.endsWith('.mdc') || name.endsWith('.md')) {
    return { physical_path: record.target_path, format: 'rules' };
  }
  try {
    if (statSync(record.target_path).isDirectory()) {
      return { physical_path: record.target_path, format: 'skill' };
    }
  } catch {
    // 路径不存在时保留 unknown，由调用方决定是否可删。
  }
  return { physical_path: record.target_path, format: 'unknown' };
}

/** 把内置账本与插件账本中属于该 Skill 的记录统一为物理副本视图。 */
export function collectUnifiedLandings(
  hostIndex: HostLandingIndex | null,
  pluginIndex: PluginIndex | null,
  skillId: string,
): UnifiedLanding[] {
  const landings: UnifiedLanding[] = [];
  for (const record of hostIndex?.landings ?? []) {
    if (record.skill_id !== skillId) continue;
    landings.push({
      ledger_source: 'host_landings',
      skill_id: record.skill_id,
      host_id: record.host_id,
      ledger_target_path: record.target_path,
      physical_path: record.target_path,
      format: record.format,
      state: record.state,
      record,
    });
  }
  for (const record of pluginIndex?.landings ?? []) {
    if (record.skill_id !== skillId) continue;
    const physical = pluginPhysical(record);
    landings.push({
      ledger_source: 'plugin_landings',
      skill_id: record.skill_id,
      host_id: record.host_id,
      host_key: record.host_key,
      plugin_id: record.plugin_id,
      ledger_target_path: record.target_path,
      physical_path: physical.physical_path,
      format: physical.format,
      state: record.state,
      record,
    });
  }
  return landings;
}

/** 原件卸载的阻断证据：两本账本中的 active 记录。 */
export function activeBlockers(
  hostIndex: HostLandingIndex | null,
  pluginIndex: PluginIndex | null,
  skillId: string,
): UnifiedLanding[] {
  return collectUnifiedLandings(hostIndex, pluginIndex, skillId).filter(
    (item) => item.state === 'active',
  );
}

export function groupByPhysicalPath(
  landings: readonly UnifiedLanding[],
): Map<string, UnifiedLanding[]> {
  const groups = new Map<string, UnifiedLanding[]>();
  for (const landing of landings) {
    const list = groups.get(landing.physical_path) ?? [];
    list.push(landing);
    groups.set(landing.physical_path, list);
  }
  return groups;
}

export function physicalExists(path: string): boolean {
  return existsSync(path);
}

/** 把内置账本中匹配 Skill 与物理路径的记录标为 orphaned。 */
export function orphanHostLandingsForPaths(
  index: HostLandingIndex,
  skillId: string,
  physicalPaths: readonly string[],
  now: string,
): HostLandingIndex {
  const paths = new Set(physicalPaths);
  return {
    ...index,
    landings: index.landings.map((item) =>
      item.skill_id === skillId && paths.has(item.target_path)
        ? { ...item, state: 'orphaned' as const, updated_at: now }
        : item,
    ),
  };
}

/** 把插件账本中匹配 Skill 与物理路径的记录标为 orphaned。 */
export function orphanPluginLandingsForPaths(
  index: PluginIndex,
  skillId: string,
  physicalPaths: readonly string[],
  now: string,
): PluginIndex {
  const paths = new Set(physicalPaths);
  return {
    ...index,
    landings: index.landings.map((item) => {
      if (item.skill_id !== skillId) return item;
      const physical = pluginPhysical(item).physical_path;
      return paths.has(physical) ? { ...item, state: 'orphaned' as const, updated_at: now } : item;
    }),
  };
}

/** 原件卸载成功后，清除内置账本中该 Skill 的 orphaned 记录。 */
export function purgeHostOrphanedLandings(
  index: HostLandingIndex,
  skillId: string,
): HostLandingIndex {
  return {
    ...index,
    landings: index.landings.filter(
      (item) => !(item.skill_id === skillId && item.state === 'orphaned'),
    ),
  };
}
