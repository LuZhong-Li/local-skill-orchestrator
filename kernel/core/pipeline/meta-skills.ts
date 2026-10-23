/** 元 skill 注册表：将 PipelineStage 映射到对应的元 skill。 */

import type { PipelineStage } from './types.ts';

/** 元 skill 定义。 */
export interface MetaSkill {
  id: string;
  stage: PipelineStage;
  docType: string;
  prompt: string;
}

/** 已注册的元 skill 列表。 */
const META_SKILLS: MetaSkill[] = [
  {
    id: 'doc.requirements',
    stage: 'requirements',
    docType: 'requirements',
    prompt: '需求文档',
  },
  {
    id: 'research.fetch',
    stage: 'research',
    docType: 'research',
    prompt: '调研文档',
  },
  {
    id: 'design.arch',
    stage: 'design',
    docType: 'design',
    prompt: '设计文档',
  },
  {
    id: 'page-design.layout',
    stage: 'page-design',
    docType: 'page-design',
    prompt: '页面设计文档',
  },
  {
    id: 'ui.components',
    stage: 'ui',
    docType: 'ui',
    prompt: 'UI 组件文档',
  },
  {
    id: 'interaction.flow',
    stage: 'interaction',
    docType: 'interaction',
    prompt: '交互流程文档',
  },
  {
    id: 'visual-style.tokens',
    stage: 'visual-style',
    docType: 'visual-style',
    prompt: '视觉风格文档',
  },
  {
    id: 'plan.milestone',
    stage: 'plan',
    docType: 'plan',
    prompt: '计划文档',
  },
  {
    id: 'approval.review',
    stage: 'approval',
    docType: 'approval',
    prompt: '评审文档',
  },
];

/**
 * 根据环节获取对应的元 skill。找不到时抛错。
 */
export function getMetaSkill(stage: PipelineStage): MetaSkill {
  const skill = META_SKILLS.find((s) => s.stage === stage);
  if (!skill) {
    throw new Error(`Meta skill not found for stage: ${stage}`);
  }
  return skill;
}