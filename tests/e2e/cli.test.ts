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
import { parseYaml as parseYamlDocument } from '../../kernel/store/yaml/index.ts';
import semver from 'semver';
import { spawnSync } from 'node:child_process';

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

const CLI_ENTRY = join(
  new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  'kernel',
  'entry',
  'cli.ts',
);

/**
 * 以真实子进程运行一次命令行入口，返回退出码与标准输出。
 *
 * 用于内含子进程的指令（如 `deps` 的运行时探测）：就地替换标准输出会把测试框架自己
 * 写往同一管道的消息一并捕获进来，因此这类断言走真正独立的进程。
 */
function runCli(argv: string[], env?: Record<string, string>): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    encoding: 'utf8',
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
  // 元文件的逐文件映射只列出 SKILL.md，副本因此只有一个文件
  assert.equal(result.data.would_remove_file_count, 1, '应给出文件数量');
  assert.equal(result.data.backup_planned, true);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得删除内容');
});

/** 造一个含可用与失效两条记录的工作区，供只读指令使用 */
async function readonlyWorkspace(): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  skill(root, 'beta', `${validMeta('beta')}dependencies:\n  skills:\n    - ghost\n`);
  await run(['scan', '--workspace', root]);
  return root;
}

test('验收：list 给出分组计数与过滤结果', async () => {
  const root = await readonlyWorkspace();
  const all = await capture(['list', '--workspace', root, '--json']);
  assert.equal(all.code, 0);
  const summary = JSON.parse(all.out) as {
    data: {
      total: number;
      filtered: number;
      by_state: { enabled: number; disabled: number };
      by_validation: { ok: number; invalid: number };
      records: Array<{ id: string }>;
    };
  };
  assert.equal(summary.data.total, 2);
  assert.equal(summary.data.filtered, 2);
  assert.deepEqual(summary.data.by_state, { enabled: 2, disabled: 0 });
  assert.deepEqual(summary.data.by_validation, { ok: 1, invalid: 1 });
  assert.deepEqual(
    summary.data.records.map((item) => item.id),
    ['alpha', 'beta'],
  );

  const filtered = await capture(['list', '--workspace', root, '--state', 'disabled', '--json']);
  assert.equal(filtered.code, 0);
  assert.equal((JSON.parse(filtered.out) as { data: { filtered: number } }).data.filtered, 0);
  assert.equal(await run(['list', '--workspace', root, '--state', 'paused']), 2);
});

test('验收：list 在未初始化的工作区返回引导性结果而非错误', async () => {
  const root = workspace();
  const { code, out } = await capture(['list', '--workspace', root, '--json']);
  assert.equal(code, 0, '契约 4.5：索引不存在时是引导性结果，不是错误');
  const data = (JSON.parse(out) as { data: { initialized: boolean; guide: string } }).data;
  assert.equal(data.initialized, false);
  assert.match(data.guide, /init/);
});

test('验收：inspect 输出完整元信息，未登记标识返回退出码 2', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['inspect', 'beta', '--workspace', root, '--json']);
  assert.equal(code, 0, '元文件本身合格时没有问题；失效结论由索引的运行期结论承载');
  const data = (
    JSON.parse(out) as {
      data: {
        meta_path: string;
        dependencies: { skills: string[] };
        targets: Array<{ file_map: Record<string, string> }>;
        checksum: { match: boolean };
        validation: { status: string; errors: string[] };
      };
    }
  ).data;
  assert.equal(data.meta_path, 'skills/beta/skill_meta.yaml');
  assert.deepEqual(data.dependencies, { skills: ['ghost'] });
  assert.equal(data.targets[0]?.file_map['SKILL.md'], 'SKILL.md');
  assert.equal(data.checksum.match, true);
  assert.equal(data.validation.status, 'invalid', '索引内已有的校验结论照实呈现');
  assert.deepEqual(data.validation.errors, ['E-DEP-001']);
  assert.equal(await run(['inspect', 'nosuch', '--workspace', root]), 2);
  assert.equal(await run(['inspect', '--workspace', root]), 2);

  // 元文件本身不合格时按错误级返回
  const broken = workspace();
  await run(['init', '--workspace', broken]);
  skill(broken, 'bad-one', 'id: bad-one\nstatus: paused\n');
  await run(['scan', '--workspace', broken]);
  assert.equal(await run(['inspect', 'bad-one', '--workspace', broken]), 1);
});

