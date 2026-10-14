/**
 * S-07 中心库与受控副本。
 *
 * AMB-01 的裁决：启用与禁用只作用于目标位置的受控副本，
 * 通过把副本内的技能元数据文件改名为带禁用后缀的名称实现；
 * 不移动、不重命名、不删除任何目录，也不改动中心库原件与用户源文件。
 *
 * 本体只提供副本层面的可见性切换原语，不负责决定哪个目录是副本——
 * 该判断由调用方依据索引中的落位目标给出。
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { KernelError } from '../errors.ts';
import { CODES } from '../contract.ts';
import { DISABLED_SUFFIX, SKILL_MD_NAME } from '../../core/metadata/constants.ts';

/** 副本内被改名的文件：技能元数据文件本身 */
export function copyMarkerName(): string {
  return SKILL_MD_NAME;
}

/** 副本内禁用态的文件名 */
export function disabledMarkerName(): string {
  return SKILL_MD_NAME + DISABLED_SUFFIX;
}

/** 副本当前是否处于禁用态 */
export function isCopyDisabled(copyDir: string): boolean {
  return (
    existsSync(join(copyDir, disabledMarkerName())) && !existsSync(join(copyDir, copyMarkerName()))
  );
}

/** 切换副本的可见性；已是目标状态时不产生变更，天然幂等 */
export function setCopyVisibility(copyDir: string, enabled: boolean): 'changed' | 'unchanged' {
  const active = join(copyDir, copyMarkerName());
  const disabled = join(copyDir, disabledMarkerName());

  if (enabled) {
    if (existsSync(active)) return 'unchanged';
    if (!existsSync(disabled)) {
      throw new KernelError({
        code: CODES.PATH_INVALID,
        message: `副本缺少技能元数据文件：${copyDir}`,
        source: 'library-fs',
        target: copyDir,
        remedy: '请重新安装该 Skill，或检查副本是否完整',
      });
    }
    renameSync(disabled, active);
    return 'changed';
  }

  if (existsSync(disabled) && !existsSync(active)) return 'unchanged';
  if (!existsSync(active)) {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: `副本缺少技能元数据文件：${copyDir}`,
      source: 'library-fs',
      target: copyDir,
      remedy: '请重新安装该 Skill，或检查副本是否完整',
    });
  }
  renameSync(active, disabled);
  return 'changed';
}
