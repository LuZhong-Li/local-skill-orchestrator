import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_CHECK_BACKUP_NOTICE,
  checkUpdates,
  classifyInspectItem,
  compareFormalVersions,
  normalizeFormalVersion,
  parseLsRemote,
  runGitLsRemote,
  type CommandResult,
  type ProbeOutcome,
} from '../../gui/main/update-check/index.ts';

const NOW = '2026-10-17T08:00:00Z';

function inspectData(
  source: unknown,
  options: { version?: string; checksum?: string } = {},
): Record<string, unknown> {
  const version = options.version;
  const checksum = options.checksum ?? 'sha256:abc';
  return {
    source,
    meta: version === undefined ? {} : { version },
    record: { version, checksum },
    checksum: { recorded: checksum, recomputed: checksum, match: true },
    validation: { status: 'ok', errors: [] },
  };
}

function tags(text: string) {
  return parseLsRemote(text);
}

function success(text: string): ProbeOutcome {
  return { ok: true, tags: tags(text) };
}

test('T1 ls-remote：解析重复标签、annotated peeled 引用与怪输出', () => {
  const parsed = tags(
    [
      '1111111111111111111111111111111111111111\trefs/tags/v1.2.0',
      '2222222222222222222222222222222222222222\trefs/tags/v1.2.0^{}',
      '3333333333333333333333333333333333333333\trefs/tags/release/1.4.0',
      'not-a-sha\trefs/tags/broken',
      '4444444444444444444444444444444444444444\trefs/heads/main',
      '',
    ].join('\r\n'),
  );

  assert.deepEqual(
    parsed.map((item) => [item.tag, item.commit, item.peeled]),
    [
      ['v1.2.0', '2222222222222222222222222222222222222222', true],
      ['release/1.4.0', '3333333333333333333333333333333333333333', false],
    ],
    '同一标签的 annotated tag 与 peeled 引用只保留 peeled 目标 commit',
  );
});

test('T1 semver：仅接受正式版、v 前缀归一化，构建元数据不参与优先级', () => {
  assert.equal(normalizeFormalVersion('v1.2.0')?.version, '1.2.0');
  assert.equal(normalizeFormalVersion('1.2.0')?.version, '1.2.0');
  assert.equal(normalizeFormalVersion('1.2.0+build.7')?.version, '1.2.0');
  assert.equal(normalizeFormalVersion('v1.3.0-rc.1'), null);
  assert.equal(normalizeFormalVersion('latest'), null);
  assert.equal(normalizeFormalVersion('feature-x'), null);
  assert.equal(normalizeFormalVersion('01.2.0'), null);

  assert.ok(compareFormalVersions('1.2.0', '1.10.0') < 0);
  assert.equal(compareFormalVersions('v2.0.0', '2.0.0+build.2'), 0);
  assert.ok(compareFormalVersions('2.0.1', '2.0.0') > 0);
});

test('T1 四态：远端最高正式版高于基线 → update-available（目标 tag/commit/来源齐全）', () => {
  const item = classifyInspectItem(
    'review',
    inspectData(
      { type: 'git', url: 'https://example.com/review.git', ref: 'v1.2.0' },
      {
        version: '1.2.0',
        checksum: 'sha256:source-record',
      },
    ),
    success(
      [
        '1111111111111111111111111111111111111111\trefs/tags/v1.2.0',
        '2222222222222222222222222222222222222222\trefs/tags/v1.3.0',
        '3333333333333333333333333333333333333333\trefs/tags/v1.4.0-rc.1',
        '4444444444444444444444444444444444444444\trefs/tags/latest',
      ].join('\n'),
    ),
    NOW,
  );

  assert.equal(item.state, 'update-available');
  assert.deepEqual(item.available, {
    ref: 'v1.3.0',
    commit: '2222222222222222222222222222222222222222',
  });
  assert.equal(item.baseline_version, '1.2.0');
  assert.equal(item.checksum, 'sha256:source-record');
  assert.deepEqual(item.provenance, {
    url: 'https://example.com/review.git',
    ref: 'v1.2.0',
    checked_at: NOW,
  });
  assert.equal(item.backup_notice, UPDATE_CHECK_BACKUP_NOTICE);
});

