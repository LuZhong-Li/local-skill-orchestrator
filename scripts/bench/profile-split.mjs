/**
 * M3 阶段归集：把源码线的 `--cpu-prof` 剖面按帧自耗时归到六个阶段。
 *
 * 依据：`docs/design/m3-benchmark.md` §3.4。两点必须如实表达：
 *   一、这是**启发式归集**——按调用栈自叶向根匹配帧名与来源，未命中计入 `other`；
 *      报告必须同时给出未归集占比，占比过高时声明结论弱化（不得只给六阶段数字）；
 *   二、`--cpu-prof` 为 1 ms 采样粒度，结果只用于**占比**，不当作绝对耗时。
 */

/** 六个阶段 + 未归集 */
export const STAGES = [
  'readdir',
  'read_meta',
  'parse_yaml',
  'digest',
  'serialize',
  'atomic_write',
  'other',
];

const RULES = [
  { stage: 'readdir', pattern: /readdir/i },
  { stage: 'digest', pattern: /createHash|hashUpdate|digest|Hash\.update/i },
  { stage: 'atomic_write', pattern: /atomicWrite|writeFileSync|rename|openSync|writeSync/i },
  { stage: 'serialize', pattern: /stringify/i },
  { stage: 'parse_yaml', pattern: /parseYaml|parseDocument|lex|tokeniz|scanFlow|composeNode/i },
  { stage: 'read_meta', pattern: /readFileSync|readSync|readFile/i },
];

/** 单个帧是否值得作为归集依据（内核自身代码优先，内部实现帧次之） */
function frameText(frame) {
  const name = typeof frame?.functionName === 'string' ? frame.functionName : '';
  const url = typeof frame?.url === 'string' ? frame.url : '';
  return `${name} ${url}`;
}

/** 按规则匹配单个帧；不命中返回 null */
export function classifyFrame(frame) {
  const text = frameText(frame);
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.stage;
  }
  return null;
}

/** 建立 节点 id → 调用栈（叶到根）的映射 */
export function stacksOf(profile) {
  const byId = new Map();
  for (const node of profile?.nodes ?? []) {
    byId.set(node.id, node);
  }
  const cache = new Map();
  const stackOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    const stack = [];
    let current = byId.get(id);
    const guard = new Set();
    while (current !== undefined && !guard.has(current.id)) {
      guard.add(current.id);
      stack.push(current.callFrame ?? {});
      current = current.parent === undefined ? undefined : byId.get(current.parent);
    }
    cache.set(id, stack);
    return stack;
  };
  return { byId, stackOf };
}

/**
 * 归集剖面：返回各阶段自耗时（毫秒）、未归集占比与索引写入延迟。
 *
 * `index_write_ms` = 序列化 + 原子写（设计 §3.4），未采集到则为 null。
 */
export function splitProfile(profile) {
  const { stackOf } = stacksOf(profile);
  const nodes = new Map((profile?.nodes ?? []).map((node) => [node.id, node]));
  const samples = profile?.samples ?? [];
  const deltas = profile?.timeDeltas ?? [];
  const totals = Object.fromEntries(STAGES.map((stage) => [stage, 0]));

  let totalMs = 0;
  samples.forEach((nodeId, index) => {
    const deltaMs = (deltas[index] ?? 0) / 1000;
    totalMs += deltaMs;
    const stack = stackOf(nodeId);
    const stage =
      stack.map((frame) => classifyFrame(frame)).find((value) => value !== null) ?? 'other';
    totals[stage] += deltaMs;
  });

  const round = (value) => Math.round(value * 100) / 100;
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, round(totals[stage])]));
  const ownFrames = nodes.size;
  return {
    total_ms: round(totalMs),
    stages,
    coverage: totalMs === 0 ? null : round(1 - totals.other / totalMs),
    index_write_ms: round(totals.serialize + totals.atomic_write),
    sample_count: samples.length,
    node_count: ownFrames,
  };
}
