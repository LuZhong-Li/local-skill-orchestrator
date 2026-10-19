#!/usr/bin/env node
/** 发布物内核验证：用打包资产解包出的内核执行 init → 分发 → 盘点 → missing/untracked。 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const kernel = process.argv[2];
if (kernel === undefined || kernel === '') {
  console.error('用法：node scripts/probe-production-kernel.mjs <解包后的内核可执行文件>');
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'sm-production-kernel-'));
const home = join(base, 'home');
const local = join(base, 'local');
const workspace = join(base, 'workspace');
const source = join(base, 'source', 'probe-skill');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: local,
};

function run(args) {
  const result = spawnSync(kernel, args, { env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `发布物内核失败：${args.join(' ')}（${String(result.status)}）\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function expect(name, condition, detail = '') {
  if (condition !== true) throw new Error(`${name}${detail === '' ? '' : `：${detail}`}`);
  console.log(`✔ ${name}`);
}

function writeSource() {
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: probe-skill\ndescription: production probe\nversion: 1.0.0\n---\n\n# probe-skill\n',
  );
  writeFileSync(
    join(source, 'skill_meta.yaml'),
    [
      'id: probe-skill',
      'name: probe-skill',
      'description: production probe',
      'version: 1.0.0',
      'status: enabled',
      'path: ./skills/probe-skill',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/probe-skill',
      '    mode: copy',
      '    enabled: true',
      '',
    ].join('\n'),
  );
}

function writeUntracked() {
  const dir = join(home, '.claude', 'skills', 'legacy-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: legacy-skill\ndescription: legacy fixture\nversion: 1.0.0\n---\n\n# legacy\n',
  );
}

function scan() {
  return JSON.parse(run(['scan', '--inventory', '--json', '--workspace', workspace])).data;
}

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(local, { recursive: true });
  const version = run(['--version']).trim();
  expect('发布物内核版本为 0.4.0', version === '0.4.0', version);
  run(['init', '--workspace', workspace]);
  writeSource();
  run(['install', source, '--workspace', workspace, '--yes']);
  run(['update', 'probe-skill', '--host', 'claude', '--workspace', workspace, '--yes']);

  const hostCopy = join(home, '.claude', 'skills', 'probe-skill');
  expect('分发落位到默认 Claude 根', existsSync(join(hostCopy, 'SKILL.md')));
  const ledger = readFileSync(join(workspace, 'host_landings.yaml'), 'utf8');
  expect(
    'host_landings 写入 active 记录',
    ledger.includes('skill_id: probe-skill') && ledger.includes('state: active'),
  );

  const managed = scan();
  const managedCopy = managed.copies.find((copy) => copy.path === hostCopy);
  expect(
    '盘点识别 managed 副本',
    managedCopy?.reconciliation.classification === 'managed_consistent',
  );

  rmSync(hostCopy, { recursive: true, force: true });
  const missing = scan();
  expect(
    '删除副本后账本反查 missing',
    missing.missing.some(
      (item) => item.target_path === hostCopy && item.authority === 'authoritative',
    ),
  );

  writeUntracked();
  const untracked = scan();
  expect(
    '未纳管副本进入 untracked',
    untracked.copies.some(
      (copy) =>
        copy.path === join(home, '.claude', 'skills', 'legacy-skill') &&
        copy.reconciliation.classification === 'untracked',
    ),
  );
  console.log(
    `PRODUCTION_KERNEL_RESULT=ok version=${version} managed=${managed.copies.length} missing=${missing.missing.length}`,
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
