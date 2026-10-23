/**
 * M0 文档流水线领域模型。
 *
 * skill-manager 作为文档驱动的问题处理 agent：输入一个问题，
 * 产出一条流水线计划（走哪些环节、为什么走/不走），每个环节
 * 对应一份交付文档。
 */

/** 问题类型（规则分类，M0 不接 LLM）。 */
export type ProblemKind = 'new-feature' | 'refactor' | 'bugfix' | 'docs' | 'research';

/** 流水线环节。 */
export type PipelineStage =
  | 'requirements'
  | 'research'
  | 'design'
  | 'plan'
  | 'approval'
  | 'page-design'
  | 'ui'
  | 'interaction'
  | 'visual-style';

/** 环节状态。 */
export type StageStatus = 'pending' | 'skipped' | 'done';

/** 输入问题。 */
export interface Problem {
  id: string;
  statement: string;
  kind: ProblemKind;
  /** 是否涉及 UI / 前端 / 界面（决定是否加 UI 四件套）。 */
  involvesUi: boolean;
}

/** 单个环节的计划。 */
export interface StagePlan {
  stage: PipelineStage;
  status: StageStatus;
  /** 走/不走这个环节的理由。 */
  reason: string;
  /** 产出文档类型（doc.* 主元skill）。 */
  deliverableDoc: string;
}

/** 一条问题对应的完整流水线计划。 */
export interface PipelinePlan {
  problemId: string;
  kind: ProblemKind;
  stages: StagePlan[];
  createdAt: string;
}

/** 单份交付文档。 */
export interface DeliverableDoc {
  stage: PipelineStage;
  docType: string;
  content: string;
  source: string;
  createdAt: string;
}

/** 智能生成提供者接口。 */
export interface IntelligenceProvider {
  readonly name: string;
  generate(prompt: string, context: Record<string, unknown>): Promise<string>;
}