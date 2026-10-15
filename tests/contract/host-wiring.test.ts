import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { run } from '../../kernel/entry/cli.ts';

/** 工作区（含标准目录由 init 建立） */
function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'sm-wire-ws-'));
}

/** 宿主真实根：测试用配置覆盖指向临时目录，绝不触碰真实宿主目录 */
function tempHostRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sm-wire-host-'));
}

/** 造一个可安装的 Skill 来源目录 */
function makeSource(id: string, description = '演示用技能'): string {
  const dir = mkdtempSync(join(tmpdir(), `sm-src-${id}-`));
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\n---\n\n# ${id}\n\n正文。\n`);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: ${description}`,
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      `  location: ${dir}`,
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

/** 捕获一次调用的 JSON 输出与退出码 */
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

async function call(argv: string[]): Promise<number> {
  return await run(argv);
}

test('契约：install --host 分发到宿主真实根；无 --host 时行为与一期一致', async () => {
  const ws = tempWorkspace();
  const hostRoot = tempHostRoot();
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(
    await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]),
    0,
    '宿主真实根配置应可设置（测试用覆盖根）',
  );

  const withHost = makeSource('skill-with-host');
  assert.equal(
    await call(['install', withHost, '--workspace', ws, '--host', 'claude', '--yes']),
    0,
  );
  const landed = join(hostRoot, 'skill-with-host', 'SKILL.md');
  assert.equal(existsSync(landed), true, '宿主真实根应出现产物');
  const content = readFileSync(landed, 'utf8');
  assert.match(content, /^---\n/, '产物应为技能形态');
  assert.match(content, /name: skill-with-host/);
  assert.match(content, /演示用技能/, '渲染产物应带内部描述');
  assert.match(content, /正文/, '渲染产物应保留指令正文');
  assert.equal(
    existsSync(join(ws, 'skills', 'skill-with-host', 'skill_meta.yaml')),
    true,
    '中心库照常登记',
  );

  // 回归：无 --host 时不触碰宿主真实根
  const withoutHost = makeSource('skill-without-host');
  assert.equal(await call(['install', withoutHost, '--workspace', ws, '--yes']), 0);
  assert.equal(
    existsSync(join(hostRoot, 'skill-without-host')),
    false,
    '未给出 --host 时不应分发到宿主真实根',
  );
});

test('契约：enable / disable --host 在宿主根内改名，目录不动、索引状态不变', async () => {
  const ws = tempWorkspace();
  const hostRoot = tempHostRoot();
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);
  const source = makeSource('toggle-skill');
  assert.equal(await call(['install', source, '--workspace', ws, '--host', 'claude', '--yes']), 0);

  const copyDir = join(hostRoot, 'toggle-skill');
  const before = readdirSync(copyDir).sort();

  assert.equal(
    await call(['disable', 'toggle-skill', '--workspace', ws, '--host', 'claude', '--yes']),
    0,
  );
  assert.equal(existsSync(join(copyDir, 'SKILL.md')), false);
  assert.equal(existsSync(join(copyDir, 'SKILL.md.disabled')), true);
  assert.equal(existsSync(copyDir), true, '禁用不得移动或删除目录');

  // 索引状态不受宿主根操作影响（宿主根内的禁用不写索引）
  const indexDocument = parseYaml(readFileSync(join(ws, 'skill_index.yaml'), 'utf8')) as {
    skills: Array<{ id: string; status: string }>;
  };
  assert.equal(
    indexDocument.skills.find((item) => item.id === 'toggle-skill')?.status,
    'enabled',
    '宿主根内的禁用不改变索引状态',
  );

  assert.equal(
    await call(['enable', 'toggle-skill', '--workspace', ws, '--host', 'claude', '--yes']),
    0,
  );
  assert.deepEqual(
    readdirSync(copyDir).sort(),
    before,
    '启用/禁用往返后文件集合不变（AMB-01 锚点）',
  );
});

