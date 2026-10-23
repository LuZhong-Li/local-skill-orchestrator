import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { InventoryAuditData } from '@skill-manager/contract';
import { computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import { run } from '../../kernel/entry/cli.ts';
import { loadHostLandings, saveHostLandings } from '../../kernel/store/host-landings/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';

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

function twoTargetSource(id: string): string {
  return makeSkillSource(id, {
    description: 'base description',
    content: `---\nname: ${id}\ndescription: base description\n---\n\n# ${id}\n`,
    meta: [
      `id: ${id}`,
      `name: ${id}`,
      'description: base description',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: unknown',
      'targets:',
      ...['doubao', 'codex'].flatMap((target) => [
        `  - target: ${target}`,
        '    scope: global',
        `    path: .${target}/skills/${id}`,
        '    mode: copy',
        '    enabled: true',
        '    file_map:',
        '      SKILL.md: SKILL.md',
      ]),
      '',
    ].join('\n'),
  });
}

function refreshCodexDigest(root: string, copyPath: string): void {
  const loaded = loadHostLandings(join(root, 'host_landings.yaml'));
  assert.ok(loaded.index, JSON.stringify(loaded.findings));
  const contentDigest = computeLandingChecksum({ targetPath: copyPath, format: 'skill' });
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...loaded.index,
    landings: loaded.index.landings.map((item) =>
      item.target_path === copyPath && item.state === 'active'
        ? { ...item, content_digest: contentDigest }
        : item,
    ),
  });
  const saved = loadHostLandings(join(root, 'host_landings.yaml'));
  assert.ok(saved.index, JSON.stringify(saved.findings, null, 2));
}

test('M6 audit：checksum 一致但跨宿主 frontmatter 不同，矩阵标为 frontmatter drift', async (t) => {
  const root = makeTempDir('sm-m6-frontmatter-drift-');
  const doubaoRoot = makeHostRoot('sm-m6-frontmatter-doubao-');
  const codexRoot = makeHostRoot('sm-m6-frontmatter-codex-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['doubao', doubaoRoot],
    ['codex', codexRoot],
  ]);

  const installed = await capture([
    'install',
    twoTargetSource('frontmatter-drift'),
    '--host',
    'doubao',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);
  const repaired = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'frontmatter-drift',
    '--host',
    'codex',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(repaired.code, 0, JSON.stringify(repaired.result));

  const codexCopy = join(codexRoot, 'frontmatter-drift');
  writeFileSync(
    join(codexCopy, 'SKILL.md'),
    '---\nname: frontmatter-drift\ndescription: codex changed description\n---\n\n# frontmatter-drift\n',
  );
  refreshCodexDigest(root, codexCopy);

  const scanned = await json(['scan', '--inventory', '--audit', '--workspace', root]);
  assert.equal(scanned.code, 0, JSON.stringify(scanned.result));
  const audit = (scanned.result['data'] as { audit: InventoryAuditData }).audit;
  const rows = audit.rows.filter(
    (row) =>
      row.skill_id === 'frontmatter-drift' && (row.target === 'doubao' || row.target === 'codex'),
  );

  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.status === 'drift'),
    JSON.stringify(rows, null, 2),
  );
  assert.ok(
    rows.every((row) => row.drift_subtype === 'frontmatter'),
    JSON.stringify(rows, null, 2),
  );
  assert.ok(rows.some((row) => row.frontmatter_diffs?.[0]?.field === 'description'));
  assert.equal(audit.summary.drift, 2);
  assert.equal(audit.summary.drift_by_subtype?.frontmatter, 2);
});
