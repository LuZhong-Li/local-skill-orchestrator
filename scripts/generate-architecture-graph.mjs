#!/usr/bin/env node
/**
 * 从 check:arch 使用的同一份 import 图生成机器可读架构依赖图。
 *
 * 生成物入库以便审阅和比较；`--check` 只校验新鲜度，不写文件。
 * 图不包含时间戳或平台路径，保证同一棵树在任何平台产出相同 JSON。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGraph, classifyRegion, collectSourceFiles, findCycles } from './check-layer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['contract', 'kernel', 'gui', 'scripts'];
export const GRAPH_FILE = 'docs/architecture/dependency-graph.json';

function layerOf(region) {
  if (region === 'contract' || region === 'scripts') return region;
  if (region.startsWith('kernel-')) return region.slice('kernel-'.length);
  if (region.startsWith('gui-')) return 'gui';
  return region;
}

function sortedEntries(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarize(graph, nodes, edges, cycles, sourceFileCount) {
  const layerFiles = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const crossEdges = new Map();
  for (const node of nodes) layerFiles.set(node.layer, (layerFiles.get(node.layer) ?? 0) + 1);
  for (const edge of edges) {
    outgoing.set(edge.from_layer, (outgoing.get(edge.from_layer) ?? 0) + 1);
    incoming.set(edge.to_layer, (incoming.get(edge.to_layer) ?? 0) + 1);
    if (edge.from_layer !== edge.to_layer) {
      const key = `${edge.from_layer}->${edge.to_layer}`;
      crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
    }
  }
  return {
    source_files: sourceFileCount,
    asset_nodes: nodes.length - sourceFileCount,
    nodes: nodes.length,
    edges: edges.length,
    unresolved: graph.unresolved.length,
    cycles: cycles.length,
    layers: Object.fromEntries(
      [...layerFiles.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    outgoing: sortedEntries(outgoing),
    incoming: sortedEntries(incoming),
    cross_layer_edges: sortedEntries(crossEdges),
  };
}

export function buildArchitectureGraph() {
  const files = SCAN_DIRS.flatMap((dir) => collectSourceFiles(dir)).sort();
  const graph = buildGraph(files);
  const sourceNodes = files
    .map((path) => {
      const region = classifyRegion(path);
      return { path, kind: 'source', region, layer: layerOf(region) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const sourceSet = new Set(files);
  const assetNodes = [...new Set(graph.edges.map((edge) => edge.to))]
    .filter((path) => !sourceSet.has(path))
    .sort()
    .map((path) => {
      const region = classifyRegion(path);
      return { path, kind: 'asset', region, layer: layerOf(region) };
    });
  const nodes = [...sourceNodes, ...assetNodes];
  const edges = graph.edges
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      specifier: edge.specifier,
      from_layer: layerOf(classifyRegion(edge.from)),
      to_layer: layerOf(classifyRegion(edge.to)),
    }))
    .sort((left, right) =>
      `${left.from}\0${left.to}\0${left.specifier}`.localeCompare(
        `${right.from}\0${right.to}\0${right.specifier}`,
      ),
    );
  const cycles = findCycles(graph.adjacency);
  return {
    schema_version: '1',
    source: 'scripts/check-layer.mjs',
    nodes,
    edges,
    stats: summarize(graph, nodes, edges, cycles, files.length),
  };
}

export function serializeArchitectureGraph(graph = buildArchitectureGraph()) {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function checkGraph() {
  const absolute = join(ROOT, GRAPH_FILE);
  if (!existsSync(absolute)) {
    console.error(`缺少架构依赖图：${GRAPH_FILE}；运行 npm run arch:graph`);
    process.exit(1);
  }
  const expected = serializeArchitectureGraph();
  const actual = readFileSync(absolute, 'utf8');
  if (actual !== expected) {
    console.error(`架构依赖图已过期：${GRAPH_FILE}；运行 npm run arch:graph`);
    process.exit(1);
  }
  const graph = buildArchitectureGraph();
  console.log(
    `架构依赖图校验通过：${String(graph.stats.source_files)} 源文件 + ${String(graph.stats.asset_nodes)} 资产节点，${String(graph.stats.edges)} 边，${String(graph.stats.cycles)} 循环。`,
  );
}

function writeGraph() {
  const output = join(ROOT, GRAPH_FILE);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serializeArchitectureGraph());
  const graph = buildArchitectureGraph();
  console.log(
    `已生成 ${relative(ROOT, output)}：${String(graph.stats.source_files)} 源文件 + ${String(graph.stats.asset_nodes)} 资产节点，${String(graph.stats.edges)} 边，${String(graph.stats.cycles)} 循环。`,
  );
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  if (process.argv.includes('--check')) checkGraph();
  else writeGraph();
}
