/** validate 处理器。 */
import { existsSync } from 'node:fs';
import { loadIndex } from '../../../core/index/index.ts';
import { validateWorkspace, type ValidationReport } from '../../../core/validation/index.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { categoryOf, finding } from '../../../store/findings.ts';
import { buildResult } from '../../result/index.ts';
import { flag } from '../../parsers/index.ts';
import { workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
function validateResult(
  findings: Finding[],
  report: ValidationReport | undefined,
  strict: boolean,
) {
  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warning');
  let exitCode = 0;
  if (errors.length > 0) {
    exitCode = errors.some((item) => categoryOf(item.code) === 'INPUT') ? 2 : 1;
  } else if (strict && warnings.length > 0) {
    exitCode = 1;
  }
  const result = buildResult(
    'validate',
    findings,
    [],
    report === undefined ? {} : { data: report },
  );
  result.exit_code = exitCode;
  result.ok = exitCode === 0;
  return result;
}
export const validateHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const subject = args.positionals[0];
  const strict = flag(args, 'strict');
  // 前置条件为「无」：索引不存在时报告环境类问题而非崩溃
  if (!existsSync(layout.indexFile)) {
    return validateResult(
      [
        finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化，无法校验',
          remedy: '请先执行 init 建立工作区',
        }),
      ],
      undefined,
      strict,
    );
  }
  const loaded = loadIndex(layout.indexFile);
  const findings: Finding[] = [...loaded.findings];
  if (loaded.index === null) {
    findings.push(
      finding(CODES.ENV_INCOMPLETE, {
        source: 'workspace',
        target: layout.indexFile,
        message: '索引无法读取，无法校验',
        remedy: '请先修复或重建索引',
      }),
    );
    return validateResult(findings, undefined, strict);
  }
  const outcome = validateWorkspace({
    layout,
    index: loaded.index,
    ...(subject !== undefined && subject !== '' ? { subject } : {}),
  });
  return validateResult([...findings, ...outcome.findings], outcome.report, strict);
};
/**
 * 只读指令的公共前置：读取索引。
 * 与写操作不同，只读指令在索引缺失或损坏时不建立任何东西，只把问题交给调用方。
 */
