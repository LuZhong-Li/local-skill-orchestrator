/** K-04 启用 / 禁用命令。 */
import { judgeDependency } from '../metadata/validate.ts';
import { libraryPathOf } from '../targets/resolver/index.ts';
import {
  deliverFiles,
  isCopyDisabled,
  pathExists,
  setCopyVisibility,
} from '../../store/library-fs/index.ts';
import { CODES, finding, type Change, type Finding } from '../../store/contract.ts';
import { toKernelError } from '../../store/errors.ts';
import type { LifecycleOutcome, ToggleInput } from './types.ts';
import { notRegistered, planOf, targetsOfRecord, toFinding, withTargets } from './shared.ts';
export function enableSkill(input: ToggleInput): LifecycleOutcome {
  const { layout, index, id, now, target, scope, dryRun } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) return notRegistered(id, index);

  // 不可用条件 2：校验不通过一律拒绝，且不得表述为「已被禁用」
  if (record.validation.status === 'invalid') {
    return {
      index,
      findings: [
        finding(CODES.VALIDATION_REJECTED, {
          source: 'lifecycle',
          target: id,
          message: `该 Skill 的校验不通过，拒绝启用。问题码：${record.validation.errors.join('、') || '（无明细）'}`,
          remedy: '请先修复上述问题并重新扫描；该拒绝与「已被禁用」语义不同，二者不得混用',
        }),
      ],
      changes: [],
      data: { rejected: 'validation_failed', problem_codes: record.validation.errors },
    };
  }

  // 不可用条件 3：依赖未满足
  const availability = new Map(
    index.skills.map((item) => [item.id, item.validation.status === 'ok']),
  );
  const dependencyFindings: Finding[] = [];
  for (const raw of record.dependencies ?? []) {
    const name = raw.trim().split(' ')[0] ?? '';
    if (name === '') continue;
    const verdict = judgeDependency(name, availability);
    if (verdict === 'missing') {
      dependencyFindings.push(
        finding(CODES.DEP_MISSING, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 不在索引中，拒绝启用`,
          remedy: `请先安装 ${name}，或从依赖声明中移除该项后重新扫描`,
        }),
      );
    } else if (verdict === 'invalid') {
      dependencyFindings.push(
        finding(CODES.VALIDATION_DEPENDENCY, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 校验不通过，依赖未满足，拒绝启用`,
          remedy: `请先修复 ${name} 的问题并重新扫描`,
        }),
      );
    }
  }
  if (dependencyFindings.length > 0) {
    return {
      index,
      findings: dependencyFindings,
      changes: [],
      data: { rejected: 'dependency_unmet' },
    };
  }

  const resolved = targetsOfRecord({ layout, record, target, scope });
  if (resolved.targets.length === 0 && resolved.findings.length > 0) {
    return {
      index,
      findings: resolved.findings,
      changes: [],
      data: { rejected: 'targets_unreadable' },
    };
  }

  const libraryDir = libraryPathOf(layout.root, id);
  const findings: Finding[] = [];
  const changes: Change[] = [];
  const targetStates: Array<Record<string, unknown>> = [];
  const planned: Change[] = [];

  for (const item of resolved.targets) {
    const copyPath = item.absolutePath;
    const missing = !pathExists(copyPath);
    const before = missing ? null : isCopyDisabled(copyPath) ? 'disabled' : 'enabled';
    if (missing) planned.push({ action: 'add', kind: 'target_copy', path: copyPath });
    if (before === 'disabled') {
      planned.push({ action: 'modify', kind: 'copy_marker', path: copyPath });
    }
    targetStates.push({
      target: item.target,
      scope: item.scope,
      path: item.declaredPath,
      existed: !missing,
      state_before: before,
      state_after: 'enabled',
    });
  }

  if (dryRun === true) {
    return {
      index,
      findings,
      changes: [...planned, { action: 'modify', kind: 'index_record', path: record.path }],
      preview: true,
      data: {
        preview: true,
        id,
        status_before: record.status,
        status_after: 'enabled',
        targets: targetStates,
      },
    };
  }

  // 幂等：状态与副本都已是目标态时不产生任何变更，也不刷新最近变更时间
  const summaryDrifted = resolved.targets.some(
    (item) =>
      record.targets.find((entry) => entry.target === item.target && entry.scope === item.scope)
        ?.enabled !== true,
  );
  if (planned.length === 0 && record.status === 'enabled' && !summaryDrifted) {
    return {
      index,
      findings,
      changes: [],
      data: {
        id,
        status_before: record.status,
        status_after: 'enabled',
        targets: targetStates,
        unchanged: true,
      },
    };
  }

  for (const item of resolved.targets) {
    try {
      if (!pathExists(item.absolutePath)) {
        // 按需补齐：文件不存在时按落位方式把中心库原件补到目标位置，映射表存在时按逐文件落位
        deliverFiles(libraryDir, item.absolutePath, planOf(item.fileMap));
        changes.push({ action: 'add', kind: 'target_copy', path: item.absolutePath });
      }
      if (setCopyVisibility(item.absolutePath, true) === 'changed') {
        changes.push({ action: 'modify', kind: 'copy_marker', path: item.absolutePath });
      }
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      findings.push(toFinding(kernelError));
      return { index, findings, changes: [], data: { rejected: 'copy_toggle_failed' } };
    }
  }

  const next = withTargets(index, id, 'enabled', resolved.targets, now);
  if (next !== index) changes.push({ action: 'modify', kind: 'index_record', path: record.path });
  return {
    index: next,
    findings,
    changes,
    data: {
      id,
      status_before: record.status,
      status_after: 'enabled',
      targets: targetStates,
      unchanged: changes.length === 0,
    },
  };
}

