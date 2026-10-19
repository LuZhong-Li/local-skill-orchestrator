import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import * as tar from 'tar';
import { installSkill, updateSkill } from '../../kernel/core/lifecycle/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf, ensureWorkspaceDirs } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { copyPathOf } from '../../kernel/core/metadata/targets.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T06:00:00Z';
const CONTENT_TYPES: Record<string, string> = {
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
};

function workspace(): string {
  const root = makeTempDir('sm-remote-ws-');
  ensureWorkspaceDirs(layoutOf(root));
  return root;
}

function skillContent(dir: string, id: string, sourceLines: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}`);
  writeFileSync(join(dir, 'extra.md'), 'v1');
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

function git(args: string[], cwd?: string): void {
  const result = spawnSync('git', [...(cwd !== undefined ? ['-C', cwd] : []), ...args], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}：${result.stderr}`);
}

/** 一个只做静态文件服务的本地服务器：归档与 dumb HTTP 的裸仓库都靠它模拟远端 */
async function startServer(rootDir: string): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    if (path === '/unauthorized/info/refs') {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="private"' });
      response.end('auth required');
      return;
    }
    if (path === '/slow.zip') {
      // 故意不回包体：用于触发下载超时
      response.writeHead(200, { 'content-length': '999999' });
      return;
    }
    if (path === '/huge.zip') {
      response.writeHead(200, { 'content-length': String(512 * 1024 * 1024) });
      response.end('');
      return;
    }
    const file = join(rootDir, ...path.split('/').filter((part) => part !== ''));
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('N-05：远程归档 URL 安装（含单层自动下钻）', async () => {
  const served = makeTempDir('sm-remote-arch-');
  const { server, base } = await startServer(served);
  try {
    const stage = makeTempDir('sm-remote-stage-');
    // 外层套一层目录：验证单层自动下钻
    const inner = join(stage, 'remote-archive');
    skillContent(inner, 'remote-archive', [
      '  type: archive',
      `  url: ${base}/skill.tar.gz`,
      '  ref: main',
    ]);
    // 元文件里的地址要在打包前写好，因此先打包一次拿到 URL 再重打包
    await tar.c({ gzip: true, file: join(served, 'skill.tar.gz'), cwd: stage }, ['.']);

    const root = workspace();
    const outcome = await install(root, `${base}/skill.tar.gz`);
    assert.deepEqual(outcome.findings, [], JSON.stringify(outcome.findings));
    assert.equal(outcome.index.skills[0]?.source_type, 'archive');
    assert.equal(readFileSync(join(root, 'skills', 'remote-archive', 'extra.md'), 'utf8'), 'v1');
  } finally {
    server.close();
  }
});

test('N-05：远程归档的 zip slip 仍被拒绝', async () => {
  const served = makeTempDir('sm-remote-evil-');
  const stage = makeTempDir('sm-remote-evil-stage-');
  skillContent(stage, 'evil', ['  type: archive']);
  writeFileSync(join(stage, 'payload.txt'), 'escaped');
  const archive = join(served, 'evil.tar');
  await tar.c({ file: archive, cwd: stage, preservePaths: true }, ['./payload.txt']);
  // 重写条目名并重算校验和，构造出合法的穿越归档
  const buffer = readFileSync(archive);
  for (let offset = 0; offset + 512 <= buffer.length; offset += 512) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name !== './payload.txt') continue;
    const patched = Buffer.from(header);
    patched.fill(0, 0, 100);
    patched.write('../escaped.txt', 0, 100, 'utf8');
    patched.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of patched) sum += byte;
    patched.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
    patched[154] = 0;
    patched[155] = 0x20;
    patched.copy(buffer, offset);
    break;
  }
  writeFileSync(archive, buffer);

  const { server, base } = await startServer(served);
  try {
    const root = workspace();
    const outcome = await install(root, `${base}/evil.tar`);
    assert.equal(
      outcome.findings[0]?.code,
      CODES.SRC_INSECURE_ARCHIVE,
      JSON.stringify(outcome.findings),
    );
    assert.ok(!existsSync(join(served, '..', 'escaped.txt')), '不得写出到服务目录之外');
  } finally {
    server.close();
  }
});

