/** 落位结果装配与通用回滚；不负责账本内容决策。 */
import { CODES, type Change, type Finding, type Result } from '@skill-manager/contract';
import { toKernelError } from '../../store/errors.ts';
import { rollbackLandWrites, type LandWrite } from '../../core/adapters/land.ts';
import { hostWritesOutside } from './channel.ts';
import { buildResult } from '../result/index.ts';
import type { HostChannel } from './channel.ts';

export function rollbackLandingErrors(
  dryRun: boolean,
  writes: readonly LandWrite[],
  findings: Finding[],
): void {
  if (dryRun || !findings.some((item) => item.severity === 'error')) return;
  try {
    rollbackLandWrites(writes);
  } catch (rollbackCause) {
    const error = toKernelError(rollbackCause, CODES.LANDING_LEDGER_INVALID);
    findings.push({
      code: error.code,
      severity: 'error',
      source: error.source,
      target: error.target,
      message: `宿主副本回滚失败：${error.message}`,
      remedy: error.remedy,
    });
  }
}

export function buildLandingResult(
  input: {
    command: string;
    channel: HostChannel;
    dryRun: boolean;
  },
  landed: {
    skipped: Array<{ target_path: string; reason: string }>;
    backups: string[];
  },
  changes: Change[],
  findings: Finding[],
  ledger: { recorded: boolean; source: 'host_landings' | 'plugin_landings' | 'none' },
): Result<unknown> {
  return buildResult(input.command, findings, changes, {
    data: {
      host: input.channel.hostId,
      ...(input.channel.plugin === undefined
        ? { ledger_source: ledger.source, ledger_recorded: ledger.recorded }
        : { plugin_id: input.channel.plugin.pluginId, ledger_recorded: ledger.recorded }),
      host_root: input.channel.resolution?.path ?? '',
      host_writes_outside_workspace: hostWritesOutside(input.channel.plan),
      skipped: landed.skipped,
      backups: landed.backups,
      consumed_by: [
        ...new Set(input.channel.plan.entries.flatMap((entry) => entry.consumed_by)),
      ].sort(),
      dry_run: input.dryRun,
    },
  });
}
