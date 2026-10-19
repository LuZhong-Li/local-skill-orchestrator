#!/usr/bin/env node
/**
 * 发布物内核验证：从打包资产解包出的内核执行 init、盘点只读、六动作与
 * 大 JSON 管道。脚本只依赖 Node 内置模块，Windows / macOS 共用。
 *
 * 用法：node scripts/probe-production-kernel.mjs <kernel> [expected-version]
 */
import { spawn, spawnSync } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const kernel = process.argv[2];
const expectedVersion =
  process.argv[3] ??
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
if (kernel === undefined || kernel === '') {
  console.error('用法：node scripts/probe-production-kernel.mjs <内核> [期望版本]');
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'sm-production-kernel-'));
const home = join(base, 'home');
const local = join(base, 'local');
const workspace = join(base, 'workspace');
const sources = join(base, 'sources');
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local };

function expect(name, condition, detail = '') {
  if (condition !== true) throw new Error(`${name}${detail === '' ? '' : `：${detail}`}`);
  console.log(`✔ ${name}`);
}

function run(args) {
  const result = spawnSync(kernel, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `发布物内核失败：${args.join(' ')}（${String(result.status)}）\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function json(args) {
  return JSON.parse(run([...args, '--json']));
}

function scan() {
  return json(['scan', '--inventory', '--workspace', workspace]).data;
}

function treeHash(root) {
  if (!existsSync(root)) return 'missing';
  const digest = createHash('sha256');
  walk(root, '', digest);
  return digest.digest('hex');
}

function walk(absolute, relative, digest) {
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const child = join(absolute, entry.name);
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) digest.update(`link:${key}\n`);
    else if (entry.isDirectory()) {
      digest.update(`dir:${key}\n`);
      walk(child, key, digest);
    } else if (entry.isFile()) {
      digest.update(`file:${key}:${String(lstatSync(child).size)}\n`);
      digest.update(readFileSync(child));
      digest.update('\n');
    }
  }
}

function stateHash() {
  return `${treeHash(workspace)}|${treeHash(home)}`;
}

function writeSource(id) {
  const dir = join(sources, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} production fixture\n---\n\n# ${id}\n`,
  );
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} production fixture`,
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: .claude/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  return dir;
}

function writeHostSkill(id, description = `${id} fixture`) {
  const dir = join(home, '.claude', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`,
  );
  return dir;
}

function preview(args) {
  const before = stateHash();
  const data = json(['reconcile', ...args, '--workspace', workspace]).data;
  expect('预览零写入', stateHash() === before && data.applied === false);
  return data;
}

function apply(args) {
  return json(['reconcile', ...args, '--workspace', workspace, '--apply', '--yes']);
}

function checkAdopt() {
  const dir = writeHostSkill('legacy-skill');
  const plan = preview(['--action', 'adopt', '--path', dir]);
  expect('adopt 计划为 planned', plan.items[0]?.status === 'planned');
  const applied = apply(['--action', 'adopt', '--path', dir]);
  expect('adopt succeeded', applied.data.results[0]?.status === 'succeeded');
  expect('adopt 建立中心库', existsSync(join(workspace, 'skills', 'legacy-skill', 'SKILL.md')));
  expect(
    'adopt 后 managed',
    scan().copies.find((copy) => copy.path === dir)?.reconciliation.classification ===
      'managed_consistent',
  );
}

function checkTrack() {
  const id = 'track-prod';
  run(['install', writeSource(id), '--workspace', workspace, '--yes']);
  const hostDir = join(home, '.claude', 'skills', id);
  mkdirSync(hostDir, { recursive: true });
  cpSync(join(workspace, 'skills', id, 'SKILL.md'), join(hostDir, 'SKILL.md'));
  const indexBefore = readFileSync(join(workspace, 'skill_index.yaml'));
  const libraryBefore = treeHash(join(workspace, 'skills', id));
  const hostBefore = treeHash(hostDir);
  const trackCopy = scan().copies.find((copy) => copy.path === hostDir);
  expect(
    'track 前 inferred',
    trackCopy?.reconciliation.classification === 'inferred_consistent',
    JSON.stringify(trackCopy?.reconciliation),
  );
  const applied = apply(['--action', 'track', '--path', hostDir]);
  expect('track succeeded', applied.data.results[0]?.status === 'succeeded');
  expect(
    'track 只补账本',
    readFileSync(join(workspace, 'skill_index.yaml')).equals(indexBefore) &&
      treeHash(join(workspace, 'skills', id)) === libraryBefore &&
      treeHash(hostDir) === hostBefore,
  );
  return { id, hostDir };
}

