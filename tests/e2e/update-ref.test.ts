/**
 * M4a T3：远端目标标签 update --ref。
 *
 * 使用真实 CLI、真实内核、回环 git daemon 与主进程 UpdateCoordinator；
 * happy path 不注入 probe / bridge。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelBridge } from '../../gui/bridge/commands.ts';
import {
  DEFAULT_UPDATE_SETTINGS,
  UpdateCoordinator,
  UpdateSettingsStore,
} from '../../gui/main/updates/index.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLI = join(REPO, 'kernel', 'entry', 'cli.ts');

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(cwd: string, args: string[]) {
  const result = spawnSync(
    'git',
    ['-C', cwd, '-c', 'user.email=bench@example.com', '-c', 'user.name=bench', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout ?? '';
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0);
  return port;
}

async function startDaemon(basePath: string, port: number) {
  const child = spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      `--base-path=${basePath}`,
      `--port=${port}`,
      '--listen=127.0.0.1',
    ],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      const probe = spawnSync(process.execPath, [
        '-e',
        `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
      ]);
      if (probe.status === 0) return resolve();
      if (Date.now() > deadline) return reject(new Error('git daemon 未在 10 秒内就绪'));
      setTimeout(attempt, 100);
    };
    attempt();
  });
  return child;
}

function stopDaemon(child: { pid?: number } | null) {
  if (child?.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 已退出
  }
}

function metaOf(url: string, ref: string, version: string) {
  return [
    'id: remote-skill',
    'name: remote-skill',
    `version: ${version}`,
    'status: enabled',
    'path: ./skills/remote-skill',
    'source:',
    '  type: git',
    `  url: ${url}`,
    `  ref: ${ref}`,
    'targets:',
    '  - target: claude',
    '    scope: global',
    '    path: .claude/skills/remote-skill',
    '    mode: copy',
    '    enabled: true',
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');
}

function libraryMeta(workspace: string): string {
  return readFileSync(join(workspace, 'skills', 'remote-skill', 'skill_meta.yaml'), 'utf8');
}

function libraryText(workspace: string): string {
  return readFileSync(join(workspace, 'skills', 'remote-skill', 'SKILL.md'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

test('T3 全链路：update --ref 切换目标标签，持久化 declared.ref 后检查为最新', async () => {
  const root = mkdtempSync(join(tmpdir(), 'update-ref-'));
  const served = join(root, 'served');
  const work = join(root, 'work');
  const workspace = join(root, 'ws');
  mkdirSync(served, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(workspace, 'skills', 'remote-skill'), { recursive: true });
  let daemon: ReturnType<typeof spawn> | null = null;

  try {
    const port = await freePort();
    const url = `git://127.0.0.1:${port}/sample.git`;
    git(work, ['init', '-q', '-b', 'main']);
    writeFileSync(join(work, 'SKILL.md'), '# v1\n');
    writeFileSync(join(work, 'skill_meta.yaml'), metaOf(url, 'v1.0.0', '1.0.0'));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'v1']);
    git(work, ['tag', 'v1.0.0']);

    // 远端目标版本故意仍保留旧 ref，证明 --ref 的持久化由 update 完成。
    writeFileSync(join(work, 'SKILL.md'), '# v2\n');
    writeFileSync(join(work, 'skill_meta.yaml'), metaOf(url, 'v1.0.0', '1.1.0'));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'v2']);
    git(work, ['tag', 'v1.1.0']);
    git(root, ['clone', '-q', '--bare', work, join(served, 'sample.git')]);
    daemon = await startDaemon(served, port);

    writeFileSync(join(workspace, 'skills', 'remote-skill', 'SKILL.md'), '# v1\n');
    writeFileSync(
      join(workspace, 'skills', 'remote-skill', 'skill_meta.yaml'),
      metaOf(url, 'v1.0.0', '1.0.0'),
    );
    cli(['init', '--workspace', workspace]);
    assert.equal(cli(['scan', '--workspace', workspace]).code, 0);
    const indexBefore = readFileSync(join(workspace, 'skill_index.yaml'));

    const bridge = new KernelBridge({
      command: process.execPath,
      entry: ['kernel/entry/cli.ts'],
      workspace,
      cwd: REPO,
    });
    const settings = new UpdateSettingsStore(join(root, 'settings.json'), {
      readText: () => JSON.stringify(DEFAULT_UPDATE_SETTINGS),
      writeText: () => {
        throw new Error('检查不得写设置');
      },
    });
    const coordinator = new UpdateCoordinator({
      bridge,
      settings,
      now: () => Date.now(),
      notify: () => undefined,
    });
    const before = await coordinator.checkNow('manual');
    assert.equal(before.data.items[0]?.state, 'update-available');
    assert.equal(before.data.items[0]?.baseline_version, '1.0.0');
    assert.equal(before.data.items[0]?.available?.ref, 'v1.1.0');
    assert.equal(libraryText(workspace), '# v1\n');
    assert.deepEqual(readFileSync(join(workspace, 'skill_index.yaml')), indexBefore);

    const preview = cli([
      'update',
      'remote-skill',
      '--ref',
      'v1.1.0',
      '--dry-run',
      '--workspace',
      workspace,
      '--json',
    ]);
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    const previewResult = JSON.parse(preview.stdout) as {
      preview?: boolean;
      data?: { version_before?: string; version_after?: string };
    };
    assert.equal(previewResult.preview, true);
    assert.equal(previewResult.data?.version_before, '1.0.0');
    assert.equal(previewResult.data?.version_after, '1.1.0');
    assert.equal(libraryText(workspace), '# v1\n');
    assert.deepEqual(readFileSync(join(workspace, 'skill_index.yaml')), indexBefore);

    const updated = cli([
      'update',
      'remote-skill',
      '--ref',
      'v1.1.0',
      '--yes',
      '--workspace',
      workspace,
      '--json',
    ]);
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    assert.equal(libraryText(workspace), '# v2\n');
    assert.match(libraryMeta(workspace), /ref: v1\.1\.0/);
    assert.match(libraryMeta(workspace), /version: 1\.1\.0/);

    const report = await coordinator.checkNow('manual');
    assert.equal(report.data.items[0]?.state, 'up-to-date');
    assert.equal(report.data.items[0]?.baseline_version, '1.1.0');

    const backups = await bridge.restoreList('remote-skill');
    assert.equal(backups.ok, true);
    const rows = (backups.data as { backups?: Array<{ id: string; file_count: number }> }).backups;
    assert.equal(rows?.length, 1, '目标标签更新前必须生成可恢复备份');
    assert.equal(rows?.[0]?.id, 'remote-skill');
    assert.equal(rows?.[0]?.file_count, 2);
  } finally {
    stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

test('T3 边界：--check --ref 拒绝；本地来源传 --ref 报参数错误', () => {
  const root = mkdtempSync(join(tmpdir(), 'update-ref-input-'));
  const workspace = join(root, 'ws');
  const localRepo = join(root, 'local-repo');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(localRepo, { recursive: true });
  try {
    writeFileSync(join(localRepo, 'SKILL.md'), '# local\n');
    writeFileSync(
      join(localRepo, 'skill_meta.yaml'),
      [
        'id: local-skill',
        'name: local-skill',
        'version: 1.0.0',
        'status: enabled',
        'path: ./skills/local-skill',
        'source:',
        '  type: git',
        `  location: ${localRepo}`,
        '  ref: v1.0.0',
        'targets:',
        '  - target: claude',
        '    scope: global',
        '    path: .claude/skills/local-skill',
        '    mode: copy',
        '    enabled: true',
        '    file_map:',
        '      SKILL.md: SKILL.md',
        '',
      ].join('\n'),
    );
    cli(['init', '--workspace', workspace]);
    assert.equal(cli(['scan', '--workspace', workspace]).code, 0);

    const checkRef = cli([
      'update',
      'local-skill',
      '--check',
      '--ref',
      'v1.1.0',
      '--workspace',
      workspace,
      '--json',
    ]);
    assert.equal(checkRef.code, 2);
    assert.match(checkRef.stdout, /不能与 --check 组合/);

    const localRef = cli([
      'update',
      'local-skill',
      '--ref',
      'v1.1.0',
      '--yes',
      '--workspace',
      workspace,
      '--json',
    ]);
    assert.equal(localRef.code, 2);
    assert.match(localRef.stdout, /只适用于远端 git 来源/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T3 失败：目标 ref 不存在时退出码 4，索引与原件不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'update-ref-missing-'));
  const served = join(root, 'served');
  const work = join(root, 'work');
  const workspace = join(root, 'ws');
  mkdirSync(served, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(workspace, 'skills', 'remote-skill'), { recursive: true });
  let daemon: ReturnType<typeof spawn> | null = null;
  try {
    const port = await freePort();
    const url = `git://127.0.0.1:${port}/sample.git`;
    git(work, ['init', '-q', '-b', 'main']);
    writeFileSync(join(work, 'SKILL.md'), '# v1\n');
    writeFileSync(join(work, 'skill_meta.yaml'), metaOf(url, 'v1.0.0', '1.0.0'));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'v1']);
    git(work, ['tag', 'v1.0.0']);
    git(root, ['clone', '-q', '--bare', work, join(served, 'sample.git')]);
    daemon = await startDaemon(served, port);

    writeFileSync(join(workspace, 'skills', 'remote-skill', 'SKILL.md'), '# v1\n');
    writeFileSync(
      join(workspace, 'skills', 'remote-skill', 'skill_meta.yaml'),
      metaOf(url, 'v1.0.0', '1.0.0'),
    );
    cli(['init', '--workspace', workspace]);
    assert.equal(cli(['scan', '--workspace', workspace]).code, 0);
    const before = readFileSync(join(workspace, 'skill_index.yaml'));
    const result = cli([
      'update',
      'remote-skill',
      '--ref',
      'v9.9.9',
      '--yes',
      '--workspace',
      workspace,
      '--json',
    ]);
    assert.equal(result.code, 4, result.stdout + result.stderr);
    assert.match(result.stdout, /E-SRC-/);
    assert.deepEqual(readFileSync(join(workspace, 'skill_index.yaml')), before);
    assert.equal(libraryText(workspace), '# v1\n');
  } finally {
    stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});
