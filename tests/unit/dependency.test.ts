import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDependencies,
  collectDependents,
  cyclesThrough,
  splitDeclaration,
  type Availability,
} from '../../kernel/core/dependency/index.ts';
import { CODES } from '@skill-manager/contract';

function graphOf(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

function availabilityOf(entries: Record<string, boolean>): Availability {
  return new Map(Object.entries(entries));
}

test('K-06 依赖声明拆分为名称与版本约束', () => {
  assert.deepEqual(splitDeclaration('alpha'), { name: 'alpha', constraint: null });
  assert.deepEqual(splitDeclaration('alpha ^1.0.0'), { name: 'alpha', constraint: '^1.0.0' });
  assert.deepEqual(splitDeclaration('  alpha   >=1.2 '), {
    name: 'alpha',
    constraint: '>=1.2',
  });
  assert.deepEqual(splitDeclaration(''), { name: '', constraint: null });
});

test('K-06 依赖条目区分可用、已登记但不通过、不在索引三种状态', () => {
  const report = analyzeDependencies({
    id: 'gamma',
    declared: ['alpha ^1.0.0', 'beta', 'ghost', ''],
    availability: availabilityOf({ alpha: true, beta: false, gamma: true }),
    edges: graphOf({ alpha: [], beta: [], gamma: ['alpha', 'beta', 'ghost'] }),
  });

  assert.deepEqual(
    report.entries.map((item) => [item.name, item.status]),
    [
      ['alpha', 'ok'],
      ['beta', 'invalid'],
      ['ghost', 'missing'],
    ],
    '空声明被忽略，其余逐条给出结论',
  );
  assert.equal(report.entries[0]?.constraint, '^1.0.0', '版本约束原样保留');
  assert.deepEqual(
    report.findings.map((item) => item.code),
    [CODES.VALIDATION_DEPENDENCY, CODES.DEP_MISSING],
    '不通过与缺失分别对应两个问题码',
  );
  assert.ok(report.findings.every((item) => item.severity === 'error'));
});

test('K-06 依赖全部满足时不产生问题', () => {
  const report = analyzeDependencies({
    id: 'beta',
    declared: ['alpha'],
    availability: availabilityOf({ alpha: true, beta: true }),
    edges: graphOf({ alpha: [], beta: ['alpha'] }),
  });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.entries.map((item) => item.status),
    ['ok'],
  );
  assert.deepEqual(report.affected, []);
  assert.deepEqual(report.cycles, []);
});

test('K-06 影响面取传递依赖者并去重排序', () => {
  const edges = graphOf({
    alpha: [],
    beta: ['alpha'],
    gamma: ['beta'],
    delta: ['gamma', 'alpha'],
    epsilon: [],
  });
  assert.deepEqual(collectDependents('alpha', edges), ['beta', 'delta', 'gamma']);
  assert.deepEqual(collectDependents('gamma', edges), ['delta'], '只取传递依赖者');
  assert.deepEqual(collectDependents('epsilon', edges), []);
  assert.deepEqual(collectDependents('delta', edges), []);
});

test('K-06 自引用不把自身算作受影响对象', () => {
  const edges = graphOf({ alpha: ['alpha'], beta: ['alpha'] });
  assert.deepEqual(collectDependents('alpha', edges), ['beta']);
});

test('K-06 依赖环只报告牵涉该标识的环，且同一个环只报一次', () => {
  const edges = graphOf({ alpha: ['beta'], beta: ['alpha'], gamma: ['alpha'], delta: [] });
  const cycles = cyclesThrough('alpha', edges);
  assert.equal(cycles.length, 1, '同一个环只保留一次');
  assert.deepEqual(cycles[0], ['alpha', 'beta', 'alpha'], '环以回到起点收尾，便于直接呈现');
  assert.deepEqual(cyclesThrough('delta', edges), [], '与该标识无关的环不报告');
});

test('K-06 成环时给出错误级问题码', () => {
  const report = analyzeDependencies({
    id: 'alpha',
    declared: ['beta'],
    availability: availabilityOf({ alpha: true, beta: true }),
    edges: graphOf({ alpha: ['beta'], beta: ['alpha'] }),
  });
  assert.ok(report.findings.some((item) => item.code === CODES.DEP_CYCLE));
  assert.equal(report.cycles.length, 1);
});