test('T1 四态：相同/更低/仅预发布 → up-to-date', () => {
  for (const remote of [
    '1111111111111111111111111111111111111111\trefs/tags/v1.2.0\n',
    [
      '1111111111111111111111111111111111111111\trefs/tags/v1.2.0',
      '2222222222222222222222222222222222222222\trefs/tags/v1.1.9',
    ].join('\n'),
    [
      '1111111111111111111111111111111111111111\trefs/tags/v1.2.0',
      '2222222222222222222222222222222222222222\trefs/tags/v1.3.0-beta.1',
    ].join('\n'),
  ]) {
    const item = classifyInspectItem(
      'review',
      inspectData({ type: 'git', url: 'https://example.com/review.git', ref: 'v1.2.0' }),
      success(remote),
      NOW,
    );
    assert.equal(item.state, 'up-to-date', remote);
  }
});

test('T1 四态：本地/归档/未知/分支/提交五类均 not-checkable 且有具体原因', () => {
  const cases: Array<[unknown, string, RegExp]> = [
    [{ type: 'git', location: 'D:/repos/review', ref: 'v1.2.0' }, 'local-source', /本地来源/],
    [{ type: 'archive', url: 'https://example.com/review.tar.gz' }, 'archive-source', /归档/],
    [{ type: 'unknown' }, 'unknown-source', /来源未知/],
    [
      { type: 'git', url: 'https://example.com/review.git', ref: 'main' },
      'ref-not-formal-tag',
      /分支|提交|正式版标签/,
    ],
    [
      { type: 'git', url: 'https://example.com/review.git', ref: '0123456' },
      'ref-not-formal-tag',
      /分支|提交|正式版标签/,
    ],
  ];

  for (const [source, reason, message] of cases) {
    const item = classifyInspectItem('review', inspectData(source), success(''), NOW);
    assert.equal(item.state, 'not-checkable');
    assert.equal(item.reason, reason);
    assert.match(item.summary, message);
  }
});

test('T1 四态：401/403、超时、离线映射为 failed 且保留问题码与说明', () => {
  const base = inspectData({
    type: 'git',
    url: 'https://example.com/private.git',
    ref: 'v1.2.0',
  });
  const outcomes: ProbeOutcome[] = [
    {
      ok: false,
      code: 'E-SRC-010',
      message: '远端返回 403：需要认证或已限流',
      remedy: '稍后重试，或改用公开来源',
    },
    {
      ok: false,
      code: 'E-SRC-006',
      message: 'git ls-remote 超时（上限 60 秒）',
      remedy: '检查网络连通性',
    },
    {
      ok: false,
      code: 'E-SRC-007',
      message: '无法解析远端主机（离线）',
      remedy: '恢复网络后重试',
    },
  ];

  for (const outcome of outcomes) {
    const item = classifyInspectItem('review', base, outcome, NOW);
    assert.equal(item.state, 'failed');
    assert.equal(item.code, outcome.code);
    assert.match(item.summary, new RegExp(outcome.message));
  }
});

test('T1 基线：来源 ref 标签在远端消失 → not-checkable，不伪造网络失败', () => {
  const item = classifyInspectItem(
    'review',
    inspectData({ type: 'git', url: 'https://example.com/review.git', ref: 'v1.2.0' }),
    success('1111111111111111111111111111111111111111\trefs/tags/v1.3.0\n'),
    NOW,
  );
  assert.equal(item.state, 'not-checkable');
  assert.equal(item.reason, 'baseline-tag-missing');
  assert.match(item.summary, /基线标签 v1\.2\.0.*不存在|force-push/);
});

