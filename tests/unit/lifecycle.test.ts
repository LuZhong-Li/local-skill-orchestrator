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
import { installSkill, uninstallSkill } from '../../kernel/core/lifecycle/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf, ensureWorkspaceDirs } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import { BACKUP_CONTENT_DIR_NAME, timestampToDirName } from '../../kernel/store/backup-fs/index.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-14T00:00:00Z';
const LATER = '2026-10-14T02:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-life-'));
  ensureWorkspaceDirs(layoutOf(root));
  return root;
}

/** 造一份可安装的来源目录 */
function sourceSkill(
  id: string,
  options: { extra?: string; content?: string; status?: string; targetPath?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-src-'));
  writeFileSync(join(dir, 'SKILL.md'), options.content ?? '# skill');
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `status: ${options.status ?? 'enabled'}`,
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: ${options.targetPath ?? `.claude/skills/${id}`}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      options.extra ?? '',
      '',
    ].join('\n'),
  );
  return dir;
}

function emptyIndex(): SkillIndex {
  return createInitialIndex(NOW);
}

function codesOf(findings: Array<{ code: string }>): string[] {
  return findings.map((item) => item.code);
}

test('验收一：安装合法 Skill 写入中心库、创建副本并登记索引', async () => {
  const root = workspace();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index.skills.length, 1);

  const record = outcome.index.skills[0];
  assert.equal(record?.id, 'code-review');
  assert.equal(record?.validation.status, 'ok');
  assert.ok(record?.checksum.startsWith('sha256:'));
  assert.equal(record?.created_at, NOW);
  assert.deepEqual(record?.targets, [{ target: 'claude', scope: 'global', enabled: true }]);

  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '中心库原件应落位');
  assert.ok(
    existsSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md')),
    '受控副本应创建且处于启用态',
  );
  assert.deepEqual(outcome.data['targets'], [
    { target: 'claude', scope: 'global', path: '.claude/skills/code-review', enabled: true },
  ]);
});

test('验收二：重复安装同一标识被拒绝，不覆盖也不新增', async () => {
  const root = workspace();
  const first = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const second = await installSkill({
    layout: layoutOf(root),
    index: first.index,
    sourcePath: sourceSkill('code-review'),
    now: LATER,
  });
  assert.deepEqual(codesOf(second.findings), [CODES.CONFLICT_NAMING]);
  assert.equal(second.index.skills.length, 1, '不应新增记录');
  assert.equal(second.index.skills[0]?.created_at, NOW, '既有记录不应被改写');
  assert.equal(second.data['rejected'], 'already_registered');
});

test('验收三之一：依赖缺失时拒绝安装', async () => {
  const root = workspace();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('needs-ghost', {
      extra: 'dependencies:\n  skills:\n    - ghost',
    }),
    now: NOW,
  });
  assert.ok(codesOf(outcome.findings).includes(CODES.DEP_MISSING));
  assert.equal(outcome.index.skills.length, 0);
  assert.equal(outcome.data['rejected'], 'dependency_unmet');
});

test('验收三之二：被依赖对象校验不通过时拒绝安装，返回 E-VALIDATION-002', async () => {
  const root = workspace();
  const broken: SkillIndex = {
    ...emptyIndex(),
    skills: [
      {
        id: 'broken-dep',
        name: 'broken-dep',
        status: 'enabled',
        path: './skills/broken-dep',
        source_type: 'local',
        targets: [],
        created_at: NOW,
        updated_at: NOW,
        checksum: `sha256:${'0'.repeat(64)}`,
        validation: { status: 'invalid', errors: [CODES.STATUS_INVALID] },
      },
    ],
  };
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: broken,
    sourcePath: sourceSkill('needs-broken', {
      extra: 'dependencies:\n  skills:\n    - broken-dep',
    }),
    now: NOW,
  });
  assert.deepEqual(codesOf(outcome.findings), [CODES.VALIDATION_DEPENDENCY]);
  assert.equal(outcome.data['rejected'], 'dependency_unmet');
});