function checkRepairAcceptForget(id, hostDir) {
  rmSync(hostDir, { recursive: true, force: true });
  expect(
    'repair 前 missing',
    scan().missing.some((item) => item.target_path === hostDir),
  );
  const repaired = apply(['--action', 'repair', '--path', hostDir]);
  expect('repair succeeded', repaired.data.results[0]?.status === 'succeeded');
  expect('repair 重建副本', existsSync(join(hostDir, 'SKILL.md')));

  writeFileSync(
    join(hostDir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: production accepted\n---\n\n# accepted\n`,
  );
  expect(
    'accept 前 drift',
    scan().copies.find((copy) => copy.path === hostDir)?.reconciliation.classification === 'drift',
  );
  const accepted = apply(['--action', 'accept', '--path', hostDir]);
  expect('accept succeeded', accepted.data.results[0]?.status === 'succeeded');
  expect(
    'accept 更新中心库',
    readFileSync(join(workspace, 'skills', id, 'SKILL.md'), 'utf8').includes('# accepted'),
  );

  rmSync(hostDir, { recursive: true, force: true });
  const forgotten = apply(['--action', 'forget', '--path', hostDir]);
  expect(
    'forget succeeded',
    forgotten.data.results.some((item) => item.status === 'succeeded'),
  );
  expect('forget 后不再 missing', !scan().missing.some((item) => item.target_path === hostDir));
}

function checkClean() {
  const dir = join(home, '.claude', 'skills', 'broken-prod');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: broken\ndescription: [unclosed\n---\n');
  expect(
    'clean 前 corrupt',
    scan().corrupt.some((copy) => copy.path === dir),
  );
  const cleaned = apply(['--action', 'clean', '--path', dir]);
  expect('clean succeeded', cleaned.data.results[0]?.status === 'succeeded');
  expect('clean 删除副本', !existsSync(dir));
}

function checkReadonly() {
  const before = stateHash();
  const indexBefore = readFileSync(join(workspace, 'skill_index.yaml'));
  scan();
  expect('scan --inventory 前后字节不变', stateHash() === before);
  expect(
    'scan --inventory 不写 last_scan_at',
    readFileSync(join(workspace, 'skill_index.yaml')).equals(indexBefore),
  );
}

function writeBulkSkills(count) {
  for (let index = 0; index < count; index += 1) {
    writeHostSkill(`bulk-${String(index).padStart(3, '0')}`);
  }
}

async function scanThroughPipe() {
  return await new Promise((resolve, reject) => {
    const child = spawn(kernel, ['scan', '--inventory', '--json', '--workspace', workspace], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reader = spawn(
      process.execPath,
      [
        '-e',
        'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const d=JSON.parse(s);console.log(JSON.stringify({copies:(d.data?.copies??[]).length,bytes:s.length}))}catch(e){console.error(String(e));process.exitCode=1}})',
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    child.stdout.pipe(reader.stdin);
    let error = '';
    let output = '';
    child.stderr.on('data', (chunk) => (error += String(chunk)));
    reader.stdout.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    reader.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`内核管道失败 ${String(code)}：${error}`));
    });
    reader.on('close', (code) => {
      if (code !== 0) return reject(new Error(`管道读取失败 ${String(code)}：${output}`));
      try {
        resolve(JSON.parse(output.trim()));
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

async function main() {
  mkdirSync(home, { recursive: true });
  mkdirSync(local, { recursive: true });
  const version = run(['--version']).trim();
  expect(`发布物内核版本为 ${expectedVersion}`, version === expectedVersion, version);
  run(['init', '--workspace', workspace]);

  checkAdopt();
  const tracked = checkTrack();
  checkRepairAcceptForget(tracked.id, tracked.hostDir);
  checkClean();
  checkReadonly();

  writeBulkSkills(300);
  const piped = await scanThroughPipe();
  expect('大 JSON 管道不截断', piped.bytes > 65536, JSON.stringify(piped));
  expect('管道解析出全部批量副本', piped.copies >= 300, JSON.stringify(piped));
  console.log(
    `PRODUCTION_KERNEL_RESULT=ok version=${version} actions=6 pipe_copies=${String(piped.copies)} bytes=${String(piped.bytes)}`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(base, { recursive: true, force: true });
  });
