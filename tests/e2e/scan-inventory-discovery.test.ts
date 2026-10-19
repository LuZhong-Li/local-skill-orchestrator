import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeTempDir } from '../helpers/temp.ts';
import {
  makeHostRoot,
  makeSharedHostRoot,
  writeCorruptHostSkill,
  writeHostSkill,
} from '../helpers/host.ts';

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

interface RootItem {
  root_id: string;
  state: string;
  host_id: string;
  root_role: string;
  is_x_host: boolean;
}

interface CopyItem {
  path: string;
  host_id: string;
  format: string;
  visibility: string;
  skill_id?: string;
  content_digest?: string;
  consumed_by: string[];
  root_ids: string[];
  recursive: boolean;
}

interface InventoryData {
  mode: 'inventory';
  workspace: { root: string; state: string };
  roots: RootItem[];
  copies: CopyItem[];
  corrupt: Array<{ path: string; reason: string }>;
  summary: {
    copies_before_dedup: number;
    copies_after_dedup: number;
    duplicates_removed: number;
  };
}

function dataOf(result: Record<string, unknown>): InventoryData {
  return result['data'] as InventoryData;
}

test('M4c-2 e2e：多宿主发现、递归、rules、去重、损坏与只读', async (t) => {
  const root = makeTempDir('sm-inventory-discovery-');
  const restoreEnv = isolateHostEnvironment(root);
  t.after(restoreEnv);

  const workspace = makeTempDir('sm-inventory-discovery-ws-');
  const shared = makeSharedHostRoot('sm-inventory-shared-');
  const claudeRoot = makeHostRoot('sm-inventory-claude-');
  const rulesRoot = makeHostRoot('sm-inventory-rules-');
  const missingRoot = join(root, 'missing-skills');
  const fileRoot = join(root, 'not-a-directory');
  writeFileSync(fileRoot, 'not a directory');

  writeHostSkill(shared, 'alpha');
  mkdirSync(join(shared, 'alpha', 'references'), { recursive: true });
  writeHostSkill(claudeRoot, 'alpha');
  writeHostSkill(claudeRoot, 'beta');
  writeCorruptHostSkill(shared, 'bad', 'bad-yaml');
  writeCorruptHostSkill(shared, 'no-skill', 'missing');
  writeFileSync(join(rulesRoot, 'alpha.mdc'), '---\nalwaysApply: false\n---\n');
  writeFileSync(join(rulesRoot, 'ignored.md'), 'ignored');

  const cursorRoot = join(root, 'home', '.cursor', 'skills');
  writeHostSkill(join(cursorRoot, 'outer'), 'inner');

  assert.equal((await capture(['init', '--workspace', workspace])).code, 0);
  const configs: Array<[string, string]> = [
    ['host.codex.root', shared],
    ['host.cursor.root', shared],
    ['host.claude.root', claudeRoot],
    ['host.cursor.rules_root', rulesRoot],
    ['host.agentskills.root', missingRoot],
    ['host.doubao.root', fileRoot],
  ];
  for (const [key, value] of configs) {
    const result = await capture(['config', 'set', key, value, '--workspace', workspace]);
    assert.equal(result.code, 0, `${key} 应可写入：${result.out}`);
  }

  const indexFile = layoutOf(workspace).indexFile;
  const before = {
    index: readFileSync(indexFile),
    shared: readFileSync(join(shared, 'alpha', 'SKILL.md')),
    rule: readFileSync(join(rulesRoot, 'alpha.mdc')),
  };
  const scanned = await json(['scan', '--inventory', '--workspace', workspace]);
  assert.equal(scanned.code, 0);
  const data = dataOf(scanned.result);
  assert.equal(data.mode, 'inventory');
  assert.equal(data.workspace.state, 'ok');
  assert.equal(data.copies.length, 5, JSON.stringify(data.copies));
  assert.equal(data.summary.copies_before_dedup, 6);
  assert.equal(data.summary.copies_after_dedup, 5);
  assert.equal(data.summary.duplicates_removed, 1);

  const sharedAlpha = data.copies.filter((copy) => copy.path === join(shared, 'alpha'));
  assert.equal(sharedAlpha.length, 1);
  assert.ok(sharedAlpha[0]?.consumed_by.includes('codex'));
  assert.ok(sharedAlpha[0]?.consumed_by.includes('cursor'));
  assert.equal(sharedAlpha[0]?.content_digest?.startsWith('sha256:'), true);
  assert.equal(
    data.copies.filter((copy) => copy.format === 'skill' && copy.skill_id === 'alpha').length,
    2,
    JSON.stringify(data.copies),
  );
  assert.ok(data.copies.some((copy) => copy.path === join(cursorRoot, 'outer', 'inner')));
  assert.ok(data.copies.some((copy) => copy.format === 'rules' && copy.path.endsWith('alpha.mdc')));
  assert.equal(
    data.copies.some((copy) => copy.path.endsWith('references')),
    false,
  );
  assert.equal(
    data.copies.some((copy) => copy.path.endsWith('no-skill')),
    false,
  );
  assert.ok(data.corrupt.some((copy) => copy.path.endsWith('bad') && copy.reason === 'bad_yaml'));
  assert.equal(
    data.roots.find((item) => item.root_id === 'agents-md/project')?.state,
    'not_applicable',
  );
  assert.equal(
    data.roots.find((item) => item.root_id === 'agentskills/config-root')?.state,
    'missing',
  );
  assert.equal(
    data.roots.find((item) => item.root_id === 'doubao/config-root')?.state,
    'unreadable',
  );

  assert.deepEqual(readFileSync(indexFile), before.index);
  assert.deepEqual(readFileSync(join(shared, 'alpha', 'SKILL.md')), before.shared);
  assert.deepEqual(readFileSync(join(rulesRoot, 'alpha.mdc')), before.rule);
  assert.equal(existsSync(join(shared, 'alpha', 'SKILL.md')), true);
});