test('验收四：不合格元数据被拒绝，问题码清单完整可见', async () => {
  const root = workspace();
  const source = mkdtempSync(join(tmpdir(), 'sm-src-bad-'));
  writeFileSync(join(source, 'SKILL.md'), '# x');
  writeFileSync(join(source, 'skill_meta.yaml'), 'id: bad-one\nstatus: paused\n');
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: source,
    now: NOW,
  });
  assert.ok(outcome.findings.length >= 4, '应逐项列出缺失与取值问题');
  const codes = codesOf(outcome.findings);
  assert.ok(codes.includes(CODES.STATUS_INVALID));
  assert.ok(codes.includes(CODES.FIELD_REQUIRED));
  assert.equal(outcome.data['rejected'], 'invalid_metadata');
  assert.ok(Array.isArray(outcome.data['problem_codes']));
  assert.equal(outcome.index.skills.length, 0);
  assert.ok(!existsSync(join(root, 'skills', 'bad-one')), '被拒绝时不应写入中心库');
});

test('验收五之一：卸载默认清理副本并保留中心库原件', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index.skills.length, 0, '索引记录应被移除');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '副本应被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '中心库原件默认保留');
  assert.equal(outcome.data['library_kept'], true);
});

test('验收五之二：--hard 时连同中心库原件一并删除', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
    hard: true,
  });
  assert.equal(outcome.index.skills.length, 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '原件应被删除');
  assert.equal(outcome.data['library_kept'], false);
});

test('验收六：卸载不存在的标识返回输入类错误', async () => {
  const root = workspace();
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    id: 'ghost',
    now: NOW,
  });
  assert.deepEqual(codesOf(outcome.findings), [CODES.INPUT_INVALID_ARG]);
  assert.equal(outcome.data['rejected'], 'not_registered');
  assert.equal(outcome.index.skills.length, 0);
});

test('冲突：逐文件映射把两个来源写到同一目标时拒绝安装', async () => {
  const root = workspace();
  const source = mkdtempSync(join(tmpdir(), 'sm-src-dup-'));
  writeFileSync(join(source, 'SKILL.md'), '# x');
  writeFileSync(join(source, 'extra.md'), '# y');
  writeFileSync(
    join(source, 'skill_meta.yaml'),
    [
      'id: dup-target',
      'name: dup-target',
      'status: enabled',
      'path: ./skills/dup-target',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/dup-target',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: same.md',
      '      extra.md: same.md',
      '',
    ].join('\n'),
  );
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: source,
    now: NOW,
  });
  assert.ok(codesOf(outcome.findings).includes(CODES.CONFLICT_MAPPING));
  assert.equal(outcome.data['rejected'], 'conflict');
});

test('冲突：落位路径与目标落位根约定不一致时拒绝登记', async () => {
  const root = workspace();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review', {
      targetPath: '.custom/skills/code-review',
    }),
    now: NOW,
  });
  assert.deepEqual(codesOf(outcome.findings), [CODES.FIELD_INVALID_VALUE]);
  assert.match(String(outcome.findings[0]?.remedy), /\.claude\/skills\/code-review/);
});

test('冲突：目标位置已被同名目录占用时拒绝安装', async () => {
  const root = workspace();
  mkdirSync(join(root, '.claude', 'skills', 'code-review'), { recursive: true });
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  assert.ok(codesOf(outcome.findings).includes(CODES.CONFLICT_OCCUPIED));
  assert.equal(outcome.data['rejected'], 'conflict');
});

test('来源缺少元文件时返回路径类错误', async () => {
  const root = workspace();
  const source = mkdtempSync(join(tmpdir(), 'sm-src-none-'));
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: source,
    now: NOW,
  });
  assert.deepEqual(codesOf(outcome.findings), [CODES.PATH_INVALID]);
});

test('预演：安装不写入任何文件，原样返回索引并给出将发生的变更', async () => {
  const root = workspace();
  const index = emptyIndex();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index,
    sourcePath: sourceSkill('code-review'),
    now: NOW,
    dryRun: true,
  });
  assert.equal(outcome.preview, true);
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index, index, '预演必须原样返回索引，调用方据此跳过写入');
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写入中心库');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得创建副本');
  assert.equal(outcome.changes.length, 2, '应返回将发生的两项变更');
  assert.equal(outcome.data['status'], 'enabled');
});

test('预演：内容指纹与实装一致，因为指纹在写入中心库之前计算', async () => {
  const root = workspace();
  const source = sourceSkill('code-review');
  const preview = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: source,
    now: NOW,
    dryRun: true,
  });
  const real = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: source,
    now: NOW,
  });
  assert.equal(preview.data['checksum'], real.data['checksum']);
});