test('T1 probe：只执行 git ls-remote；401/403→E-SRC-010，超时→E-SRC-006，缺少 git→E-SRC-005', async () => {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const run = async (
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<CommandResult> => {
    calls.push({ command, args, env });
    return {
      code: 0,
      stdout: '1111111111111111111111111111111111111111\trefs/tags/v1.3.0\n',
      stderr: '',
      timedOut: false,
    };
  };
  const ok = await runGitLsRemote('https://example.com/review.git', run);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0]?.args, [
    'ls-remote',
    '--tags',
    '--refs',
    'https://example.com/review.git',
  ]);
  assert.equal(calls[0]?.env['GIT_TERMINAL_PROMPT'], '0');
  assert.equal(
    calls[0]?.args.some((arg) => /clone|fetch|push/.test(arg)),
    false,
    '检查只能使用只读 ls-remote',
  );

  const auth = await runGitLsRemote('https://example.com/private.git', async () => ({
    code: 128,
    stdout: '',
    stderr: 'fatal: unable to access ... The requested URL returned error: 403',
    timedOut: false,
  }));
  assert.equal(auth.ok, false);
  assert.equal(auth.ok ? '' : auth.code, 'E-SRC-010');

  const timeout = await runGitLsRemote('https://example.com/slow.git', async () => ({
    code: null,
    stdout: '',
    stderr: '',
    timedOut: true,
  }));
  assert.equal(timeout.ok ? '' : timeout.code, 'E-SRC-006');

  const missing = await runGitLsRemote('https://example.com/review.git', async () => ({
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    error: 'spawn git ENOENT',
    errorCode: 'ENOENT',
  }));
  assert.equal(missing.ok ? '' : missing.code, 'E-SRC-005');
});

test('T1 probe：来源地址内嵌凭据时拒绝发起请求', async () => {
  let called = false;
  const result = await runGitLsRemote('https://user:secret@example.com/review.git', async () => {
    called = true;
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'E-SRC-010');
  assert.equal(called, false, '含凭据的地址不得进入子进程参数');
});

test('T1 probe：协议白名单与内核一致，file 与非回环 http 在启动子进程前拒绝', async () => {
  const calls: string[] = [];
  const run = async (_command: string, args: string[]): Promise<CommandResult> => {
    calls.push(args.at(-1) ?? '');
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };

  for (const url of ['file:///tmp/repo.git', 'http://example.com/repo.git']) {
    const result = await runGitLsRemote(url, run);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'E-SRC-009');
  }
  assert.deepEqual(calls, [], '被拒协议不得进入子进程');

  for (const url of [
    'https://example.com/repo.git',
    'git://example.com/repo.git',
    'http://127.0.0.1:9418/repo.git',
  ]) {
    const result = await runGitLsRemote(url, run);
    assert.equal(result.ok, true, url);
  }
});

test('T1 聚合：顺序检查、单条失败不阻断，结果逐项保留', async () => {
  const inspected: string[] = [];
  const probed: string[] = [];
  const report = await checkUpdates({
    ids: ['a', 'b', 'c'],
    now: () => NOW,
    inspect: async (id) => {
      inspected.push(id);
      return {
        ok: true,
        command: 'inspect',
        findings: [],
        changes: [],
        exit_code: 0,
        data: inspectData(
          {
            type: 'git',
            url: `https://example.com/${id}.git`,
            ref: 'v1.0.0',
          },
          { version: '1.0.0' },
        ),
      };
    },
    probe: async (url) => {
      probed.push(url);
      if (url.includes('/b.git')) {
        return {
          ok: false,
          code: 'E-SRC-007',
          message: '远端不可达',
          remedy: '检查网络',
        };
      }
      return success(
        url.includes('/a.git')
          ? [
              '1111111111111111111111111111111111111111\trefs/tags/v1.0.0',
              '2222222222222222222222222222222222222222\trefs/tags/v1.1.0',
            ].join('\n')
          : '1111111111111111111111111111111111111111\trefs/tags/v1.0.0\n',
      );
    },
  });

  assert.deepEqual(inspected, ['a', 'b', 'c']);
  assert.deepEqual(probed, [
    'https://example.com/a.git',
    'https://example.com/b.git',
    'https://example.com/c.git',
  ]);
  assert.deepEqual(
    report.data.items.map((item) => item.state),
    ['update-available', 'failed', 'up-to-date'],
  );
  assert.equal(report.command, 'update-check');
  assert.equal(report.ok, false, '存在失败条目时结果封装 ok 为 false');
  assert.equal(report.exit_code, 4, '来源类失败按既有派生规则落 4');
  assert.equal(report.changes.length, 0);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.code, 'E-SRC-007');
  assert.equal(report.findings[0]?.target, 'b');
});
