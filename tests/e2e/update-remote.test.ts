/**
 * M4a T0：`update` 的远端来源重新获取（独立进程 + 回环 `git daemon`）。
 *
 * 背景（2026-10-17 文本纠偏）：实现早已支持远端 refetch（`readDeclaredSource` 把 `url` 折进
 * `location`，`acquireSource` 按 `looksRemote()` 走克隆/下载），但契约写着「远端拉取属二期」、
 * 也没有任何测试覆盖。本文件把这条路径变成**可失败的事实**：内容与指纹真的更新、失败不写索引。
 *
 * 传输选择：协议白名单只接受 `https` / `git`（`http` 仅限回环），`file://` 被拒绝，
 * 因此用回环 `git daemon`（`git://127.0.0.1:<port>/sample.git`）——Windows / Linux / macOS 均可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(
  new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  'kernel',
  'entry',
  'cli.ts',
);

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

/** 取一个空闲端口（绑定 0 后立即释放；git daemon 需要显式端口） */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0);
  return port;
}

/** 起回环 git daemon，等端口可连接后返回句柄 */
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
    // POSIX 上用独立进程组，便于连同子进程一起收掉；Windows 用 taskkill /T
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

/** 收掉 git daemon：Windows 上 `git daemon` 会再拉起 `git-daemon` 子进程，必须按进程树杀 */
function stopDaemon(child: { pid?: number } | null) {
  if (child?.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 进程已退出时忽略
  }
}

/** 读库内内容：Windows 的 git autocrlf 可能把检出内容写成 CRLF，比较前统一换行符 */
function libraryText(workspace: string): string {
  return readFileSync(join(workspace, 'skills', 'remote-skill', 'SKILL.md'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

function metaOf(url: string, ref: string) {
  return [
    'id: remote-skill',
    'name: remote-skill',
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

test('远端来源 update：重新获取并更新内容与指纹；--check 不落盘；失败不写索引', async () => {
  const root = mkdtempSync(join(tmpdir(), 'update-remote-'));
  const served = join(root, 'served');
  const work = join(root, 'work');
  const workspace = join(root, 'ws');
  mkdirSync(served, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(workspace, 'skills', 'remote-skill'), { recursive: true });
  let daemon: ReturnType<typeof spawn> | null = null;

  try {
    // 一、源仓库：v1 内容 + 裸仓库，供 daemon 导出（端口先定，元文件里写真实 URL）
    const port = await freePort();
    const url = `git://127.0.0.1:${port}/sample.git`;
    git(work, ['init', '-q', '-b', 'main']);
    writeFileSync(join(work, 'SKILL.md'), '# v1\n');
    writeFileSync(join(work, 'skill_meta.yaml'), metaOf(url, 'main'));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'v1']);
    git(root, ['clone', '-q', '--bare', work, join(served, 'sample.git')]);

    daemon = await startDaemon(served, port);

    // 二、工作区：旧内容 + 声明远端来源 → scan 登记
    writeFileSync(join(workspace, 'skills', 'remote-skill', 'SKILL.md'), '# v1\n');
    writeFileSync(
      join(workspace, 'skills', 'remote-skill', 'skill_meta.yaml'),
      metaOf(url, 'main'),
    );
    cli(['init', '--workspace', workspace]);
    const scan = cli(['scan', '--workspace', workspace]);
    assert.equal(scan.code, 0, `scan 应成功：${scan.stdout}${scan.stderr}`);
    const before = readFileSync(join(workspace, 'skill_index.yaml'), 'utf8');
    const checksumBefore = /checksum: (sha256:[0-9a-f]+)/.exec(before)?.[1];
    assert.ok(checksumBefore !== undefined);

    // 三、推进远端 main（v2）
    writeFileSync(join(work, 'SKILL.md'), '# v2-changed\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'v2']);
    git(work, ['push', '-q', join(served, 'sample.git'), 'main']);

    // 四、--check 只读：不重新获取、不写盘
    const check = cli(['update', 'remote-skill', '--workspace', workspace, '--check']);
    assert.equal(check.code, 0, `--check 应成功：${check.stdout}${check.stderr}`);
    assert.equal(libraryText(workspace), '# v1\n', '--check 不得替换原件');
    assert.equal(
      readFileSync(join(workspace, 'skill_index.yaml'), 'utf8'),
      before,
      '--check 不得写索引',
    );

    // 五、真正 update：内容与指纹都更新（不是只看时间戳）
    const updated = cli(['update', 'remote-skill', '--workspace', workspace, '--yes']);
    assert.equal(updated.code, 0, `update 应成功：${updated.stdout}${updated.stderr}`);
    assert.equal(libraryText(workspace), '# v2-changed\n', '原件内容必须来自远端的新提交');
    const after = readFileSync(join(workspace, 'skill_index.yaml'), 'utf8');
    const checksumAfter = /checksum: (sha256:[0-9a-f]+)/.exec(after)?.[1];
    assert.ok(checksumAfter !== undefined && checksumAfter !== checksumBefore, '指纹必须更新');
    assert.match(after, /source_type: git/, '来源类型保持');

    // 六、失败矩阵：远端不可达 → 退出码 4、索引字节不变。
    // 用一个「确定没人监听」的端口构造不可达（不依赖 daemon 进程是否已退出）
    const deadPort = await freePort();
    writeFileSync(
      join(workspace, 'skills', 'remote-skill', 'skill_meta.yaml'),
      metaOf(`git://127.0.0.1:${deadPort}/sample.git`, 'main'),
    );
    const unreachable = cli(['update', 'remote-skill', '--workspace', workspace, '--yes']);
    assert.equal(unreachable.code, 4, `远端不可达应返回来源类退出码 4：${unreachable.stdout}`);
    assert.match(unreachable.stdout, /E-SRC-/, '失败必须带来源类问题码');
    assert.equal(
      readFileSync(join(workspace, 'skill_index.yaml'), 'utf8'),
      after,
      '失败不得写索引',
    );
    assert.equal(libraryText(workspace), '# v2-changed\n', '失败不得改动原件');
  } finally {
    stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

test('契约：update 的远端表述已与实现对齐（无「二期/占位」残留）', () => {
  const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const contract = readFileSync(join(root, 'docs', 'specification', 'cli-contract.md'), 'utf8');
  const source = readFileSync(join(root, 'kernel', 'core', 'lifecycle', 'source.ts'), 'utf8');

  // 只检查 4.11 正文与源码注释：变更记录里引用旧措辞是历史，不算残留
  const sectionStart = contract.indexOf('### 4.11 `update`');
  assert.notEqual(sectionStart, -1);
  const sectionEnd = contract.indexOf('### 4.12', sectionStart);
  const section = contract.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  for (const stale of ['远端拉取属二期', '本批次不接受远程来源']) {
    assert.equal(section.includes(stale), false, `4.11 正文不得保留占位表述：${stale}`);
  }
  for (const stale of ['本批次不接受远程来源', '远程地址会在 acquireSource 里被拒绝']) {
    assert.equal(source.includes(stale), false, `源码注释不得保留占位表述：${stale}`);
  }
  assert.match(
    contract,
    /远端来源（`url` \+ `ref`）与本地来源走\*\*同一套重新获取路径\*\*/,
    '契约须写明远端来源走同一路径',
  );
  assert.match(
    section,
    /语法、参数、行为、输出载荷与退出码\*\*保持不变\*\*/,
    '契约须显式保留本地来源不变声明',
  );
});
