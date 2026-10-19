/** 依赖可用性、环检测与依赖规则。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { SkillMeta } from './types.ts';
import { judgeDependency, type AvailabilityMap } from './validate-meta.ts';

function declaredNameOf(raw: string): string {
  return raw.trim().split(' ')[0] ?? '';
}

export function cyclesByNode(edges: Map<string, string[]>): Map<string, string[][]> {
  const byNode = new Map<string, string[][]>();
  for (const cycle of findCycles(edges)) {
    for (const member of new Set(cycle)) {
      const list = byNode.get(member) ?? [];
      list.push(cycle);
      byNode.set(member, list);
    }
  }
  return byNode;
}

/**
 * 校验依赖：存在性、被依赖对象的可用性与环路。
 *
 * 语义（2026-10-17 裁决，M3 内核核查批次）：
 *   一、**环是全量图上的结构事实**——用全部声明建图检测，不受本轮可用性影响；
 *       环上每个技能各带一条 `E-DEP-003`（target 为自身），环成员**不再叠加**
 *       `E-VALIDATION-002`（根因只归一次环）；
 *   二、环外依赖方（直接或传递）在目标不可用时带 `E-VALIDATION-002`；
 *   三、被依赖对象不在索引中 → `E-DEP-001`（环成员同样保留这条可操作的事实）；
 *   四、因为环不再随轮次出现/消失，可用性只会由 true 翻 false，扫描的不动点收敛且结果
 *       与迭代顺序、技能数量无关（此前在「当前轮可用图」上现算环会导致振荡）。
 */
export function validateDependencies(metas: SkillMeta[], availability: AvailabilityMap): Finding[] {
  const findings: Finding[] = [];

  // 全量图：键为节点 id（异常的 id 关系由扫描侧按不可用处理，不在此过滤）
  const fullEdges = new Map<string, string[]>();
  for (const meta of metas) {
    const names: string[] = [];
    for (const raw of meta.dependencies?.skills ?? []) {
      const name = declaredNameOf(raw);
      if (name !== '' && !names.includes(name)) names.push(name);
    }
    fullEdges.set(meta.id, names);
  }
  const byNode = cyclesByNode(fullEdges);

  for (const meta of metas) {
    const declared = meta.dependencies?.skills ?? [];
    const cyclesOfMeta = byNode.get(meta.id);

    if (cyclesOfMeta !== undefined) {
      findings.push(
        finding(CODES.DEP_CYCLE, {
          source: 'meta',
          target: meta.id,
          message: `依赖关系成环：${cyclesOfMeta.map((cycle) => cycle.join(' -> ')).join('；')}`,
          remedy: '请打断环中的任意一条依赖声明',
        }),
      );
      // 环成员只报环本身；「声明了不存在的依赖」仍是可操作事实，继续报告
      for (const raw of declared) {
        const name = declaredNameOf(raw);
        if (name === '') continue;
        if (judgeDependency(name, availability) === 'missing') {
          findings.push(
            finding(CODES.DEP_MISSING, {
              source: 'meta',
              target: `${meta.id}.dependencies`,
              message: `依赖的 Skill ${name} 不在索引中`,
              remedy: `请先安装 ${name}，或从依赖声明中移除该项`,
            }),
          );
        }
      }
      continue;
    }

    for (const raw of declared) {
      const name = declaredNameOf(raw);
      if (name === '') continue;
      const verdict = judgeDependency(name, availability);
      if (verdict === 'missing') {
        findings.push(
          finding(CODES.DEP_MISSING, {
            source: 'meta',
            target: `${meta.id}.dependencies`,
            message: `依赖的 Skill ${name} 不在索引中`,
            remedy: `请先安装 ${name}，或从依赖声明中移除该项`,
          }),
        );
        continue;
      }
      if (verdict === 'invalid') {
        findings.push(
          finding(CODES.VALIDATION_DEPENDENCY, {
            source: 'meta',
            target: `${meta.id}.dependencies`,
            message: `依赖的 Skill ${name} 校验不通过，依赖方判定为依赖未满足`,
            remedy: `请先修复 ${name} 的问题并重新扫描`,
          }),
        );
      }
    }
  }

  return findings;
}

/**
 * 依赖环检测的唯一实现：返回全部环，每项以回到起点收尾，同一个环只保留一次。
 */
export function findCycles(edges: Map<string, string[]>): string[][] {
  const found = new Map<string, string[]>();
  const visiting = new Set<string>();
  const done = new Set<string>();

  const walk = (node: string, path: string[]): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      const cycle = [...path, node];
      const key = [...new Set(cycle)].sort().join('>');
      if (!found.has(key)) found.set(key, cycle);
      return;
    }
    visiting.add(node);
    for (const next of edges.get(node) ?? []) walk(next, [...path, node]);
    visiting.delete(node);
    done.add(node);
  };

  for (const node of edges.keys()) walk(node, []);
  return [...found.values()];
}

/** 深度优先检测依赖环，同一个环只报告一次 */
export function detectCycles(edges: Map<string, string[]>): Finding[] {
  const findings: Finding[] = [];
  for (const cycle of findCycles(edges)) {
    findings.push(
      finding(CODES.DEP_CYCLE, {
        source: 'meta',
        target: cycle[0] ?? '',
        message: `依赖关系成环：${cycle.join(' -> ')}`,
        remedy: '请打断环中的任意一条依赖声明',
      }),
    );
  }
  return findings;
}
