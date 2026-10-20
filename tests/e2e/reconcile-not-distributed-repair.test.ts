import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import { loadPluginIndex } from '../../kernel/store/plugin-registry/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makePluginDir, writePluginManifest } from '../helpers/plugin.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type {
  InventoryAuditData,
  ReconcileApplyData,
  ReconcilePreviewData,
} from '@skill-manager/contract';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json']);
  return { code: captured.code, result: JSON.parse(captured.out) as Record<string, unknown> };
}

async function init(root: string, hosts: Array<[string, string]>): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  for (const [host, hostRoot] of hosts) {
    assert.equal(
      (await capture(['config', 'set', `host.${host}.root`, hostRoot, '--workspace', root])).code,
      0,
    );
  }
}

function targetsYaml(id: string, targets: Array<[string, string]>): string[] {
  return [
    'targets:',
    ...targets.flatMap(([target]) => [
      `  - target: ${target}`,
      '    scope: global',
      `    path: .${target}/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
    ]),
  ];
}

function twoTargetSource(id: string, targets: Array<[string, string]>): string {
  return makeSkillSource(id, {
    description: 'two target repair',
    content: `---\nname: ${id}\ndescription: two target repair\n---\n\n# ${id}\n`,
    meta: [
      `id: ${id}`,
      `name: ${id}`,
      'description: two target repair',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: unknown',
      ...targetsYaml(id, targets),
      '',
    ].join('\n'),
  });
}

function pluginSource(id: string, hostId: string): string {
  return makeSkillSource(id, {
    description: 'plugin target repair',
    content: `---\nname: ${id}\ndescription: plugin target repair\n---\n\n# ${id}\n`,
    meta: [
      `id: ${id}`,
      `name: ${id}`,
      'description: plugin target repair',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: unknown',
      'targets:',
      `  - target: ${hostId}`,
      '    scope: global',
      `    path: .${hostId}/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  });
}

async function audit(root: string): Promise<InventoryAuditData> {
  const scanned = await json(['scan', '--inventory', '--audit', '--workspace', root]);
  assert.equal(scanned.code, 0, JSON.stringify(scanned.result));
  return (scanned.result['data'] as { audit: InventoryAuditData }).audit;
}

function hostLedger(root: string) {
  return loadHostLandings(join(root, 'host_landings.yaml')).index;
}

test('T4 repair：声明 A/B，A 已分发时批量 repair 补齐 B 并刷新两份账本', async (t) => {
  const root = makeTempDir('sm-t4-targets-');
  const doubaoRoot = makeHostRoot('sm-t4-targets-doubao-');
  const codexRoot = makeHostRoot('sm-t4-targets-codex-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['doubao', doubaoRoot],
    ['codex', codexRoot],
  ]);
  const source = twoTargetSource('two-targets', [
    ['doubao', doubaoRoot],
    ['codex', codexRoot],
  ]);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  assert.equal(existsSync(join(doubaoRoot, 'two-targets', 'SKILL.md')), true);
  assert.equal(existsSync(join(codexRoot, 'two-targets')), false);
  assert.equal((await audit(root)).summary.missing, 1);

  const preview = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'two-targets',
    '--host',
    'all',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const previewData = preview.result['data'] as ReconcilePreviewData;
  assert.deepEqual(previewData.items.map((item) => item.host_ids[0]).sort(), ['codex', 'doubao']);
  assert.equal(existsSync(join(codexRoot, 'two-targets')), false, '预览零写入');

  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'two-targets',
    '--host',
    'all',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal((applied.result['data'] as ReconcileApplyData).summary.failed, 0);
  assert.equal(existsSync(join(codexRoot, 'two-targets', 'SKILL.md')), true);
  const activeHosts =
    hostLedger(root)
      ?.landings.filter((item) => item.skill_id === 'two-targets' && item.state === 'active')
      .map((item) => item.host_id) ?? [];
  assert.ok(activeHosts.includes('codex'));
  assert.ok(activeHosts.includes('doubao'));
  const after = await audit(root);
  assert.equal(after.summary.missing, 0);
  assert.equal(after.summary.distributed, 2);
});

test('T4 repair：已启用插件 x- 宿主由 targets 驱动生成并分发', async (t) => {
  const root = makeTempDir('sm-t4-plugin-target-');
  const pluginRoot = makeHostRoot('sm-t4-plugin-target-host-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const plugin = makePluginDir('sm-t4-plugin-target-src-');
  writePluginManifest(plugin, {
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'skill',
        roots: [{ kind: 'skill', path_template: '.zed/skills/<skill_id>', scope: 'global' }],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  assert.equal(
    (
      await capture([
        'config',
        'set',
        'plugin.acme-tools.zed.root',
        pluginRoot,
        '--workspace',
        root,
      ])
    ).code,
    0,
  );
  const hostId = 'x-acme-tools-zed';
  const source = pluginSource('plugin-not-distributed', hostId);
  assert.equal(
    (await capture(['install', source, '--library-only', '--workspace', root, '--yes'])).code,
    0,
  );

  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'plugin-not-distributed',
    '--host',
    hostId,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  const pluginCopy = join(pluginRoot, '.zed', 'skills', 'plugin-not-distributed');
  assert.ok(
    existsSync(join(pluginCopy, 'SKILL.md')) || existsSync(join(pluginCopy, 'SKILL.md.disabled')),
    JSON.stringify(applied.result),
  );
  assert.equal(
    loadPluginIndex(join(root, 'plugin_index.yaml')).index?.landings.find(
      (item) => item.skill_id === 'plugin-not-distributed' && item.host_id === hostId,
    )?.state,
    'active',
  );
});

test('T4 repair：插件宿主不可用时生成 skipped 并记录原因', async (t) => {
  const root = makeTempDir('sm-t4-plugin-skip-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const plugin = makePluginDir('sm-t4-plugin-skip-src-');
  writePluginManifest(plugin, {
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'skill',
        roots: [{ kind: 'skill', path_template: '.zed/skills/<skill_id>', scope: 'global' }],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  const source = pluginSource('plugin-disabled-target', 'x-acme-tools-zed');
  const installed = await capture([
    'install',
    source,
    '--library-only',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);

  const preview = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'plugin-disabled-target',
    '--host',
    'all',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const item = (preview.result['data'] as ReconcilePreviewData).items.find(
    (entry) => entry.skill_id === 'plugin-disabled-target',
  );
  assert.equal(item?.status, 'skipped');
  assert.equal(item?.reason, 'plugin_host_unavailable');
  assert.deepEqual(item?.writes, []);
});

test('T4 repair：目标被文件占用时失败且不写 active 账本', async (t) => {
  const root = makeTempDir('sm-t4-target-occupied-');
  const codexRoot = makeHostRoot('sm-t4-target-occupied-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['codex', codexRoot]]);
  const source = twoTargetSource('occupied-target', [['codex', codexRoot]]);
  const installed = await capture([
    'install',
    source,
    '--library-only',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(codexRoot, 'occupied-target'), 'occupied');

  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'occupied-target',
    '--host',
    'codex',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.notEqual(applied.code, 0, JSON.stringify(applied.result));
  const data = applied.result['data'] as ReconcileApplyData;
  assert.equal(data.results[0]?.status, 'failed');
  assert.equal(
    hostLedger(root)?.landings.some(
      (item) => item.skill_id === 'occupied-target' && item.state === 'active',
    ),
    false,
  );
  assert.equal(existsSync(join(codexRoot, 'occupied-target', 'SKILL.md')), false);
});

test('T4 repair：preview 只读，不创建宿主副本或账本记录', async (t) => {
  const root = makeTempDir('sm-t4-preview-readonly-');
  const codexRoot = makeHostRoot('sm-t4-preview-readonly-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['codex', codexRoot]]);
  const source = twoTargetSource('preview-readonly', [['codex', codexRoot]]);
  const installed = await capture([
    'install',
    source,
    '--library-only',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);
  const ledgerBefore = hostLedger(root)?.landings.length;

  const preview = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'preview-readonly',
    '--host',
    'codex',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(existsSync(join(codexRoot, 'preview-readonly')), false);
  assert.equal(hostLedger(root)?.landings.length, ledgerBefore);
});
