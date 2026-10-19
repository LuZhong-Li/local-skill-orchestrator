import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { adapterFor } from '../../kernel/core/adapters/index.ts';
import { rebasePlan } from '../../kernel/core/adapters/plan.ts';
import { landPlan, rollbackLandWrites } from '../../kernel/core/adapters/land.ts';
import { commitHostLandings } from '../../kernel/core/host-landings/index.ts';
import {
  createInitialHostLandings,
  saveHostLandings,
  syncActiveHostLandings,
  upsertHostLanding,
} from '../../kernel/store/host-landings/index.ts';
import { ensureWorkspaceDirs, layoutOf } from '../../kernel/store/workspace/index.ts';
import type { RenderSource } from '../../kernel/core/render/types.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type { HostLanding } from '../../contract/src/index.ts';

const NOW = '2026-10-18T00:00:00Z';

function source(id = 'rollback-skill'): RenderSource {
  return { id, description: '回滚测试', body: '# 新内容\n' };
}

function workspace(): string {
  const dir = makeTempDir('sm-rollback-ws-');
  ensureWorkspaceDirs(layoutOf(dir));
  return dir;
}

function sourceDir(id = 'rollback-skill'): string {
  const dir = makeTempDir('sm-rollback-src-');
  writeFileSync(join(dir, 'SKILL.md'), '# 新内容\n');
  writeFileSync(join(dir, 'asset.txt'), 'new asset\n');
  writeFileSync(join(dir, 'skill_meta.yaml'), `id: ${id}\n`);
  return dir;
}

function failingCommit(file: string, writes: Parameters<typeof rollbackLandWrites>[0]) {
  return commitHostLandings({
    file,
    index: createInitialHostLandings(NOW, '0.3.0'),
    rollback: () => rollbackLandWrites(writes),
    save: () => {
      throw new Error('injected ledger write failure');
    },
  });
}

test('回滚：技能副本已有内容时，账本失败恢复原目录', () => {
  const ws = workspace();
  const hostRoot = makeHostRoot('sm-rollback-host-');
  const copyDir = join(hostRoot, 'rollback-skill');
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, 'SKILL.md'), '# 旧内容\n');
  writeFileSync(join(copyDir, 'old.txt'), 'old asset\n');

  const plan = rebasePlan(adapterFor('claude')!.plan(source()), hostRoot, true);
  const landed = landPlan({ plan, workspace: layoutOf(ws), now: NOW, sourceDir: sourceDir() });
  assert.equal(landed.writes.length, 1);
  assert.match(readFileSync(join(copyDir, 'SKILL.md'), 'utf8'), /# 新内容/);
  assert.equal(existsSync(join(copyDir, 'asset.txt')), true, '落位应写入新资产');

  const commit = failingCommit(join(ws, 'host_landings.yaml'), landed.writes);
  assert.equal(commit.ok, false);
  assert.equal(readFileSync(join(copyDir, 'SKILL.md'), 'utf8'), '# 旧内容\n');
  assert.equal(readFileSync(join(copyDir, 'old.txt'), 'utf8'), 'old asset\n');
  assert.equal(existsSync(join(copyDir, 'asset.txt')), false, '新文件必须随回滚移除');
});

test('回滚：首次落位时账本失败删除新副本', () => {
  const ws = workspace();
  const hostRoot = makeHostRoot('sm-rollback-host-');
  const plan = rebasePlan(adapterFor('claude')!.plan(source()), hostRoot, true);
  const landed = landPlan({ plan, workspace: layoutOf(ws), now: NOW, sourceDir: sourceDir() });
  const copyDir = join(hostRoot, 'rollback-skill');
  assert.equal(existsSync(copyDir), true);

  const commit = failingCommit(join(ws, 'host_landings.yaml'), landed.writes);
  assert.equal(commit.ok, false);
  assert.equal(existsSync(copyDir), false, '首次落位失败不得留下副本');
});

