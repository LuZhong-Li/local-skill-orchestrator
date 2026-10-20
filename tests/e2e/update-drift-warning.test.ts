import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
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

async function workspace(): Promise<string> {
  const root = makeTempDir('sm-update-drift-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const source = makeSkillSource('update-drift', {
    description: 'update drift fixture',
    content: '---\nname: update-drift\ndescription: old content\n---\n\n# old\n',
  });
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  return root;
}

function editLibrary(root: string, text: string): void {
  writeFileSync(join(root, 'skills', 'update-drift', 'SKILL.md'), text);
}

test('T5 update：成功刷新后不携带更新前旧快照的 W-DRIFT-001', async (t) => {
  const root = await workspace();
  t.after(isolateHostEnvironment(root));
  editLibrary(
    root,
    '---\nname: update-drift\ndescription: refreshed content\n---\n\n# refreshed\n',
  );

  const updated = await json(['update', 'update-drift', '--workspace', root, '--yes']);
  assert.equal(updated.code, 0, JSON.stringify(updated.result));
  const findings = updated.result['findings'] as Array<{ code: string; message?: string }>;
  assert.equal(
    findings.some((item) => item.code === 'W-DRIFT-001'),
    false,
    JSON.stringify(findings),
  );

  const validated = await json(['validate', '--workspace', root]);
  assert.equal(validated.code, 0, JSON.stringify(validated.result));
  assert.equal(
    (validated.result['findings'] as Array<{ code: string }>).some(
      (item) => item.code === 'W-DRIFT-001',
    ),
    false,
    '更新后的索引基线必须与磁盘重新对齐',
  );
});

test('T5 update：成功刷新后真实篡改仍产生 W-DRIFT-001', async (t) => {
  const root = await workspace();
  t.after(isolateHostEnvironment(root));
  editLibrary(
    root,
    '---\nname: update-drift\ndescription: refreshed content\n---\n\n# refreshed\n',
  );
  const updated = await json(['update', 'update-drift', '--workspace', root, '--yes']);
  assert.equal(updated.code, 0, JSON.stringify(updated.result));

  editLibrary(
    root,
    '---\nname: update-drift\ndescription: manual tamper\n---\n\n# tampered after update\n',
  );
  const validated = await json(['validate', '--workspace', root]);
  assert.equal(validated.code, 0, JSON.stringify(validated.result));
  const drift = (validated.result['findings'] as Array<{ code: string; target: string }>).filter(
    (item) => item.code === 'W-DRIFT-001',
  );
  assert.equal(drift.length > 0, true, JSON.stringify(validated.result));
  assert.ok(drift.some((item) => item.target === 'update-drift/SKILL.md'));
});
