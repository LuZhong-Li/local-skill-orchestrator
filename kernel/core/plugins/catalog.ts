/**
 * K-16 插件宿主合并纯函数。
 *
 * 输入是内置注册表快照与已校验的插件条目；输出只读视图。
 * 不读盘、不写盘、不修改内置对象、不把插件写入内置宿主形态绑定。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import type { HostEntry } from '../hosts/types.ts';
import { canonicalHostId } from './manifest.ts';
import type {
  HostCatalogView,
  PluginCatalogEntry,
  PluginHostRecord,
  PluginHostProfile,
} from './types.ts';

function copyProfile(profile: PluginHostProfile, hostId: string): PluginHostRecord {
  return {
    host_id: hostId,
    host_key: profile.host_key,
    display_name: profile.display_name,
    form: profile.form,
    roots: profile.roots.map((root) => ({
      kind: root.kind,
      path_template: root.path_template,
      scope: root.scope,
      ...(root.platform !== undefined ? { platform: root.platform } : {}),
    })),
    render_policy: {
      field_mode: profile.render_policy.field_mode,
      ...(profile.render_policy.degrade_form !== undefined
        ? { degrade_form: profile.render_policy.degrade_form }
        : {}),
    },
    ...(profile.capability !== undefined ? { capability: { ...profile.capability } } : {}),
  };
}

/**
 * 合并内置宿主与启用插件。冲突时整插件拒绝；内置集永远先占据命名空间。
 */
export function buildHostCatalog(input: {
  builtins: readonly HostEntry[];
  entries: readonly PluginCatalogEntry[];
}): HostCatalogView {
  const builtinHostIds = input.builtins.map((host) => host.host_id).sort();
  const builtinSet = new Set(builtinHostIds);
  const used = new Set(builtinHostIds);
  const pluginHosts: PluginHostRecord[] = [];
  const findings: Finding[] = [];
  const seenPluginIds = new Set<string>();

  const entries = [...input.entries].sort((left, right) =>
    left.record.id.localeCompare(right.record.id),
  );

  for (const entry of entries) {
    if (entry.findings !== undefined && entry.findings.some((item) => item.severity === 'error')) {
      findings.push(...entry.findings);
      continue;
    }
    if (entry.record.state !== 'enabled') continue;
    if (entry.record.validation.status !== 'ok') continue;
    if (entry.manifest === null) continue;
    if (seenPluginIds.has(entry.record.id)) {
      findings.push(
        finding(CODES.ID_PLUGIN_DUPLICATED, {
          source: 'plugin-catalog',
          target: entry.record.id,
          message: `插件标识重复：${entry.record.id}`,
          remedy: '移除重复的插件登记；同一插件标识只能有一条记录',
        }),
      );
      continue;
    }
    seenPluginIds.add(entry.record.id);
    if (entry.manifest.plugin_id !== entry.record.id) {
      findings.push(
        finding(CODES.ID_PLUGIN_INVALID, {
          source: 'plugin-catalog',
          target: entry.record.id,
          message: `插件记录标识 ${entry.record.id} 与 manifest 标识 ${entry.manifest.plugin_id} 不一致`,
          remedy: '重新安装插件并修正 plugin.json 的 plugin_id',
        }),
      );
      continue;
    }

    const proposed: PluginHostRecord[] = [];
    const proposedIds = new Set<string>();
    let conflict = false;
    for (const profile of entry.manifest.hosts) {
      const hostId = canonicalHostId(entry.manifest.plugin_id, profile.host_key);
      if (
        !hostId.startsWith('x-') ||
        builtinSet.has(hostId) ||
        used.has(hostId) ||
        proposedIds.has(hostId)
      ) {
        findings.push(
          finding(CODES.CONFLICT_PLUGIN_HOST, {
            source: 'plugin-catalog',
            target: hostId,
            message: `canonical 宿主命名空间冲突：${hostId}`,
            remedy: '修改 plugin_id 或 host_key；内置宿主与已加载插件的命名空间不可覆盖',
          }),
        );
        conflict = true;
        break;
      }
      proposedIds.add(hostId);
      proposed.push(copyProfile(profile, hostId));
    }
    if (conflict) continue;
    for (const profile of proposed) {
      used.add(profile.host_id);
      pluginHosts.push(profile);
    }
  }

  pluginHosts.sort((left, right) => left.host_id.localeCompare(right.host_id));
  return {
    builtinHostIds,
    pluginHosts,
    hostIds: [...builtinHostIds, ...pluginHosts.map((host) => host.host_id)].sort(),
    findings,
  };
}
