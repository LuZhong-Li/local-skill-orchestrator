import { join } from 'node:path';
import { TOOL_VERSION } from '../../../core/index/index.ts';
import { savePluginIndex } from '../../../store/plugin-registry/index.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { loadHostRegistry } from '../../../core/hosts/index.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { flag } from '../../parsers/index.ts';
import { inspectPluginPackage } from '../../../core/plugins/discovery.ts';
import { loadPluginCatalog } from '../../../core/plugins/host.ts';
import { buildHostCatalog } from '../../../core/plugins/catalog.ts';
import type { PluginIndex } from '@skill-manager/contract';
import { rejectPluginOptions, workspaceRootOf } from '../../shared/options.ts';
import { loadPluginsForWrite, pluginUnreadable } from '../../plugins/state.ts';
import type { CommandContext } from '../types.ts';
export async function pluginToggleCommand(
  command: 'enable' | 'disable',
  context: CommandContext,
): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult(command, [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: `${command} --kind plugin 需要给出插件标识`,
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const rejected = rejectPluginOptions(command, args, ['target', 'host', 'scope']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable(command, layout, loaded.findings, loaded.missing);
  const record = loaded.index.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult(command, [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const dryRun = flag(args, 'dry-run');
  if (command === 'disable') {
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: loaded.index.plugins.map((item) =>
        item.id === id ? { ...item, state: 'disabled' as const, updated_at: now } : item,
      ),
    };
    if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
    return buildResult(command, loaded.findings, [], {
      data: { kind: 'plugin', plugin: next.plugins.find((item) => item.id === id) },
      ...(dryRun ? { preview: true } : {}),
    });
  }
  const inspected = inspectPluginPackage(join(layout.pluginsDir, id), TOOL_VERSION);
  const errors = [...inspected.findings.filter((item) => item.severity === 'error')];
  if (inspected.manifest === null || inspected.manifest.plugin_id !== id) {
    errors.push(
      finding(CODES.ID_PLUGIN_INVALID, {
        source: 'plugin-enable',
        target: id,
        message: '插件包 manifest 无法通过校验',
        remedy: '修复 plugin.json 后重新安装',
      }),
    );
  }
  if (inspected.manifest !== null && inspected.manifest_hash !== record.manifest_hash) {
    errors.push(
      finding(CODES.HASH_FORMAT, {
        source: 'plugin-enable',
        target: id,
        message: '插件包 manifest 哈希与登记不一致',
        remedy: '重新安装插件，或运行 scan --kind plugin 确认变更',
      }),
    );
  }
  if (errors.length > 0 || inspected.manifest === null) {
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: loaded.index.plugins.map((item) =>
        item.id === id
          ? {
              ...item,
              state: 'invalid' as const,
              updated_at: now,
              validation: {
                status: 'invalid' as const,
                errors: errors.map((item) => item.code),
                last_scan_at: now,
              },
            }
          : item,
      ),
    };
    if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
    return buildResult(command, [...loaded.findings, ...errors], [], { data: { kind: 'plugin' } });
  }
  const base = loadPluginCatalog({
    layout,
    builtins: loadHostRegistry().hosts,
    toolVersion: TOOL_VERSION,
  });
  const entries = base.entries
    .filter(
      (entry) =>
        entry.record.id === id ||
        (entry.record.state === 'enabled' &&
          entry.manifest !== null &&
          !(entry.findings ?? []).some((item) => item.severity === 'error')),
    )
    .map((entry) =>
      entry.record.id === id
        ? {
            ...entry,
            manifest: inspected.manifest,
            findings: [],
            record: {
              ...entry.record,
              state: 'enabled' as const,
              validation: { status: 'ok' as const, errors: [] },
            },
          }
        : entry,
    );
  const candidateView = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries,
  });
  if (candidateView.findings.some((item) => item.severity === 'error')) {
    return buildResult(command, [...loaded.findings, ...candidateView.findings], [], {
      data: { kind: 'plugin' },
    });
  }
  const next: PluginIndex = {
    ...loaded.index,
    generated_at: now,
    plugins: loaded.index.plugins.map((item) =>
      item.id === id
        ? {
            ...item,
            state: 'enabled' as const,
            updated_at: now,
            validation: { status: 'ok' as const, errors: [], last_scan_at: now },
          }
        : item,
    ),
  };
  if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
  return buildResult(command, [...loaded.findings, ...inspected.findings], [], {
    data: {
      kind: 'plugin',
      plugin: next.plugins.find((item) => item.id === id),
      hosts: candidateView.pluginHosts.map((item) => item.host_id),
    },
    ...(dryRun ? { preview: true } : {}),
  });
}
