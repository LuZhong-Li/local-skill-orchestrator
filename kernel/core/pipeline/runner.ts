/** 流水线执行器：将 PipelinePlan 转换为 DeliverableDoc[]。 */

import type { PipelinePlan, DeliverableDoc } from './types.ts';
import type { IntelligenceProvider } from './types.ts';
import { HumanFallbackProvider } from './provider.ts';
import { getMetaSkill } from './meta-skills.ts';

/**
 * 执行流水线计划，产出各环节的交付文档。
 *
 * @param plan 流水线计划
 * @param provider 智能生成提供者
 * @returns 交付文档数组
 */
export async function runPipeline(
  plan: PipelinePlan,
  provider: IntelligenceProvider
): Promise<DeliverableDoc[]> {
  const safeProvider = new HumanFallbackProvider(provider);
  const docs: DeliverableDoc[] = [];

  for (const stagePlan of plan.stages) {
    if (stagePlan.status === 'skipped') {
      continue;
    }

    if (stagePlan.status === 'pending') {
      const metaSkill = getMetaSkill(stagePlan.stage);
      const content = await safeProvider.generate(metaSkill.prompt, {
        problemId: plan.problemId,
        kind: plan.kind,
        docType: metaSkill.docType,
        topic: plan.problemId,
      });

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