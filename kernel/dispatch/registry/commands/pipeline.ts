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
  createDoubaoProvider,
  createClaudeProvider,
  OpenAICompatibleProvider,
} from '../../../core/pipeline/index.ts';
import type { CommandContext, CommandHandler, CommandSpec } from '../types.ts';
import type { IntelligenceProvider } from '../../../core/pipeline/types.ts';
import { join } from 'node:path';
import { layoutOf, resolveWorkspaceRoot } from '../../../store/workspace/index.ts';
import {
  buildExperience,
  findSimilarExperience,
  newExperienceId,
  saveExperience,
} from '../../../core/experience/store.ts';
import type { ExperienceDecision } from '../../../core/experience/types.ts';

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

  // 经验回归：--experience <关键词> 预填相似经验的问答
  const experienceKeyword = option(context.args, 'experience');
  const experiencesDir = layoutOf(resolveWorkspaceRoot()).experiencesDir;
  let experienceApplied = false;
  if (experienceKeyword && Object.keys(answers).length === 0) {
    const similar = findSimilarExperience(experiencesDir, experienceKeyword);
    if (similar !== null && similar.decisions.length > 0) {
      for (const d of similar.decisions) {
        if (!answers[d.question]) answers[d.question] = d.answer;
      }
      experienceApplied = true;
    }
  }

  // 创建 provider
  const provider = createProvider(context);

  // 执行流水线
  const classification = classifyProblem(problem);
  const planResult = planPipeline({
    id: 'cli-pipeline',
    statement: problem,
    kind: classification.kind,
    involvesUi: classification.involvesUi,
  });

  const startedAt = Date.now();
  let docs;
  if (Object.keys(answers).length > 0) {
    docs = await runPipelineWithAnswers(planResult, provider, answers);
  } else {
    docs = await runPipeline(planResult, provider);
  }
  const durationMs = Date.now() - startedAt;

  // 检查是否是 questionnaire-pending
  const first = docs[0];
  if (docs.length === 1 && first && first.docType === 'questionnaire-pending') {
    const data = JSON.parse(first.content);
    return buildResult(context.args.command, [], [], { data });
  }

  // 收敛了，写出文档包
  writeDocumentPackage(outputDir, docs);

  // 经验回归：本次处理自动累计一条经验
  const experienceId = recordExperience({
    experiencesDir,
    problem,
    classification,
    planResult,
    docs,
    provider,
    answers,
    durationMs,
  });

  const docPaths = docs.map((d) => join(outputDir, `${d.stage}.md`));
  docPaths.push(join(outputDir, 'INDEX.md'));

  return buildResult(context.args.command, [], [], {
    data: {
      message: '文档包生成成功',
      output_dir: outputDir,
      provider: provider.name,
      documents: docPaths,
      experience_applied: experienceApplied,
      experience_id: experienceId,
    },
  });
};

/** 按 --llm-provider / --llm-api-key 创建 provider；缺省用 Stub。 */
function createProvider(context: CommandContext): IntelligenceProvider {
  const llmProviderType = option(context.args, 'llm-provider');
  const llmApiKey = option(context.args, 'llm-api-key');

  if (llmProviderType && llmApiKey) {
    const llmBaseUrl = option(context.args, 'llm-base-url');
    const llmModel = option(context.args, 'llm-model');
    const llmTemperature = option(context.args, 'llm-temperature');
    const config: { apiKey: string; baseURL?: string; model?: string; temperature?: number } = {
      apiKey: llmApiKey,
    };
    if (llmBaseUrl) config.baseURL = llmBaseUrl;
    if (llmModel) config.model = llmModel;
    if (llmTemperature) config.temperature = parseFloat(llmTemperature);

    if (llmProviderType === 'doubao') return createDoubaoProvider(config);
    if (llmProviderType === 'claude') return createClaudeProvider(config);
    return new OpenAICompatibleProvider(llmProviderType, config);
  }
  return new StubProvider();
}

/** 把本次处理写为一条经验；失败静默（不影响主流程）。 */
function recordExperience(input: {
  experiencesDir: string;
  problem: string;
  classification: { kind: string; involvesUi: boolean };
  planResult: { stages: Array<{ stage: string; status: string }> };
  docs: Array<{ docType: string }>;
  provider: { name: string };
  answers: Record<string, string>;
  durationMs: number;
}): string {
  const record = buildExperience({
    id: newExperienceId(new Date().toISOString()),
    problem: input.problem,
    kind: input.classification.kind,
    involvesUi: input.classification.involvesUi,
    stages: input.planResult.stages.filter((s) => s.status !== 'skipped').map((s) => s.stage),
    decisions: createDecisionRecords(input.answers),
    docTypes: input.docs.map((d) => d.docType),
    provider: input.provider.name,
    durationMs: input.durationMs,
    createdAt: new Date().toISOString(),
  });
  try {
    saveExperience(input.experiencesDir, record);
  } catch {
    // 经验记录失败不影响主流程
  }
  return record.id;
}

/** 由 --answers 构造决策记录（问题文本取问卷固定文案）。 */
function createDecisionRecords(answers: Record<string, string>): ExperienceDecision[] {
  const QUESTION_TEXTS: Record<string, string> = {
    q1: '这个问题要解决谁的痛点？',
    q2: '成功标准是什么？',
    q3: '有哪些硬约束？',
    q4: '有没有相关的参考或竞品？',
  };
  return Object.entries(answers).map(([questionId, answer]) => ({
    question: QUESTION_TEXTS[questionId] ?? questionId,
    answer,
  }));
}

/** 注册 pipeline 命令 */
export function registerPipelineCommands(registerFn: (spec: CommandSpec) => void): void {
  registerFn({
    name: 'pipeline run',
    handler: pipelineRunHandler,
  });
}
