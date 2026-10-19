import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegion, evaluateArchitecture, findCycles } from '../../scripts/check-layer.mjs';

test('架构：区域归类覆盖 kernel / gui / scripts', () => {
  assert.equal(classifyRegion('kernel/store/library-fs/index.ts'), 'kernel-store');
  assert.equal(classifyRegion('kernel/core/lifecycle/index.ts'), 'kernel-core');
  assert.equal(classifyRegion('kernel/index.ts'), 'kernel-public');
  assert.equal(classifyRegion('gui/main/index.ts'), 'gui-main');
  assert.equal(classifyRegion('gui/renderer/src/App.vue'), 'gui-renderer');
  assert.equal(classifyRegion('scripts/gui-smoke.mjs'), 'scripts');
});

test('架构：store → core 的新边必须失败', () => {
  const result = evaluateArchitecture([{ from: 'kernel/store/a.ts', to: 'kernel/core/b.ts' }], []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /\[layer\]/);
});

test('架构：精确 allowlist 只放行同一文件对', () => {
  const allowlist = [
    {
      from: 'kernel/store/library-fs/index.ts',
      to: 'kernel/core/metadata/constants.ts',
      rule: 'kernel-store -> kernel-core',
      reason: 'P0-a baseline',
      clearedBy: 'P0-b',
    },
  ];
  const allowed = evaluateArchitecture(
    [
      {
        from: 'kernel/store/library-fs/index.ts',
        to: 'kernel/core/metadata/constants.ts',
      },
    ],
    allowlist,
  );
  assert.deepEqual(allowed.failures, []);
  assert.deepEqual(allowed.baselineObserved, [
    'kernel/store/library-fs/index.ts -> kernel/core/metadata/constants.ts',
  ]);

  const sibling = evaluateArchitecture(
    [
      {
        from: 'kernel/store/library-fs/index.ts',
        to: 'kernel/core/metadata/other.ts',
      },
    ],
    allowlist,
  );
  assert.equal(sibling.failures.length, 2);
});

test('架构：循环依赖必须被捕获且不能靠 allowlist 放行', () => {
  const cycles = findCycles(
    new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['a.ts']],
    ]),
  );
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ['a.ts', 'b.ts', 'a.ts']);
});

test('架构：GUI / scripts 不得引用 kernel 内部', () => {
  const result = evaluateArchitecture(
    [
      { from: 'gui/renderer/src/App.vue', to: 'kernel/core/index.ts' },
      { from: 'scripts/probe.mjs', to: 'kernel/store/index.ts' },
    ],
    [],
  );
  assert.equal(result.failures.length, 2);
});
