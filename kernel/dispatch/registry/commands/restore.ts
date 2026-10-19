import { saveIndex } from '../../../core/index/index.ts';
import { restoreSkill } from '../../../core/lifecycle/index.ts';
import { listAllBackups, listBackups } from '../../../store/backup-fs/index.ts';
import { ID_PATTERN } from '../../../core/metadata/constants.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES, finding } from '../../../store/contract.ts';
import { buildResult } from '../../result/index.ts';
import { flag, option } from '../../parsers/index.ts';
import { workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
import { confirmationGate, loadForWrite, planOf, unreadableIndex } from '../shared.ts';
export const restoreHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  // 备份列表出口：备份管理界面要列出可用备份，而界面不得直读工作区文件，
  // 因此由这条既有指令的取值选项给出列表。它不是写操作，不参与确认流程。
  if (flag(args, 'list')) {
    if (id !== undefined && id !== '' && !ID_PATTERN.test(id)) {
      return buildResult('restore', [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识不符合命名规范：${id}`,
          remedy: '标识需为全小写、短横线分隔',
        }),
      ]);
    }
    const entries =
      id === undefined || id === ''
        ? listAllBackups(layout.root, layout.backupsDir)
        : listBackups(layout.root, layout.backupsDir, id);
    return buildResult('restore', [], [], {
      data: {
        backups: entries.map((entry) => ({
          id: entry.id,
          timestamp: entry.timestamp,
          type: entry.type,
          file_count: entry.fileCount,
          path: entry.portableDir,
        })),
        total: entries.length,
        filtered_by: id === undefined || id === '' ? null : id,
        notes: [
          '列表只读取备份清单，不校验载体内容；恢复时会逐份校验后再写回',
          entries.length === 0
            ? '没有可用备份：卸载 Skill 时会自动生成备份，也可以用 restore 之外的导出/导入流程迁移记录'
            : '按标识与时间戳恢复：restore <标识> --timestamp <时间戳>',
        ],
      },
    });
  }
  if (id === undefined || id === '') {
    return buildResult('restore', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'restore 需要给出 Skill 标识',
        remedy: '请提供要恢复的 Skill 标识；省略时间戳时取该标识最新的备份',
      }),
    ]);
  }
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('restore', layout, findings, missing);
  const dryRun = flag(args, 'dry-run');
  const timestamp = option(args, 'timestamp');
  const base = {
    layout,
    index,
    id,
    now,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
  // 恢复是覆盖性写操作：常规确认级别，预演先给出将写回的文件清单
  if (!dryRun) {
    const preview = restoreSkill({ ...base, dryRun: true });
    const blocked = await confirmationGate({
      command: 'restore',
      args,
      interaction,
      preview,
      plan: planOf('restore', id, preview, [
        '恢复会把备份内容写回中心库，覆盖该位置现有的原件',
        '恢复不判定校验结论，完成后请执行扫描',
      ]),
    });
    if (blocked !== null) return blocked;
  }
  const outcome = restoreSkill({ ...base, dryRun });
  if (!dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);
  return buildResult('restore', [...findings, ...outcome.findings], outcome.changes, {
    data: outcome.data,
    ...(outcome.preview === true ? { preview: true } : {}),
  });
};
