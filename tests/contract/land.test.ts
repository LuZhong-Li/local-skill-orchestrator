import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../../kernel/core/adapters/index.ts';
import { rebasePlan } from '../../kernel/core/adapters/plan.ts';
import {
  isHostSkillDisabled,
  landPlan,
  setHostSkillVisibility,
} from '../../kernel/core/adapters/land.ts';
import {
  defaultRootFor,
  resolveHostRoot,
  rootConfigKey,
} from '../../kernel/core/adapters/roots.ts';
import type { PlacementPlan } from '../../kernel/core/adapters/types.ts';
import type { RenderSource } from '../../kernel/core/render/types.ts';
import { ensureWorkspaceDirs, layoutOf } from '../../kernel/store/workspace/index.ts';

const NOW = '2026-10-15T00:00:00Z';

function sample(overrides: Partial<RenderSource> = {}): RenderSource {
  return {
    id: 'demo-skill',
    description: '演示用技能：落位契约测试',
    body: '# demo-skill\n\n正文。',
    ...overrides,
  };
}

/** 临时工作区（含标准目录） */
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-land-'));
  ensureWorkspaceDirs(layoutOf(dir));
  return dir;
}

/** 临时宿主根（测试用配置覆盖，绝不触碰真实宿主目录） */
function tempHostRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sm-host-'));
}

