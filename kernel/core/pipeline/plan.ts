/**
 * M0 流水线规划器：根据问题类型和 UI 涉否，决定走哪些环节。
 *
 * 基础五环节：requirements -> research -> design -> plan -> approval
 * UI 四件套：page-design -> ui -> interaction -> visual-style（design 之后）
 */
import type { PipelinePlan, Problem, StagePlan } from './types.ts';

function baseStage(stage: StagePlan['stage'], reason: string, deliverableDoc: string): StagePlan {
  return { stage, status: 'pending', reason, deliverableDoc };
}

function skipStage(stage: StagePlan['stage'], reason: string, deliverableDoc: string): StagePlan {
  return { stage, status: 'skipped', reason, deliverableDoc };
}

function uiStages(): StagePlan[] {
  return [
    baseStage('page-design', '问题涉及 UI，需先做页面结构设计', 'doc.page-design'),
    baseStage('ui', '问题涉及 UI，需做组件级设计', 'doc.ui'),
    baseStage('interaction', '问题涉及 UI，需做交互流程设计', 'doc.interaction'),
    baseStage('visual-style', '问题涉及 UI，需定义视觉风格 token', 'doc.visual-style'),
  ];
}

export function planPipeline(problem: Problem): PipelinePlan {
  const stages: StagePlan[] = [];

  // 1. 需求：所有问题都走（research 类简化但保留）
  stages.push(baseStage('requirements', '所有问题必须先收敛需求', 'doc.requirements'));

  // 2. 调研
  if (problem.kind === 'bugfix') {
    stages.push(skipStage('research', 'bugfix 原因通常明确，跳过独立调研环节', 'doc.research'));
  } else if (problem.kind === 'research') {
    stages.push(baseStage('research', '问题本身就是调研，重点投入', 'doc.research'));
  } else {
    stages.push(baseStage('research', '需要调研佐证设计决策', 'doc.research'));
  }

  // 3. 设计
  if (problem.kind === 'docs') {
    stages.push(baseStage('design', '文档类问题需要结构设计但简化', 'doc.design'));
  } else {
    stages.push(baseStage('design', '需要架构/领域模型/契约设计', 'doc.design'));
  }

  // 4. UI 四件套（按需）
  if (problem.involvesUi) {
    stages.push(...uiStages());
  } else {
    // 跳过 UI 四件套
    stages.push(skipStage('page-design', '问题不涉及 UI', 'doc.page-design'));
    stages.push(skipStage('ui', '问题不涉及 UI', 'doc.ui'));
    stages.push(skipStage('interaction', '问题不涉及 UI', 'doc.interaction'));
    stages.push(skipStage('visual-style', '问题不涉及 UI', 'doc.visual-style'));
  }

  // 5. 计划
  if (problem.kind === 'docs') {
    stages.push(skipStage('plan', '文档类问题不需要实施计划', 'doc.plan'));
  } else {
    stages.push(baseStage('plan', '需要拆里程碑/任务/验收映射', 'doc.plan'));
  }

  // 6. 审批：所有问题都走
  stages.push(baseStage('approval', '所有文档包需经审批收口', 'doc.approval'));

  return {
    problemId: problem.id,
    kind: problem.kind,
    stages,
    createdAt: new Date().toISOString(),
  };
}
