import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES,
  classifyFrame,
  classifyLibraryFrame,
  classifyStack,
  splitProfile,
  stacksOf,
} from '../../scripts/bench/profile-split.mjs';

/** 构造一个最小可用的 cpuprofile：root → 三帧子树，样本落在指定节点上 */
function profileOf(samples: Array<[number, number]>) {
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '' } },
    {
      id: 2,
      parent: 1,
      callFrame: {
        functionName: 'scanWorkspace',
        url: 'file:///repo/kernel/core/discovery/index.ts',
      },
    },
    {
      id: 3,
      parent: 2,
      callFrame: { functionName: 'readdirSync', url: 'node:fs' },
    },
    {
      id: 4,
      parent: 2,
      callFrame: { functionName: 'parseYaml', url: 'file:///repo/kernel/store/yaml/index.ts' },
    },
    {
      id: 5,
      parent: 2,
      callFrame: {
        functionName: 'computeDigests',
        url: 'file:///repo/kernel/core/integrity/index.ts',
      },
    },
    {
      id: 6,
      parent: 5,
      callFrame: { functionName: 'createHash', url: 'node:crypto' },
    },
    {
      id: 7,
      parent: 2,
      callFrame: { functionName: 'stringifyYaml', url: 'file:///repo/kernel/store/yaml/index.ts' },
    },
    {
      id: 8,
      parent: 2,
      callFrame: {
        functionName: 'atomicWriteFile',
        url: 'file:///repo/kernel/store/atomic/index.ts',
      },
    },
    {
      id: 9,
      parent: 2,
      callFrame: { functionName: 'readFileSync', url: 'node:fs' },
    },
    {
      id: 10,
      parent: 2,
      callFrame: { functionName: 'mysteryNative', url: 'node:internal/whatever' },
    },
  ];
  return {
    nodes,
    samples: samples.map(([nodeId]) => nodeId),
    timeDeltas: samples.map(([, deltaUs]) => deltaUs),
  };
}

test('T1 剖面：栈构建自叶向根，分类按帧名与来源', () => {
  const profile = profileOf([]);
  const { stackOf } = stacksOf(profile);
  assert.deepEqual(
    stackOf(6).map((frame: { functionName: string }) => frame.functionName),
    ['createHash', 'computeDigests', 'scanWorkspace', '(root)'],
  );
  assert.equal(classifyFrame({ functionName: 'readdirSync', url: 'node:fs' }), 'readdir');
  assert.equal(classifyFrame({ functionName: 'computeDigests', url: 'x' }), 'digest');
  assert.equal(classifyFrame({ functionName: 'nothingKnown', url: 'x' }), null);
  assert.equal(
    classifyLibraryFrame({
      functionName: 'resolveProps',
      url: 'file:///repo/node_modules/yaml/dist/compose.js',
    }),
    'parse_yaml',
    '库内部帧由兜底趟归到解析',
  );
  assert.equal(
    classifyLibraryFrame({ functionName: '(garbage collector)', url: '' }),
    null,
    'V8 合成帧留给 other',
  );
  assert.equal(
    classifyStack([
      { functionName: 'writeNode', url: 'file:///repo/node_modules/yaml/dist/compose.js' },
      { functionName: 'stringifyYaml', url: 'file:///repo/kernel/store/yaml/index.ts' },
    ]),
    'serialize',
    '库内部帧必须按栈里的内核锚点归到序列化（而不是解析）',
  );
  assert.equal(classifyStack([{ functionName: '(program)', url: '' }]), 'other');
});

test('T1 剖面：六阶段归集 + 未归集占比 + 索引写入延迟（序列化 + 原子写）', () => {
  const profile = profileOf([
    [3, 1000],
    [3, 1000],
    [4, 2000],
    [6, 3000],
    [9, 500],
    [7, 4000],
    [8, 4000],
    [10, 2500],
  ]);
  const result = splitProfile(profile);
  assert.equal(result.total_ms, 18, '总耗时 = Σ timeDeltas');
  assert.deepEqual(result.stages, {
    readdir: 2,
    read_meta: 0.5,
    parse_yaml: 2,
    digest: 3,
    serialize: 4,
    atomic_write: 4,
    other: 2.5,
  });
  assert.equal(result.index_write_ms, 8, '索引写入延迟 = 序列化 + 原子写');
  assert.equal(result.coverage, 0.86, '未归集占比必须可读出（1 − other / total）');
  assert.equal(result.sample_count, 8);
});

test('T1 剖面：空剖面给出零值而非报错（不被误当成「无成本」）', () => {
  const result = splitProfile({ nodes: [], samples: [], timeDeltas: [] });
  assert.equal(result.total_ms, 0);
  assert.equal(result.coverage, null, '无样本时不谎称覆盖率');
  assert.equal(result.index_write_ms, 0);
  assert.deepEqual(Object.keys(result.stages), STAGES);
});
