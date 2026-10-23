import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRAPH_FILE,
  buildArchitectureGraph,
  serializeArchitectureGraph,
} from '../../scripts/generate-architecture-graph.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('架构：依赖图覆盖分层源码且无循环、无未解析相对 import', () => {
  const graph = buildArchitectureGraph();
  assert.ok(graph.nodes.length > 0);
  assert.ok(graph.edges.length > 0);
  assert.equal(graph.stats.cycles, 0);
  assert.equal(graph.stats.unresolved, 0);
  assert.deepEqual([...new Set(graph.nodes.map((node) => node.layer))].sort(), [
    'contract',
    'core',
    'dispatch',
    'entry',
    'gui',
    'public',
    'scripts',
    'store',
  ]);
  for (const edge of graph.edges) {
    assert.equal(
      graph.nodes.some((node) => node.path === edge.from),
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.path === edge.to),
      true,
    );
  }
});

test('架构：入库依赖图与当前源码生成结果逐字节一致', () => {
  const committed = readFileSync(join(ROOT, GRAPH_FILE), 'utf8');
  assert.equal(committed, serializeArchitectureGraph());
});

test('架构：除声明的入口外不存在孤立源码文件', () => {
  const graph = buildArchitectureGraph();
  const incoming = new Set(graph.edges.map((edge) => edge.to));
  const roots = graph.nodes
    .filter((node) => node.kind === 'source' && !node.path.startsWith('scripts/'))
    .filter((node) => !incoming.has(node.path))
    .map((node) => node.path)
    .sort();
  assert.deepEqual(roots, [
    'contract/src/index.ts',
    'gui/electron.vite.config.ts',
    'gui/main/index.ts',
    'gui/preload/index.ts',
    'gui/renderer/env.d.ts',
    'gui/renderer/src/main.ts',
    'kernel/core/pipeline/index.ts',
    'kernel/entry/exe.ts',
  ]);
});
