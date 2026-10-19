import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeTempDir } from '../helpers/temp.ts';

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

function asData(result: Record<string, unknown>): {
  summary: {
    main: { total_copies: number; unique_skills: number };
    roles: { user: { total_copies: number; unique_skills: number } };
    classification_groups: { untracked: number };
  };
} {
  return result['data'] as never;
}

test('M4c-4 e2e：人类摘要突出 user 主计数，JSON 可下钻', async (t) => {
  const root = makeTempDir('sm-aggregate-e2e-');
  const hostRoot = makeHostRoot('sm-aggregate-host-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
  writeHostSkill(hostRoot, 'loose-skill');

  const human = await capture(['scan', '--inventory', '--workspace', root]);
  assert.equal(human.code, 0);
  assert.match(human.out, /全机盘点：1 个安装副本 \/ 1 个不同技能/);
  assert.match(human.out, /用户 user/);
  assert.match(human.out, /分类：managed/);
  assert.match(human.out, /宿主：/);

  const verbose = await capture(['scan', '--inventory', '--workspace', root, '--verbose']);
  assert.match(verbose.out, /副本明细：/);
  assert.match(verbose.out, /untracked/);

  const json = await capture(['scan', '--inventory', '--workspace', root, '--json']);
  assert.equal(json.code, 0);
  const data = asData(JSON.parse(json.out) as Record<string, unknown>);
  assert.deepEqual(data.summary.main, { total_copies: 1, unique_skills: 1 });
  assert.equal(data.summary.roles.user.total_copies, 1);
  assert.equal(data.summary.roles.user.unique_skills, 1);
  assert.equal(data.summary.classification_groups.untracked, 1);
});
