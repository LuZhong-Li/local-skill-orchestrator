import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SEED,
  DISTRIBUTION,
  INVALID_KIND_CODES,
  allocateExact,
  mulberry32,
  planFixture,
  writeFixture,
} from '../../scripts/bench/fixture.mjs';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';

const NOW = '2026-10-16T00:00:00Z';
const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

type Plan = ReturnType<typeof planFixture>;
type Skill = Plan['skills'][number];

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function withFixture<T>(n: number, body: (root: string, plan: Plan) => T, seed = DEFAULT_SEED): T {
  const root = makeTempDir(`bench-fixture-${String(n)}-`);
  try {
    const plan = planFixture({ seed, n });
    writeFixture(plan, root);
    return body(root, plan);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 与 `planFixture` 第九步同口径的有效无效推导：自身无效，或依赖链上级联 */
function derivedInvalid(plan: Plan): { own: Map<string, string>; cascade: Set<string> } {
  const own = new Map<string, string>();
  for (const skill of plan.skills) {
    if (skill.invalidKind !== null) own.set(skill.indexId, INVALID_KIND_CODES[skill.invalidKind]);
    else if (skill.danglingDep !== null) own.set(skill.indexId, 'E-DEP-001');
  }
  const cascade = new Set<string>();
  for (const skill of plan.skills) {
    if (own.has(skill.indexId)) continue;
    if (skill.dependsOn.some((dep) => own.has(dep) || cascade.has(dep))) cascade.add(skill.indexId);
  }
  return { own, cascade };
}

test('T0 夹具：PRNG 与精确配额本身确定性', () => {
  const first = mulberry32(1234);
  const second = mulberry32(1234);
  const series = Array.from({ length: 5 }, () => first());
  assert.deepEqual(
    series,
    Array.from({ length: 5 }, () => second()),
    '同种子必须给出同序列',
  );
  assert.deepEqual(allocateExact(37, [0.4, 0.45, 0.15]), [15, 17, 5], '配额之和必须等于总数');
  assert.equal(
    allocateExact(1000, [0.4, 0.45, 0.15]).reduce((sum, value) => sum + value, 0),
    1000,
  );
});

test('T0 夹具：同种子同规模结构一致，换种子结构不同', () => {
  const a = planFixture({ seed: DEFAULT_SEED, n: 100 });
  const b = planFixture({ seed: DEFAULT_SEED, n: 100 });
  assert.deepEqual(a, b, '同种子 + 同规模的两次计划必须深度相等（含文本与资产大小）');

  const other = planFixture({ seed: DEFAULT_SEED + 1, n: 100 });
  assert.equal(other.counts.files, a.counts.files, '配额化后文件数与种子无关');
  assert.notDeepEqual(
    other.skills.map((skill) => skill.description),
    a.skills.map((skill) => skill.description),
    '换种子必须给出不同内容',
  );
});

test('T0 夹具：分布参数逐项符合冻结取值（类别 / 无效五类 / 描述档 / 资产 / 依赖 / 悬空）', () => {
  const plan = planFixture({ seed: DEFAULT_SEED, n: 1000 });
  const { counts, skills } = plan;

  assert.deepEqual(
    [counts.valid, counts.warned, counts.invalid],
    allocateExact(1000, [
      DISTRIBUTION.categories.valid,
      DISTRIBUTION.categories.warned,
      DISTRIBUTION.categories.invalid,
    ]),
    '三类占比按精确配额',
  );
  for (const kind of DISTRIBUTION.invalidKinds) {
    assert.ok(counts.invalidByKind[kind] >= 1, `无效类 ${kind} 至少 1 例`);
  }
  assert.equal(
    Object.values(counts.invalidByKind).reduce((sum, value) => sum + value, 0),
    counts.invalid,
    '五类合计等于无效总数',
  );

  for (const band of DISTRIBUTION.descriptionBands.map((item) => item.name)) {
    assert.ok(
      skills.some((skill) => skill.band === band),
      `描述长度档 ${band} 应有样本`,
    );
  }
  const byOrdinal = new Map(skills.map((skill) => [skill.indexId, skill]));
  for (const skill of skills) {
    assert.ok(skill.description.length <= 1024, '描述不得超过规范上限');
    assert.ok(skill.triggerKeywords.length <= DISTRIBUTION.triggerKeywords.max);
    for (const keyword of skill.triggerKeywords) {
      assert.ok(keyword.length <= DISTRIBUTION.triggerKeywords.maxLength);
    }
    assert.ok(skill.assets.length <= 4, '每技能资产数上限为 4');
    for (const asset of skill.assets) {
      assert.ok(asset.bytes >= 1024 && asset.bytes <= 1024 * 128, '资产大小落在 1 KB ~ 128 KB');
      assert.ok(Number.isInteger(Math.log2(asset.bytes / 1024)), '资产大小取 2 的整数次幂');
    }
    assert.ok(skill.dependsOn.length <= 3, '夹具内依赖出度上限为 3');
    // 依赖图是不变量：依赖一律指向更小序号 → 构造上必然无环
    for (const dep of skill.dependsOn) {
      const target = byOrdinal.get(dep);
      assert.ok(target !== undefined, `依赖目标 ${dep} 必须存在于夹具内`);
      assert.ok(
        target.ordinal < skill.ordinal,
        `依赖必须指向更小序号（${skill.indexId} → ${dep}），保证依赖图无环`,
      );
    }
  }
  assert.equal(counts.dangling, allocateExact(1000, [0.95, 0.05])[1], '悬空依赖占 5%');
  assert.equal(
    counts.dependsOnInvalid.length,
    DISTRIBUTION.dependsOnInvalidMinimum,
    '「被依赖方无效」的叶子依赖方个数固定',
  );
  assert.equal(counts.cascadeChain.length, DISTRIBUTION.cascadeChainDepth, '级联链长度固定');
  assert.ok(counts.maxInDegree <= DISTRIBUTION.maxInDegree, '扇入上界由构造保证');
  assert.ok(counts.assets > 0 && counts.edges > 0);
});

test('T0 夹具：有效无效数可推导（自身无效 + 级联），且等于内核判定', () => {
  withFixture(100, (root, plan) => {
    const { own, cascade } = derivedInvalid(plan);
    assert.equal(
      plan.counts.effectiveInvalid,
      own.size + cascade.size,
      '计划的有效无效数 = 自身无效 + 级联无效',
    );
    assert.equal(plan.counts.ownInvalid, own.size);
    assert.equal(plan.counts.cascadeInvalid, cascade.size);

    const outcome = scanWorkspace({
      layout: layoutOf(root),
      index: createInitialIndex(NOW),
      now: NOW,
    });
    assert.equal(outcome.summary.invalid, plan.counts.effectiveInvalid, '内核无效数等于推导值');
    assert.equal(
      outcome.summary.available,
      plan.counts.skills - plan.counts.effectiveInvalid,
      '可用数与无效数互补',
    );
  });
});

test('T0 夹具：无效样本在内核判定下真的无效（五类问题码 + 级联 + 警告锚点）', () => {
  withFixture(100, (root, plan) => {
    const { own, cascade } = derivedInvalid(plan);
    const outcome = scanWorkspace({
      layout: layoutOf(root),
      index: createInitialIndex(NOW),
      now: NOW,
    });

    for (const skill of plan.skills) {
      const record = outcome.index.skills.find((item) => item.id === skill.indexId);
      assert.ok(record !== undefined, `索引中应存在 ${skill.indexId}`);
      const ownCode = own.get(skill.indexId);
      if (ownCode !== undefined) {
        assert.equal(record.validation.status, 'invalid', `${skill.indexId} 应判无效`);
        assert.ok(
          record.validation.errors.includes(ownCode),
          `${skill.indexId} 应命中 ${ownCode}，实得 ${record.validation.errors.join(',')}`,
        );
        continue;
      }
      if (cascade.has(skill.indexId)) {
        assert.equal(record.validation.status, 'invalid', `${skill.indexId} 应因级联判无效`);
        assert.ok(record.validation.errors.includes('E-VALIDATION-002'));
        continue;
      }
      assert.equal(record.validation.status, 'ok', `${skill.indexId} 应判可用`);
      assert.deepEqual(
        record.validation.errors,
        skill.category === 'warned' ? ['W-FIELD-004'] : [],
        `${skill.indexId} 的问题码集合应为预期`,
      );
    }

    const kindsSeen = new Set(
      plan.skills.filter((skill) => skill.invalidKind !== null).map((skill) => skill.invalidKind),
    );
    assert.equal(kindsSeen.size, DISTRIBUTION.invalidKinds.length, '五类无效样本都必须实际出现');
  });
});

test('T0 夹具：N=1000 落盘规模（文件数按公式、占用与设计同量级）', () => {
  withFixture(1000, (root, plan) => {
    assert.equal(
      plan.counts.files,
      3000 - 2 * plan.counts.noContent,
      '文件数 = 3N − 2 × 内容缺失样本数',
    );
    assert.equal(countFiles(join(root, 'skills')), plan.counts.files, '磁盘文件数与计划一致');
    const mib = plan.counts.bytes / 1024 / 1024;
    assert.ok(mib > 24 && mib < 44, `N=1000 占用应与设计同量级（实测 ${mib.toFixed(1)} MB）`);
  });
});

test('T0 夹具：内容差异只在声明的维度上（结构差异抽样）', () => {
  const plan = planFixture({ seed: DEFAULT_SEED, n: 100 });
  const invalid = plan.skills.filter((skill: Skill) => skill.invalidKind !== null);
  assert.equal(invalid.length, plan.counts.invalid);
  const noContent = plan.skills.filter((skill: Skill) => skill.invalidKind === 'no-content');
  for (const skill of noContent) {
    assert.equal(skill.skillMdText, null, '内容缺失样本不产出 SKILL.md');
    assert.equal(skill.assets.length, 0, '内容缺失样本不产出资产');
  }
  for (const skill of plan.skills) {
    if (skill.invalidKind !== 'no-content') {
      assert.equal(
        skill.files.some((file) => file.path === 'SKILL.md'),
        true,
      );
    }
    assert.equal(skill.files[0].path, 'skill_meta.yaml');
  }
});

test('T0 夹具：命令行入口的失败路径可定位（独立进程断言，非零退出码 + 明确原因）', () => {
  const cli = join(root, 'scripts', 'bench', 'fixture-cli.mjs');
  for (const [args, expected] of [
    [['--n', '0'], '--n 必须是正整数'],
    [['--bogus'], '未知选项'],
    [['--n'], '缺少取值'],
  ] as Array<[string[], string]>) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${args.join(' ')} 应以非零退出码失败`);
    assert.ok(
      String(result.stderr).includes(expected),
      `${args.join(' ')} 的错误信息应包含「${expected}」，实得 ${String(result.stderr)}`,
    );
  }

  // 正常路径：显式 --root 落盘，且不在仓库内
  const target = makeTempDir('bench-cli-');
  try {
    const result = spawnSync(process.execPath, [cli, '--n', '50', '--root', target], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, String(result.stderr));
    const summary = JSON.parse(String(result.stdout)) as { counts: { files: number } };
    assert.equal(summary.counts.files, countFiles(join(target, 'skills')));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
