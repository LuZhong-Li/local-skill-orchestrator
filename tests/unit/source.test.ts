import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { installSkill, updateSkill } from '../../kernel/core/lifecycle/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf, ensureWorkspaceDirs } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { copyPathOf } from '../../kernel/core/metadata/targets.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T05:00:00Z';

function workspace(): string {
  const root = makeTempDir('sm-source-ws-');
  ensureWorkspaceDirs(layoutOf(root));
  return root;
}

/** 造一份技能内容；source 块按传入的声明生成 */
function skillContent(
  dir: string,
  id: string,
  source: { type: string; location?: string; ref?: string },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}`);
  writeFileSync(join(dir, 'extra.md'), 'v1');
  const sourceLines = [`  type: ${source.type}`];
  if (source.location !== undefined) sourceLines.push(`  location: ${source.location}`);
  if (source.ref !== undefined) sourceLines.push(`  ref: ${source.ref}`);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      ...sourceLines,
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: ${copyPathOf('claude', id)}`,
      '    mode: copy',
      '    enabled: true',
      '',
    ].join('\n'),
  );
}

function install(root: string, source: string) {
  return installSkill({
    layout: layoutOf(root),
    index: createInitialIndex(NOW),
    sourcePath: source,
    now: NOW,
  });
}

/** 造一个本地 git 仓库；返回仓库路径 */
function gitRepo(id: string, content: { location: string }): string {
  const repo = makeTempDir('sm-source-repo-');
  skillContent(repo, id, { type: 'git', location: content.location });
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false });
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  return repo;
}

/**
 * 把 tar 里某个条目名替换掉，并重算头部校验和。
 * 直接改名字而不重算校验和会让归档变成损坏文件，测出来的就不再是路径穿越防护。
 */
function renameTarEntry(archive: string, from: string, to: string): void {
  const buffer = readFileSync(archive);
  for (let offset = 0; offset + 512 <= buffer.length; offset += 512) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) continue;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name !== from) continue;
    const patched = Buffer.from(header);
    patched.fill(0, 0, 100);
    patched.write(to, 0, 100, 'utf8');
    // 校验和字段先置为空格再求和，最后写成六位八进制
    patched.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of patched) sum += byte;
    patched.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
    patched[154] = 0;
    patched[155] = 0x20;
    patched.copy(buffer, offset);
    writeFileSync(archive, buffer);
    return;
  }
  throw new Error(`归档中未找到条目：${from}`);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * 极简 ZIP 写入器：条目以「存储」方式写入（不压缩），只为实现测试夹具——
 * 归档解压路径需要一个能造出任意条目名的 zip，而项目里没有任何 zip 写入能力。
 */
function writeZip(archive: string, entries: Array<{ name: string; data: Buffer }>): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  writeFileSync(archive, Buffer.concat([localPart, centralPart, end]));
}

/** 断言只报警告不报错误：重新获取内容后出现指纹漂移警告是预期的 */
function assertNoErrors(outcome: { findings: Array<{ severity: string }> }, hint: string): void {
  const errors = outcome.findings.filter((item) => item.severity === 'error');
  assert.deepEqual(errors, [], `${hint}：${JSON.stringify(errors)}`);
}

test('N-05：从本地 git 仓库路径安装，读取的是已提交内容', async () => {
  const root = workspace();
  const repo = gitRepo('from-git', { location: '' });
  // 把仓库自身的路径作为来源位置写回元文件并提交
  skillContent(repo, 'from-git', { type: 'git', location: repo });
  spawnSync('git', ['-C', repo, 'add', '.'], { shell: false });
  spawnSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'set location'], { shell: false });

  const outcome = await install(root, repo);
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index.skills[0]?.source_type, 'git');
  const library = join(root, 'skills', 'from-git');
  assert.ok(existsSync(join(library, 'SKILL.md')), '内容已写入中心库');
  assert.ok(!existsSync(join(library, '.git')), '版本控制目录不进入中心库');
  assert.equal(readFileSync(join(library, 'extra.md'), 'utf8'), 'v1');
});

test('N-05：从本地 git 仓库刷新，仓库提交变更后内容随之更新', async () => {
  const root = workspace();
  const repo = gitRepo('repo-refresh', { location: '' });
  skillContent(repo, 'repo-refresh', { type: 'git', location: repo });
  spawnSync('git', ['-C', repo, 'add', '.'], { shell: false });
  spawnSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'set location'], { shell: false });
  const installed = await install(root, repo);
  assert.deepEqual(installed.findings, []);
  const library = join(root, 'skills', 'repo-refresh');
  assert.equal(readFileSync(join(library, 'extra.md'), 'utf8'), 'v1');

  // 仓库里改内容并提交，再刷新
  writeFileSync(join(repo, 'extra.md'), 'v2');
  spawnSync('git', ['-C', repo, 'add', '.'], { shell: false });
  spawnSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'update content'], { shell: false });
  const refreshed = await updateSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'repo-refresh',
    now: LATER,
  });
  // 内容被替换后，指纹漂移警告是预期的；不得出现错误级问题
  assertNoErrors(refreshed, '仓库刷新应成功');
  assert.equal(readFileSync(join(library, 'extra.md'), 'utf8'), 'v2', '中心库内容随仓库更新');
  assert.equal(
    readFileSync(join(root, '.claude', 'skills', 'repo-refresh', 'SKILL.md'), 'utf8'),
    '# repo-refresh',
    '副本也被重分发',
  );
});

