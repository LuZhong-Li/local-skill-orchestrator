/** pipeline runner 单元测试。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StubProvider,
  HumanFallbackProvider,
  getMetaSkill,
  runPipeline,
} from '../../kernel/core/pipeline/index.ts';
import type { PipelinePlan, PipelineStage, IntelligenceProvider } from '../../kernel/core/pipeline/types.ts';

test('StubProvider 对每个 pending 环节产出非空内容', async () => {
  const provider = new StubProvider();
  const content = await provider.generate('需求文档', { topic: '测试主题' });
  assert.ok(content.length > 0);
  assert.ok(content.includes('需求文档'));
});

test('skipped 环节不产出文档', async () => {
  const plan: PipelinePlan = {
    problemId: 'test-1',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'pending', reason: '需要', deliverableDoc: 'doc.requirements' },
      { stage: 'research', status: 'skipped', reason: '不需要', deliverableDoc: 'research.fetch' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new StubProvider());
  assert.equal(docs.length, 1);
  assert.equal(docs[0].stage, 'requirements');
});

test('HumanFallbackProvider 在 provider 抛错时回退人工模板', async () => {
  class FailingProvider implements IntelligenceProvider {
    readonly name = 'failing';
    async generate(): Promise<string> {
      throw new Error('Intentional failure');
    }
  }

  const provider = new HumanFallbackProvider(new FailingProvider());
  const content = await provider.generate('需求文档', { docType: 'requirements' });
  assert.ok(content.includes('（请人工填写）'));
});

test('HumanFallbackProvider 不中断整批执行', async () => {
  class FailingProvider implements IntelligenceProvider {
    readonly name = 'failing';
    async generate(): Promise<string> {
      throw new Error('Intentional failure');
    }
  }

  const plan: PipelinePlan = {
    problemId: 'test-2',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'pending', reason: '需要', deliverableDoc: 'doc.requirements' },
      { stage: 'design', status: 'pending', reason: '需要', deliverableDoc: 'design.arch' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new FailingProvider());
  assert.equal(docs.length, 2);
  docs.forEach((doc) => {
    assert.ok(doc.content.includes('（请人工填写）'));
  });
});

test('getMetaSkill 对 9 个环节都能找到', () => {
  const stages: PipelineStage[] = [
    'requirements',
    'research',
    'design',
    'plan',
    'approval',
    'page-design',
    'ui',
    'interaction',
    'visual-style',
  ];

  stages.forEach((stage) => {
    const skill = getMetaSkill(stage);
    assert.equal(skill.stage, stage);
  });
});

test('getMetaSkill 对未知 stage 抛错', () => {
  assert.throws(() => {
    // @ts-expect-error testing unknown stage
    getMetaSkill('unknown-stage');
  });
});

test('runPipeline 正常流程：所有 pending 环节都产出文档', async () => {
  const plan: PipelinePlan = {
    problemId: 'test-3',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'pending', reason: '需要', deliverableDoc: 'doc.requirements' },
      { stage: 'design', status: 'pending', reason: '需要', deliverableDoc: 'design.arch' },
      { stage: 'plan', status: 'pending', reason: '需要', deliverableDoc: 'plan.milestone' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new StubProvider());
  assert.equal(docs.length, 3);
  assert.ok(docs.every((doc) => doc.content.length > 0));
  assert.ok(docs.every((doc) => doc.source === 'human-fallback'));
});

test('DeliverableDoc 字段完整', async () => {
  const plan: PipelinePlan = {
    problemId: 'test-4',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'pending', reason: '需要', deliverableDoc: 'doc.requirements' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new StubProvider());
  const doc = docs[0];
  assert.ok(doc.stage);
  assert.ok(doc.docType);
  assert.ok(doc.content);
  assert.ok(doc.source);
  assert.ok(doc.createdAt);
});

test('多个 skipped 环节都被正确跳过', async () => {
  const plan: PipelinePlan = {
    problemId: 'test-5',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'pending', reason: '需要', deliverableDoc: 'doc.requirements' },
      { stage: 'research', status: 'skipped', reason: '不需要', deliverableDoc: 'research.fetch' },
      { stage: 'design', status: 'pending', reason: '需要', deliverableDoc: 'design.arch' },
      { stage: 'plan', status: 'skipped', reason: '不需要', deliverableDoc: 'plan.milestone' },
      { stage: 'approval', status: 'pending', reason: '需要', deliverableDoc: 'approval.review' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new StubProvider());
  assert.equal(docs.length, 3);
  const stages = docs.map((d) => d.stage);
  assert.ok(stages.includes('requirements'));
  assert.ok(stages.includes('design'));
  assert.ok(stages.includes('approval'));
});

test('done 状态环节不处理（当前只处理 pending）', async () => {
  const plan: PipelinePlan = {
    problemId: 'test-6',
    kind: 'new-feature',
    stages: [
      { stage: 'requirements', status: 'done', reason: '已完成', deliverableDoc: 'doc.requirements' },
      { stage: 'design', status: 'pending', reason: '需要', deliverableDoc: 'design.arch' },
    ],
    createdAt: new Date().toISOString(),
  };

  const docs = await runPipeline(plan, new StubProvider());
  assert.equal(docs.length, 1);
  assert.equal(docs[0].stage, 'design');
});