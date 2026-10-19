/** 宿主落位前的可见性准备与落位后的可见性恢复。 */
import { existsSync } from 'node:fs';
import { CODES, type Finding, type HostLandingVisibility } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { toKernelError } from '../../store/errors.ts';
import { isCopyDisabled, setCopyVisibility } from '../../store/library-fs/index.ts';
import { rollbackLandWrites, type LandWrite } from '../../core/adapters/land.ts';
import type { HostChannel } from './channel.ts';

export function landingCopyDir(input: { channel: HostChannel }): string | undefined {
  if (input.channel.form !== 'skill') return undefined;
  return input.channel.plan.entries.find((entry) => entry.landable)?.root_path;
}

export function prepareLandingVisibility(
  input: { channel: HostChannel; dryRun: boolean; visibility?: HostLandingVisibility },
  findings: Finding[],
): boolean {
  if (input.dryRun || input.visibility === undefined) return true;
  const copyDir = landingCopyDir(input);
  if (copyDir === undefined || !existsSync(copyDir) || !isCopyDisabled(copyDir)) return true;
  try {
    setCopyVisibility(copyDir, true);
    return true;
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    findings.push(
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: `宿主副本可见性准备失败：${kernelError.message}`,
        remedy: '检查宿主副本的 SKILL.md / SKILL.md.disabled 状态后重试',
      }),
    );
    return false;
  }
}

export function applyLandingVisibility(
  input: {
    channel: HostChannel;
    skillId: string;
    dryRun: boolean;
    visibility?: HostLandingVisibility;
  },
  writes: readonly LandWrite[],
  findings: Finding[],
): Finding[] | undefined {
  if (input.dryRun || input.visibility !== 'disabled') return undefined;
  const copyDir = landingCopyDir(input);
  if (copyDir === undefined) return undefined;
  try {
    setCopyVisibility(copyDir, false);
    return undefined;
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    findings.push(
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: `宿主副本可见性恢复失败：${kernelError.message}`,
        remedy: '检查宿主副本的 SKILL.md / SKILL.md.disabled 状态后重试',
      }),
    );
    try {
      rollbackLandWrites(writes);
    } catch (rollbackCause) {
      findings.push(
        finding(CODES.LANDING_LEDGER_INVALID, {
          source: 'host-landings',
          target: kernelError.target,
          message: `宿主可见性回滚失败：${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`,
          remedy: '停止继续分发，检查宿主副本状态后手工修复',
        }),
      );
    }
    return findings;
  }
}
