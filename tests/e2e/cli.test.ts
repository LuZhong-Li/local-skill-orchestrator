import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import type { Interaction } from '../../kernel/dispatch/policy/index.ts';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-cli-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function indexPath(root: string): string {
  return join(root, 'skill_index.yaml');
}

/**
 * 捕获一次调用的标准输出，便于断言结构化结果的内容。
 * 只用于测试：入口把结果写在标准输出上，退出码不足以区分「无问题」与「仅警告」。
 */
async function capture(
  argv: string[],
  interaction?: Interaction,
): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  const patched = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = patched as typeof process.stdout.write;
  try {
    const code = interaction === undefined ? await run(argv) : await run(argv, interaction);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/** 注入的交互通道：记录提示文本，按固定回答返回，不依赖真实终端 */
function interactionOf(answer: string, interactive = true) {
  const written: string[] = [];
  const channel: Interaction = {
    interactive,
    write: (text: string): void => {
      written.push(text);
    },
    read: (): Promise<string> => Promise.resolve(answer),
  };
  return { written, channel };
}

function skill(root: string, dir: string, meta: string, content = '# skill'): void {
  const target = join(root, 'skills', dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), content);
  writeFileSync(join(target, 'skill_meta.yaml'), meta);
}

const validMeta = (id: string): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
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
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');

test('验收一：init 建立工作区与初始索引，重复执行幂等', async () => {
  const root = workspace();
  assert.equal(await run(['init', '--workspace', root]), 0);
  assert.ok(existsSync(indexPath(root)), '应创建索引文件');
  assert.ok(existsSync(join(root, 'skills')), '应创建 skills 目录');
  assert.ok(existsSync(join(root, 'backups')), '应创建 backups 目录');
  assert.ok(existsSync(join(root, 'locks')), '应创建 locks 目录');
  assert.ok(existsSync(join(root, 'logs')), '应创建 logs 目录');

  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['init', '--workspace', root]), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '重复 init 不应覆盖既有索引');
});

test('验收二：scan 生成索引，合格记录 ok、不合格记录 invalid 且重复扫描不新增条目', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'good-skill', validMeta('good-skill'));
  skill(root, 'bad-skill', 'id: bad-skill\nstatus: paused\n');

  const first = await run(['scan', '--workspace', root]);
  assert.equal(first, 1, '存在不合格记录时退出码应为 1');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('status: ok'), '应存在校验通过的记录');
  assert.ok(index.includes('status: invalid'), '应存在校验不通过的记录');
  assert.ok(index.includes('E-STATUS-001'), '不合格记录应携带问题码');

  const second = await run(['scan', '--workspace', root, '--json']);
  assert.equal(second, 1);
});

test('验收二续：--dry-run 不写入索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'good-skill', validMeta('good-skill'));
  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['scan', '--workspace', root, '--dry-run']), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '预演不应改写索引');
});

test('未初始化的工作区执行 scan 返回环境类错误与退出码 1', async () => {
  const root = workspace();
  assert.equal(await run(['scan', '--workspace', root]), 1);
});

test('未知指令返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['frobnicate', '--workspace', root]), 2);
});

test('缺少选项取值返回输入类错误与退出码 2', async () => {
  assert.equal(await run(['scan', '--workspace']), 2);
});

test('--version 输出后直接返回 0', async () => {
  assert.equal(await run(['--version']), 0);
});

/** 造一份可安装的来源目录 */
function sourceSkill(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cli-src-'));
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
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
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
  return dir;
}

test('验收：install 写入中心库、创建副本并登记索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']), 0);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')));
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md')));
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'));
});

test('验收：install 缺少来源参数返回输入类错误', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['install', '--workspace', root, '--yes']), 2);
});

test('验收：install 重复标识返回冲突错误与退出码 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']), 1);
});

test('验收：uninstall 默认保留中心库原件，--hard 一并删除', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);

  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--yes']), 0);
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '副本应被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '原件默认保留');

  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--hard', '--yes']), 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '--hard 应删除原件');
});

test('验收：uninstall 不存在的标识返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['uninstall', 'ghost', '--workspace', root, '--yes']), 2);
});

test('验收：install --dry-run 不写入任何文件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(
    await run(['install', sourceSkill('code-review'), '--workspace', root, '--dry-run']),
    0,
  );
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写入中心库');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得创建副本');
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '预演不得登记记录');
});

test('验收：install --library-only 只落库，不分发到目标位置', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(
    await run([
      'install',
      sourceSkill('code-review'),
      '--workspace',
      root,
      '--library-only',
      '--yes',
    ]),
    0,
  );
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '中心库原件应落位');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '不得分发到目标位置');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('status: disabled'));
});

test('验收：uninstall 接受契约中的 --keep-library 选项', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root, '--keep-library', '--yes']),
    0,
  );
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '中心库原件应保留');
});

test('验收：uninstall --dry-run 不删除任何文件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--dry-run']), 0);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得清理副本');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '预演不得移除记录');
});

test('验收：validate 在干净工作区返回 0，且不改写索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['validate', '--workspace', root]), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '校验全程只读');
});

test('验收：validate 仅警告时返回 0，--strict 时返回 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const meta = join(root, 'skills', 'code-review', 'skill_meta.yaml');
  writeFileSync(meta, readFileSync(meta, 'utf8').replace('name: code-review', 'name: renamed'));

  assert.equal(await run(['validate', '--workspace', root]), 0);
  assert.equal(await run(['validate', '--workspace', root, '--strict']), 1);
  assert.equal(readFileSync(indexPath(root), 'utf8').includes('name: renamed'), false);
});