test('契约：update --host 刷新后重分发到宿主真实根', async () => {
  const ws = tempWorkspace();
  const hostRoot = tempHostRoot();
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);
  const source = makeSource('update-skill', '第一版描述');
  assert.equal(await call(['install', source, '--workspace', ws, '--host', 'claude', '--yes']), 0);

  // 本地目录来源的刷新语义是「按磁盘现状刷新记录，不重新获取内容」，
  // 因此改动中心库内容后刷新：记录与各宿主副本都应跟上磁盘现状。
  const libraryMeta = join(ws, 'skills', 'update-skill', 'skill_meta.yaml');
  writeFileSync(libraryMeta, readFileSync(libraryMeta, 'utf8').replace('第一版描述', '第二版描述'));
  assert.equal(
    await call(['update', 'update-skill', '--workspace', ws, '--host', 'claude', '--yes']),
    0,
  );
  assert.match(
    readFileSync(join(hostRoot, 'update-skill', 'SKILL.md'), 'utf8'),
    /第二版描述/,
    '刷新后宿主根副本应重分发为新内容',
  );
});

test('契约：--host 非法取值报错并列出可用取值；非终端缺 --yes 被拒', async () => {
  const ws = tempWorkspace();
  assert.equal(await call(['init', '--workspace', ws]), 0);
  const source = makeSource('invalid-host-skill');

  const invalid = await callJson([
    'install',
    source,
    '--workspace',
    ws,
    '--host',
    'not-a-host',
    '--yes',
  ]);
  assert.notEqual(invalid.code, 0, '非法 --host 取值应失败');
  const findings = (invalid.result['findings'] ?? []) as Array<{ message: string; remedy: string }>;
  assert.ok(
    findings.some((item) => item.remedy.includes('claude') && item.remedy.includes('cursor-rules')),
    `应列出可用取值：${JSON.stringify(findings)}`,
  );

  // 非终端且未给 --yes：宿主分发写工作区之外，必须显式跳过确认
  const hostRoot = tempHostRoot();
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);
  const refused = await call(['install', source, '--workspace', ws, '--host', 'claude']);
  assert.notEqual(refused, 0, '非终端缺 --yes 时应拒绝执行');
  assert.equal(existsSync(join(hostRoot, 'invalid-host-skill')), false, '拒绝后不应产生任何写入');
});

test('契约：--dry-run 预览工作区外目标且不落盘；--host 与 --target 正交', async () => {
  const ws = tempWorkspace();
  const hostRoot = tempHostRoot();
  assert.equal(await call(['init', '--workspace', ws]), 0);
  assert.equal(await call(['config', 'set', 'host.claude.root', hostRoot, '--workspace', ws]), 0);

  const preview = makeSource('preview-skill');
  const dry = await callJson([
    'install',
    preview,
    '--workspace',
    ws,
    '--host',
    'claude',
    '--dry-run',
  ]);
  assert.equal(dry.code, 0);
  assert.equal(existsSync(join(hostRoot, 'preview-skill')), false, '预演不得创建目录');
  const changes = (dry.result['changes'] ?? []) as Array<{ path: string; kind: string }>;
  assert.ok(
    changes.some((item) => item.path.includes(hostRoot) && item.kind === 'skill_md'),
    `预演应列出将写入的工作区外路径：${JSON.stringify(changes)}`,
  );

  // 正交：--target 落工作区目标，--host 落宿主真实根，两者各自生效
  const both = makeSource('orthogonal-skill');
  assert.equal(
    await call([
      'install',
      both,
      '--workspace',
      ws,
      '--target',
      'claude',
      '--host',
      'claude',
      '--yes',
    ]),
    0,
  );
  assert.equal(
    existsSync(join(ws, '.claude', 'skills', 'orthogonal-skill', 'SKILL.md')),
    true,
    '--target 仍按一期可推导布局落位',
  );
  assert.equal(
    existsSync(join(hostRoot, 'orthogonal-skill', 'SKILL.md')),
    true,
    '--host 落宿主真实根',
  );
});