test('仅落库：只写中心库与登记记录，不分发到目标位置', async () => {
  const root = workspace();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
    libraryOnly: true,
  });
  assert.deepEqual(outcome.findings, []);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '中心库原件应落位');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '不得分发到目标位置');

  const record = outcome.index.skills[0];
  assert.equal(record?.status, 'disabled', '仅落库时状态置为已禁用');
  assert.deepEqual(record?.targets, [{ target: 'claude', scope: 'global', enabled: false }]);
  assert.equal(outcome.data['library_only'], true);
});

test('安装登记的状态置为已启用，不沿用元文件的声明值', async () => {
  const root = workspace();
  const outcome = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review', { status: 'disabled' }),
    now: NOW,
  });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index.skills[0]?.status, 'enabled');
});

test('预演：卸载不删除任何文件，原样返回索引并列出将删除的路径', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
    dryRun: true,
  });
  assert.equal(outcome.preview, true);
  assert.equal(outcome.index, installed.index, '预演必须原样返回索引');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得清理副本');
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '预演不得删除原件');
  // 影响范围统一用相对工作区的路径表达，便于跨机器阅读
  assert.deepEqual(outcome.data['would_remove'], ['.claude/skills/code-review']);
  assert.deepEqual(outcome.data['would_remove_detail'], [
    {
      path: '.claude/skills/code-review',
      file_count: 1,
      files: ['.claude/skills/code-review/SKILL.md'],
    },
  ]);
});

test('备份：卸载默认生成备份，载荷含备份位置、时间戳与文件数', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
  });
  const dir = join(root, 'backups', 'code-review', timestampToDirName(LATER));
  assert.equal(outcome.data['backup_path'], `backups/code-review/${timestampToDirName(LATER)}`);
  assert.equal(outcome.data['backup_timestamp'], LATER);
  assert.equal(outcome.data['backup_file_count'], 2, '含元文件与内容文件');
  assert.ok(existsSync(join(dir, 'backup_meta.yaml')), '应写出备份清单');
  assert.deepEqual(
    readFileSync(join(dir, BACKUP_CONTENT_DIR_NAME, 'SKILL.md')),
    readFileSync(join(root, 'skills', 'code-review', 'SKILL.md')),
    '备份内容应与原件一致',
  );
});

test('备份：--hard 删除原件前同样先备份', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
    hard: true,
  });
  const dir = join(
    root,
    'backups',
    'code-review',
    timestampToDirName(LATER),
    BACKUP_CONTENT_DIR_NAME,
  );
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '原件应被删除');
  assert.ok(existsSync(join(dir, 'SKILL.md')), '删除原件后仍能从备份回溯内容');
});

test('备份：备份失败时卸载中止，副本、原件与索引记录都不动', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  // 用同名文件占住 backups/<标识>，使备份目录无法创建
  writeFileSync(join(root, 'backups', 'code-review'), 'occupied');

  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(codesOf(outcome.findings), [CODES.BACKUP_UNAVAILABLE]);
  assert.equal(outcome.data['rejected'], 'backup_failed');
  assert.equal(outcome.index, installed.index, '索引必须原样返回');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '副本不得被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '原件不得被删除');
});

test('备份：重复卸载已移除的标识不产生新的备份', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
  });
  const second = uninstallSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(codesOf(second.findings), [CODES.INPUT_INVALID_ARG]);
  const dirs = readdirSync(join(root, 'backups', 'code-review'));
  assert.equal(dirs.length, 1, '只在第一次卸载时产生备份');
});

test('备份：中心库原件不存在时无备份可做，副本仍按约定被回收', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });

  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
  });
  assert.equal(outcome.data['backup_path'], undefined);
  assert.match(String(outcome.data['backup_reason']), /没有可备份的内容/);
  assert.equal(outcome.index.skills.length, 0, '记录仍应被移除');
  // 副本位置由目标落位根约定推导，不依赖原件是否存在——这正是 N-09 要解决的场景
  assert.deepEqual(outcome.findings, [], '不再因为原件缺失而无法定位副本');
  assert.deepEqual(outcome.data['removed_copies'], ['.claude/skills/code-review']);
  assert.deepEqual(outcome.data['removed_files'], ['.claude/skills/code-review/SKILL.md']);
  assert.equal(outcome.data['removed_file_count'], 1);
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '副本已被回收');
});

test('备份：预演不产生备份', async () => {
  const root = workspace();
  const installed = await installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill('code-review'),
    now: NOW,
  });
  const outcome = uninstallSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'code-review',
    now: LATER,
    dryRun: true,
  });
  assert.equal(outcome.data['backup_planned'], true);
  assert.ok(!existsSync(join(root, 'backups', 'code-review')), '预演不得写盘');
});
