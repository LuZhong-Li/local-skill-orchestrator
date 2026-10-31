/**
 * 经验回归领域模型。
 *
 * 每次 pipeline run 处理完一个问题后自动记录一条经验；
 * 之后可以通过 experience list / search / show 查询回归，
 * 或通过 pipeline run --experience 预填相似问题的问答。
 */

/** 单条经验记录。 */
export interface ExperienceRecord {
  id: string;
  /** 问题原文。 */
  problem: string;
  /** 问题分类。 */
  kind: string;
  /** 是否涉及 UI。 */
  involvesUi: boolean;
  /** 走过的环节。 */
  stages: string[];
  /** 追问的决策记录（问答对）。 */
  decisions: ExperienceDecision[];
  /** 产出文档类型列表。 */
  docTypes: string[];
  /** 使用的 provider 名称。 */
  provider: string;
  /** 耗时毫秒。 */
  durationMs: number;
  /** 记录时间（ISO）。 */
  createdAt: string;
  /** 问题摘要（用于检索展示，取原文前 N 字）。 */
  summary: string;
}

/** 经验中的单条问答决策。 */
export interface ExperienceDecision {
  question: string;
  answer: string;
}
