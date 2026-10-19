import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  makeHostRoot,
  makeSharedHostRoot,
  makePluginManifest,
  makeSkillSource,
  makeTempDir,
  makeWorkspaceSkill,
  tempDirCount,
  writeCorruptHostSkill,
  writeHostSkill,
  writePluginManifest,
} from '../helpers/index.ts';

test('helper：makeTempDir 可创建并由 cleanupTempDirs 清理', () => {
  const dir = makeTempDir('sm-helper-');
  assert.equal(existsSync(dir), true);
  assert.ok(tempDirCount() >= 1);
  cleanupTempDirs();
  assert.equal(existsSync(dir), false);
});

test('helper：makeWorkspaceSkill 同时写正文与元文件', () => {
  const root = makeTempDir('sm-helper-ws-');
  const dir = makeWorkspaceSkill(root, 'demo', { description: '演示' });
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# demo');
  const meta = readFileSync(join(dir, 'skill_meta.yaml'), 'utf8');
  assert.match(meta, /^id: demo$/m);
  assert.match(meta, /^description: 演示$/m);
});

test('helper：makeHostRoot / writeHostSkill 覆盖启用与禁用', () => {
  const root = makeHostRoot('sm-helper-host-');
  writeHostSkill(root, 'enabled');
  writeHostSkill(root, 'disabled', { disabled: true });
  assert.equal(existsSync(join(root, 'enabled', 'SKILL.md')), true);
  assert.equal(existsSync(join(root, 'disabled', 'SKILL.md.disabled')), true);
  assert.equal(existsSync(join(root, 'disabled', 'SKILL.md')), false);
});

test('helper：共享宿主根与损坏样本可构造', () => {
  const shared = makeSharedHostRoot('sm-helper-shared-');
  writeHostSkill(shared, 'shared-skill');
  writeCorruptHostSkill(shared, 'broken-yaml', 'bad-yaml');
  writeCorruptHostSkill(shared, 'missing-skill', 'missing');
  assert.equal(existsSync(join(shared, 'shared-skill', 'SKILL.md')), true);
  assert.equal(existsSync(join(shared, 'broken-yaml', 'SKILL.md')), true);
  assert.equal(existsSync(join(shared, 'missing-skill', 'SKILL.md')), false);
});

test('helper：makeSkillSource 生成带 location 的来源目录', () => {
  const dir = makeSkillSource('source-demo');
  assert.match(readFileSync(join(dir, 'skill_meta.yaml'), 'utf8'), /location: /);
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /name: source-demo/);
});

test('helper：makePluginManifest / writePluginManifest 生成标准 manifest', () => {
  const dir = makeTempDir('sm-helper-plugin-');
  const manifest = makePluginManifest({ plugin_id: 'demo-tools' });
  assert.equal(manifest.plugin_id, 'demo-tools');
  const target = writePluginManifest(dir, { plugin_id: 'demo-tools' });
  assert.match(readFileSync(target, 'utf8'), /"plugin_id": "demo-tools"/);
});
