/** 插件安装处理器。 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOL_VERSION } from '../../../core/index/index.ts';
import { type LifecycleOutcome } from '../../../core/lifecycle/index.ts';
import { savePluginIndex } from '../../../store/plugin-registry/index.ts';
import type { SkillIndex } from '../../../core/metadata/types.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { toKernelError } from '../../../store/errors.ts';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { renameWithRetry } from '../../../store/atomic/index.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { flag } from '../../parsers/index.ts';
import { acquireFromPath, looksRemote, releaseSource } from '../../../core/lifecycle/source.ts';
import { inspectPluginPackage } from '../../../core/plugins/discovery.ts';
import { createPluginRecord } from '../../../core/plugins/record.ts';
import type { PluginIndex } from '@skill-manager/contract';
import { rejectPluginOptions, workspaceRootOf } from '../../shared/options.ts';
import { loadPluginsForWrite, pluginUnreadable } from '../../plugins/state.ts';
import type { CommandContext } from '../types.ts';
import { confirmationGate, planOf } from '../shared.ts';
export async function pluginInstallCommand(context: CommandContext): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const source = args.positionals[0];
  const rejected = rejectPluginOptions('install', args, [
    'target',
    'host',
    'scope',
    'mode',
    'library-only',
  ]);
  if (rejected !== null) return rejected;
  if (source === undefined || source === '') {
    return buildResult('install', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'source',
        message: 'install --kind plugin 需要给出来源',
        remedy: '提供包含 plugin.json 的目录、归档或远端仓库',
      }),
    ]);
  }
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('install', layout, loaded.findings, loaded.missing);
  let acquired;
  try {
    acquired = await acquireFromPath(source, 'plugin.json');
  } catch (error) {
    const kernelError = toKernelError(error, CODES.SRC_UNRESOLVED);
    return buildResult('install', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
  try {
    const inspected = inspectPluginPackage(acquired.dir, TOOL_VERSION);
    if (
      inspected.manifest === null ||
      inspected.findings.some((item) => item.severity === 'error')
    ) {
      return buildResult('install', inspected.findings, []);
    }
    const manifest = inspected.manifest;
    const existing = loaded.index.plugins.find((item) => item.id === manifest.plugin_id);
    if (existing !== undefined) {
      if (existing.manifest_hash === inspected.manifest_hash) {
        return buildResult('install', [], [], {
          data: { kind: 'plugin', plugin: existing, idempotent: true },
        });
      }
      return buildResult('install', [
        finding(CODES.ID_PLUGIN_DUPLICATED, {
          source: 'plugin-install',
          target: manifest.plugin_id,
          message: `插件 ${manifest.plugin_id} 已登记且版本内容不同`,
          remedy: '如需替换，请先 uninstall --kind plugin，再重新安装；插件本期不做 update',
        }),
      ]);
    }
    const destination = join(layout.pluginsDir, manifest.plugin_id);
    if (existsSync(destination)) {
      return buildResult('install', [
        finding(CODES.CONFLICT_NAMING, {
          source: 'plugin-install',
          target: manifest.plugin_id,
          message: `插件目录已存在但未登记：${destination}`,
          remedy: '先清理该目录，或运行 scan --kind plugin 确认候选',
        }),
      ]);
    }
    const relativeManifest = `./plugins/${manifest.plugin_id}/plugin.json`;
    const record = createPluginRecord({
      manifest,
      manifestPath: relativeManifest,
      manifestHash: inspected.manifest_hash,
      now,
      ...(looksRemote(source) ? { sourceUrl: source } : {}),
    });
    const dryRun = flag(args, 'dry-run');
    const preview: LifecycleOutcome = {
      index: {} as SkillIndex,
      findings: [],
      changes: [
        { action: 'add', kind: 'plugin', path: destination },
        { action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile },
      ],
      data: {},
    };
    if (!dryRun) {
      const blocked = await confirmationGate({
        command: 'install',
        args,
        interaction: context.interaction,
        preview,
        plan: planOf('install', manifest.plugin_id, preview, [
          `将把插件包复制到 ${destination}`,
          '安装只登记插件，默认状态为 disabled；启用需要显式 enable --kind plugin',
        ]),
      });
      if (blocked !== null) return blocked;
    }
    if (dryRun) {
      return buildResult('install', [], [], {
        data: {
          kind: 'plugin',
          plugin: record,
          manifest_hash: inspected.manifest_hash,
          target: destination,
          state: 'disabled',
        },
        preview: true,
      });
    }
    const temp = join(layout.pluginsDir, `.${manifest.plugin_id}.tmp-${randomUUID()}`);
    try {
      mkdirSync(temp, { recursive: true });
      cpSync(acquired.dir, temp, {
        recursive: true,
        filter: (path) => basename(path) !== '.git',
      });
      const copied = inspectPluginPackage(temp, TOOL_VERSION);
      if (
        copied.manifest === null ||
        copied.manifest.plugin_id !== manifest.plugin_id ||
        copied.manifest_hash !== inspected.manifest_hash
      ) {
        return buildResult('install', [
          ...copied.findings,
          finding(CODES.IO_FAILED, {
            source: 'plugin-install',
            target: temp,
            message: '插件复制后校验失败',
            remedy: '删除临时目录后重试',
          }),
        ]);
      }
      renameWithRetry(temp, destination);
    } finally {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    }
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: [...loaded.index.plugins, record],
    };
    try {
      savePluginIndex(layout.pluginIndexFile, next);
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return buildResult(
      'install',
      [],
      [
        { action: 'add', kind: 'plugin', path: destination },
        { action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile },
      ],
      { data: { kind: 'plugin', plugin: record, state: 'disabled' } },
    );
  } finally {
    releaseSource(acquired);
  }
}