test('契约：外部根解析——默认值平台展开与配置覆盖', () => {
  const workspaceRoot = tempWorkspace();

  // 默认值：按宿主惯例与平台展开
  assert.equal(
    defaultRootFor('claude', 'skill', { home: '/home/u', platform: 'linux', env: {} }),
    join('/home/u', '.claude', 'skills'),
  );
  assert.equal(
    defaultRootFor('codex', 'skill', { home: '/home/u', platform: 'darwin', env: {} }),
    join('/home/u', '.agents', 'skills'),
    'Codex 用户级技能根依官方文档为 $HOME/.agents/skills',
  );
  assert.equal(
    defaultRootFor('cursor', 'rules', { home: '/home/u', platform: 'linux', env: {} }),
    join('/home/u', '.cursor', 'rules'),
  );
  const doubaoDefault = defaultRootFor('doubao', 'external', {
    home: 'C:/Users/u',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' },
  });
  assert.match(String(doubaoDefault), /agent_mode[\\/]workspace[\\/]\.user_skills$/);
  assert.equal(
    defaultRootFor('doubao', 'external', { home: '/home/u', platform: 'linux', env: {} }),
    undefined,
    '非 Windows 平台缺少豆包实测证据，不给默认值',
  );
  assert.equal(
    defaultRootFor('agentskills', 'skill', { home: '/home/u', platform: 'linux', env: {} }),
    undefined,
    '通用标准目标不绑定宿主目录',
  );

  // 无默认值且无配置：明确报错，不猜测路径
  const unresolved = resolveHostRoot({
    hostId: 'agentskills',
    workspaceRoot,
    config: {},
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.equal(unresolved?.path, '');
  assert.ok(
    unresolved?.findings.some((item) => item.code === 'E-FIELD-001'),
    '缺少默认值且无配置覆盖时应报必填类问题',
  );

  // 配置覆盖生效，且工作区外的根标记为 external
  const hostRoot = tempHostRoot();
  const overridden = resolveHostRoot({
    hostId: 'claude',
    workspaceRoot,
    config: { [rootConfigKey('claude', 'skill')]: hostRoot },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.equal(overridden?.path, hostRoot);
  assert.equal(overridden?.source, 'config');
  assert.equal(overridden?.external, true);
  assert.deepEqual(overridden?.findings, []);

  // 非法根：已存在但不是目录
  const filePath = join(hostRoot, 'not-a-dir');
  writeFileSync(filePath, 'x');
  const invalid = resolveHostRoot({
    hostId: 'claude',
    workspaceRoot,
    config: { [rootConfigKey('claude', 'skill')]: filePath },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.ok(
    invalid?.findings.some((item) => item.code === 'E-PATH-001'),
    '落位根是文件时应报路径类错误',
  );

  // 未登记宿主：没有根可解析
  assert.equal(resolveHostRoot({ hostId: 'deepseek', workspaceRoot }), undefined);
  assert.equal(resolveHostRoot({ hostId: 'unknown', workspaceRoot }), undefined);
});

test('契约：Codex 落位计划重定基到官方 agents 根，遗留根仅经配置生效且不双写', () => {
  const workspaceRoot = tempWorkspace();
  const source = sample();
  const plan = adapterFor('codex')!.plan(source);

  // 默认：官方 agents 根（与 Cursor、dsh 共享同一根）
  const fallback = resolveHostRoot({
    hostId: 'codex',
    workspaceRoot,
    config: {},
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.equal(fallback?.path, join('/home/u', '.agents', 'skills'));
  assert.equal(fallback?.source, 'default');
  assert.equal(fallback?.external, true);
  assert.deepEqual(fallback?.findings, []);

  const rebased = rebasePlan(plan, fallback!.path, fallback!.external);
  assert.equal(rebased.entries.length, 1, '技能形态只产出一条落位项');
  assert.equal(
    rebased.entries[0]!.target_path,
    join('/home/u', '.agents', 'skills', source.id, 'SKILL.md'),
  );
  assert.equal(rebased.entries[0]!.external, true);
  assert.equal(
    rebased.entries.some((entry) => entry.root_path.includes('.codex')),
    false,
    '默认不得同时写旧版兼容根（不双写）',
  );
  assert.deepEqual(
    rebased.overlaps,
    [
      {
        root_path: join('/home/u', '.agents', 'skills', source.id),
        consumed_by: ['codex', 'cursor', 'dsh'],
      },
    ],
    'agents 根的重叠消费应如实声明（codex / cursor / dsh）',
  );

  // 遗留兼容根：旧版本用户用配置覆盖回 ~/.codex/skills，仍然只有一条落位项
  const legacy = resolveHostRoot({
    hostId: 'codex',
    workspaceRoot,
    config: { [rootConfigKey('codex', 'skill')]: join('/home/u', '.codex', 'skills') },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.equal(legacy?.source, 'config');
  const legacyRebased = rebasePlan(plan, legacy!.path, legacy!.external);
  assert.equal(legacyRebased.entries.length, 1);
  assert.equal(
    legacyRebased.entries[0]!.target_path,
    join('/home/u', '.codex', 'skills', source.id, 'SKILL.md'),
    '配置覆盖后落位到遗留兼容根',
  );
  assert.equal(
    legacyRebased.entries.some((entry) => entry.root_path.includes('.agents')),
    false,
    '覆盖后不得同时写官方根（不双写）',
  );
});

test('契约：落位写盘到宿主真实根（技能形态），原子写无残留', () => {
  const workspaceRoot = tempWorkspace();
  const hostRoot = tempHostRoot();
  const layout = layoutOf(workspaceRoot);
  const source = sample();
  const plan = adapterFor('claude')!.plan(source);

  // 目标根由配置覆盖指向临时目录，绝不触碰真实宿主根
  const resolved = resolveHostRoot({
    hostId: 'claude',
    workspaceRoot,
    config: { [rootConfigKey('claude', 'skill')]: hostRoot },
    home: '/home/u',
    platform: 'linux',
    env: {},
  });
  assert.equal(resolved?.findings.length, 0);
  plan.entries[0]!.target_path = join(hostRoot, source.id, 'SKILL.md');
  plan.entries[0]!.root_path = join(hostRoot, source.id);

  const result = landPlan({ plan, workspace: layout, now: NOW });
  assert.equal(result.dry_run, false);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.action, 'add');
  assert.deepEqual(result.skipped, []);

  const written = join(hostRoot, source.id, 'SKILL.md');
  assert.equal(existsSync(written), true);
  const content = readFileSync(written, 'utf8');
  assert.match(content, /^---\n/, '产物应为技能形态（YAML 元数据块开头）');
  assert.match(content, /name: demo-skill/);

  // 原子写：目录内不应残留临时文件
  const leftovers = readdirSync(join(hostRoot, source.id)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不应留下临时文件');

  // 手工构造重复目标路径：同一路径只写一次（重叠消费不重复产出）
  const duplicated: PlacementPlan = {
    ...plan,
    entries: [{ ...plan.entries[0]! }, { ...plan.entries[0]! }],
  };
  const second = landPlan({ plan: duplicated, workspace: layout, now: NOW });
  assert.equal(second.changes.length, 1, '同一目标路径只落位一次');
  assert.ok(
    second.findings.some((item) => item.code === 'E-CONFLICT-003'),
    '重复目标路径应回报冲突类警告',
  );
});

test('契约：备份先行——写前备份既有内容，备份失败即中止且不改动环境', () => {
  const workspaceRoot = tempWorkspace();
  const hostRoot = tempHostRoot();
  const layout = layoutOf(workspaceRoot);
  const source = sample();

  // 既有宿主副本（旧内容），落位前应先备份
  const targetDir = join(hostRoot, source.id);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'SKILL.md'), '旧内容');

  const plan = adapterFor('claude')!.plan(source);
  plan.entries[0]!.root_path = targetDir;
  plan.entries[0]!.target_path = join(targetDir, 'SKILL.md');

  const result = landPlan({ plan, workspace: layout, now: NOW });
  assert.equal(result.backups.length, 1, '写工作区外目标前应产生备份');
  // portableDir 已含 backups/ 前缀，直接相对工作区拼接
  const backupContent = join(
    workspaceRoot,
    ...result.backups[0]!.split('/'),
    'content',
    'SKILL.md',
  );
  assert.equal(readFileSync(backupContent, 'utf8'), '旧内容', '备份应保存写前内容');
  assert.match(readFileSync(join(targetDir, 'SKILL.md'), 'utf8'), /name: demo-skill/);
  assert.equal(result.changes[0]!.action, 'modify');

  // 备份失败中止：既有落位内容不是目录（技能形态需要目录型备份载体）
  const brokenRoot = tempHostRoot();
  const brokenTarget = join(brokenRoot, source.id, 'SKILL.md');
  mkdirSync(join(brokenRoot, source.id), { recursive: true });
  writeFileSync(brokenTarget, '旧内容');
  const brokenPlan = adapterFor('claude')!.plan(source);
  // 把目标目录指到一个文件上，制造「既有内容不是目录」的情形
  const fileInsteadOfDir = join(brokenRoot, 'file-target');
  writeFileSync(fileInsteadOfDir, 'x');
  brokenPlan.entries[0]!.root_path = fileInsteadOfDir;
  brokenPlan.entries[0]!.target_path = join(fileInsteadOfDir, 'SKILL.md');
  assert.throws(
    () => landPlan({ plan: brokenPlan, workspace: layout, now: NOW }),
    /既有落位内容不是目录/,
    '备份失败应中止写盘',
  );
  assert.equal(readFileSync(fileInsteadOfDir, 'utf8'), 'x', '中止后既有内容未被改动');
});

test('契约：启用 / 禁用在宿主根内改名，目录不动（Q-06）', () => {
  const hostRoot = tempHostRoot();
  const skillId = 'demo-skill';
  const dir = join(hostRoot, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '内容');
  writeFileSync(join(dir, 'asset.txt'), '资产');

  const before = readdirSync(dir).sort();
  assert.equal(setHostSkillVisibility({ rootPath: hostRoot, skillId, enabled: false }), 'changed');
  assert.equal(isHostSkillDisabled({ rootPath: hostRoot, skillId }), true);
  assert.equal(existsSync(join(dir, 'SKILL.md')), false);
  assert.equal(existsSync(join(dir, 'SKILL.md.disabled')), true);
  assert.equal(existsSync(dir), true, '禁用不得移动或删除目录');
  assert.equal(
    setHostSkillVisibility({ rootPath: hostRoot, skillId, enabled: false }),
    'unchanged',
  );

  assert.equal(setHostSkillVisibility({ rootPath: hostRoot, skillId, enabled: true }), 'changed');
  assert.equal(isHostSkillDisabled({ rootPath: hostRoot, skillId }), false);
  assert.deepEqual(readdirSync(dir).sort(), before, '往返后文件集合不变');
  assert.equal(readFileSync(join(dir, 'asset.txt'), 'utf8'), '资产', '资产文件不受影响');
});

test('契约：指令文件载体不落盘、预演不触碰磁盘', () => {
  const workspaceRoot = tempWorkspace();
  const layout = layoutOf(workspaceRoot);
  const source = sample();
  const agentsMd = adapterFor('agents-md')!.plan(source);

  const result = landPlan({ plan: agentsMd, workspace: layout, now: NOW });
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 1);
  assert.match(String(result.skipped[0]!.reason), /合并策略未定稿/);
  assert.equal(result.backups.length, 0);

  // 预演：产出将执行的变更清单但不落盘
  const hostRoot = tempHostRoot();
  const plan = adapterFor('claude')!.plan(source);
  plan.entries[0]!.root_path = join(hostRoot, source.id);
  plan.entries[0]!.target_path = join(hostRoot, source.id, 'SKILL.md');
  const preview = landPlan({ plan, workspace: layout, now: NOW, dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.changes.length, 1);
  assert.match(String(preview.changes[0]!.detail), /预演/);
  assert.equal(existsSync(join(hostRoot, source.id)), false, '预演不得创建目录');
  assert.deepEqual(preview.backups, []);

  // 同时给出中心库原件时，资产按逐文件映射落位
  const libraryDir = mkdtempSync(join(tmpdir(), 'sm-lib-'));
  writeFileSync(join(libraryDir, 'SKILL.md'), '中心库原件');
  writeFileSync(join(libraryDir, 'asset.txt'), '资产');
  const withAssets = adapterFor('claude')!.plan(source);
  withAssets.entries[0]!.root_path = join(hostRoot, source.id);
  withAssets.entries[0]!.target_path = join(hostRoot, source.id, 'SKILL.md');
  landPlan({
    plan: withAssets,
    workspace: layout,
    now: NOW,
    sourceDir: libraryDir,
    fileMap: [
      { source: 'SKILL.md', destination: 'SKILL.md' },
      { source: 'asset.txt', destination: 'asset.txt' },
    ],
  });
  assert.equal(readFileSync(join(hostRoot, source.id, 'asset.txt'), 'utf8'), '资产');
  assert.match(
    readFileSync(join(hostRoot, source.id, 'SKILL.md'), 'utf8'),
    /name: demo-skill/,
    '渲染产物应覆盖中心库原件中的同名文件',
  );
});