test('N-05：从本地归档安装并刷新（tar.gz 与 zip 各一条路径）', async () => {
  for (const kind of ['tar.gz', 'zip'] as const) {
    const root = workspace();
    const stage = makeTempDir('sm-source-stage-');
    const id = `archived-${kind.replace('.', '')}`;
    const archive = join(
      makeTempDir('sm-source-arch-'),
      kind === 'zip' ? 'skill.zip' : 'skill.tar.gz',
    );
    // 先写出内容，把来源位置指回归档本身，再打包
    skillContent(stage, id, { type: 'archive', location: archive });
    const pack = async (): Promise<void> => {
      if (kind === 'zip') {
        writeZip(archive, [
          { name: 'SKILL.md', data: readFileSync(join(stage, 'SKILL.md')) },
          { name: 'extra.md', data: readFileSync(join(stage, 'extra.md')) },
          { name: 'skill_meta.yaml', data: readFileSync(join(stage, 'skill_meta.yaml')) },
        ]);
        return;
      }
      await tar.c({ gzip: true, file: archive, cwd: stage }, ['.']);
    };
    await pack();

    const outcome = await install(root, archive);
    assertNoErrors(outcome, `${kind} 安装应成功`);
    assert.equal(outcome.index.skills[0]?.source_type, 'archive');
    assert.equal(readFileSync(join(root, 'skills', id, 'extra.md'), 'utf8'), 'v1');

    // 归档内容变化后刷新
    writeFileSync(join(stage, 'extra.md'), 'v2');
    await pack();
    const refreshed = await updateSkill({
      layout: layoutOf(root),
      index: outcome.index,
      id,
      now: LATER,
    });
    assertNoErrors(refreshed, `${kind} 刷新应成功`);
    assert.equal(readFileSync(join(root, 'skills', id, 'extra.md'), 'utf8'), 'v2');
  }
});

test('N-05 安全：含上级目录跳转的归档被拒绝，且不在工作区外产生文件', async () => {
  const root = workspace();
  const stage = makeTempDir('sm-source-evil-');
  skillContent(stage, 'evil', { type: 'archive', location: '' });
  // 手工构造含 ../ 条目的 tar：把 payload 写成 ../escaped.txt
  const payload = join(stage, 'payload.txt');
  writeFileSync(payload, 'escaped');
  const evil = join(makeTempDir('sm-source-evilarch-'), 'evil.tar');
  await tar.c({ file: evil, cwd: stage, preservePaths: true }, ['./payload.txt']);
  const escapedPath = join(stage, '..', 'escaped.txt');
  rmSync(escapedPath, { force: true });

  // 重写 tar 头里的路径让它指向上一级目录，并重算校验和保证归档本身是合法的
  renameTarEntry(evil, './payload.txt', '../escaped.txt');
  rmSync(payload, { force: true });

  const outcome = await install(root, evil);
  assert.equal(outcome.findings[0]?.code, CODES.SRC_INSECURE_ARCHIVE);
  assert.equal(outcome.data['rejected'], 'source_unavailable');
  assert.ok(!existsSync(escapedPath), '不得在工作区外写出文件');
  assert.ok(!existsSync(join(root, 'skills', 'evil')), '拒绝时不得写入中心库');
});

test('N-05 安全：zip 归档含绝对路径条目时被拒绝', async () => {
  const root = workspace();
  const stage = makeTempDir('sm-source-abs-');
  skillContent(stage, 'abs', { type: 'archive', location: '' });
  const archive = join(makeTempDir('sm-source-absarch-'), 'abs.zip');
  writeZip(archive, [
    { name: 'skill_meta.yaml', data: readFileSync(join(stage, 'skill_meta.yaml')) },
    { name: 'C:/escaped.md', data: Buffer.from('escaped') },
  ]);

  const outcome = await install(root, archive);
  assert.equal(
    outcome.findings[0]?.code,
    CODES.SRC_INSECURE_ARCHIVE,
    JSON.stringify(outcome.findings),
  );
  assert.ok(!existsSync('C:/escaped.md'), '绝对路径条目不得被解出');
});

test('N-05 安全：git 不可用时给出外部命令缺失错误与安装引导', async () => {
  const root = workspace();
  const repo = gitRepo('needs-git', { location: '' });
  skillContent(repo, 'needs-git', { type: 'git', location: repo });
  const originalPath = process.env['PATH'];
  const emptyPath = makeTempDir('sm-source-nopath-');
  process.env['PATH'] = emptyPath;
  try {
    const outcome = await install(root, repo);
    assert.equal(outcome.findings[0]?.code, CODES.SRC_COMMAND_UNAVAILABLE);
    assert.match(String(outcome.findings[0]?.message), /git/);
    assert.match(String(outcome.findings[0]?.remedy), /安装 git/);
  } finally {
    process.env['PATH'] = originalPath;
  }
});

test('N-05：归档内容根缺少元文件时给出获取失败错误', async () => {
  const root = workspace();
  const stage = makeTempDir('sm-source-nometa-');
  mkdirSync(join(stage, 'inner'), { recursive: true });
  writeFileSync(join(stage, 'inner', 'SKILL.md'), '# nested');
  const archive = join(makeTempDir('sm-source-nometaarch-'), 'nested.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: stage }, ['.']);
  const outcome = await install(root, archive);
  assert.equal(outcome.findings[0]?.code, CODES.SRC_FETCH_FAILED);
  assert.match(String(outcome.findings[0]?.message), /skill_meta\.yaml/);
});

test('N-05 安全：来源标识非法时按参数类问题拒绝', async () => {
  const root = workspace();
  const repo = gitRepo('bad-ref', { location: '' });
  skillContent(repo, 'bad-ref', { type: 'git', location: repo, ref: '--upload-pack=evil' });
  const outcome = await install(root, repo);
  assert.equal(outcome.findings[0]?.code, CODES.INPUT_INVALID_ARG);
  assert.match(String(outcome.findings[0]?.message), /引用标识非法/);
});
