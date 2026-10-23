/**
 * M0 问题分类：规则匹配，不接 LLM。
 * M1 接入 IntelligenceProvider 后可升级为 LLM 分类。
 */
import type { ProblemKind } from './types.ts';

const BUG_KEYWORDS = [
  'bug',
  'crash',
  'error',
  'fix',
  'broken',
  'regression',
  'fail',
  '崩溃',
  '报错',
  '修复',
  '故障',
  '异常',
];

const REFACTOR_KEYWORDS = [
  'refactor',
  'cleanup',
  'restructure',
  'migrate',
  'improve',
  'tech debt',
  '重构',
  '清理',
  '迁移',
  '优化结构',
  '技术债',
];

const DOCS_KEYWORDS = [
  'document',
  'docs',
  'readme',
  'guide',
  'tutorial',
  'api doc',
  '文档',
  '说明',
  '教程',
  '注释',
];

const RESEARCH_KEYWORDS = [
  'research',
  'investigate',
  'compare',
  'evaluate',
  'feasibility',
  '调研',
  '对比',
  '评估',
  '可行性',
  '选型',
];

const UI_KEYWORDS = [
  'ui',
  'ux',
  '界面',
  '页面',
  '按钮',
  '弹窗',
  '交互',
  '视觉',
  '样式',
  '布局',
  'frontend',
  'frontend',
  'dashboard',
  'view',
  'component',
];

export interface ClassificationResult {
  kind: ProblemKind;
  involvesUi: boolean;
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function classifyProblem(statement: string): ClassificationResult {
  if (hasKeyword(statement, BUG_KEYWORDS))
    return { kind: 'bugfix', involvesUi: hasKeyword(statement, UI_KEYWORDS) };
  if (hasKeyword(statement, REFACTOR_KEYWORDS))
    return { kind: 'refactor', involvesUi: hasKeyword(statement, UI_KEYWORDS) };
  if (hasKeyword(statement, DOCS_KEYWORDS))
    return { kind: 'docs', involvesUi: hasKeyword(statement, UI_KEYWORDS) };
  if (hasKeyword(statement, RESEARCH_KEYWORDS))
    return { kind: 'research', involvesUi: hasKeyword(statement, UI_KEYWORDS) };
  // 默认：新功能
  return { kind: 'new-feature', involvesUi: hasKeyword(statement, UI_KEYWORDS) };
}