test('验收：config get 原样返回配置区', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['config', 'get', '--workspace', root, '--json']);
  assert.equal(code, 0);
  const data = JSON.parse(out) as {
    command: string;
    data: { skill_roots: string[]; default_target: string; default_mode: string };
  };
  assert.equal(data.command, 'config get');
  assert.deepEqual(data.data.skill_roots, ['./skills']);
  assert.equal(data.data.default_target, 'claude');
  assert.equal(data.data.default_mode, 'copy');
});

test('验收：deps 区分依赖状态，未满足时返回退出码 6', async () => {
  const root = await readonlyWorkspace();
  const missing = await capture(['deps', 'beta', '--workspace', root, '--json']);
  assert.equal(missing.code, 6, '契约 4.13：存在未满足的依赖时返回 6');
  const data = (
    JSON.parse(missing.out) as { data: { entries: Array<{ name: string; status: string }> } }
  ).data;
  assert.deepEqual(data.entries, [
    { name: 'ghost', constraint: null, status: 'missing', conclusion: '不在索引中' },
  ]);

  skill(root, 'gamma', `${validMeta('gamma')}dependencies:\n  skills:\n    - beta\n`);
  await run(['scan', '--workspace', root]);
  const invalid = await capture(['deps', 'gamma', '--workspace', root, '--json']);
  assert.equal(invalid.code, 6);
  const invalidData = (
    JSON.parse(invalid.out) as { data: { entries: Array<{ name: string; status: string }> } }
  ).data;
  assert.equal(invalidData.entries[0]?.status, 'invalid', '依赖目标校验不通过单独区分');

  assert.equal(await run(['deps', 'alpha', '--workspace', root]), 0, '依赖已满足时返回 0');
  assert.equal(await run(['deps', 'nosuch', '--workspace', root]), 2);
});

test('验收：export 导出文件与索引一致，载荷含路径与条目数', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture([
    'export',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: {
        path: string;
        entry_count: number;
        stripped: string[];
        backup_format_version: string;
      };
    }
  ).data;
  assert.equal(data.path, 'backups/snapshot.yaml');
  assert.equal(data.entry_count, 2);
  assert.deepEqual(data.stripped, []);
  assert.equal(data.backup_format_version, '1');

  const exported = readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.match(exported, /backup_format_version: "1"/);
  for (const id of ['alpha', 'beta']) {
    assert.ok(exported.includes(`id: ${id}`), `导出应包含 ${id}`);
  }
  assert.ok(index.includes('id: alpha'), '索引未被导出动作改写');
  assert.equal(await run(['export', '../outside.yaml', '--workspace', root]), 1);
  assert.equal(await run(['export', 'nodir/out.yaml', '--workspace', root]), 5);
});

test('验收：本批五条指令执行前后索引文件字节完全一致', async () => {
  const root = await readonlyWorkspace();
  const before = readFileSync(indexPath(root), 'utf8');
  await run(['list', '--workspace', root]);
  await run(['inspect', 'beta', '--workspace', root]);
  await run(['config', 'get', '--workspace', root]);
  await run(['deps', 'beta', '--workspace', root]);
  await run(['export', 'backups/readonly.yaml', '--workspace', root]);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '只读指令不得写入索引');
});

test('验收：enable 按需补齐副本并更新索引状态，disable 只改名', async () => {
  const root = await readonlyWorkspace();
  assert.equal(await run(['enable', 'alpha', '--workspace', root]), 0);
  assert.deepEqual(readdirSync(join(root, '.claude', 'skills', 'alpha')).sort(), ['SKILL.md']);
  assert.ok(
    readFileSync(indexPath(root), 'utf8').includes('status: enabled'),
    '索引状态应已是已启用',
  );

  assert.equal(await run(['disable', 'alpha', '--workspace', root]), 0);
  assert.deepEqual(readdirSync(join(root, '.claude', 'skills', 'alpha')).sort(), [
    'SKILL.md.disabled',
  ]);
  assert.equal(await run(['disable', 'alpha', '--workspace', root]), 0, '重复禁用幂等');
  assert.equal(await run(['enable', 'alpha', '--workspace', root]), 0);
  assert.ok(readdirSync(join(root, '.claude', 'skills', 'alpha')).includes('SKILL.md'));
});

