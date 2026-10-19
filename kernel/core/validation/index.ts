/** K-05 校验引擎入口：工作区编排与公共导出。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { SkillMeta } from '../metadata/types.ts';
import {
  validateDependencies,
  validateIndexVersion,
  type AvailabilityMap,
} from '../metadata/validate.ts';
import { declaredSkillsOf, readMetaFile, type MetaRead } from '../metadata/read.ts';
import {
  resolveScope,
  recordDir,
  unresolvableSubject,
  validateConfig,
  validateRecord,
} from './validation-record.ts';
import {
  summarize,
  type RecordVerdict,
  type ValidateInput,
  type ValidateOutcome,
} from './validation-shared.ts';

export type {
  RecordVerdict,
  ValidationReport,
  ValidateOutcome,
  ValidateInput,
} from './validation-shared.ts';

export function validateWorkspace(input: ValidateInput): ValidateOutcome {
  const { layout, index, subject } = input;
  const environment: Finding[] = [];

  // 一、索引文件自身与配置区
  environment.push(...validateIndexVersion(index.schema_version));
  environment.push(...validateConfig(layout, index));

  // 二、索引层面的标识唯一性（V-02）：重复出现时逐条列出冲突的双方
  const seen = new Map<string, number>();
  for (const record of index.skills) {
    const count = (seen.get(record.id) ?? 0) + 1;
    seen.set(record.id, count);
    if (count === 2) {
      environment.push(
        finding(CODES.ID_DUPLICATED, {
          source: 'registry',
          target: record.id,
          message: `索引中标识 ${record.id} 出现多次`,
          remedy: '请删除重复记录，保留其中一条',
        }),
      );
    }
  }

  // 三、确定校验范围；单对象模式下只读取该对象的元文件
  const scope = resolveScope(layout, index, subject);
  const single = subject !== undefined && subject !== '';

  // 单对象模式下，指定的对象既不在索引中、也不是工作区内的可达目录时，立即报参数类问题
  if (single && scope.length === 1 && !scope[0]!.registered) {
    const invalid = unresolvableSubject(layout, scope[0]!.record.path);
    if (invalid !== null) {
      const all = [...environment, invalid];
      return { findings: all, report: summarize(all, [], true, subject) };
    }
  }

  const reads = new Map<string, MetaRead>();
  for (const item of scope) {
    reads.set(item.record.id, readMetaFile(recordDir(layout, item.record), item.record.id));
  }

  // 四、依赖校验：可用性取索引中已有的运行期结论，图的默认来源为索引记录的依赖摘要
  const availability: AvailabilityMap = new Map(
    index.skills.map((record) => [record.id, record.validation.status === 'ok']),
  );
  const dependencyMetas: SkillMeta[] = index.skills.map((record) => {
    const fromLive = declaredSkillsOf(reads.get(record.id)?.raw ?? null);
    return {
      id: record.id,
      dependencies: { skills: fromLive ?? record.dependencies ?? [] },
    } as unknown as SkillMeta;
  });
  const byOwner = new Map<string, Finding[]>();
  for (const item of validateDependencies(dependencyMetas, availability)) {
    const owner = item.target.split('.')[0] ?? '';
    // 单对象模式：只保留该对象自身的依赖问题，以及牵涉该对象的依赖环
    if (single && owner !== subject && !item.message.includes(subject)) continue;
    const bucket = byOwner.get(owner) ?? [];
    bucket.push(item);
    byOwner.set(owner, bucket);
  }

  // 五、逐条校验
  const findings: Finding[] = [];
  const verdicts: RecordVerdict[] = [];
  for (const item of scope) {
    const read = reads.get(item.record.id) ?? { raw: null, findings: [] };
    const own = validateRecord(layout, item, read, byOwner.get(item.record.id) ?? []);
    verdicts.push(own.verdict);
    findings.push(...own.findings);
  }

  const all = [...environment, ...findings];
  return {
    findings: all,
    report: summarize(all, verdicts, single, subject),
  };
}

/** 校验索引的配置区；目标标识目前无登记表，因此只校验非空与取值域 */
