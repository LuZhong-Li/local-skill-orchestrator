import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES } from '../../kernel/store/contract.ts';
import { validateDependencies } from '../../kernel/core/metadata/validate.ts';

type Meta = Parameters<typeof validateDependencies>[0][number];

/** 造一条只带依赖声明的元数据（其余字段与本组用例无关） */
const meta = (id: string, skills: string[] = []): Meta =>
  ({ id, dependencies: { skills } }) as unknown as Meta;

const availabilityOf = (ids: string[], unavailable: string[] = []) =>
  new Map(ids.map((id) => [id, !unavailable.includes(id)]));

const cycleFindings = (findings: ReturnType<typeof validateDependencies>) =>
  findings.filter((item) => item.code === CODES.DEP_CYCLE).map((item) => item.target);
const dependencyFindings = (findings: ReturnType<typeof validateDependencies>) =>
  findings.filter((item) => item.code === CODES.VALIDATION_DEPENDENCY).map((item) => item.target);

test('环矩阵：自环 / 2 环 / 3 环——环上每个技能各一条，target 为自身，不叠加依赖未满足', () => {
  const cases: Array<{ name: string; metas: Meta[]; members: string[] }> = [
    { name: '自环', metas: [meta('a', ['a'])], members: ['a'] },
    { name: '2 环', metas: [meta('a', ['b']), meta('b', ['a'])], members: ['a', 'b'] },
    {
      name: '3 环',
      metas: [meta('a', ['b']), meta('b', ['c']), meta('c', ['a'])],
      members: ['a', 'b', 'c'],
    },
  ];
  for (const item of cases) {
    const ids = item.metas.map((entry) => entry.id);
    const findings = validateDependencies(item.metas, availabilityOf(ids));
    assert.deepEqual(
      cycleFindings(findings).sort(),
      [...item.members].sort(),
      `${item.name}：每个成员各一条`,
    );
    assert.deepEqual(
      dependencyFindings(findings),
      [],
      `${item.name}：环成员不叠加 E-VALIDATION-002`,
    );
  }
});

test('环矩阵（单轮）：只判直接依赖——直接下游带依赖未满足，传递下游由不动点下一轮补上', () => {
  const metas = [
    meta('a', ['b']),
    meta('b', ['a']),
    meta('c', ['a']),
    meta('d', ['b']),
    meta('e', ['c']),
  ];
  const ids = metas.map((entry) => entry.id);
  const findings = validateDependencies(metas, availabilityOf(ids, ['a', 'b']));
  assert.deepEqual(cycleFindings(findings).sort(), ['a', 'b']);
  assert.deepEqual(dependencyFindings(findings).sort(), ['c.dependencies', 'd.dependencies']);
  // e 依赖 c，而 c 在本轮仍可用 → 下一轮 c 被翻为不可用后 e 才会被报出（由扫描的不动点负责）
});

test('环矩阵：加/不加无关技能，结论完全一致（历史上会随技能数量奇偶翻转）', () => {
  const base = [meta('a', ['b']), meta('b', ['a']), meta('c', ['a'])];
  const withExtra = [...base, meta('d')];
  const run = (metas: Meta[]) =>
    validateDependencies(
      metas,
      availabilityOf(
        metas.map((entry) => entry.id),
        ['a', 'b'],
      ),
    )
      .map((item) => `${item.code}@${item.target}`)
      .sort();
  assert.deepEqual(run(withExtra), run(base));
});

test('环成员声明了不存在的依赖：环根因照报，缺失依赖这条可操作事实也保留', () => {
  const metas = [meta('a', ['b', 'ghost']), meta('b', ['a'])];
  const findings = validateDependencies(metas, availabilityOf(['a', 'b']));
  assert.deepEqual(cycleFindings(findings).sort(), ['a', 'b']);
  assert.deepEqual(
    findings.filter((item) => item.code === CODES.DEP_MISSING).map((item) => item.target),
    ['a.dependencies'],
  );
});

test('环外的普通依赖未满足：只报 E-VALIDATION-002（与环结论互不干扰）', () => {
  const metas = [meta('a', ['b']), meta('b', ['a']), meta('c', ['a']), meta('x', ['y']), meta('y')];
  const findings = validateDependencies(
    metas,
    availabilityOf(['a', 'b', 'c', 'x', 'y'], ['a', 'b', 'y']),
  );
  assert.deepEqual(cycleFindings(findings).sort(), ['a', 'b']);
  assert.deepEqual(dependencyFindings(findings).sort(), ['c.dependencies', 'x.dependencies']);
});
