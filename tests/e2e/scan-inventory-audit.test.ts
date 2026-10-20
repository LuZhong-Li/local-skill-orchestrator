import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { snapshotTree } from '../helpers/snapshot.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type { InventoryAuditData, InventoryScanData } from '@skill-manager/contract';

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

function dataOf(result: Record<string, unknown>): InventoryScanData {
  return result['data'] as InventoryScanData;
}

function auditOf(result: Record<string, unknown>): InventoryAuditData {
  const audit = dataOf(result).audit;
  assert.ok(audit, 'scan --inventory --audit 必须返回 data.audit');
  return audit;
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

async function scanAudit(root: string) {
  const scanned = await json(['scan', '--inventory', '--audit', '--workspace', root]);
  assert.equal(scanned.code, 0, JSON.stringify(scanned.result));
  return auditOf(scanned.result);
}

function disableDeclaredTarget(root: string, skillId: string): void {
  const meta = join(root, 'skills', skillId, 'skill_meta.yaml');
  const before = readFileSync(meta, 'utf8');
  const after = before.replace('    enabled: true', '    enabled: false');
  assert.notEqual(after, before, '夹具必须实际翻转 targets[].enabled');
  writeFileSync(meta, after);
}

test('T2 audit 参数：--audit 只能与 --inventory 同用', async (t) => {
  const root = makeTempDir('sm-audit-options-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);

  const rejected = await json(['scan', '--audit', '--workspace', root]);
  assert.equal(rejected.code, 2);
  assert.equal((rejected.result['findings'] as Array<{ code: string }>)[0]?.code, 'E-INPUT-002');

  const audit = await scanAudit(root);
  assert.equal(audit.rows.length, 0);
  assert.equal(audit.summary.declared, 0);
});

test('T2 audit：targets 声明、账本 active、副本一致时判 distributed', async (t) => {
  const root = makeTempDir('sm-audit-distributed-');
  const hostRoot = makeHostRoot('sm-audit-distributed-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-distributed', {
    target: 'claude',
    description: 'audit distributed',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );

  const audit = await scanAudit(root);
  const row = audit.rows.find((item) => item.skill_id === 'audit-distributed');
  assert.equal(row?.target, 'claude');
  assert.equal(row?.status, 'distributed');
  assert.equal(row?.ledger_state, 'active');
  assert.equal(audit.summary.declared, 1);
  assert.equal(audit.summary.distributed, 1);
  assert.equal(audit.summary.missing, 0);
  assert.equal(audit.summary.undeclared, 0);
});

test('T2 audit：disabled target 无副本仍判 missing，不改期望存在性', async (t) => {
  const root = makeTempDir('sm-audit-disabled-missing-');
  const hostRoot = makeHostRoot('sm-audit-disabled-missing-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-disabled-missing', {
    target: 'claude',
    description: 'audit disabled missing',
  });
  assert.equal(
    (await capture(['install', source, '--library-only', '--workspace', root, '--yes'])).code,
    0,
  );
  disableDeclaredTarget(root, 'audit-disabled-missing');

  const audit = await scanAudit(root);
  const row = audit.rows.find((item) => item.skill_id === 'audit-disabled-missing');
  assert.equal(row?.status, 'missing');
  assert.equal(row?.expected_enabled, false);
  assert.ok(row?.reasons.includes('ledger_missing'));
  assert.equal(audit.summary.missing, 1);
});

test('T2 audit：副本存在但 targets 未声明时判 undeclared，不计 missing', async (t) => {
  const root = makeTempDir('sm-audit-undeclared-');
  const claudeRoot = makeHostRoot('sm-audit-undeclared-claude-');
  const codexRoot = makeHostRoot('sm-audit-undeclared-codex-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['claude', claudeRoot],
    ['codex', codexRoot],
  ]);
  const source = makeSkillSource('audit-undeclared', {
    target: 'claude',
    description: 'audit undeclared',
  });
  assert.equal(
    (await capture(['install', source, '--library-only', '--workspace', root, '--yes'])).code,
    0,
  );
  writeHostSkill(codexRoot, 'audit-undeclared');

  const audit = await scanAudit(root);
  const claude = audit.rows.find(
    (item) => item.skill_id === 'audit-undeclared' && item.host_id === 'claude',
  );
  const codex = audit.rows.find(
    (item) => item.skill_id === 'audit-undeclared' && item.host_id === 'codex',
  );
  assert.equal(claude?.status, 'missing');
  assert.equal(codex?.status, 'undeclared');
  assert.equal(audit.summary.missing, 1);
  assert.equal(audit.summary.undeclared, 1);
});

test('T2 audit：active 副本内容变化判 drift，并复用 reconcile 证据', async (t) => {
  const root = makeTempDir('sm-audit-drift-');
  const hostRoot = makeHostRoot('sm-audit-drift-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-drift', {
    target: 'claude',
    description: 'audit drift',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  writeFileSync(
    join(hostRoot, 'audit-drift', 'SKILL.md'),
    '---\nname: audit-drift\ndescription: changed outside manager\n---\n\nchanged\n',
  );

  const audit = await scanAudit(root);
  const row = audit.rows.find((item) => item.skill_id === 'audit-drift');
  assert.equal(row?.status, 'drift');
  assert.equal(row?.classification, 'drift');
  assert.equal(row?.evidence.content, 'authoritative');
  assert.equal(audit.summary.drift, 1);
});

test('T2 audit：targets enabled=false 但副本可见时判 visibility_mismatch', async (t) => {
  const root = makeTempDir('sm-audit-visibility-');
  const hostRoot = makeHostRoot('sm-audit-visibility-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-visibility', {
    target: 'claude',
    description: 'audit visibility',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  disableDeclaredTarget(root, 'audit-visibility');

  const audit = await scanAudit(root);
  const row = audit.rows.find((item) => item.skill_id === 'audit-visibility');
  assert.equal(row?.status, 'visibility_mismatch');
  assert.ok(row?.reasons.includes('visibility_mismatch'));
  assert.equal(audit.summary.visibility_mismatch, 1);
});

test('T2 audit：账本不可读时保留 insufficient，不伪造 missing', async (t) => {
  const root = makeTempDir('sm-audit-insufficient-');
  const hostRoot = makeHostRoot('sm-audit-insufficient-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-insufficient', {
    target: 'claude',
    description: 'audit insufficient',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  writeFileSync(join(root, 'host_landings.yaml'), 'schema_version: [broken\n');

  const audit = await scanAudit(root);
  const row = audit.rows.find((item) => item.skill_id === 'audit-insufficient');
  assert.equal(row?.status, 'insufficient');
  assert.equal(row?.ledger_state, 'unreadable');
  assert.ok(row?.reasons.includes('ledger_unreadable'));
  assert.equal(audit.summary.missing, 0);
  assert.equal(audit.summary.insufficient, 1);
});

test('T2 audit：开启审计不写工作区或宿主', async (t) => {
  const root = makeTempDir('sm-audit-readonly-');
  const hostRoot = makeHostRoot('sm-audit-readonly-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('audit-readonly', {
    target: 'claude',
    description: 'audit readonly',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  const beforeWorkspace = snapshotTree(root);
  const beforeHost = snapshotTree(hostRoot);

  await scanAudit(root);

  assert.deepEqual(snapshotTree(root), beforeWorkspace);
  assert.deepEqual(snapshotTree(hostRoot), beforeHost);
});
