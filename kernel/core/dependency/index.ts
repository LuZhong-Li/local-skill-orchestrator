/**
 * K-06 依赖分析服务。
 *
 * 面向 `deps` 指令的报告式分析：逐条给出依赖对象的名称、版本约束、当前状态与检查结论，
 * 并给出影响面——哪些其他 Skill 会因该 Skill 被卸载或被禁用而受影响。
 *
 * 职责边界（单一判定源）：
 *   依赖**判定**的唯一实现在 K-01（judgeDependency 与 findCycles），本模块只做**呈现**——
 *   把判定结果组织成条目、问题码与影响面，不重写任何判定逻辑；
 *   影响面分析是本模块自己的职责，但同样建立在 K-01 给出的判定结果之上。
 * 本模块只分析、只报告，不自动安装任何依赖，只接收纯数据，不读写文件。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { findCycles, judgeDependency, type AvailabilityMap } from '../metadata/validate.ts';

/** 依赖目标的可用性：在索引中且运行期结论为校验通过 */
export type Availability = AvailabilityMap;

export interface DependencyEntry {
  name: string;
  /** 元文件中声明的版本约束，未声明时为 null */
  constraint: string | null;
  /** ok 表示可用；invalid 表示已登记但结论为校验不通过；missing 表示不在索引中 */
  status: 'ok' | 'invalid' | 'missing';
  conclusion: string;
}

export interface DependencyReport {
  findings: Finding[];
  entries: DependencyEntry[];
  /** 受影响的对象：直接与传递依赖该 Skill 的其他 Skill */
  affected: string[];
  /** 牵涉该 Skill 的依赖环，每项是一个环上的标识序列 */
  cycles: string[][];
}

/**
 * 把一条依赖声明拆成名称与版本约束。
 * 一期约定声明形如 `name` 或 `name 约束`，约束原样保留、不做版本比较。
 */
export function splitDeclaration(declaration: string): { name: string; constraint: string | null } {
  const trimmed = declaration.trim();
  const separator = trimmed.search(/\s/);
  if (separator < 0) return { name: trimmed, constraint: null };
  const name = trimmed.slice(0, separator);
  const constraint = trimmed.slice(separator + 1).trim();
  return { name, constraint: constraint === '' ? null : constraint };
}

/**
 * 分析一个 Skill 的依赖。
 *
 * declared 为该 Skill 声明的依赖原文列表，availability 为全索引的可用性映射，
 * edges 为全索引的依赖图（标识到其依赖标识列表），用于计算影响面与依赖环。
 */
export function analyzeDependencies(input: {
  id: string;
  declared: string[];
  availability: Availability;
  edges: Map<string, string[]>;
}): DependencyReport {
  const { id, declared, availability, edges } = input;
  const findings: Finding[] = [];
  const entries: DependencyEntry[] = [];

  for (const raw of declared) {
    const { name, constraint } = splitDeclaration(raw);
    if (name === '') continue;
    const verdict = judgeDependency(name, availability);
    if (verdict === 'missing') {
      entries.push({ name, constraint, status: 'missing', conclusion: '不在索引中' });
      findings.push(
        finding(CODES.DEP_MISSING, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 不在索引中`,
          remedy: `请先安装 ${name}，或从依赖声明中移除该项`,
        }),
      );
      continue;
    }
    if (verdict === 'invalid') {
      entries.push({ name, constraint, status: 'invalid', conclusion: '已登记但校验不通过' });
      findings.push(
        finding(CODES.VALIDATION_DEPENDENCY, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 校验不通过，依赖方判定为依赖未满足`,
          remedy: `请先修复 ${name} 的问题并重新扫描`,
        }),
      );
      continue;
    }
    entries.push({ name, constraint, status: 'ok', conclusion: '依赖已满足' });
  }

  const affected = collectDependents(id, edges);
  const cycles = cyclesThrough(id, edges);
  for (const cycle of cycles) {
    findings.push(
      finding(CODES.DEP_CYCLE, {
        source: 'dependency',
        target: id,
        message: `依赖关系成环：${cycle.join(' -> ')}`,
        remedy: '请打断环中的任意一条依赖声明',
      }),
    );
  }

  return { findings, entries, affected, cycles };
}

/** 收集传递依赖该标识的全部其他标识，按标识升序 */
export function collectDependents(id: string, edges: Map<string, string[]>): string[] {
  const reverse = new Map<string, string[]>();
  for (const [owner, declared] of edges) {
    for (const dependency of declared) {
      const bucket = reverse.get(dependency) ?? [];
      bucket.push(owner);
      reverse.set(dependency, bucket);
    }
  }

  const affected = new Set<string>();
  const queue = [...(reverse.get(id) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === id || affected.has(current)) continue;
    affected.add(current);
    queue.push(...(reverse.get(current) ?? []));
  }
  return [...affected].sort();
}

/** 从 K-01 的环检测结果中筛出经过该标识的环 */
export function cyclesThrough(id: string, edges: Map<string, string[]>): string[][] {
  return findCycles(edges).filter((cycle) => cycle.includes(id));
}
