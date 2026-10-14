/**
 * L2 指令注册与路由。
 *
 * 一期只注册 init 与 scan 两条指令的最小闭环：把参数转成对内核服务的调用，
 * 捕获内核抛出的错误并转换为标准结果封装。领域规则一律不在本层实现。
 */
import { existsSync } from 'node:fs';
import { createInitialIndex, loadIndex, saveIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { scanWorkspace } from '../../core/discovery/index.ts';
import {
  ensureWorkspaceDirs,
  layoutOf,
  resolveWorkspaceRoot,
  WORKSPACE_ENV,
} from '../../store/workspace/index.ts';
import { withLock } from '../../store/locking/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { buildResult, type Change, type Result } from '../result/index.ts';
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';

export interface CommandContext {
  args: ParsedArgs;
  /** 当前时间戳，由入口注入以便测试确定化 */
  now: string;
}

export type CommandHandler = (context: CommandContext) => Promise<Result<unknown>>;

export interface CommandSpec {
  name: string;
  handler: CommandHandler;
}

/** 一期已注册的指令名 */
export const REGISTERED_COMMANDS = ['init', 'scan'] as const;

const handlers = new Map<string, CommandHandler>();

/** 指令注册 */
export function register(spec: CommandSpec): void {
  handlers.set(spec.name, spec.handler);
}

/** 指令路由：未注册的指令返回输入类错误 */
export async function dispatch(context: CommandContext): Promise<Result<unknown>> {
  const handler = handlers.get(context.args.command);
  if (handler === undefined) {
    return buildResult(context.args.command, [
      finding(CODES.INPUT_UNKNOWN_COMMAND, {
        source: 'input',
        target: context.args.command,
        message: `未知指令：${context.args.command}`,
        remedy: `一期可用指令：${REGISTERED_COMMANDS.join('、')}`,
      }),
    ]);
  }
  return handler(context);
}

/** 解析工作区根目录：命令行选项优先，其次环境变量，最后用户主目录 */
function workspaceRootOf(args: ParsedArgs): string {
  return resolveWorkspaceRoot(option(args, 'workspace'));
}

const initHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const changes: Change[] = [];
  try {
    const existed = existsSync(layout.indexFile);
    ensureWorkspaceDirs(layout);
    if (existed) {
      // 幂等：工作区已存在时不覆盖既有索引与配置
      return buildResult('init', [], [], {
        data: {
          root: layout.root,
          index: layout.indexFile,
          created: false,
          tool_version: TOOL_VERSION,
        },
      });
    }
    const index = createInitialIndex(now);
    await withLock(layout.indexFile, () => {
      saveIndex(layout.indexFile, index);
    });
    changes.push({ action: 'add', kind: 'index', path: layout.indexFile });
    return buildResult('init', [], changes, {
      data: {
        root: layout.root,
        index: layout.indexFile,
        created: true,
        tool_version: TOOL_VERSION,
      },
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('init', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

const scanHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const dryRun = flag(args, 'dry-run');
  const overrides = optionList(args, 'root');

  if (!existsSync(layout.indexFile)) {
    return buildResult('scan', [
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化',
        remedy: `请先执行 init，或设置环境变量 ${WORKSPACE_ENV} 指向已有工作区`,
      }),
    ]);
  }

  try {
    return await withLock(layout.indexFile, () => {
      const loaded = loadIndex(layout.indexFile);
      const findings: Finding[] = [...loaded.findings];
      if (loaded.index === null) {
        findings.push(
          finding(CODES.ENV_INCOMPLETE, {
            source: 'workspace',
            target: layout.indexFile,
            message: '索引无法读取，请重建后再扫描',
            remedy: '请先执行 init 建立新的索引，或修复索引文件',
          }),
        );
        return buildResult('scan', findings);
      }

      const index =
        overrides.length > 0
          ? { ...loaded.index, config: { ...loaded.index.config, skill_roots: overrides } }
          : loaded.index;

      const outcome = scanWorkspace({ layout, index, now });
      findings.push(...outcome.findings);

      if (!dryRun) saveIndex(layout.indexFile, outcome.index);

      const extra: {
        data: { root: string; summary: typeof outcome.summary; total: number };
        preview?: boolean;
      } = {
        data: {
          root: layout.root,
          summary: outcome.summary,
          total: outcome.index.skills.length,
        },
      };
      if (dryRun) extra.preview = true;
      return buildResult('scan', findings, outcome.changes, extra);
    });
  } catch (error) {
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
};

register({ name: 'init', handler: initHandler });
register({ name: 'scan', handler: scanHandler });
