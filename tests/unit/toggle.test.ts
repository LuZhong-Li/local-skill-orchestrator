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
import { disableSkill, enableSkill, updateSkill } from '../../kernel/core/lifecycle/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf, ensureWorkspaceDirs } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T02:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-toggle-'));
  ensureWorkspaceDirs(layoutOf(root));
  return root;
}

function putSkill(root: string, id: string, extra = '', body = '# skill'): void {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1.0.0',
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
      extra,
      '',
    ].join('\n'),
  );
}

/** 造一个已扫描的工作区：good 合格，broken 依赖不存在的目标 */
function scenario(): { root: string; layout: ReturnType<typeof layoutOf>; index: SkillIndex } {
  const root = workspace();
  putSkill(root, 'good');
  putSkill(root, 'broken', 'dependencies:\n  skills:\n    - ghost');
  const layout = layoutOf(root);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  return { root, layout, index: scanned.index };
}

function copyNames(root: string, id: string): string[] {
  const target = join(root, '.claude', 'skills', id);
  return existsSync(target) ? readdirSync(target).sort() : [];
}

function hasCopy(root: string, id: string): boolean {
  return existsSync(join(root, '.claude', 'skills', id));
}

test('K-04 启用：校验不通过的记录被拒绝，且文案不得表述为已禁用', async () => {
  const { layout, index } = scenario();
  const outcome = enableSkill({ layout, index, id: 'broken', now: LATER });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.VALIDATION_REJECTED],
  );
  assert.equal(outcome.findings[0]?.severity, 'error');
  assert.equal(outcome.data['rejected'], 'validation_failed');
  assert.deepEqual(outcome.data['problem_codes'], [CODES.DEP_MISSING]);
  assert.equal(outcome.index, index, '拒绝时索引原样返回');
  assert.ok(
    !String(outcome.findings[0]?.remedy).includes('该 Skill 已被禁用'),
    '不得把校验不通过表述为用户禁用',
  );
});

test('K-04 启用：未登记的标识返回输入类问题', async () => {
  const { layout, index } = scenario();
  const outcome = enableSkill({ layout, index, id: 'nosuch', now: LATER });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.equal(outcome.data['rejected'], 'not_registered');
});

test('K-04 启用：依赖未满足时拒绝，并给出补齐建议', async () => {
  const { layout, index } = scenario();
  // 把 broken 的运行期结论改为通过，模拟结论过期，触发依赖的实时判定
  const refreshed: SkillIndex = {
    ...index,
    skills: index.skills.map((record) =>
      record.id === 'broken' ? { ...record, validation: { status: 'ok', errors: [] } } : record,
    ),
  };
  const outcome = enableSkill({ layout, index: refreshed, id: 'broken', now: LATER });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.DEP_MISSING],
  );
  assert.equal(outcome.data['rejected'], 'dependency_unmet');
  assert.match(String(outcome.findings[0]?.remedy), /请先安装/);
});

test('K-04 启用：副本缺失时按需补齐，并把索引状态与目标摘要置为已启用', async () => {
  const { root, layout, index } = scenario();
  assert.ok(!hasCopy(root, 'good'), '扫描不负责分发');

  const outcome = enableSkill({ layout, index, id: 'good', now: LATER });
  assert.deepEqual(outcome.findings, []);
  // 元文件提供的逐文件映射只列出 SKILL.md，因此副本只落这一个文件
  assert.deepEqual(copyNames(root, 'good'), ['SKILL.md'], '副本按映射被补齐');
  const record = outcome.index.skills.find((item) => item.id === 'good');
  assert.equal(record?.status, 'enabled');
  assert.equal(record?.targets[0]?.enabled, true);
  assert.equal(record?.updated_at, LATER, '状态变更刷新最近变更时间');
  assert.equal(
    outcome.changes.filter((item) => item.kind === 'target_copy').length,
    1,
    '补齐记入文件变更明细',
  );
});

test('K-04 启用：副本处于禁用态时把技能元数据文件改回原名', async () => {
  const { root, layout, index } = scenario();
  const enabled = enableSkill({ layout, index, id: 'good', now: LATER });
  const disabled = disableSkill({ layout, index: enabled.index, id: 'good', now: LATER });
  assert.deepEqual(copyNames(root, 'good'), ['SKILL.md.disabled']);

  const again = enableSkill({ layout, index: disabled.index, id: 'good', now: LATER });
  assert.deepEqual(copyNames(root, 'good'), ['SKILL.md']);
  assert.equal(again.index.skills.find((item) => item.id === 'good')?.status, 'enabled');
});

test('K-04 启用与禁用：重复执行不产生额外变更', async () => {
  const { layout, index } = scenario();
  const first = enableSkill({ layout, index, id: 'good', now: LATER });
  const second = enableSkill({ layout, index: first.index, id: 'good', now: LATER });
  assert.deepEqual(second.changes, [], '已启用时重复启用不产生变更');

  const off = disableSkill({ layout, index: second.index, id: 'good', now: LATER });
  const offAgain = disableSkill({ layout, index: off.index, id: 'good', now: LATER });
  assert.deepEqual(offAgain.changes, []);
});

test('K-04 禁用：不改动任何内容文件，也不触发内容分发', async () => {
  const { root, layout, index } = scenario();
  const enabled = enableSkill({ layout, index, id: 'good', now: LATER });
  // 把禁用标记归一化为原名，得到与可见性无关的内容文件集合
  const logical = (names: string[]): string[] =>
    names.map((name) => (name === 'SKILL.md.disabled' ? 'SKILL.md' : name)).sort();
  const before = logical(copyNames(root, 'good'));
  const outcome = disableSkill({ layout, index: enabled.index, id: 'good', now: LATER });
  assert.deepEqual(outcome.findings, []);
  const after = copyNames(root, 'good');
  assert.deepEqual(logical(after), before, '没有内容文件被增删');
  assert.equal(after.length, before.length, '文件数量不变');
  assert.ok(after.includes('SKILL.md.disabled'), '只把技能元数据文件改为禁用态');
  assert.ok(after.includes('SKILL.md.disabled'), '技能元数据文件改为禁用态');
  assert.equal(
    outcome.changes.filter((item) => item.kind === 'target_copy').length,
    0,
    '禁用不分发内容',
  );
});