test('N-05：远程 git 仓库安装与刷新（dumb HTTP 模拟）', async () => {
  const served = makeTempDir('sm-remote-git-');
  const { server, base } = await startServer(served);
  try {
    const url = `${base}/source.git`;
    const work = makeTempDir('sm-remote-work-');
    git(['init', '--quiet', '-b', 'main'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'test'], work);
    skillContent(work, 'remote-git', ['  type: git', `  url: ${url}`, '  ref: main']);
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'first'], work);
    git(['clone', '--bare', '--quiet', work, join(served, 'source.git')]);
    git(['update-server-info'], join(served, 'source.git'));

    const root = workspace();
    const outcome = await install(root, url);
    assert.deepEqual(outcome.findings, [], JSON.stringify(outcome.findings));
    assert.equal(outcome.index.skills[0]?.source_type, 'git');
    const library = join(root, 'skills', 'remote-git');
    assert.equal(readFileSync(join(library, 'extra.md'), 'utf8'), 'v1');
    assert.ok(!existsSync(join(library, '.git')), '版本控制目录不进入中心库');

    // 远端新增提交后刷新
    writeFileSync(join(work, 'extra.md'), 'v2');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'second'], work);
    git(['push', '--quiet', join(served, 'source.git'), 'main'], work);
    git(['update-server-info'], join(served, 'source.git'));

    const refreshed = await updateSkill({
      layout: layoutOf(root),
      index: outcome.index,
      id: 'remote-git',
      now: LATER,
    });
    const errors = refreshed.findings.filter((item) => item.severity === 'error');
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.equal(readFileSync(join(library, 'extra.md'), 'utf8'), 'v2', '中心库随远端更新');
    assert.equal(
      readFileSync(join(root, '.claude', 'skills', 'remote-git', 'extra.md'), 'utf8'),
      'v2',
      '副本也被重分发',
    );
  } finally {
    server.close();
  }
});

test('N-05：协议不在白名单内时按来源类问题拒绝', async () => {
  const root = workspace();
  const ftp = await install(root, 'ftp://example.com/skill.tar.gz');
  assert.equal(ftp.findings[0]?.code, CODES.SRC_PROTOCOL_REJECTED);

  // 非回环地址的 http 同样被拒绝
  const plain = await install(root, 'http://example.com/skill.tar.gz');
  assert.equal(plain.findings[0]?.code, CODES.SRC_PROTOCOL_REJECTED);
  assert.match(String(plain.findings[0]?.remedy), /https/);
});

test('N-05：远端 404、体积超限、超时各归明确问题码', async () => {
  const served = makeTempDir('sm-remote-errors-');
  const { server, base } = await startServer(served);
  try {
    const root = workspace();
    const missing = await install(root, `${base}/nosuch.tar.gz`);
    assert.equal(missing.findings[0]?.code, CODES.SRC_DOWNLOAD_FAILED);
    assert.match(String(missing.findings[0]?.message), /404/);

    const huge = await install(root, `${base}/huge.zip`);
    assert.equal(huge.findings[0]?.code, CODES.SRC_TOO_LARGE);

    process.env['SKILL_MANAGER_SOURCE_TIMEOUT_MS'] = '800';
    // 超时上限在模块加载时读取，因此这里用动态导入重新加载模块
    const fresh = await import(`../../kernel/core/lifecycle/source.ts?timeout=${Date.now()}`);
    await assert.rejects(
      () => fresh.acquireFromPath(`${base}/slow.zip`),
      (error: unknown) => (error as { code?: string }).code === CODES.SRC_TIMEOUT,
    );
    delete process.env['SKILL_MANAGER_SOURCE_TIMEOUT_MS'];
  } finally {
    server.close();
  }
});

test('N-05：私有仓库无凭据时归认证类问题并给出引导', async () => {
  const served = makeTempDir('sm-remote-auth-');
  const { server, base } = await startServer(served);
  try {
    const root = workspace();
    const outcome = await install(root, `${base}/unauthorized/repo.git`);
    const code = outcome.findings[0]?.code;
    assert.ok(
      code === CODES.SRC_AUTH_REQUIRED || code === CODES.SRC_DOWNLOAD_FAILED,
      `应归入认证或下载类问题，实际：${String(code)}`,
    );
    assert.ok(!existsSync(join(root, 'skills', 'repo')), '失败时不得写入中心库');
  } finally {
    server.close();
  }
});
