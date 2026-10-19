/** scan 结果组装：保持既有 8 字段封装、数据字段与预览标记。 */
import type { ScanOutcome } from '../../core/discovery/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { toKernelError } from '../../store/errors.ts';
import { WORKSPACE_ENV, type WorkspaceLayout } from '../../store/workspace/index.ts';
import { buildResult, type Result } from '../result/index.ts';
import type { PluginScanData, WorkspaceScanData } from './types.ts';

export function scanUninitializedResult(layout: WorkspaceLayout): Result<unknown> {
  return buildResult('scan', [
    finding(CODES.ENV_NOT_INITIALIZED, {
      source: 'workspace',
      target: layout.root,
      message: '工作区尚未初始化',
      remedy: `请先执行 init，或设置环境变量 ${WORKSPACE_ENV} 指向已有工作区`,
    }),
  ]);
}

export function scanUnreadableIndexResult(
  layout: WorkspaceLayout,
  findings: Finding[],
): Result<unknown> {
  return buildResult('scan', [
    ...findings,
    finding(CODES.ENV_INCOMPLETE, {
      source: 'workspace',
      target: layout.indexFile,
      message: '索引无法读取，请重建后再扫描',
      remedy: '请先执行 init 建立新的索引，或修复索引文件',
    }),
  ]);
}

export function workspaceScanResult(input: {
  layout: WorkspaceLayout;
  outcome: ScanOutcome;
  findings: Finding[];
  dryRun: boolean;
}): Result<unknown> {
  const data: WorkspaceScanData = {
    root: input.layout.root,
    summary: input.outcome.summary,
    total: input.outcome.index.skills.length,
  };
  return buildResult('scan', input.findings, input.outcome.changes, {
    data,
    ...(input.dryRun ? { preview: true } : {}),
  });
}

export function scanFailureResult(error: unknown): Result<unknown> {
  const kernelError = toKernelError(error, CODES.IO_FAILED);
  return buildResult('scan', [
    finding(kernelError.code, {
      source: kernelError.source,
      target: kernelError.target,
      message: kernelError.message,
      remedy: kernelError.remedy,
    }),
  ]);
}

export function pluginScanResult(
  findings: Finding[],
  data: PluginScanData,
  dryRun: boolean,
): Result<unknown> {
  return buildResult('scan', findings, [], {
    data,
    ...(dryRun ? { preview: true } : {}),
  });
}
