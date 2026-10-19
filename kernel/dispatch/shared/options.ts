/** 指令层共享的参数辅助：工作区定位与插件分支选项拒绝。 */
import { resolveWorkspaceRoot } from '../../store/workspace/index.ts';
import { CODES, finding } from '../../store/contract.ts';
import { buildResult, type Result } from '../result/index.ts';
import { flag, option, type ParsedArgs } from '../parsers/index.ts';

/** 当前调用是否显式选择插件对象。 */
export function pluginKind(args: ParsedArgs): boolean {
  return option(args, 'kind') === 'plugin';
}

/** 插件分支只接受 plugin-format 明确列出的选项；Skill 专用选项必须显式拒绝。 */
export function rejectPluginOptions(
  command: string,
  args: ParsedArgs,
  disallowed: readonly string[],
): Result<unknown> | null {
  for (const name of disallowed) {
    if (option(args, name) !== undefined || flag(args, name)) {
      return buildResult(command, [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: `--${name}`,
          message: `插件分支不接受 --${name}`,
          remedy: '使用 --kind plugin 的插件专用语义；Skill 目标/宿主选项不适用于插件对象',
        }),
      ]);
    }
  }
  return null;
}

/** 解析工作区根目录：命令行选项优先，其次环境变量，最后用户主目录。 */
export function workspaceRootOf(args: ParsedArgs): string {
  return resolveWorkspaceRoot(option(args, 'workspace'));
}
