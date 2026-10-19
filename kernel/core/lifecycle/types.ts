/** K-04 lifecycle 的稳定输入与输出类型；不含执行逻辑。 */
import type { Change, Finding } from '../../store/contract.ts';
import type { SkillIndex } from '../metadata/types.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';

export interface LifecycleOutcome {
  index: SkillIndex;
  findings: Finding[];
  changes: Change[];
  data: Record<string, unknown>;
  /** 预演：调用方不得写入任何文件 */
  preview?: boolean;
}

export interface InstallInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 来源：本地目录，或指向 skill_meta.yaml 的文件路径，均为工作区内或显式给出的路径 */
  sourcePath: string;
  now: string;
  /** 只向指定目标分发；省略时分发到全部声明的目标 */
  target?: string;
  /** 仅落库：只写中心库与登记记录，不分发到目标位置，状态置为已禁用 */
  libraryOnly?: boolean;
  /** 预演：返回将要发生的变更，不写入任何文件 */
  dryRun?: boolean;
  /** 只向指定作用域的目标分发 */
  scope?: string;
}

export interface UninstallInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 是否连同中心库原件一并删除；默认为否 */
  hard?: boolean;
  /** 预演：返回将要删除与保留的路径，不执行删除 */
  dryRun?: boolean;
}

export interface ToggleInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 只作用于指定目标；省略时作用于全部已落位目标 */
  target?: string;
  scope?: string;
  dryRun?: boolean;
}

export interface UpdateInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 只检查并报告漂移与版本差异，不写入任何文件 */
  check?: boolean;
  /** 只刷新指定目标的副本；省略时刷新全部已存在的副本 */
  target?: string | undefined;
  /** 远端 git 来源的目标标签；成功后持久化为新的 source.ref */
  ref?: string | undefined;
}

export interface RestoreInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 指定备份时间戳；省略时取该 Skill 最新的备份 */
  timestamp?: string | undefined;
  /** 预演：返回将恢复的文件清单，不写入任何文件 */
  dryRun?: boolean;
}