test('验收：enable 拒绝校验不通过的记录，且不表述为已禁用', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['enable', 'beta', '--workspace', root, '--json']);
  assert.equal(code, 1, '校验类问题按错误级返回');
  const findings = (JSON.parse(out) as { findings: Array<{ code: string; remedy: string }> })
    .findings;
  assert.equal(findings[0]?.code, 'E-VALIDATION-001');
  assert.ok(!JSON.stringify(findings).includes('该 Skill 已被禁用'));
  assert.equal(await run(['enable', 'nosuch', '--workspace', root]), 2);
});

test('验收：update 需要确认，--check 只报告不写盘', async () => {
  const root = await readonlyWorkspace();
  const checked = await capture(['update', 'alpha', '--workspace', root, '--check', '--json']);
  assert.equal(checked.code, 0, '检查模式不需要确认');
  assert.equal((JSON.parse(checked.out) as { preview?: boolean }).preview, true);

  assert.equal(await run(['update', 'alpha', '--workspace', root]), 2, '非终端且未给 --yes');
  assert.equal(await run(['update', 'alpha', '--workspace', root, '--yes']), 0);
  assert.equal(await run(['update', 'alpha', '--workspace', root, '--target', 'claude']), 2);
  assert.equal(await run(['update', 'nosuch', '--workspace', root, '--yes']), 2);
});

test('验收：update 刷新版本与指纹，首次登记时间不变', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const meta = join(root, 'skills', 'code-review', 'skill_meta.yaml');
  writeFileSync(
    meta,
    readFileSync(meta, 'utf8').replace('id: code-review', 'id: code-review\nversion: 2.0.0'),
  );
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# code-review changed');

  const before = await capture(['inspect', 'code-review', '--workspace', root, '--json']);
  const recordBefore = (
    JSON.parse(before.out) as { data: { record: { created_at: string; checksum: string } } }
  ).data.record;

  const { code, out } = await capture([
    'update',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (JSON.parse(out) as { data: Record<string, unknown> }).data;
  assert.equal(data['version_after'], '2.0.0');
  assert.equal(data['version_changed'], true);
  assert.equal(data['created_at'], recordBefore.created_at, '首次登记时间不变');
  assert.notEqual(data['checksum_after'], recordBefore.checksum, '指纹按磁盘重算');
});

test('验收：config set 写入并拒绝非法取值，写入前后索引可解析', async () => {
  const root = await readonlyWorkspace();
  const set = await capture([
    'config',
    'set',
    'default_target',
    'codex',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(set.code, 0);
  const data = (JSON.parse(set.out) as { data: Record<string, unknown> }).data;
  assert.equal(data['previous_value'], 'claude');
  assert.equal(data['new_value'], 'codex');

  const read = await capture(['config', 'get', '--workspace', root, '--json']);
  assert.equal(
    (JSON.parse(read.out) as { data: { default_target: string } }).data.default_target,
    'codex',
  );
  assert.equal(await run(['config', 'set', 'default_mode', '硬链接', '--workspace', root]), 2);
  assert.equal(await run(['config', 'set', 'nosuchkey', 'x', '--workspace', root]), 2);
  assert.equal(await run(['config', 'set', 'default_target', '--workspace', root]), 2);
});

test('验收：export --no-config 不含配置区并记入剥离清单', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture([
    'export',
    'backups/no-config.yaml',
    '--no-config',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (JSON.parse(out) as { data: { config_included: boolean; stripped: string[] } }).data;
  assert.equal(data.config_included, false);
  assert.deepEqual(data.stripped, ['config']);
  assert.ok(!readFileSync(join(root, 'backups', 'no-config.yaml'), 'utf8').includes('skill_roots'));
});

test('验收：deps --tree 给出嵌套依赖树', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['deps', 'beta', '--tree', '--workspace', root, '--json']);
  assert.equal(code, 6, '依赖未满足仍按专属口径返回 6');
  const tree = (
    JSON.parse(out) as { data: { tree: { name: string; status: string; children: unknown[] } } }
  ).data.tree;
  assert.equal(tree.name, 'beta');
  assert.equal(tree.status, 'invalid', '该记录自身的运行期结论为校验不通过');
  assert.deepEqual(tree.children, [{ name: 'ghost', status: 'missing', children: [] }]);
});

test('验收：未知选项按参数类错误拒绝', async () => {
  const root = await readonlyWorkspace();
  assert.equal(await run(['list', '--workspace', root, '--sttae', 'enabled']), 2);
  assert.equal(await run(['scan', '--workspace', root, '--frobnicate']), 2);
});

/** 造一份清单并移除其中一条记录，返回工作区路径 */
async function importScenario(): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  skill(root, 'beta', validMeta('beta'));
  await run(['scan', '--workspace', root]);
  await run(['export', 'backups/snapshot.yaml', '--workspace', root]);
  await run(['uninstall', 'alpha', '--hard', '--workspace', root, '--yes']);
  return root;
}

test('验收：import 需要轻确认，非终端未给 --yes 时拒绝', async () => {
  const root = await importScenario();
  assert.equal(await run(['import', 'backups/snapshot.yaml', '--workspace', root]), 2);
  assert.equal(await run(['import', 'backups/snapshot.yaml', '--workspace', root, '--yes']), 0);
});

test('验收：import 的确认提示给出将登记的记录条数', async () => {
  const root = await importScenario();
  const { written, channel } = interactionOf('n');
  const code = await run(['import', 'backups/snapshot.yaml', '--workspace', root], channel);
  assert.equal(code, 0, '用户取消不是执行失败');
  assert.match(written[0] ?? '', /将登记 1 条记录/);
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('id: alpha'), '取消后不登记');
});