/**
 * 禁用（契约 4.10）。
 *
 * 只切换可见性：把副本内的技能元数据文件改名为带禁用后缀的名称，不删除任何内容文件，
 * 也不触发内容分发。副本不存在的目标只有索引状态变更，实际动作在载荷中说明。
 */
export function disableSkill(input: ToggleInput): LifecycleOutcome {
  const { layout, index, id, now, target, scope, dryRun } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) return notRegistered(id, index);

  const resolved = targetsOfRecord({ layout, record, target, scope });
  if (resolved.targets.length === 0 && resolved.findings.length > 0) {
    return {
      index,
      findings: resolved.findings,
      changes: [],
      data: { rejected: 'targets_unreadable' },
    };
  }

  // 第一遍只做判定，不落盘：得到将发生的变更与各目标的前后状态
  const targetStates: Array<Record<string, unknown>> = [];
  const pending: Array<{ path: string; declared: string; existed: boolean }> = [];
  for (const item of resolved.targets) {
    const copyPath = item.absolutePath;
    const existed = pathExists(copyPath);
    const before = existed ? (isCopyDisabled(copyPath) ? 'disabled' : 'enabled') : null;
    if (!existed) {
      targetStates.push({
        target: item.target,
        scope: item.scope,
        path: item.declaredPath,
        existed: false,
        state_before: null,
        state_after: 'disabled',
      });
      continue;
    }
    if (before === 'enabled')
      pending.push({ path: copyPath, declared: item.declaredPath, existed });
    targetStates.push({
      target: item.target,
      scope: item.scope,
      path: item.declaredPath,
      existed: true,
      state_before: before,
      state_after: 'disabled',
    });
  }
  const summaryDrifted =
    record.status !== 'disabled' ||
    resolved.targets.some(
      (item) =>
        record.targets.find((entry) => entry.target === item.target && entry.scope === item.scope)
          ?.enabled !== false,
    );

  if (dryRun === true) {
    return {
      index,
      findings: [],
      changes: [
        ...pending.map((item): Change => ({
          action: 'modify',
          kind: 'copy_marker',
          path: item.path,
        })),
        ...(summaryDrifted
          ? [{ action: 'modify' as const, kind: 'index_record', path: record.path }]
          : []),
      ],
      preview: true,
      data: {
        preview: true,
        id,
        status_before: record.status,
        status_after: 'disabled',
        targets: targetStates,
        actions: [
          ...pending.map((item) => `副本 ${item.declared} 内的技能元数据文件将改为禁用态`),
          ...targetStates
            .filter((item) => item['existed'] === false)
            .map((item) => `目标 ${String(item['target'])} 尚未落位，将只更新索引状态`),
        ],
      },
    };
  }

  // 幂等：副本与状态都已是目标态时不产生任何变更
  if (pending.length === 0 && !summaryDrifted) {
    return {
      index,
      findings: [],
      changes: [],
      data: {
        id,
        status_before: record.status,
        status_after: 'disabled',
        targets: targetStates,
        actions: ['副本与索引状态均已是禁用态，无需改动'],
      },
    };
  }

  const changes: Change[] = [];
  const actions: string[] = [];
  for (const item of pending) {
    try {
      if (setCopyVisibility(item.path, false) === 'changed') {
        changes.push({ action: 'modify', kind: 'copy_marker', path: item.path });
        actions.push(`副本 ${item.declared} 内的技能元数据文件已改为禁用态`);
      }
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [toFinding(kernelError)],
        changes: [],
        data: { rejected: 'copy_toggle_failed' },
      };
    }
  }
  for (const item of targetStates) {
    if (item['existed'] === false)
      actions.push(`目标 ${String(item['target'])} 尚未落位，仅更新索引状态`);
  }

  const next = withTargets(index, id, 'disabled', resolved.targets, now);
  changes.push({ action: 'modify', kind: 'index_record', path: record.path });
  return {
    index: next,
    findings: [],
    changes,
    data: {
      id,
      status_before: record.status,
      status_after: 'disabled',
      targets: targetStates,
      actions: actions.length > 0 ? actions : ['无需改动副本，仅更新索引状态'],
    },
  };
}

/** 标识不在索引中的统一回应：索引原样返回，调用方据此跳过写入 */
