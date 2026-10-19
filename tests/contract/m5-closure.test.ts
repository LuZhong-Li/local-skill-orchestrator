import { makeTempDir } from '../helpers/temp.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { resolveHostRoot, rootConfigKey } from '../../kernel/core/adapters/roots.ts';
import { hostIds } from '../../kernel/core/hosts/index.ts';

function makeSource(id: string): string {
  const dir = makeTempDir(`sm-closure-src-${id}-`);
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\n---\n\n# ${id}\n\n正文。\n`);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: 收口审计用技能`,
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

async function call(argv: string[]): Promise<number> {
  return await run(argv);
}

async function callJson(
  argv: string[],
): Promise<{ code: number; result: Record<string, unknown> }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code = -1;
  try {
    code = await run([...argv, '--json']);
  } finally {
    process.stdout.write = original;
  }
  const text = chunks.join('').trim();
  return { code, result: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

test('收口审计：多宿主分发按调用次数独立完成，单次调用只取一个宿主取值', async () => {
  const ws = makeTempDir('sm-closure-ws-');
  const claudeRoot = makeHostRoot('sm-closure-host-');
  const cursorRoot = makeHostRoot('sm-closure-host-');
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', claudeRoot, '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.cursor.root', cursorRoot, '--workspace', ws]), 0);

  // 多次调用：各自分发到对应宿主真实根，互不影响
  const first = makeSource('multi-host-skill');
  assert.equal(await call(['install', first, '--workspace', ws, '--host', 'claude', '--yes']), 0);
  const second = makeSource('multi-host-skill-two');
  assert.equal(await call(['install', second, '--workspace', ws, '--host', 'cursor', '--yes']), 0);
  assert.equal(existsSync(join(claudeRoot, 'multi-host-skill', 'SKILL.md')), true);
  assert.equal(existsSync(join(cursorRoot, 'multi-host-skill-two', 'SKILL.md')), true);
  assert.equal(existsSync(join(cursorRoot, 'multi-host-skill')), false, '分发按调用隔离');

  // 同一命令内重复给出 --host：按参数类错误拒绝，不静默取最后值（解析器硬化批次）
  const third = makeSource('repeated-host-skill');
  const repeated = await call([
    'install',
    third,
    '--workspace',
    ws,
    '--host',
    'claude',
    '--host',
    'cursor',
    '--yes',
  ]);
  assert.notEqual(repeated, 0, '重复给出 --host 应按参数类错误拒绝');
  assert.equal(
    existsSync(join(cursorRoot, 'repeated-host-skill', 'SKILL.md')),
    false,
    '重复给出时不产生任何写入（不取最后值分发）',
  );
  assert.equal(
    existsSync(join(claudeRoot, 'repeated-host-skill')),
    false,
    '重复给出时不产生任何写入（前一个取值同样不生效）',
  );
});

test('收口审计：update --host 在宿主根尚无副本时拒绝并引导 reconcile repair', async () => {
  const ws = makeTempDir('sm-closure-ws-');
  const hostRoot = makeHostRoot('sm-closure-host-');
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);

  const source = makeSource('update-without-copy');
  // 先只安装到工作区（无 --host），宿主根此时没有副本
  assert.equal(await call(['install', source, '--workspace', ws, '--yes']), 0);
  assert.equal(existsSync(join(hostRoot, 'update-without-copy')), false);

  const outcome = await callJson([
    'update',
    'update-without-copy',
    '--workspace',
    ws,
    '--host',
    'claude',
    '--yes',
  ]);
  assert.equal(outcome.code, 1);
  assert.equal(
    existsSync(join(hostRoot, 'update-without-copy', 'SKILL.md')),
    false,
    'update --host 不得隐式创建副本',
  );
  const findings = (outcome.result['findings'] ?? []) as Array<{
    code: string;
    remedy: string;
  }>;
  assert.equal(findings[0]?.code, 'E-PATH-001');
  assert.match(findings[0]?.remedy ?? '', /reconcile --action repair/);
  const data = outcome.result['data'] as Record<string, unknown>;
  assert.equal(data['rejected'], 'host_copy_missing');
});

test('收口审计：外部根解析边界（覆盖根为文件、父级不是目录）', async () => {
  const ws = makeTempDir('sm-closure-ws-');
  const hostRoot = makeHostRoot('sm-closure-host-');
  const asFile = join(hostRoot, 'occupies-the-path');
  writeFileSync(asFile, 'x');
  const parentIsFile = join(asFile, 'nested', 'skills');

  const fileCase = resolveHostRoot({
    hostId: 'claude',
    workspaceRoot: ws,
    config: { [rootConfigKey('claude', 'skill')]: asFile },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.ok(
    fileCase?.findings.some((item) => item.code === 'E-PATH-001'),
    '覆盖根是文件时应报路径类错误',
  );

  const parentCase = resolveHostRoot({
    hostId: 'codex',
    workspaceRoot: ws,
    config: { [rootConfigKey('codex', 'skill')]: parentIsFile },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.ok(
    parentCase?.findings.some((item) => item.message.includes('无法创建')),
    '最近上级不是目录时应明确报错（不可创建）',
  );
  assert.deepEqual(
    parentCase?.findings.filter((item) => item.severity === 'error').length,
    1,
    '该情形只报一条错误级问题',
  );

  // 不适用宿主没有可解析的根
  assert.equal(resolveHostRoot({ hostId: 'deepseek', workspaceRoot: ws }), undefined);
  assert.deepEqual([...hostIds()].length, 7, '注册表仍为 7 条（本批不新增宿主）');
});

test('收口审计：重叠消费在详情输出中呈现；agents-md 形态不落盘', async () => {
  const ws = makeTempDir('sm-closure-ws-');
  const hostRoot = makeHostRoot('sm-closure-host-');
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);

  // 重叠消费：Claude 技能根同时被 Claude 与 Cursor 读取，结果载荷须列出消费宿主
  const claudeSkill = makeSource('overlap-detail-skill');
  const landed = await callJson([
    'install',
    claudeSkill,
    '--workspace',
    ws,
    '--host',
    'claude',
    '--yes',
  ]);
  assert.equal(landed.code, 0);
  const hostData = ((landed.result['data'] as Record<string, unknown>)['host'] ?? {}) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    hostData['consumed_by'],
    ['claude', 'cursor'],
    '详情输出应列出该落位根的消费宿主集合（DP-02）',
  );
  assert.equal(hostData['host_writes_outside_workspace'], true, '宿主分发写工作区之外应显式标注');

  // 指令文件载体形态不落盘：只登记跳过原因
  const fragmentSkill = makeSource('fragment-skill');
  const fragment = await callJson([
    'install',
    fragmentSkill,
    '--workspace',
    ws,
    '--host',
    'agents-md',
    '--yes',
  ]);
  assert.equal(fragment.code, 0);
  const fragmentData = ((fragment.result['data'] as Record<string, unknown>)['host'] ??
    {}) as Record<string, unknown>;
  const skipped = (fragmentData['skipped'] ?? []) as Array<{ reason: string }>;
  assert.equal(skipped.length, 1, '指令文件载体应报告一项跳过');
  assert.match(String(skipped[0]?.reason), /合并策略未定稿/);
  assert.ok(
    ((fragment.result['changes'] ?? []) as Array<{ path: string }>).every(
      (item) => !item.path.includes('AGENTS.md'),
    ),
    '不落盘形态不应产生宿主侧变更（install 自身的工作区变更照常）',
  );
  assert.equal(existsSync(join(ws, 'AGENTS.md')), false, '片段不得写入工作区');

  // enable --host 对不落盘形态给出明确错误（没有副本可切换）
  const toggled = await callJson([
    'disable',
    'fragment-skill',
    '--workspace',
    ws,
    '--host',
    'agents-md',
    '--yes',
  ]);
  assert.notEqual(toggled.code, 0, '不落盘形态没有副本可切换，应报错');
  assert.ok(
    ((toggled.result['findings'] ?? []) as Array<{ message: string }>).some((item) =>
      item.message.includes('不落盘'),
    ),
    '应给出「该形态不落盘」的明确说明',
  );
});
