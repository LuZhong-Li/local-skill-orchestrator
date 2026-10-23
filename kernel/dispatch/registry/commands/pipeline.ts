/** pipeline 命令处理器。 */

import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { option, optionList } from '../../parsers/index.ts';
import {
  classifyProblem,
  planPipeline,
  runPipeline,
  runPipelineWithAnswers,
  StubProvider,
  writeDocumentPackage,
} from '../../../core/pipeline/index.ts';
import type { CommandHandler, CommandSpec } from '../types.ts';
import { join } from 'node:path';

/** pipeline run 命令处理器 */
const pipelineRunHandler: CommandHandler = async (context): Promise<Result<unknown>> => {
  const findings: Finding[] = [];
  let problem = option(context.args, 'problem');
  let outputDir = option(context.args, 'output-dir');
  const answersRaw = optionList(context.args, 'answers');

  if (!problem || !outputDir) {
    if (!problem) {
      findings.push(
        finding(CODES.INPUT_MISSING_ARG, {
          source: 'input',
          target: '--problem',
          message: '缺少 --problem 选项',
          remedy: '请提供 --problem "问题描述"',
        }),
      );
    }
    if (!outputDir) {
      findings.push(
        finding(CODES.INPUT_MISSING_ARG, {
          source: 'input',
          target: '--output-dir',
          message: '缺少 --output-dir 选项',
          remedy: '请提供 --output-dir 目录路径',
        }),
      );
    }
    return buildResult(context.args.command, findings);
  }

  problem = problem as string;
  outputDir = outputDir as string;

  // 解析 answers（格式 q1=a1）
  const answers: Record<string, string> = {};
  for (const ans of answersRaw) {
    const eqIndex = ans.indexOf('=');
    if (eqIndex > 0) {
      const q = ans.slice(0, eqIndex);
      const a = ans.slice(eqIndex + 1);
      answers[q] = a;
    }
  }

  // 执行流水线
  const classification = classifyProblem(problem);
  const planResult = planPipeline({
    id: 'cli-pipeline',
    statement: problem,
    kind: classification.kind,
    involvesUi: classification.involvesUi,
  });

  let docs;
  if (Object.keys(answers).length > 0) {
    docs = await runPipelineWithAnswers(planResult, new StubProvider(), answers);
  } else {
    docs = await runPipeline(planResult, new StubProvider());
  }

  // 检查是否是 questionnaire-pending
  const first = docs[0];
  if (docs.length === 1 && first && first.docType === 'questionnaire-pending') {
    const data = JSON.parse(first.content);
    return buildResult(context.args.command, [], [], { data });
  }

  // 收敛了，写出文档包
  writeDocumentPackage(outputDir, docs);

  const docPaths = docs.map((d) => join(outputDir, `${d.stage}.md`));
  docPaths.push(join(outputDir, 'INDEX.md'));

  return buildResult(context.args.command, [], [], {
    data: {
      message: '文档包生成成功',
      output_dir: outputDir,
      documents: docPaths,
    },
  });
};

/** 注册 pipeline 命令 */
export function registerPipelineCommands(registerFn: (spec: CommandSpec) => void): void {
  registerFn({
    name: 'pipeline run',
    handler: pipelineRunHandler,
  });
}