test('验收：import 恢复记录并跳过既有标识，扫描后与磁盘实况一致', async () => {
  const root = await importScenario();
  const { code, out } = await capture([
    'import',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: { imported: number; conflicts: number; ids: string[]; roundtrip: string };
    }
  ).data;
  assert.equal(data.imported, 1, 'alpha 的原目录已删除，仍按清单登记');
  assert.equal(data.conflicts, 1, 'beta 已在索引中，跳过不覆盖');
  assert.deepEqual(data.ids, ['alpha']);
  assert.equal(data.roundtrip, 'consistent');

  // 导入后 alpha 的记录未经验证，扫描按磁盘实况给出结论
  await run(['scan', '--workspace', root]);
  const listed = await capture(['list', '--workspace', root, '--json']);
  const summary = (
    JSON.parse(listed.out) as {
      data: { total: number; by_validation: { ok: number; invalid: number } };
    }
  ).data;
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.by_validation, { ok: 1, invalid: 1 }, 'alpha 的目录缺失判为不通过');
});

test('验收：import 重复执行时全部按冲突跳过且不改动索引', async () => {
  const root = await importScenario();
  await run(['import', 'backups/snapshot.yaml', '--workspace', root, '--yes']);
  const before = readFileSync(indexPath(root), 'utf8');
  const { code, out } = await capture([
    'import',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (JSON.parse(out) as { data: { imported: number; conflicts: number } }).data;
  assert.equal(data.imported, 0);
  assert.equal(data.conflicts, 2);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '无新增时不改写索引');
});

test('验收：import 格式非法时返回退出码 3 且详情可见', async () => {
  const root = await importScenario();
  const bad = join(root, 'backups', 'bad.yaml');
  writeFileSync(
    bad,
    ['backup_format_version: "1"', 'skills:', '  - id: UPPER', '    status: paused', ''].join('\n'),
  );
  const { code, out } = await capture([
    'import',
    'backups/bad.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 3, '契约 4.15：备份格式校验失败返回 3');
  const result = JSON.parse(out) as {
    findings: Array<{ code: string }>;
    data: { rejected?: string; problem_codes?: string[] };
  };
  assert.equal(result.data.rejected, 'invalid_format');
  assert.ok((result.data.problem_codes ?? []).includes('E-FIELD-001'));
  assert.ok(result.findings.some((item) => item.code === 'E-STATUS-001'));

  assert.equal(await run(['import', '../outside.yaml', '--workspace', root, '--yes']), 1);
  assert.equal(await run(['import', 'backups/nosuch.yaml', '--workspace', root, '--yes']), 4);
  assert.equal(
    await run(['import', 'backups/snapshot.yaml', '--on-conflict', 'keep', '--workspace', root]),
    2,
  );
});

/** 造出「已安装并留下一份卸载备份」的现场，供恢复指令用例复用 */
async function restoreScenario(options: { hard?: boolean } = {}): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const argv = ['uninstall', 'code-review', '--workspace', root, '--yes'];
  if (options.hard === true) argv.push('--hard');
  assert.equal(await run(argv), 0);
  return root;
}

/** 取该 Skill 单个备份载体的绝对路径 */
function backupDirOf(root: string, id: string): string {
  const stamps = readdirSync(join(root, 'backups', id));
  assert.equal(stamps.length, 1, '前置：应恰好有一份备份');
  return join(root, 'backups', id, stamps[0]!);
}

test('验收：restore 需要常规确认，非终端未给 --yes 时拒绝执行且不写盘', async () => {
  const root = await restoreScenario({ hard: true });
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '前置：原件已被硬卸载删除');

  const { code, out } = await capture(['restore', 'code-review', '--workspace', root]);
  assert.equal(code, 2, '参数类退出码');
  assert.match(out, /E-INPUT-001/);
  assert.match(out, /--yes/);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '拒绝后不得写回原件');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '拒绝后不得创建副本');

  assert.equal(await run(['restore', 'code-review', '--workspace', root, '--yes']), 0);
});

