/** 经验回归端到端测试：pipeline run 自动累计 + experience 命令查询。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { listExperiences, loadExperience } from '../../kernel/core/experience/store.ts';
import { makeTempDir } from '../helpers/temp.ts';

function tempDir(prefix: string): string {
  return makeTempDir(prefix);
}

/** 用隔离工作区跑一条命令，返回 JSON 结果。 */
async function runJson(workspace: string, args: string[]): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    process.env.SKILL_MANAGER_HOME = workspace;
    const code = await run(['--json', ...args], {
      read: async () => '',
      write: () => {},
      confirm: async () => true,
    });
    assert.equal(code, 0, `命令失败退出码 ${code}: ${lines.join('')}`);
  } finally {
    process.stdout.write = original;
    delete process.env.SKILL_MANAGER_HOME;
  }
  const out = lines.join('');
  const match = out.match(/\{[\s\S]*\}/);
  assert.ok(match !== null, `未找到 JSON 输出: ${out}`);
  return JSON.parse(match[0]);
}

test('pipeline run 完成后自动累计一条经验', async () => {
  const ws = tempDir('sm-exp-ws-');
  const outDir = tempDir('sm-exp-out-');
  await runJson(ws, ['init']);

  const result = await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个内部工具',
    '--output-dir',
    outDir,
    '--answers',
    'q1=内部用户',
    '--answers',
    'q2=流程自动化',
    '--answers',
    'q3=无硬约束',
  ]);

  const data = result['data'] as Record<string, unknown>;
  assert.ok(data['experience_id'] !== undefined, '返回 experience_id');
  const id = String(data['experience_id']);

  const layout = layoutOf(ws);
  assert.ok(existsSync(join(layout.experiencesDir, `${id}.yaml`)), '经验文件已写入');
  const record = loadExperience(layout.experiencesDir, id);
  assert.ok(record !== null);
  assert.equal(record.problem, '做一个内部工具');
  assert.equal(record.kind, 'new-feature');
  assert.ok(record.decisions.length >= 3);
  assert.ok(record.stages.includes('requirements'));
});

test('experience list 列出累计的经验', async () => {
  const ws = tempDir('sm-exp-ws-');
  const outDir = tempDir('sm-exp-out-');
  await runJson(ws, ['init']);
  await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个数据看板',
    '--output-dir',
    outDir,
    '--answers',
    'q1=运营',
    '--answers',
    'q2=实时刷新',
    '--answers',
    'q3=兼容旧接口',
  ]);

  const result = await runJson(ws, ['experience', 'list']);
  const data = result['data'] as Record<string, unknown>;
  assert.equal(data['count'], 1);
  const list = data['experiences'] as Array<{ problem: string }>;
  assert.equal(list[0].problem, '做一个数据看板');
});

test('experience search 按关键词命中累计经验', async () => {
  const ws = tempDir('sm-exp-ws-');
  const outDir = tempDir('sm-exp-out-');
  await runJson(ws, ['init']);
  await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个数据看板',
    '--output-dir',
    outDir,
    '--answers',
    'q1=运营',
    '--answers',
    'q2=实时刷新',
    '--answers',
    'q3=兼容旧接口',
  ]);

  const hit = await runJson(ws, ['experience', 'search', '--query', '数据看板']);
  const hitData = hit['data'] as Record<string, unknown>;
  assert.equal(hitData['count'], 1);

  const miss = await runJson(ws, ['experience', 'search', '--query', '不存在的词']);
  const missData = miss['data'] as Record<string, unknown>;
  assert.equal(missData['count'], 0);
});

test('pipeline run --experience 预填相似经验问答', async () => {
  const ws = tempDir('sm-exp-ws-');
  const outDir = tempDir('sm-exp-out-');
  await runJson(ws, ['init']);
  // 第一次处理，累计经验
  await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个数据看板',
    '--output-dir',
    outDir,
    '--answers',
    'q1=运营',
    '--answers',
    'q2=实时刷新',
    '--answers',
    'q3=兼容旧接口',
  ]);

  // 第二次相似问题，用 --experience 预填（不带 --answers）
  const secondOut = tempDir('sm-exp-out2-');
  const result = await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个运营数据看板',
    '--output-dir',
    secondOut,
    '--experience',
    '数据看板',
  ]);
  const data = result['data'] as Record<string, unknown>;
  assert.equal(data['experience_applied'], true, '经验应已应用');
  // 第二次也累计了新经验
  const layout = layoutOf(ws);
  assert.equal(listExperiences(layout.experiencesDir).length, 2);
});

test('experience show 查看单条经验详情', async () => {
  const ws = tempDir('sm-exp-ws-');
  const outDir = tempDir('sm-exp-out-');
  await runJson(ws, ['init']);
  const result = await runJson(ws, [
    'pipeline',
    'run',
    '--problem',
    '做一个数据看板',
    '--output-dir',
    outDir,
    '--answers',
    'q1=运营',
    '--answers',
    'q2=实时刷新',
    '--answers',
    'q3=兼容旧接口',
  ]);
  const id = String((result['data'] as Record<string, unknown>)['experience_id']);

  const show = await runJson(ws, ['experience', 'show', id]);
  const data = show['data'] as Record<string, unknown>;
  assert.equal(data['id'], id);
  assert.equal(data['problem'], '做一个数据看板');
  assert.ok(Array.isArray(data['decisions']));
  assert.equal(readdirSync(layoutOf(ws).experiencesDir).length, 1);
});
