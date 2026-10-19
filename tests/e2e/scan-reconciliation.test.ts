import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { writePluginManifest } from '../helpers/plugin.ts';
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

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json']);
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

interface ReconciledCopy {
  path: string;
  host_id: string;
  host_group: string;
  consumed_by: string[];
  reconciliation: {
    classification: string;
    ledger_source: string;
    evidence: Record<string, string>;
    drift_reasons: string[];
  };
}

interface MissingCopy {
  target_path: string;
  host_id: string;
  host_group: string;
  classification: string;
  ledger_source: string;
}

interface InventoryData {
  copies: ReconciledCopy[];
  corrupt: ReconciledCopy[];
  missing: MissingCopy[];
}

function dataOf(result: Record<string, unknown>): InventoryData {
  return result['data'] as InventoryData;
}

async function initWorkspace(root: string, hostRoot: string): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
}

test('M4c-3 e2e：host active 一致 / 内容漂移 / 反向 missing', async (t) => {
  const root = makeTempDir('sm-reconcile-host-');
  const hostRoot = makeHostRoot('sm-reconcile-host-root-');
  t.after(isolateHostEnvironment(root));
  await initWorkspace(root, hostRoot);

  const source = makeSkillSource('alpha', { description: 'reconcile alpha' });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  const first = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(first.code, 0);
  const target = join(hostRoot, 'alpha');
  const managed = dataOf(first.result).copies.find((copy) => copy.path === target);
  assert.equal(managed?.reconciliation.classification, 'managed_consistent');
  assert.equal(managed?.reconciliation.ledger_source, 'host_landings');
  assert.equal(managed?.reconciliation.evidence.managed, 'authoritative');
  assert.equal(dataOf(first.result).missing.length, 0);

  writeFileSync(
    join(target, 'SKILL.md'),
    '---\nname: alpha\ndescription: changed by user\n---\n\nchanged\n',
  );
  const drifted = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const drift = drifted.copies.find((copy) => copy.path === target);
  assert.equal(drift?.reconciliation.classification, 'drift');
  assert.ok(drift?.reconciliation.drift_reasons.includes('content_drift'));

  rmSync(target, { recursive: true, force: true });
  const missing = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const absent = missing.missing.find((item) => item.target_path === target);
  assert.equal(absent?.classification, 'missing', JSON.stringify(missing.missing));
  assert.equal(absent?.ledger_source, 'host_landings');
});

test('M4c-3 e2e：无账本 inferred、未纳管、共享根多记录与插件重渲染', async (t) => {
  const root = makeTempDir('sm-reconcile-mixed-');
  const shared = makeHostRoot('sm-reconcile-shared-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.codex.root', shared, '--workspace', root])).code,
    0,
  );
  assert.equal(
    (await capture(['config', 'set', 'host.cursor.root', shared, '--workspace', root])).code,
    0,
  );

  const source = makeSkillSource('shared-skill', { description: 'shared reconcile' });
  assert.equal(
    (await capture(['install', source, '--host', 'codex', '--workspace', root, '--yes'])).code,
    0,
  );
  const sharedData = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const sharedCopy = sharedData.copies.find((copy) => copy.path === join(shared, 'shared-skill'));
  assert.ok(sharedCopy?.consumed_by.includes('codex'));
  assert.ok(sharedCopy?.consumed_by.includes('cursor'));
  assert.equal(sharedCopy?.reconciliation.classification, 'managed_consistent');

  rmSync(join(root, 'host_landings.yaml'), { force: true });
  const noLedger = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const inferred = noLedger.copies.find((copy) => copy.path === join(shared, 'shared-skill'));
  assert.match(inferred?.reconciliation.classification ?? '', /^inferred_/);

  writeHostSkill(shared, 'loose-skill');
  const untracked = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const loose = untracked.copies.find((copy) => copy.path === join(shared, 'loose-skill'));
  assert.equal(loose?.reconciliation.classification, 'untracked');
});

test('M4c-3 e2e：插件宿主 managed + 反向 missing，content/source 不冒充权威', async (t) => {
  const root = makeTempDir('sm-reconcile-plugin-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const pluginSource = makeTempDir('sm-reconcile-plugin-src-');
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
  const source = makeSkillSource('plugin-skill', { description: 'plugin reconcile' });
  const installed = await capture([
    'install',
    source,
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);

  const scan = await json(['scan', '--inventory', '--workspace', root]);
  const data = dataOf(scan.result);
  const copy = data.copies.find((item) => item.host_id === 'x-acme-tools-zed');
  assert.equal(
    copy?.reconciliation.classification,
    'managed_consistent',
    JSON.stringify(scan.result),
  );
  assert.equal(copy?.reconciliation.ledger_source, 'plugin_landings');
  assert.notEqual(copy?.reconciliation.evidence.content, 'authoritative');
  assert.notEqual(copy?.reconciliation.evidence.source, 'authoritative');

  const target = copy?.path as string;
  rmSync(target, { recursive: true, force: true });
  const missing = dataOf((await json(['scan', '--inventory', '--workspace', root])).result);
  const absent = missing.missing.find((item) => item.target_path === join(target, 'SKILL.md'));
  assert.equal(absent?.classification, 'missing', JSON.stringify(missing.missing));
  assert.equal(absent?.ledger_source, 'plugin_landings');
});
