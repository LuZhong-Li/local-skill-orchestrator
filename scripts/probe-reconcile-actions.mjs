#!/usr/bin/env node
/**
 * T6 三平台 reconcile 写动作探针。
 *
 * 在隔离 HOME 与显式 config host 根上执行真实 CLI：每个动作先预览并断言零写入，
 * 再 apply 并断言索引 / 账本 / 宿主副本的最终状态。共享根、插件 x-、分类批量、
 * 计划过期与 POSIX symlink 都在同一入口覆盖；不读取真实用户目录。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPluginChecks } from './probe-reconcile-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const checks = [];

function expect(name, condition, detail = '') {
  checks.push({ name, ok: condition === true, detail: condition === true ? '' : detail });
  if (condition !== true) throw new Error(`${name}${detail === '' ? '' : `：${detail}`}`);
}

function skillText(id, description = `${id} fixture`) {
  return `---\nname: ${id}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${id}\n`;
}

function writeSkill(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillText(id));
}

function sourceMeta(id, target) {
  return [
    `id: ${id}`,
    `name: ${id}`,
    `description: ${id} fixture`,
    'status: enabled',
    `path: ./skills/${id}`,
    'source:',
    '  type: local',
    'targets:',
    `  - target: ${target}`,
    '    scope: global',
    `    path: .${target}/skills/${id}`,
    '    mode: copy',
    '    enabled: true',
    '',
  ].join('\n');
}

function writeSource(dir, id, target = 'claude') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} fixture\n---\n\n# ${id}\n\n正文。\n`,
  );
  writeFileSync(join(dir, 'skill_meta.yaml'), sourceMeta(id, target));
  return dir;
}

function treeHash(root) {
  if (!existsSync(root)) return 'missing';
  const digest = createHash('sha256');
  walkTree(root, '', digest);
  return digest.digest('hex');
}

function walkTree(absolute, relative, digest) {
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const child = join(absolute, entry.name);
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) digest.update(`link:${key}\n`);
    else if (entry.isDirectory()) {
      digest.update(`dir:${key}\n`);
      walkTree(child, key, digest);
    } else if (entry.isFile()) {
      digest.update(`file:${key}:${String(lstatSync(child).size)}\n`);
      digest.update(readFileSync(child));
      digest.update('\n');
    }
  }
}

function prepare() {
  const base = mkdtempSync(join(tmpdir(), 'sm-probe-reconcile-'));
  const fixture = {
    base,
    home: join(base, 'home'),
    local: join(base, 'local'),
    claude: join(base, 'claude'),
    doubao: join(base, 'doubao'),
    shared: join(base, 'shared'),
    workspace: join(base, 'workspace'),
    source: join(base, 'source'),
    pluginSource: join(base, 'plugin-source'),
    pluginSkillSource: join(base, 'plugin-skill-source'),
    symlink: 'skipped',
  };
  for (const dir of [fixture.home, fixture.local, fixture.claude, fixture.doubao, fixture.shared]) {
    mkdirSync(dir, { recursive: true });
  }
  fixture.cursor = fixture.shared;
  if (process.platform !== 'win32') {
    fixture.cursor = join(base, 'cursor-link');
    symlinkSync(fixture.shared, fixture.cursor, 'dir');
    fixture.symlink = 'created';
  }
  return fixture;
}

function envOf(fixture) {
  return {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    LOCALAPPDATA: fixture.local,
  };
}

function runRaw(fixture, argv) {
  return spawnSync(process.execPath, ['kernel/entry/cli.ts', ...argv], {
    cwd: ROOT,
    env: envOf(fixture),
    encoding: 'utf8',
  });
}

function cli(fixture, argv) {
  const result = runRaw(fixture, argv);
  if (result.status !== 0) {
    throw new Error(
      `CLI 失败：${argv.join(' ')}（退出码 ${String(result.status)}）\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function json(fixture, argv) {
  return JSON.parse(cli(fixture, [...argv, '--json']));
}

function jsonRaw(fixture, argv) {
  const result = runRaw(fixture, [...argv, '--json']);
  return { status: result.status, result: JSON.parse(result.stdout) };
}

function scan(fixture) {
  return json(fixture, ['scan', '--inventory', '--workspace', fixture.workspace]).data;
}

function copyAt(data, path) {
  return data.copies.find((item) => item.path === path);
}

function missingAt(data, path) {
  return data.missing.find((item) => item.target_path === path);
}

function stateHash(fixture) {
  return [
    treeHash(fixture.workspace),
    treeHash(fixture.claude),
    treeHash(fixture.doubao),
    treeHash(fixture.shared),
  ].join('|');
}

function preview(fixture, argv) {
  const before = stateHash(fixture);
  const result = json(fixture, ['reconcile', ...argv, '--workspace', fixture.workspace]);
  expect(
    `预览零写入：${argv[0] === '--action' ? argv[1] : 'reconcile'}`,
    stateHash(fixture) === before,
  );
  expect('预览未标记 applied', result.data?.applied === false);
  return result.data;
}

function applyRaw(fixture, argv) {
  return jsonRaw(fixture, [
    'reconcile',
    ...argv,
    '--workspace',
    fixture.workspace,
    '--apply',
    '--yes',
  ]);
}

function apply(fixture, argv) {
  return applyRaw(fixture, argv).result;
}

function ledgerText(fixture) {
  return readFileSync(join(fixture.workspace, 'host_landings.yaml'), 'utf8');
}

function setup(fixture) {
  cli(fixture, ['init', '--workspace', fixture.workspace]);
  for (const [host, root] of [
    ['claude', fixture.claude],
    ['codex', fixture.shared],
    ['cursor', fixture.cursor],
    ['doubao', fixture.doubao],
  ]) {
    cli(fixture, ['config', 'set', `host.${host}.root`, root, '--workspace', fixture.workspace]);
  }
  const data = scan(fixture);
  for (const [id, path] of [
    ['claude', fixture.claude],
    ['codex', fixture.shared],
    ['cursor', fixture.cursor],
    ['doubao', fixture.doubao],
  ]) {
    expect(
      `config 根展开：${id}`,
      data.roots.some((item) => item.origin === 'config' && item.path === path),
    );
    expect(`config 根使用平台分隔符：${id}`, path.includes(sep));
  }
}

function checkAdopt(fixture) {
  const hostDir = join(fixture.claude, 'adopt-skill');
  writeSkill(hostDir, 'adopt-skill');
  const plan = preview(fixture, ['--action', 'adopt', '--path', hostDir]);
  expect('adopt 计划为 planned', plan.items[0]?.status === 'planned');
  expect(
    'adopt 计划含中心库与账本写入',
    ['library', 'skill_meta', 'index', 'host_landings'].every((kind) =>
      plan.items[0]?.writes.some((write) => write.kind === kind),
    ),
  );
  const applied = apply(fixture, ['--action', 'adopt', '--path', hostDir]);
  expect('adopt apply succeeded', applied.data?.results[0]?.status === 'succeeded');
  expect(
    'adopt 建立中心库',
    existsSync(join(fixture.workspace, 'skills', 'adopt-skill', 'SKILL.md')),
  );
  const after = scan(fixture);
  expect(
    'adopt 后分类 managed',
    copyAt(after, hostDir)?.reconciliation.classification === 'managed_consistent',
  );
  expect('adopt 后账本 active', ledgerText(fixture).includes('skill_id: adopt-skill'));
}

function prepareTrackCopy(fixture) {
  const id = 'track-skill';
  cli(fixture, [
    'install',
    writeSource(join(fixture.source, id), id),
    '--workspace',
    fixture.workspace,
    '--yes',
  ]);
  const hostDir = join(fixture.claude, id);
  mkdirSync(hostDir, { recursive: true });
  cpSync(join(fixture.workspace, 'skills', id, 'SKILL.md'), join(hostDir, 'SKILL.md'));
  return { id, hostDir };
}

function checkTrack(fixture, id, hostDir) {
  const trackCopy = copyAt(scan(fixture), hostDir);
  expect(
    'track 前为 inferred_consistent',
    trackCopy?.reconciliation.classification === 'inferred_consistent',
    JSON.stringify(trackCopy?.reconciliation),
  );
  const indexBefore = readFileSync(join(fixture.workspace, 'skill_index.yaml'));
  const libraryHash = treeHash(join(fixture.workspace, 'skills', id));
  const hostHash = treeHash(hostDir);
  const plan = preview(fixture, ['--action', 'track', '--path', hostDir]);
  expect(
    'track 只写账本',
    plan.items[0]?.writes.length === 1 && plan.items[0]?.writes[0]?.kind === 'host_landings',
  );
  const tracked = apply(fixture, ['--action', 'track', '--path', hostDir]);
  expect('track apply succeeded', tracked.data?.results[0]?.status === 'succeeded');
  expect(
    'track 不改索引',
    readFileSync(join(fixture.workspace, 'skill_index.yaml')).equals(indexBefore),
  );
  expect('track 不改中心库', treeHash(join(fixture.workspace, 'skills', id)) === libraryHash);
  expect('track 不改宿主副本', treeHash(hostDir) === hostHash);
}

function checkRepair(fixture, hostDir) {
  rmSync(hostDir, { recursive: true, force: true });
  expect('repair 前为 missing', missingAt(scan(fixture), hostDir) !== undefined);
  const repaired = apply(fixture, ['--action', 'repair', '--path', hostDir]);
  expect('repair apply succeeded', repaired.data?.results[0]?.status === 'succeeded');
  expect('repair 重建宿主副本', existsSync(join(hostDir, 'SKILL.md')));
  expect(
    'repair 后分类 managed',
    copyAt(scan(fixture), hostDir)?.reconciliation.classification === 'managed_consistent',
  );
}

function checkAccept(fixture, id, hostDir) {
  writeFileSync(join(hostDir, 'SKILL.md'), skillText(id, 'accepted by reconcile probe'));
  expect(
    'accept 前为 drift',
    copyAt(scan(fixture), hostDir)?.reconciliation.classification === 'drift',
  );
  const accepted = apply(fixture, ['--action', 'accept', '--path', hostDir]);
  expect('accept apply succeeded', accepted.data?.results[0]?.status === 'succeeded');
  expect(
    'accept 更新中心库内容',
    readFileSync(join(fixture.workspace, 'skills', id, 'SKILL.md'), 'utf8').includes(
      'accepted by reconcile probe',
    ),
  );
}

function checkForget(fixture, hostDir) {
  rmSync(hostDir, { recursive: true, force: true });
  expect('forget 前为 missing', missingAt(scan(fixture), hostDir) !== undefined);
  const forgotten = apply(fixture, ['--action', 'forget', '--path', hostDir]);
  expect(
    'forget apply succeeded',
    (forgotten.data?.results ?? []).some((item) => item.status === 'succeeded'),
  );
  expect('forget 后不再 missing', missingAt(scan(fixture), hostDir) === undefined);
  expect('forget 不改物理副本', !existsSync(hostDir));
}

function checkClean(fixture) {
  const broken = join(fixture.doubao, 'broken-clean');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'SKILL.md'), '---\nname: broken\ndescription: [unclosed\n---\n');
  expect(
    'clean 前进入 corrupt',
    scan(fixture).corrupt.some((copy) => copy.path === broken),
  );
  const plan = preview(fixture, ['--action', 'clean', '--path', broken]);
  expect('clean 计划标记 destructive', plan.summary.destructive === 1);
  const cleaned = apply(fixture, ['--action', 'clean', '--path', broken]);
  expect('clean apply succeeded', cleaned.data?.results[0]?.status === 'succeeded');
  expect('clean 删除物理副本', !existsSync(broken));
}

function checkSharedRoot(fixture) {
  const hostDir = join(fixture.shared, 'shared-skill');
  writeSkill(hostDir, 'shared-skill');
  const plan = preview(fixture, ['--action', 'adopt', '--path', hostDir]);
  expect('共享根组标记 shared', plan.transaction_groups[0]?.shared === true);
  expect(
    '共享根消费宿主包含 codex/cursor',
    ['codex', 'cursor'].every((id) => plan.items[0]?.consumed_by.includes(id)),
    JSON.stringify(plan.items[0]?.consumed_by),
  );
  const applied = apply(fixture, ['--action', 'adopt', '--path', hostDir]);
  expect('共享根 adopt succeeded', applied.data?.results[0]?.status === 'succeeded');
  expect(
    '共享根只建一份中心库',
    existsSync(join(fixture.workspace, 'skills', 'shared-skill')) &&
      !existsSync(join(fixture.workspace, 'skills', 'shared-skill-2')),
  );
  const records = ledgerText(fixture).match(/skill_id: shared-skill/g) ?? [];
  expect('共享根多宿主账本同步', records.length === 2, String(records.length));
  expect(
    '共享根后分类 managed',
    copyAt(scan(fixture), hostDir)?.reconciliation.classification === 'managed_consistent',
  );
}

function checkBatch(fixture) {
  for (const id of ['batch-a', 'batch-b']) writeSkill(join(fixture.doubao, id), id);
  const plan = preview(fixture, [
    '--action',
    'adopt',
    '--classification',
    'untracked',
    '--host',
    'doubao',
  ]);
  expect('分类批量选中两个未纳管副本', plan.summary.planned === 2);
  const applied = apply(fixture, [
    '--action',
    'adopt',
    '--classification',
    'untracked',
    '--host',
    'doubao',
  ]);
  expect(
    '分类批量逐项 succeeded',
    applied.data?.results.filter((item) => item.status === 'succeeded').length === 2,
  );
  for (const id of ['batch-a', 'batch-b']) {
    expect(`分类批量建立中心库：${id}`, existsSync(join(fixture.workspace, 'skills', id)));
  }
  const bare = runRaw(fixture, [
    'reconcile',
    '--action',
    'adopt',
    '--classification',
    'untracked',
    '--workspace',
    fixture.workspace,
    '--json',
  ]);
  expect('裸分类批量被拒绝', bare.status === 2, String(bare.status));
}

function checkFailureIsolation(fixture) {
  const hostDir = join(fixture.doubao, 'occupied-skill');
  writeSkill(hostDir, 'occupied-skill');
  preview(fixture, ['--action', 'adopt', '--path', hostDir]);
  writeFileSync(join(fixture.workspace, 'skills', 'occupied-skill'), 'occupied\n');
  const failed = applyRaw(fixture, ['--action', 'adopt', '--path', hostDir]);
  expect('目标占用时不伪造成功', failed.status !== 0, String(failed.status));
  expect(
    '目标占用返回失败结果',
    (failed.result.data?.results ?? []).some((item) => item.status === 'failed'),
  );
  expect(
    '目标占用零半成品',
    !existsSync(join(fixture.workspace, 'skills', 'occupied-skill', 'SKILL.md')),
  );
  expect(
    '目标占用不动宿主副本',
    readFileSync(join(hostDir, 'SKILL.md'), 'utf8').includes('occupied-skill'),
  );
}

function main() {
  const fixture = prepare();
  try {
    setup(fixture);
    checkAdopt(fixture);
    const tracked = prepareTrackCopy(fixture);
    checkTrack(fixture, tracked.id, tracked.hostDir);
    checkRepair(fixture, tracked.hostDir);
    checkAccept(fixture, tracked.id, tracked.hostDir);
    checkForget(fixture, tracked.hostDir);
    checkClean(fixture);
    checkSharedRoot(fixture);
    checkBatch(fixture);
    runPluginChecks({
      fixture,
      expect,
      preview,
      apply,
      scan,
      copyAt,
      cli,
      writeSource,
    });
    checkFailureIsolation(fixture);
    for (const item of checks) {
      console.log(`${item.ok ? '✔' : '✖'} ${item.name}${item.detail ? `（${item.detail}）` : ''}`);
    }
    console.log(
      `PROBE_RESULT=ok platform=${process.platform} checks=${checks.length} symlink=${fixture.symlink}`,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

main();
