/** 流水线执行器：将 PipelinePlan 转换为 DeliverableDoc[]。 */

import type { PipelinePlan, DeliverableDoc, IntelligenceProvider, Questionnaire } from './types.ts';
import { HumanFallbackProvider } from './provider.ts';
import { getMetaSkill } from './meta-skills.ts';
import {
  createQuestionnaire,
  recordAnswer,
  isConverged,
  getOpenQuestions,
  buildDecisionRecords,
} from './questionnaire.ts';

/**
 * 执行流水线计划，产出各环节的交付文档。
 * 先跑 requirements 环节的追问，未收敛时暂停并返回问卷。
 */
export async function runPipeline(
  plan: PipelinePlan,
  provider: IntelligenceProvider,
): Promise<DeliverableDoc[]> {
  // 找到 requirements 环节
  const requirementsStage = plan.stages.find((s) => s.stage === 'requirements');

  if (requirementsStage && requirementsStage.status === 'pending') {
    const q = createQuestionnaire({
      id: plan.problemId,
      statement: '',
      kind: plan.kind,
      involvesUi: false,
    });

    if (!isConverged(q)) {
      // 未收敛，返回问卷文档
      const openQuestions = getOpenQuestions(q);
      return [
        {
          stage: 'requirements',
          docType: 'questionnaire-pending',
          content: JSON.stringify({ openQuestions, state: q.state }),
          source: 'questionnaire',
          createdAt: new Date().toISOString(),
        },
      ];
    }
  }

  // 已收敛或没有 requirements 环节，执行完整流水线
  return runCompletePipeline(plan, provider);
}

/**
 * 带回答的完整流水线执行：先记录回答并收敛，再跑完整流水线。
 */
export async function runPipelineWithAnswers(
  plan: PipelinePlan,
  provider: IntelligenceProvider,
  answers: Record<string, string>,
): Promise<DeliverableDoc[]> {
  let q = createQuestionnaire({
    id: plan.problemId,
    statement: '',
    kind: plan.kind,
    involvesUi: false,
  });

  // 记录所有回答
  for (const [questionId, answer] of Object.entries(answers)) {
    q = recordAnswer(q, questionId, answer);
  }

  // 执行完整流水线
  return runCompletePipeline(plan, provider, q);
}

/**
 * 内部：执行完整流水线（假设 requirements 环节已收敛）。
 */
async function runCompletePipeline(
  plan: PipelinePlan,
  provider: IntelligenceProvider,
  questionnaire?: Questionnaire,
): Promise<DeliverableDoc[]> {
  const safeProvider = new HumanFallbackProvider(provider);
  const docs: DeliverableDoc[] = [];

  for (const stagePlan of plan.stages) {
    if (stagePlan.status === 'skipped') {
      continue;
    }

    if (stagePlan.status === 'pending') {
      const metaSkill = getMetaSkill(stagePlan.stage);
      let content = '';

      if (stagePlan.stage === 'requirements' && questionnaire) {
        // requirements 环节，附加决策记录
        const baseContent = await safeProvider.generate(metaSkill.prompt, {
          problemId: plan.problemId,
          kind: plan.kind,
          docType: metaSkill.docType,
          topic: plan.problemId,
        });
        const decisionRecords = buildDecisionRecords(questionnaire);
        content = baseContent + '\n\n## 决策记录\n\n' + JSON.stringify(decisionRecords, null, 2);
      } else {
        // 其他环节正常生成
        content = await safeProvider.generate(metaSkill.prompt, {
          problemId: plan.problemId,
          kind: plan.kind,
          docType: metaSkill.docType,
          topic: plan.problemId,
        });
      }

      docs.push({
        stage: stagePlan.stage,
        docType: metaSkill.docType,
        content,
        source: safeProvider.name,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return docs;
}