test('回滚：规则文件失败恢复旧文件或移除新文件', () => {
  const ws = workspace();
  const rulesRoot = makeHostRoot('sm-rollback-rules-');
  const target = join(rulesRoot, 'rollback-skill.mdc');
  writeFileSync(target, '---\ndescription: old\n---\n\n# old\n');

  const plan = rebasePlan(adapterFor('cursor')!.plan(source(), 'rules'), rulesRoot, true);
  const landed = landPlan({ plan, workspace: layoutOf(ws), now: NOW, sourceDir: sourceDir() });
  const commit = failingCommit(join(ws, 'host_landings.yaml'), landed.writes);
  assert.equal(commit.ok, false);
  assert.match(readFileSync(target, 'utf8'), /# old/);

  const freshRoot = makeHostRoot('sm-rollback-rules-');
  const fresh = rebasePlan(adapterFor('cursor')!.plan(source(), 'rules'), freshRoot, true);
  const freshLanded = landPlan({
    plan: fresh,
    workspace: layoutOf(ws),
    now: NOW,
    sourceDir: sourceDir(),
  });
  const freshTarget = join(freshRoot, 'rollback-skill.mdc');
  assert.equal(existsSync(freshTarget), true);
  const freshCommit = failingCommit(join(ws, 'host_landings.yaml'), freshLanded.writes);
  assert.equal(freshCommit.ok, false);
  assert.equal(existsSync(freshTarget), false, '首次规则落位失败不得留下规则文件');
});

test('回滚：账本写入失败不改变既有账本字节', () => {
  const ws = workspace();
  const file = join(ws, 'host_landings.yaml');
  const initial = createInitialHostLandings(NOW, '0.3.0');
  saveHostLandings(file, initial);
  const before = readFileSync(file);
  const hostRoot = makeHostRoot('sm-rollback-host-');
  const plan = rebasePlan(adapterFor('claude')!.plan(source()), hostRoot, true);
  const landed = landPlan({ plan, workspace: layoutOf(ws), now: NOW, sourceDir: sourceDir() });
  const commit = commitHostLandings({
    file,
    index: { ...initial, generated_at: '2026-10-19T00:00:00Z' },
    rollback: () => rollbackLandWrites(landed.writes),
    save: () => {
      throw new Error('injected');
    },
  });
  assert.equal(commit.ok, false);
  assert.deepEqual(readFileSync(file), before, '账本失败后既有字节不得变化');
});

test('回滚：共享根两条记录与物理副本一起回到操作前', () => {
  const ws = workspace();
  const hostRoot = makeHostRoot('sm-rollback-shared-');
  const target = join(hostRoot, 'rollback-skill');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), '# 旧内容\n');

  const plan = rebasePlan(adapterFor('codex')!.plan(source()), hostRoot, true);
  const landed = landPlan({ plan, workspace: layoutOf(ws), now: NOW, sourceDir: sourceDir() });
  const file = join(ws, 'host_landings.yaml');
  const record = (hostId: string): HostLanding => ({
    skill_id: 'rollback-skill',
    host_id: hostId,
    target_path: target,
    format: 'skill',
    visibility: 'visible',
    state: 'active',
    origin: 'distributed',
    source_checksum: `sha256:${'a'.repeat(64)}`,
    content_digest: `sha256:${'a'.repeat(64)}`,
    adapter_ref: hostId,
    registry_version: '1',
    created_at: NOW,
    updated_at: NOW,
  });
  let index = createInitialHostLandings(NOW, '0.3.0');
  index = upsertHostLanding(index, record('codex'));
  index = upsertHostLanding(index, record('cursor'));
  saveHostLandings(file, index);
  const before = readFileSync(file);

  const next = syncActiveHostLandings(index, target, {
    visibility: 'disabled',
    content_digest: `sha256:${'b'.repeat(64)}`,
    updated_at: '2026-10-19T00:00:00Z',
  });
  const commit = commitHostLandings({
    file,
    index: next,
    rollback: () => rollbackLandWrites(landed.writes),
    save: () => {
      throw new Error('injected shared ledger failure');
    },
  });
  assert.equal(commit.ok, false);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), '# 旧内容\n');
  assert.deepEqual(readFileSync(file), before, '共享根账本不得部分更新');
  const loaded = parseYaml(readFileSync(file, 'utf8')) as { landings: HostLanding[] };
  assert.deepEqual(
    loaded.landings.map((item) => [item.host_id, item.visibility, item.content_digest]),
    [
      ['codex', 'visible', `sha256:${'a'.repeat(64)}`],
      ['cursor', 'visible', `sha256:${'a'.repeat(64)}`],
    ],
  );
});
