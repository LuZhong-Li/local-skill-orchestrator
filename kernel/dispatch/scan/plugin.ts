/** scan --kind plugin：插件索引刷新与未登记候选盘点；不加工作区锁。 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { inspectPluginPackage } from '../../core/plugins/discovery.ts';
import type { PluginIndex } from '../../core/plugins/types.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { savePluginIndex } from '../../store/plugin-registry/index.ts';
import { layoutOf, type WorkspaceLayout } from '../../store/workspace/index.ts';
import { loadPluginsForWrite, pluginUnreadable } from '../plugins/state.ts';
import { flag } from '../parsers/index.ts';
import { rejectPluginOptions, workspaceRootOf } from '../shared/options.ts';
import { pluginScanResult } from './result.ts';
import type { PluginScanData, ScanCommandInput } from './types.ts';

export function pluginScanCommand(input: ScanCommandInput) {
  const { args, now } = input;
  const layout = layoutOf(workspaceRootOf(args));
  const rejected = rejectPluginOptions('scan', args, ['root']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('scan', layout, loaded.findings, loaded.missing);
  const dryRun = flag(args, 'dry-run');
  const unregistered: Array<Record<string, unknown>> = [];
  const findings: Finding[] = [...loaded.findings];
  const byId = new Map(loaded.index.plugins.map((item) => [item.id, item]));
  const discovered = inspectPluginPackagesForScan(layout, TOOL_VERSION);
  for (const candidate of discovered) {
    if (!byId.has(candidate.plugin_id)) {
      unregistered.push({
        plugin_id: candidate.plugin_id,
        path: candidate.dir,
        manifest_hash: candidate.manifest_hash,
      });
    }
  }
  const plugins = loaded.index.plugins.map((record) =>
    refreshedPluginRecord(record, layout, now, findings),
  );
  const orphaned = loaded.index.landings.filter((item) => !byId.has(item.plugin_id));
  const next: PluginIndex = { ...loaded.index, generated_at: now, plugins };
  if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
  const data: PluginScanData = {
    kind: 'plugin',
    registered: plugins.length,
    invalid: plugins.filter((item) => item.state === 'invalid').length,
    unregistered,
    orphaned_landings: orphaned,
  };
  return pluginScanResult(findings, data, dryRun);
}

function refreshedPluginRecord(
  record: PluginIndex['plugins'][number],
  layout: WorkspaceLayout,
  now: string,
  findings: Finding[],
): PluginIndex['plugins'][number] {
  const packageDir = join(layout.pluginsDir, record.id);
  const inspected = inspectPluginPackage(packageDir, TOOL_VERSION);
  const errors = inspected.findings.filter((item) => item.severity === 'error');
  if (errors.length > 0 || inspected.manifest === null) {
    findings.push(...errors);
    return invalidPluginRecord(
      record,
      now,
      errors.map((item) => item.code),
    );
  }
  if (
    inspected.manifest_hash !== record.manifest_hash ||
    inspected.manifest.plugin_id !== record.id
  ) {
    findings.push(
      finding(CODES.HASH_FORMAT, {
        source: 'plugin-scan',
        target: record.id,
        message: 'manifest 哈希或标识与登记不一致',
        remedy: '确认插件包未被修改；必要时重新安装',
      }),
    );
    return invalidPluginRecord(record, now, [CODES.HASH_FORMAT]);
  }
  return {
    ...record,
    validation: { ...record.validation, status: 'ok' as const, errors: [], last_scan_at: now },
    updated_at: now,
  };
}

function invalidPluginRecord(
  record: PluginIndex['plugins'][number],
  now: string,
  errors: string[],
): PluginIndex['plugins'][number] {
  return {
    ...record,
    state: 'invalid' as const,
    validation: {
      status: 'invalid' as const,
      errors,
      last_scan_at: now,
    },
    updated_at: now,
  };
}

function inspectPluginPackagesForScan(
  layout: WorkspaceLayout,
  toolVersion: string,
): Array<{ plugin_id: string; dir: string; manifest_hash: string }> {
  if (!existsSync(layout.pluginsDir)) return [];
  const result: Array<{ plugin_id: string; dir: string; manifest_hash: string }> = [];
  for (const entry of readdirSync(layout.pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const inspected = inspectPluginPackage(join(layout.pluginsDir, entry.name), toolVersion);
    result.push({
      plugin_id: inspected.manifest?.plugin_id ?? entry.name,
      dir: inspected.dir,
      manifest_hash: inspected.manifest_hash,
    });
  }
  return result;
}
