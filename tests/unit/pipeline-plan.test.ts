import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProblem, planPipeline, type Problem } from '../../kernel/core/pipeline/index.ts';

test('classifyProblem: 默认新功能', () => {
  const r = classifyProblem('给应用加一个导出按钮');
  assert.equal(r.kind, 'new-feature');
  assert.equal(r.involvesUi, true);
});

test('classifyProblem: bug 识别', () => {
  const r = classifyProblem('登录崩溃 error 500');
  assert.equal(r.kind, 'bugfix');
});

test('classifyProblem: 重构识别', () => {
  const r = classifyProblem('重构这个模块，清理技术债');
  assert.equal(r.kind, 'refactor');
});

test('classifyProblem: 文档识别', () => {
  const r = classifyProblem('写一个 readme 文档');
  assert.equal(r.kind, 'docs');
});

test('classifyProblem: 调研识别', () => {
  const r = classifyProblem('调研对比两个框架的可行性');
  assert.equal(r.kind, 'research');
});

const baseProblem: Problem = {
  id: 'p1',
  statement: '测试问题',
  kind: 'new-feature',
  involvesUi: false,
};

test('planPipeline: 新功能无 UI：基础五环节走，UI 四件套跳过', () => {
  const plan = planPipeline(baseProblem);
  assert.equal(plan.problemId, 'p1');
  const pending = plan.stages.filter((s) => s.status === 'pending').map((s) => s.stage);
  assert.deepEqual(pending, ['requirements', 'research', 'design', 'plan', 'approval']);
  const skipped = plan.stages.filter((s) => s.status === 'skipped').map((s) => s.stage);
  assert.deepEqual(skipped, ['page-design', 'ui', 'interaction', 'visual-style']);
});

test('planPipeline: 新功能有 UI：UI 四件套走', () => {
  const plan = planPipeline({ ...baseProblem, involvesUi: true });
  const pending = plan.stages.filter((s) => s.status === 'pending').map((s) => s.stage);
  assert.ok(pending.includes('page-design'));
  assert.ok(pending.includes('ui'));
  assert.ok(pending.includes('interaction'));
  assert.ok(pending.includes('visual-style'));
});

test('planPipeline: bugfix 跳过 research', () => {
  const plan = planPipeline({ ...baseProblem, kind: 'bugfix' });
  const research = plan.stages.find((s) => s.stage === 'research');
  assert.equal(research?.status, 'skipped');
});

test('planPipeline: docs 跳过 plan', () => {
  const plan = planPipeline({ ...baseProblem, kind: 'docs' });
  const planStage = plan.stages.find((s) => s.stage === 'plan');
  assert.equal(planStage?.status, 'skipped');
});

test('planPipeline: 每个环节都有 reason 和 deliverableDoc', () => {
  const plan = planPipeline(baseProblem);
  for (const s of plan.stages) {
    assert.ok(s.reason.length > 0);
    assert.match(s.deliverableDoc, /^doc\./);
  }
});
