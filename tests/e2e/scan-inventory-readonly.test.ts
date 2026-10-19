import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { writePluginManifest } from '../helpers/plugin.ts';
import { snapshotTree } from '../helpers/snapshot.ts';
import { makeTempDir } from '../helpers/temp.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run(argv);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('M4c-5 快照：已初始化多宿主/共享根/x- 宿主盘点前后工作区与宿主字节不变', async (t) => {
  const root = makeTempDir('sm-readonly-multi-');
  const claude = makeHostRoot('sm-readonly-claude-');
  const shared = makeHostRoot('sm-readonly-shared-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  for (const [key, value] of [
    ['host.claude.root', claude],
    ['host.codex.root', shared],
    ['host.cursor.root', shared],
  ] as const) {
    assert.equal((await capture(['config', 'set', key, value, '--workspace', root])).code, 0);
  }
  writeHostSkill(claude, 'claude-skill');
  writeHostSkill(shared, 'shared-skill');

  const pluginSource = makeTempDir('sm-readonly-plugin-');
  writePluginManifest(pluginSource, {
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'skill',
        roots: [{ kind: 'skill', path_template: '.zed/skills/<skill_id>', scope: 'project' }],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  assert.equal(
    (await capture(['install', pluginSource, '--kind', 'plugin', '--workspace', root, '--yes']))
      .code,
    0,
  );
  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  mkdirSync(join(root, '.zed', 'skills'), { recursive: true });
  writeHostSkill(join(root, '.zed', 'skills'), 'x-skill');

  const before = {
    root: snapshotTree(root),
    claude: snapshotTree(claude),
    shared: snapshotTree(shared),
  };
  const scanned = await capture(['scan', '--inventory', '--workspace', root]);
  assert.equal(scanned.code, 0);
  assert.deepEqual(snapshotTree(root), before.root, '工作区不得有任何写入');
  assert.deepEqual(snapshotTree(claude), before.claude, 'claude 宿主根不得有任何写入');
  assert.deepEqual(snapshotTree(shared), before.shared, '共享宿主根不得有任何写入');
});

test('M4c-5 快照：未初始化工作区、损坏账本与缺失根都不被创建或修复', async (t) => {
  const envRoot = makeTempDir('sm-readonly-env-');
  t.after(isolateHostEnvironment(envRoot));
  const empty = makeTempDir('sm-readonly-empty-');
  const emptyBefore = snapshotTree(empty);
  assert.equal((await capture(['scan', '--inventory', '--workspace', empty])).code, 0);
  assert.deepEqual(snapshotTree(empty), emptyBefore, '未初始化工作区不得被创建');

  const root = makeTempDir('sm-readonly-corrupt-');
  const hostRoot = makeHostRoot('sm-readonly-corrupt-host-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
  const missingRoot = join(root, 'missing-root');
  const fileRoot = join(root, 'not-a-root');
  writeFileSync(fileRoot, 'not a directory');
  assert.equal(
    (await capture(['config', 'set', 'host.agentskills.root', missingRoot, '--workspace', root]))
      .code,
    0,
  );
  assert.equal(
    (await capture(['config', 'set', 'host.doubao.root', fileRoot, '--workspace', root])).code,
    0,
  );
  writeFileSync(join(root, 'host_landings.yaml'), 'schema_version: "1"\nlandings: [\n');
  const corruptBefore = readFileSync(join(root, 'host_landings.yaml'));
  const rootBefore = snapshotTree(root);
  assert.equal((await capture(['scan', '--inventory', '--workspace', root])).code, 0);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), corruptBefore);
  assert.deepEqual(snapshotTree(root), rootBefore, '损坏账本不得被修复或重置');
});

test('M4c-5 快照：百级副本规模盘点不产生临时文件或缓存', async (t) => {
  const root = makeTempDir('sm-readonly-large-');
  const hostRoot = makeHostRoot('sm-readonly-large-host-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
  for (let index = 0; index < 100; index += 1) {
    writeHostSkill(hostRoot, `bulk-skill-${String(index)}`);
  }
  const before = snapshotTree(hostRoot);
  const scanned = await capture(['scan', '--inventory', '--workspace', root]);
  assert.equal(scanned.code, 0);
  assert.deepEqual(snapshotTree(hostRoot), before);
});

test('M4c-5 静态审计：盘点 fs 调用只有 read/stat/realpath 类能力', () => {
  const inventory = readFileSync(
    new URL('../../kernel/dispatch/scan/inventory.ts', import.meta.url),
    'utf8',
  );
  const discover = readFileSync(
    new URL('../../kernel/core/inventory/discover.ts', import.meta.url),
    'utf8',
  );
  const reconcile = readFileSync(
    new URL('../../kernel/dispatch/scan/reconcile.ts', import.meta.url),
    'utf8',
  );
  for (const [name, source] of [
    ['inventory.ts', inventory],
    ['discover.ts', discover],
    ['reconcile.ts', reconcile],
  ] as const) {
    for (const forbidden of [
      'writeFileSync',
      'appendFileSync',
      'mkdirSync',
      'rmSync',
      'renameSync',
      'unlinkSync',
      'cpSync',
      'withLock(',
      'saveIndex(',
      'savePluginIndex(',
      'saveHostLandings(',
      'landPlan(',
      'runHostLanding(',
    ]) {
      assert.equal(source.includes(forbidden), false, `${name} 不得包含 ${forbidden}`);
    }
  }
  assert.match(inventory, /readIndex|loadIndex|loadPluginCatalog/);
  assert.match(discover, /readdirSync|readFileSync/);
  assert.match(reconcile, /reconcileHostCopy/);
});