test('验收：restore 的确认提示写明覆盖现有原件，答 n 时中止', async () => {
  const root = await restoreScenario();
  const { written, channel } = interactionOf('n');
  const outcome = await capture(['restore', 'code-review', '--workspace', root, '--json'], channel);
  assert.equal(outcome.code, 0, '用户取消不是执行失败');
  assert.match(written[0] ?? '', /覆盖/);
  assert.match(written[0] ?? '', /扫描/);
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  const result = JSON.parse(outcome.out) as { data: { aborted?: string } };
  assert.equal(result.data.aborted, 'user_declined');

  const { channel: accept } = interactionOf('y');
  assert.equal(
    await run(['restore', 'code-review', '--workspace', root], accept),
    0,
    '答 y 后应执行',
  );
});

test('验收：restore 缺省取最新备份，重建记录后由 scan 判定为合格', async () => {
  const root = await restoreScenario({ hard: true });

  const { code, out } = await capture([
    'restore',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(out) as {
    data: {
      record_action?: string;
      file_count?: number;
      files?: string[];
      backup_timestamp?: string;
      backup_type?: string;
      library_path?: string;
    };
  };
  assert.equal(result.data.record_action, 'rebuilt', '已卸载的标识应重建记录');
  assert.equal(result.data.file_count, 2);
  assert.deepEqual(result.data.files, [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);
  assert.equal(result.data.backup_type, 'full');
  assert.equal(result.data.library_path, 'skills/code-review');
  assert.match(String(result.data.backup_timestamp), /^\d{4}-\d{2}-\d{2}T/);

  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '内容应写回中心库');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md')), '副本应重分发');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('id: code-review'), '索引记录应重建');
  assert.ok(index.includes('E-INDEX-002'), '重建记录的结论取保守值');

  assert.equal(await run(['scan', '--workspace', root]), 0, '扫描后应无不合格项');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('status: ok'), '扫描应把结论刷新为合格');
});

test('验收：restore 无备份返回 5，时间戳不存在返回 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);

  const missing = await capture(['restore', 'code-review', '--workspace', root, '--yes', '--json']);
  assert.equal(missing.code, 5, '备份类问题按通用派生落 5');
  assert.match(missing.out, /E-BAK-003/);

  await run(['uninstall', 'code-review', '--workspace', root, '--yes']);
  const stamped = await capture([
    'restore',
    'code-review',
    '--timestamp',
    '2020-01-01T00:00:00Z',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(stamped.code, 2, '时间戳不存在属参数类');
  const result = JSON.parse(stamped.out) as { data: { rejected?: string; available?: string[] } };
  assert.equal(result.data.rejected, 'timestamp_not_found');
  assert.equal(result.data.available?.length, 1, '应列出可用时间戳');
});

test('验收：restore 载体损坏返回 5，目标被占用返回 1', async () => {
  const damaged = await restoreScenario({ hard: true });
  rmSync(join(backupDirOf(damaged, 'code-review'), 'content', 'SKILL.md'), { force: true });
  const broken = await capture([
    'restore',
    'code-review',
    '--workspace',
    damaged,
    '--yes',
    '--json',
  ]);
  assert.equal(broken.code, 5);
  assert.match(broken.out, /E-BAK-004/);
  assert.ok(!existsSync(join(damaged, 'skills', 'code-review')), '载体不可信时不得写回');

  const occupied = await restoreScenario({ hard: true });
  writeFileSync(join(occupied, 'skills', 'code-review'), 'occupied');
  const conflict = await capture([
    'restore',
    'code-review',
    '--workspace',
    occupied,
    '--yes',
    '--json',
  ]);
  assert.equal(conflict.code, 1, '目标占用冲突按默认档落 1');
  assert.match(conflict.out, /E-CONFLICT-003/);
  assert.equal(readFileSync(join(occupied, 'skills', 'code-review'), 'utf8'), 'occupied');
});

test('验收：restore --dry-run 不要求确认也不写盘，载荷含将写回的清单', async () => {
  const root = await restoreScenario({ hard: true });
  const before = readFileSync(indexPath(root), 'utf8');

  const { code, out } = await capture([
    'restore',
    'code-review',
    '--workspace',
    root,
    '--dry-run',
    '--json',
  ]);
  assert.equal(code, 0, '预演不要求确认');
  const result = JSON.parse(out) as {
    preview?: boolean;
    data: { preview?: boolean; file_count?: number; files?: string[]; library_exists?: boolean };
  };
  assert.equal(result.preview, true);
  assert.equal(result.data.preview, true);
  assert.equal(result.data.file_count, 2);
  assert.deepEqual(result.data.files, [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);
  assert.equal(result.data.library_exists, false);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写回原件');
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '预演不得改写索引');
});

test('验收：validate 的内容漂移报告定位到具体文件并给出新旧摘要', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  assert.equal(await run(['scan', '--workspace', root]), 0, '前置：干净工作区');
  const baseline = (
    parseYamlDocument(readFileSync(indexPath(root), 'utf8')) as {
      skills: Array<{ id: string; digests: Record<string, string> }>;
    }
  ).skills.find((item) => item.id === 'alpha');
  const recorded = baseline?.digests['SKILL.md'];
  assert.match(String(recorded), /^sha256:[0-9a-f]{64}$/, '前置：索引内应有逐文件基准');

  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# drifted');
  const { code, out } = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(code, 0, '漂移是警告级，不改退出码');
  const result = JSON.parse(out) as {
    findings: Array<{ code: string; target: string; message: string }>;
  };
  const located = result.findings.filter(
    (item) => item.code === 'W-DRIFT-001' && item.target.startsWith('alpha/'),
  );
  assert.equal(located.length, 1, '应定位到唯一变化的文件');
  assert.equal(located[0]?.target, 'alpha/SKILL.md', '报告给出文件相对路径');
  assert.match(String(located[0]?.message), /文件内容已变化/);
  assert.match(String(located[0]?.message), new RegExp(String(recorded)), '给出原摘要');
  assert.match(String(located[0]?.message), /现有摘要 sha256:[0-9a-f]{64}/, '给出现有摘要');

  // 修复后重新扫描，基准与磁盘重新对齐，不再报告漂移
  assert.equal(await run(['scan', '--workspace', root]), 0);
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('# drifted'), '索引不含文件内容');
  const after = await capture(['validate', '--workspace', root, '--json']);
  assert.ok(
    !(JSON.parse(after.out) as { findings: Array<{ code: string }> }).findings.some(
      (item) => item.code === 'W-DRIFT-001',
    ),
    '重新扫描后漂移消失',
  );
});

