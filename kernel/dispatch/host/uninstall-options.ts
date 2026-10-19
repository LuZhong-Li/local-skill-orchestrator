/** uninstall --host 的参数与工作区前置校验。 */
import { existsSync } from 'node:fs';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { buildResult, type Result } from '../result/index.ts';

export function rejectHostUninstallOptions(input: {
  hostValue?: string | undefined;
  kindPlugin: boolean;
  hard: boolean;
}): Result<unknown> | null {
  if (input.hostValue === undefined) return null;
  if (input.kindPlugin) {
    return buildResult('uninstall', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: '插件包卸载（--kind plugin）与宿主副本卸载（--host）互斥',
        remedy: '请分开执行：uninstall --kind plugin 卸载插件包；uninstall --host 清理技能副本',
      }),
    ]);
  }
  if (!input.hard) return null;
  return buildResult('uninstall', [
    finding(CODES.INPUT_INVALID_ARG, {
      source: 'input',
      target: '--host',
      message: '原件卸载（--hard）与宿主副本卸载（--host）互斥',
      remedy: '先用 uninstall <id> --host all 清理宿主副本，再执行 uninstall <id> --hard',
    }),
  ]);
}

export function rejectUninstallBase(input: {
  layout: WorkspaceLayout;
  id: string | undefined;
}): Result<unknown> | null {
  if (input.id === undefined || input.id === '') {
    return buildResult('uninstall', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'uninstall 需要给出 Skill 标识',
        remedy: '请提供要卸载的 Skill 标识',
      }),
    ]);
  }
  if (existsSync(input.layout.indexFile)) return null;
  return buildResult('uninstall', [
    finding(CODES.ENV_NOT_INITIALIZED, {
      source: 'workspace',
      target: input.layout.root,
      message: '工作区尚未初始化',
      remedy: '请先执行 init',
    }),
  ]);
}