test('K-04 禁用：副本尚未落位时只更新索引，并在载荷中说明', async () => {
  const { layout, index } = scenario();
  const outcome = disableSkill({ layout, index, id: 'good', now: LATER });
  assert.equal(outcome.index.skills.find((item) => item.id === 'good')?.status, 'disabled');
  assert.match(String((outcome.data['actions'] as string[])[0]), /尚未落位/);
});

test('K-04 启用与禁用往返：副本命名与相对路径关系不变', async () => {
  const { root, layout, index } = scenario();
  const enabled = enableSkill({ layout, index, id: 'good', now: LATER });
  const firstOff = disableSkill({ layout, index: enabled.index, id: 'good', now: LATER });
  const snapshot = copyNames(root, 'good');
  const back = enableSkill({ layout, index: firstOff.index, id: 'good', now: LATER });
  const secondOff = disableSkill({ layout, index: back.index, id: 'good', now: LATER });
  assert.ok(secondOff.index.skills.some((item) => item.id === 'good'));
  assert.deepEqual(copyNames(root, 'good'), snapshot, '往返后副本内容与命名集合一致');
});

test('K-04 启用：预演不落盘且给出将发生的变更', async () => {
  const { root, layout, index } = scenario();
  const outcome = enableSkill({ layout, index, id: 'good', now: LATER, dryRun: true });
  assert.equal(outcome.preview, true);
  assert.equal(outcome.index, index, '预演原样返回索引');
  assert.ok(!hasCopy(root, 'good'), '预演不落盘');
  assert.deepEqual(outcome.data['status_after'], 'enabled');
});

test('K-04 刷新：重算指纹、刷新最近变更时间、首次登记时间不变、版本变化入载荷', async () => {
  const { root, layout, index } = scenario();
  const metaFile = join(root, 'skills', 'good', 'skill_meta.yaml');
  const before = readFileSync(metaFile, 'utf8');
  writeFileSync(metaFile, before.replace('version: 1.0.0', 'version: 2.0.0'));
  writeFileSync(join(root, 'skills', 'good', 'SKILL.md'), '# skill changed');

  const record = index.skills.find((item) => item.id === 'good');
  const outcome = await updateSkill({ layout, index, id: 'good', now: LATER });
  const next = outcome.index.skills.find((item) => item.id === 'good');

  assert.equal(outcome.data['version_before'], '1.0.0');
  assert.equal(outcome.data['version_after'], '2.0.0');
  assert.equal(outcome.data['version_changed'], true);
  assert.equal(next?.version, '2.0.0', '声明区投影按元文件刷新');
  assert.equal(next?.created_at, record?.created_at, '首次登记时间不变');
  assert.equal(next?.updated_at, LATER);
  assert.notEqual(next?.checksum, record?.checksum, '内容指纹按磁盘重算');
  assert.equal(outcome.data['checksum_after'], next?.checksum);
  assert.ok(
    outcome.findings.some((item) => item.code === CODES.DRIFT && item.severity === 'warning'),
  );
  assert.equal(
    readFileSync(metaFile, 'utf8').includes('version: 2.0.0'),
    true,
    '元文件本身不被改写，仍保留调用方写入的内容',
  );
});

test('K-04 刷新：元文件缺失时按既有错误码返回且不写索引', async () => {
  const { root, layout, index } = scenario();
  writeFileSync(join(root, 'skills', 'good', 'skill_meta.yaml'), '');
  const outcome = await updateSkill({ layout, index, id: 'good', now: LATER });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.YAML_INVALID],
  );
  assert.equal(outcome.index, index);
  assert.equal(outcome.data['rejected'], 'meta_unreadable');
});

test('K-04 刷新：远端来源不可达时按来源类问题返回且不刷新记录', async () => {
  const { root, layout, index } = scenario();
  // 元文件声明为远端仓库，地址指向本机一个不会有人在听的端口，失败快且不依赖外网
  const metaFile = join(root, 'skills', 'good', 'skill_meta.yaml');
  writeFileSync(
    metaFile,
    readFileSync(metaFile, 'utf8').replace(
      '  type: local',
      '  type: git\n  url: http://127.0.0.1:9/repo.git\n  ref: main',
    ),
  );
  const outcome = await updateSkill({ layout, index, id: 'good', now: LATER });
  const code = String(outcome.findings[0]?.code);
  assert.ok(code.startsWith('E-SRC-'), `应归入来源类问题，实际：${code}`);
  assert.equal(outcome.data['rejected'], 'source_unavailable');
  assert.equal(outcome.index, index, '拒绝时索引原样返回');
});

test('K-04 刷新：检查模式只报告不写盘', async () => {
  const { layout, index } = scenario();
  const outcome = await updateSkill({ layout, index, id: 'good', now: LATER, check: true });
  assert.equal(outcome.index, index, '检查模式原样返回索引');
  assert.deepEqual(outcome.changes, []);
  assert.equal(outcome.preview, true);
  assert.equal(outcome.data['checked'], true);
});

test('K-04 刷新：未登记的标识返回输入类问题', async () => {
  const { layout, index } = scenario();
  const outcome = await updateSkill({ layout, index, id: 'nosuch', now: LATER });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
});