test('验收：export 产物不含逐文件摘要，索引内仍保留该基准', async () => {
  const root = await readonlyWorkspace();
  const indexText = readFileSync(indexPath(root), 'utf8');
  assert.ok(indexText.includes('digests:'), '前置：索引派生区内有逐文件摘要');

  const { code, out } = await capture([
    'export',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(out) as { data: { entry_count: number; stripped: string[] } };
  assert.equal(payload.data.entry_count, 2);
  assert.ok(
    !payload.data.stripped.some((item) => item.endsWith('digests')),
    '内部派生数据不计入被剥离项清单',
  );

  const document = readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8');
  assert.ok(!document.includes('digests'), '导出物中不含逐文件摘要');
  assert.match(document, /checksum: sha256:/, '聚合指纹仍在导出物中');
  assert.equal(readFileSync(indexPath(root), 'utf8'), indexText, '导出不改动索引');
});

test('验收：deps 呈现运行时维度，缺失的运行时返回退出码 6', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', `${validMeta('alpha')}dependencies:\n  runtime:\n    node: ">=22.0.0"\n`);
  skill(
    root,
    'beta',
    `${validMeta('beta')}dependencies:\n  runtime:\n    skill-manager-no-such-runtime: ">=1.0.0"\n`,
  );
  assert.equal(await run(['scan', '--workspace', root]), 0, '运行时不参与校验结论');

  const satisfied = runCli(['deps', 'alpha', '--workspace', root, '--json']);
  assert.equal(satisfied.code, 0);
  const okRuntime = (
    JSON.parse(satisfied.out) as {
      data: {
        runtime: Array<{
          name: string;
          constraint: string;
          status: string;
          version: string | null;
          command: string | null;
          conclusion: string;
        }>;
      };
    }
  ).data.runtime;
  assert.equal(okRuntime.length, 1, '载荷给出运行时条目');
  assert.equal(okRuntime[0]?.name, 'node');
  assert.equal(okRuntime[0]?.constraint, '>=22.0.0', '载荷保留期望约束原文');
  assert.equal(okRuntime[0]?.status, 'ok');
  assert.equal(okRuntime[0]?.version, semver.coerce(process.versions.node)?.version);
  assert.ok((okRuntime[0]?.command ?? '').length > 0, '命中命令的位置一并呈现');

  const missing = runCli(['deps', 'beta', '--workspace', root, '--json']);
  assert.equal(missing.code, 6, '运行时缺失归入依赖档');
  const missingResult = JSON.parse(missing.out) as {
    findings: Array<{ code: string; target: string }>;
    data: { runtime: Array<{ status: string; version: string | null }> };
  };
  assert.equal(missingResult.data.runtime[0]?.status, 'missing');
  assert.equal(missingResult.data.runtime[0]?.version, null);
  assert.deepEqual(
    missingResult.findings.map((item) => item.code),
    ['E-RUN-001'],
  );
});

test('验收五：运行时缺失不改变 scan 与 validate 的判定，也不写入索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(
    root,
    'gamma',
    `${validMeta('gamma')}dependencies:\n  runtime:\n    skill-manager-no-such-runtime: ">=1.0.0"\n`,
  );

  assert.equal(await run(['scan', '--workspace', root]), 0, '运行时缺失不判失效');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('status: ok'), '记录结论为校验通过');
  assert.ok(!index.includes('skill-manager-no-such-runtime'), '探测结果不入索引');

  const validation = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(validation.code, 0, 'validate 判定不受运行时影响');
  assert.ok(
    !(JSON.parse(validation.out) as { findings: Array<{ code: string }> }).findings.some((item) =>
      item.code.startsWith('E-RUN-'),
    ),
    '校验报告不掺入运行时探测结论',
  );

  // 同一份环境里，依赖检查仍会把运行时问题如实报出来
  assert.equal(runCli(['deps', 'gamma', '--workspace', root]).code, 6);
  assert.equal(readFileSync(indexPath(root), 'utf8'), index, 'deps 不改动索引');
});
