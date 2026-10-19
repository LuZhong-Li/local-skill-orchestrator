import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeTempDir } from '../helpers/temp.ts';
import { makeWorkspaceSkill } from '../helpers/skill.ts';
import { writePluginManifest } from '../helpers/plugin.ts';

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
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_role: 'user' | 'system' | 'platform' | 'project';
  kind: string;
  path: string;
  recursive: boolean;
  origin: string;
  is_x_host: boolean;
  consumed_by: string[];
  configured: boolean;
  reason?: string;
}

interface InventoryData {
  mode: 'inventory';
  workspace: { root: string; state: 'ok' | 'uninitialized' | 'unreadable' };
  roots: RootItem[];
}

function dataOf(result: Record<string, unknown>): InventoryData {
  return result['data'] as InventoryData;
}

test('M4c-1 e2e：未初始化工作区可盘点，且不创建任何工作区文件', async (t) => {
  const root = makeTempDir('sm-inventory-empty-');
  t.after(isolateHostEnvironment(root));
  const { code, result } = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(code, 0);
  const data = dataOf(result);
  assert.equal(data.mode, 'inventory');
  assert.equal(data.workspace.state, 'uninitialized');
  assert.ok(data.roots.some((item) => item.host_id === 'codex'));
  assert.ok(data.roots.some((item) => item.root_role === 'system'));
  const rootIds = new Set(data.roots.map((item) => item.root_id));
  for (const rootId of [
    'claude/user',
    'codex/agents-user',
    'codex/legacy-user',
    'codex/system',
    'cursor/user-skills',
    'agents-md/project',
  ]) {
    assert.ok(rootIds.has(rootId), `盘点根应包含 ${rootId}`);
  }
  if (process.platform === 'win32') {
    assert.ok(data.roots.some((item) => item.root_role === 'platform'));
    assert.ok(rootIds.has('doubao/user'));
  }
  assert.equal(existsSync(join(root, 'skill_index.yaml')), false);
  assert.equal(existsSync(join(root, 'plugin_index.yaml')), false);
  assert.equal(existsSync(join(root, 'host_landings.yaml')), false);
});

test('M4c-1 e2e：inventory 与 kind/root/dry-run 逐个按参数错误拒绝', async (t) => {
  const root = makeTempDir('sm-inventory-conflict-');
  t.after(isolateHostEnvironment(root));
  for (const argv of [
    ['scan', '--inventory', '--kind', 'plugin', '--workspace', root],
    ['scan', '--inventory', '--root', 'skills', '--workspace', root],
    ['scan', '--inventory', '--dry-run', '--workspace', root],
  ]) {
    const captured = await capture([...argv, '--json']);
    assert.equal(captured.code, 2, `${argv.join(' ')} 应按参数错误拒绝`);
    assert.match(captured.out, /--inventory 与 --/);
  }
});

test('M4c-1 e2e：盘点展开 config / 共享根 / 已启用 x- 宿主，且索引字节不变', async (t) => {
  const root = makeTempDir('sm-inventory-full-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  makeWorkspaceSkill(root, 'alpha');
  assert.equal((await capture(['scan', '--workspace', root])).code, 0);

  const customClaudeRoot = join(root, 'custom-claude');
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', customClaudeRoot, '--workspace', root]))
      .code,
    0,
  );

  const pluginSource = makeTempDir('sm-inventory-plugin-');
  writePluginManifest(pluginSource);
  assert.equal(
    (await capture(['install', pluginSource, '--kind', 'plugin', '--workspace', root, '--yes']))
      .code,
    0,
  );

  const before = readFileSync(layoutOf(root).indexFile, 'utf8');
  const disabled = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(disabled.code, 0);
  const disabledData = dataOf(disabled.result);
  assert.equal(disabledData.workspace.state, 'ok');
  assert.ok(
    disabledData.roots.some(
      (item) => item.root_id === 'claude/config-root' && item.path === customClaudeRoot,
    ),
    'config 覆盖根应被展开',
  );
  const codex = disabledData.roots.find((item) => item.root_id === 'codex/agents-user');
  assert.ok(codex?.consumed_by.includes('cursor'));
  assert.ok(codex?.consumed_by.includes('dsh'));
  assert.equal(
    disabledData.roots.some((item) => item.is_x_host),
    false,
    '未启用插件的 x- 宿主不应出现',
  );

  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  const enabled = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(enabled.code, 0);
  const enabledData = dataOf(enabled.result);
  assert.ok(
    enabledData.roots.some(
      (item) =>
        item.host_id === 'x-acme-tools-zed' && item.is_x_host && item.host_group === 'plugin',
    ),
    '已启用插件的 x- 宿主根应出现',
  );
  assert.equal(readFileSync(layoutOf(root).indexFile, 'utf8'), before);
});
