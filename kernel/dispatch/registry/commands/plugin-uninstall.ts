/** 插件卸载处理器。 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type LifecycleOutcome } from '../../../core/lifecycle/index.ts';
import { savePluginIndex } from '../../../store/plugin-registry/index.ts';
import type { SkillIndex } from '../../../core/metadata/types.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { flag } from '../../parsers/index.ts';
import { orphanPluginLandings } from '../../../core/plugins/host.ts';
import { countTreeFiles } from '../../../store/library-fs/index.ts';
import type { PluginIndex } from '@skill-manager/contract';
import { rejectPluginOptions, workspaceRootOf } from '../../shared/options.ts';
import { loadPluginsForWrite, pluginUnreadable } from '../../plugins/state.ts';
import type { CommandContext } from '../types.ts';
import { confirmationGate, planOf } from '../shared.ts';
export async function pluginUninstallCommand(context: CommandContext): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('uninstall', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'uninstall --kind plugin 需要给出插件标识',
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const rejected = rejectPluginOptions('uninstall', args, ['keep-library', 'hard']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('uninstall', layout, loaded.findings, loaded.missing);
  const record = loaded.index.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('uninstall', [
      ...loaded.findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const pluginDir = join(layout.pluginsDir, id);
  const fileCount = countTreeFiles(pluginDir);
  const orphaned = loaded.index.landings.filter((item) => item.plugin_id === id);
  const preview: LifecycleOutcome = {
    index: {} as SkillIndex,
    findings: [],
    changes: [
      { action: 'remove', kind: 'plugin', path: pluginDir, detail: `${fileCount} 个文件` },
      { action: 'remove', kind: 'plugin_index', path: layout.pluginIndexFile },
    ],
    data: {
      notes: [
        `将删除插件包：${pluginDir}（${fileCount} 个文件）`,
        '插件登记将从 plugin_index.yaml 移除；Skill 索引不会被触碰',
        orphaned.length > 0
          ? `已有 ${orphaned.length} 个宿主副本会保留并标记为孤儿：${orphaned
              .map((item) => item.target_path)
              .join('、')}`
          : '没有已记录的插件宿主副本',
      ],
      plugin_dir: pluginDir,
      file_count: fileCount,
      orphaned_landings: orphaned,
    },
  };
  const dryRun = flag(args, 'dry-run');
  if (!dryRun) {
    const blocked = await confirmationGate({
      command: 'uninstall',
      args,
      interaction: context.interaction,
      preview,
      plan: planOf('uninstall', id, preview, [
        `将删除插件包：${pluginDir}（${fileCount} 个文件）`,
        '插件登记将从 plugin_index.yaml 移除；Skill 索引不会被触碰',
        orphaned.length > 0
          ? `已有 ${orphaned.length} 个宿主副本会保留并标记为孤儿：${orphaned
              .map((item) => item.target_path)
              .join('、')}`
          : '没有已记录的插件宿主副本',
      ]),
    });
    if (blocked !== null) return blocked;
  }
  const marked = orphanPluginLandings(loaded.index, id, now);
  const next: PluginIndex = {
    ...marked.index,
    generated_at: now,
    plugins: marked.index.plugins.filter((item) => item.id !== id),
  };
  if (!dryRun) {
    rmSync(pluginDir, { recursive: true, force: true });
    savePluginIndex(layout.pluginIndexFile, next);
  }
  return buildResult('uninstall', loaded.findings, preview.changes, {
    data: {
      kind: 'plugin',
      removed: !dryRun,
      plugin_dir: pluginDir,
      file_count: fileCount,
      orphaned_landings: marked.orphaned,
      notes: preview.data['notes'],
    },
    ...(dryRun ? { preview: true } : {}),
  });
}
/**
 * 确认闸门。
 *
 * 传入的是一份**只读预览**的结果：调用方先以预演方式跑一遍，本函数据此组装影响范围、
 * 交给策略层裁决。业务知识（哪些文件、索引与副本会被写入）留在调用方，本函数只做编排。
 *
 * 返回非 null 表示闸门拦下，直接以该结果结束本次调用：
 *   预览已明确拒绝，或预览产生错误级问题且没有任何计划变更时，直接返回预览结果，
 *   不向用户索要确认——这类调用注定失败，打扰用户没有意义；
 *   无终端且未给出跳过确认选项时返回参数类问题；
 *   用户给出否定回答时返回「已取消」，不产生任何变更。
 */