test('验收：validate 存在错误级问题时返回 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  assert.equal(await run(['validate', '--workspace', root]), 1);
});

test('验收：validate 指定未知对象返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['validate', 'nosuch', '--workspace', root]), 2);
});

test('验收：未初始化的工作区执行 validate 返回环境类错误', async () => {
  const root = workspace();
  assert.equal(await run(['validate', '--workspace', root]), 1);
});

test('验收：uninstall 生成备份并在载荷中给出备份位置', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);

  const { code, out } = await capture([
    'uninstall',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(out) as {
    data: { backup_path?: string; backup_file_count?: number; backup_timestamp?: string };
  };
  assert.match(String(result.data.backup_path), /^backups\/code-review\//);
  assert.equal(result.data.backup_file_count, 2);

  const backupRoot = join(root, 'backups', 'code-review');
  const stamps = readdirSync(backupRoot);
  assert.equal(stamps.length, 1);
  const dir = join(backupRoot, stamps[0]!);
  assert.ok(existsSync(join(dir, 'backup_meta.yaml')), '应写出备份清单');
  assert.ok(existsSync(join(dir, 'content', 'SKILL.md')), '应复制内容');
  assert.ok(existsSync(join(dir, 'content', 'skill_meta.yaml')), '应复制元文件');
});

test('验收：备份失败时卸载中止并返回文件系统类退出码', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  // 用同名文件占住备份目录，使备份无法创建
  writeFileSync(join(root, 'backups', 'code-review'), 'occupied');

  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--yes']), 5);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '副本不得被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '原件不得被删除');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '记录不得被移除');
});

test('验收：--hard 卸载先备份再删除原件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--hard', '--yes']), 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '原件应被删除');

  const backupRoot = join(root, 'backups', 'code-review');
  const stamps = readdirSync(backupRoot);
  assert.ok(
    existsSync(join(backupRoot, stamps[0]!, 'content', 'SKILL.md')),
    '删除原件后仍能从备份回溯内容',
  );
});

test('验收：仅落库安装后 validate 不再报告启用状态与落位摘要的投影不一致', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run([
    'install',
    sourceSkill('code-review'),
    '--workspace',
    root,
    '--library-only',
    '--yes',
  ]);

  const { code, out } = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(code, 0);
  const result = JSON.parse(out) as { findings: Array<{ code: string; target: string }> };
  assert.deepEqual(result.findings, [], 'status 与 targets.enabled 不参与投影判定');
});

test('验收：非终端环境未传 --yes 时拒绝执行且不写入', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { code, out } = await capture(['install', sourceSkill('code-review'), '--workspace', root]);
  assert.equal(code, 2, '参数类退出码');
  assert.match(out, /E-INPUT-001/);
  assert.match(out, /--yes/);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '拒绝后不得写入中心库');
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('code-review'), '不得登记记录');
});

test('验收：交互确认答 y 后执行，提示含预期变更摘要', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { written, channel } = interactionOf('y');
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root], channel), 0);
  assert.equal(written.length, 1, '应输出一次提示');
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '确认后应写入中心库');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '确认后应分发到目标位置');
});

test('验收：交互确认答 n 后中止，不产生任何变更', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { channel } = interactionOf('n');
  const { code, out } = await capture(
    ['install', sourceSkill('code-review'), '--workspace', root, '--json'],
    channel,
  );
  assert.equal(code, 0, '用户取消不是执行失败');
  const result = JSON.parse(out) as { data: { aborted?: string } };
  assert.equal(result.data.aborted, 'user_declined');
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '取消后不得写入任何内容');
});

test('验收：卸载的确认提示逐条列出影响范围与文件数量，--hard 另行指明永久删除', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);

  const normal = interactionOf('y');
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root], normal.channel),
    0,
    '常规卸载确认后执行',
  );
  const normalPrompt = normal.written[0] ?? '';
  assert.match(normalPrompt, /影响范围/);
  assert.match(normalPrompt, /\.claude[\\/]skills[\\/]code-review/, '须列出具体路径');
  assert.match(normalPrompt, /合计将移除 \d+ 个副本位置、\d+ 个文件/, '须给出文件数量');
  assert.ok(!normalPrompt.includes('永久删除'), '常规卸载不应出现永久删除提示');

  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const strict = interactionOf('y');
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root, '--hard'], strict.channel),
    0,
    '强制确认后执行',
  );
  const strictPrompt = strict.written[0] ?? '';
  assert.match(strictPrompt, /永久删除/, '--hard 须单独指明永久删除');
  assert.match(strictPrompt, /强制确认级别/);
  assert.notEqual(strictPrompt, normalPrompt, '两档确认的提示内容必须不同');
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '--hard 应删除原件');
});

test('验收：--dry-run 不要求确认也不写盘，载荷含预演信息', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);

  const { code, out } = await capture(
    ['uninstall', 'code-review', '--workspace', root, '--dry-run', '--json'],
    interactionOf('', false).channel,
  );
  assert.equal(code, 0, '预演不需要终端也不需要确认');
  const result = JSON.parse(out) as {
    preview?: boolean;
    data: { would_remove?: string[]; would_remove_file_count?: number; backup_planned?: boolean };
  };
  assert.equal(result.preview, true);
  assert.equal(result.data.would_remove?.length, 1);
  assert.equal(result.data.would_remove_file_count, 2, '应给出文件数量');
  assert.equal(result.data.backup_planned, true);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得删除内容');
});
