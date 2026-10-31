/** 经验回归存储与检索单元测试。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildExperience,
  listExperiences,
  loadExperience,
  newExperienceId,
  saveExperience,
  searchExperiences,
  findSimilarExperience,
} from '../../kernel/core/experience/store.ts';
import type { ExperienceRecord } from '../../kernel/core/experience/types.ts';
import { makeTempDir } from '../helpers/temp.ts';

function tempDir(prefix: string): string {
  return makeTempDir(prefix);
}

function sampleRecord(problem: string, createdAt: string): ExperienceRecord {
  return buildExperience({
    id: newExperienceId(createdAt),
    problem,
    kind: 'new-feature',
    involvesUi: true,
    stages: ['requirements', 'design', 'plan'],
    decisions: [
      { question: '这个问题要解决谁的痛点？', answer: '内部用户' },
      { question: '成功标准是什么？', answer: '流程自动化' },
    ],
    docTypes: ['requirements', 'design', 'plan'],
    provider: 'stub',
    durationMs: 42,
    createdAt,
  });
}

test('saveExperience 写入 yaml 并可读回', () => {
  const dir = tempDir('sm-exp-');
  const record = sampleRecord('做一个登录页面', '2026-10-31T10:00:00.000Z');
  saveExperience(dir, record);
  const file = join(dir, `${record.id}.yaml`);
  assert.ok(existsSync(file));
  const loaded = loadExperience(dir, record.id);
  assert.ok(loaded !== null);
  assert.equal(loaded.problem, '做一个登录页面');
  assert.equal(loaded.kind, 'new-feature');
  assert.equal(loaded.decisions.length, 2);
  assert.equal(loaded.stages.join(','), 'requirements,design,plan');
});

test('listExperiences 按时间倒序返回全部', () => {
  const dir = tempDir('sm-exp-');
  saveExperience(dir, sampleRecord('早的问题', '2026-10-31T08:00:00.000Z'));
  saveExperience(dir, sampleRecord('晚的问题', '2026-10-31T10:00:00.000Z'));
  const list = listExperiences(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].problem, '晚的问题');
  assert.equal(list[1].problem, '早的问题');
});

test('searchExperiences 按问题原文关键词命中', () => {
  const dir = tempDir('sm-exp-');
  saveExperience(dir, sampleRecord('做一个登录页面', '2026-10-31T10:00:00.000Z'));
  saveExperience(dir, sampleRecord('做一个支付流程', '2026-10-31T11:00:00.000Z'));
  const hits = searchExperiences(dir, '登录');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].problem, '做一个登录页面');
});

test('findSimilarExperience 返回最相似一条', () => {
  const dir = tempDir('sm-exp-');
  saveExperience(dir, sampleRecord('做一个登录页面', '2026-10-31T10:00:00.000Z'));
  saveExperience(dir, sampleRecord('做一个支付流程', '2026-10-31T11:00:00.000Z'));
  const similar = findSimilarExperience(dir, '支付');
  assert.ok(similar !== null);
  assert.equal(similar.problem, '做一个支付流程');
  const none = findSimilarExperience(dir, '不存在的关键词');
  assert.equal(none, null);
});

test('yaml 文件包含关键字段', () => {
  const dir = tempDir('sm-exp-');
  const record = sampleRecord('做一个登录页面', '2026-10-31T10:00:00.000Z');
  saveExperience(dir, record);
  const text = readFileSync(join(dir, `${record.id}.yaml`), 'utf8');
  assert.ok(text.includes('problem:'));
  assert.ok(text.includes('decisions:'));
  assert.ok(text.includes('question:'));
  assert.ok(text.includes('summary:'));
});
