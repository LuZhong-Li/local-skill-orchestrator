/** experience 鍛戒护澶勭悊鍣細缁忛獙鍥炲綊鐨勬煡璇㈠叆鍙ｃ€?*/

import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { option } from '../../parsers/index.ts';
import { layoutOf, resolveWorkspaceRoot } from '../../../store/workspace/index.ts';
import {
  listExperiences,
  loadExperience,
  searchExperiences,
} from '../../../core/experience/store.ts';
import type { CommandHandler, CommandSpec } from '../types.ts';

function experiencesDir(): string {
  return layoutOf(resolveWorkspaceRoot()).experiencesDir;
}

/** experience list锛氬垪鍑哄叏閮ㄥ巻鍙茬粡楠岋紙鍊掑簭锛夈€?*/
const listHandler: CommandHandler = async (context): Promise<Result<unknown>> => {
  const limitRaw = option(context.args, 'limit');
  const limit = limitRaw ? Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 10)) : 10;
  const records = listExperiences(experiencesDir()).slice(0, limit);
  return buildResult(context.args.command, [], [], {
    data: {
      count: records.length,
      experiences: records.map((r) => ({
        id: r.id,
        problem: r.problem,
        kind: r.kind,
        stages: r.stages,
        createdAt: r.createdAt,
        provider: r.provider,
      })),
    },
  });
};

/** experience search <鍏抽敭璇?锛氭寜鍏抽敭璇嶆绱€?*/
const searchHandler: CommandHandler = async (context): Promise<Result<unknown>> => {
  const keyword = option(context.args, 'query') ?? context.args.positionals[0];
  if (!keyword) {
    return buildResult(context.args.command, [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: '--query',
        message: '缺少检索关键词',
        remedy: '请提供 experience search --query "<关键词>"',
      }),
    ]);
  }
  const records = searchExperiences(experiencesDir(), keyword);
  return buildResult(context.args.command, [], [], {
    data: {
      keyword,
      count: records.length,
      experiences: records.map((r) => ({
        id: r.id,
        problem: r.problem,
        kind: r.kind,
        stages: r.stages,
        createdAt: r.createdAt,
      })),
    },
  });
};

/** experience show <id>锛氭煡鐪嬪崟鏉＄粡楠岃鎯呫€?*/
const showHandler: CommandHandler = async (context): Promise<Result<unknown>> => {
  const id = context.args.positionals[0];
  if (!id) {
    return buildResult(context.args.command, [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: '缺少经验 id',
        remedy: '请提供 experience show <id>',
      }),
    ]);
  }
  const record = loadExperience(experiencesDir(), id);
  if (record === null) {
    return buildResult(context.args.command, [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'experience',
        target: id,
        message: `经验不存在：${id}`,
        remedy: '请先用 experience list 查看可用 id',
      }),
    ]);
  }
  return buildResult(context.args.command, [], [], { data: record });
};

/** 娉ㄥ唽 experience 鍛戒护銆?*/
export function registerExperienceCommands(registerFn: (spec: CommandSpec) => void): void {
  registerFn({ name: 'experience list', handler: listHandler });
  registerFn({ name: 'experience search', handler: searchHandler });
  registerFn({ name: 'experience show', handler: showHandler });
}
