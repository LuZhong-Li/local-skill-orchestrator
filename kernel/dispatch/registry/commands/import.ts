import { saveIndex } from '../../../core/index/index.ts';
import { importIndex } from '../../../core/backup/index.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES, finding } from '../../../store/contract.ts';
import { buildResult } from '../../result/index.ts';
import { flag, option } from '../../parsers/index.ts';
import { workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
import { confirmationGate, formatRejected, loadForWrite, unreadableIndex } from '../shared.ts';
export const importHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const source = args.positionals[0];
  if (source === undefined || source === '') {
    return buildResult('import', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'path',
        message: 'import 需要给出备份文件路径',
        remedy: '请提供工作区之内的相对路径，例如 backups/export.yaml',
      }),
    ]);
  }
  if (option(args, 'on-conflict') !== undefined) {
    // 一期导入不覆盖既有记录，冲突一律跳过，因此没有策略维度
    return buildResult('import', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--on-conflict',
        message: '一期导入不覆盖既有记录，冲突一律跳过，该选项没有可用语义',
        remedy: '请省略 --on-conflict；策略化覆盖属二期',
      }),
    ]);
  }
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('import', layout, findings, missing);
  const dryRun = flag(args, 'dry-run');
  const preview = importIndex({ layout, index, source, now, dryRun: true });
  if (preview.refused === true) {
    // 校验失败整体拒绝，且按契约 4.15 的专属口径返回退出码 3
    return formatRejected('import', [...findings, ...preview.findings], preview.data);
  }
  if (!dryRun) {
    const planned = Number(preview.data['imported'] ?? 0);
    const blocked = await confirmationGate({
      command: 'import',
      args,
      interaction,
      preview: {
        index,
        findings: preview.findings,
        changes: preview.index.skills
          .filter((item) => !index.skills.some((old) => old.id === item.id))
          .map((item) => ({ action: 'add' as const, kind: 'index_record', path: item.path })),
        data: preview.data,
      },
      plan: {
        action: '导入',
        subject: source,
        writes: [],
        notes: [],
        inline: `将登记 ${planned} 条记录，冲突条目一律跳过`,
      },
    });
    if (blocked !== null) return blocked;
  }
  const outcome = importIndex({ layout, index, source, now, dryRun });
  if (outcome.refused === true) {
    return formatRejected('import', [...findings, ...outcome.findings], outcome.data);
  }
  if (!dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);
  return buildResult('import', [...findings, ...outcome.findings], [], {
    data: outcome.data,
    ...(outcome.preview === true ? { preview: true } : {}),
  });
};
