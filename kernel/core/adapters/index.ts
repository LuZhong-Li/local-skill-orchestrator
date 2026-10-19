/**
 * K-15 适配器层：形态实现与宿主绑定。
 *
 * 依据：设计文档 4.1 节（适配器接口与纯函数 render）、4.2 节（生命周期）、
 * 5.3 节（共用渲染核心）、6.x 节（落位计划）；需求 M5-R4（首批名单）、M5-R7（新增宿主成本）。
 *
 * 结构：**形态实现（FormImplementation）与宿主绑定（HostAdapter）分离**。
 * 复用同一形态的宿主（claude / codex / doubao / agentskills）共享同一份实现对象，
 * 因此这些宿主没有任何宿主专有代码；只有新增形态时才新增一个实现
 * （Cursor 的规则路径形态是本批唯一新增的形态）。
 *
 * 边界：本层不写盘。render 产出文本，plan 产出落位计划，verify 只读校验；
 * 落盘、受控副本衔接与清理由 T5 承担。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { parse as parseYamlText } from 'yaml';
import { hostById, hostIds } from '../hosts/index.ts';
import { renderEntry, renderSkill } from '../render/index.ts';
import { renderRuleFile } from './rules.ts';
import { assemblePlan } from './plan.ts';
import type { AdapterForm, HostAdapter, PlacementPlan } from './types.ts';
import type { RenderOutcome, RenderSource } from '../render/types.ts';

const SOURCE = 'adapters';

/** 形态实现：与宿主无关的渲染与校验实现；宿主只引用它并绑定标识 */
export interface FormImplementation {
  readonly forms: readonly AdapterForm[];
  render(hostId: string, source: RenderSource, form: AdapterForm): RenderOutcome;
  verify(hostId: string, outcome: RenderOutcome): Finding[];
}

/** 技能形态实现：由渲染核心承担，字段策略取自宿主注册项 */
const SKILL_FORM: FormImplementation = {
  forms: ['skill'],
  render(hostId, source) {
    return renderSkill(hostId, source);
  },
  verify: verifySkillArtifacts,
};

/** 指令文件降级形态实现 */
const ENTRY_FORM: FormImplementation = {
  forms: ['entry'],
  render(hostId, source) {
    return renderEntry(hostId, source);
  },
  verify(hostId, outcome) {
    const findings: Finding[] = [];
    for (const file of outcome.files) {
      if (file.kind !== 'agents_md_fragment') {
        findings.push(
          finding(CODES.FIELD_INVALID_VALUE, {
            source: SOURCE,
            target: `${hostId}:${file.path}`,
            message: '指令文件形态只产出 AGENTS.md 片段',
            remedy: '检查形态选择；片段不得携带 YAML 元数据块',
          }),
        );
      }
      if (file.content.startsWith('---')) {
        findings.push(
          finding(CODES.FIELD_INVALID_VALUE, {
            source: SOURCE,
            target: `${hostId}:${file.path}`,
            message: '降级片段不得携带 YAML 元数据块',
            remedy: 'AGENTS.md 无字段约定，片段应为纯 Markdown 条目',
          }),
        );
      }
    }
    return findings;
  },
};

/** 规则路径形态实现 */
const RULE_FORM: FormImplementation = {
  forms: ['rules'],
  render(hostId, source) {
    return renderRuleFile(hostId, source);
  },
  verify(hostId, outcome) {
    return verifyRuleArtifacts(hostId, outcome);
  },
};

const SINGLE_FORMS: Record<AdapterForm, FormImplementation> = {
  skill: SKILL_FORM,
  rules: RULE_FORM,
  entry: ENTRY_FORM,
};

const COMPOSITES = new Map<string, FormImplementation>();

/** 由注册表的 adapter_forms 组合形态实现；复用形态的宿主共享同一对象。 */
function implementationForForms(forms: readonly AdapterForm[]): FormImplementation | undefined {
  const key = [...forms].sort().join('+');
  const cached = COMPOSITES.get(key);
  if (cached !== undefined) return cached;
  const implementations = forms.map((form) => SINGLE_FORMS[form]);
  if (implementations.length === 0 || implementations.some((item) => item === undefined)) {
    return undefined;
  }
  const composite =
    implementations.length === 1
      ? (implementations[0] as FormImplementation)
      : ({
          forms,
          render(hostId, source, form) {
            return (SINGLE_FORMS[form] as FormImplementation).render(hostId, source, form);
          },
          verify(hostId, outcome) {
            return implementations.flatMap((item) => item.verify(hostId, outcome));
          },
        } satisfies FormImplementation);
  COMPOSITES.set(key, composite);
  return composite;
}

/**
 * 取宿主的形态实现；未登记（含不适用宿主）返回 undefined。
 * 该函数暴露给审计与测试：同一实现对象说明这些宿主没有宿主专有代码。
 */
export function formImplementationOf(hostId: string): FormImplementation | undefined {
  const forms = hostById(hostId)?.adapter_forms;
  return forms === undefined ? undefined : implementationForForms(forms as AdapterForm[]);
}

/** 绑定宿主标识与形态实现，得到适配器 */
function bind(hostId: string, implementation: FormImplementation): HostAdapter {
  const forms = implementation.forms;
  const defaultForm = forms[0] as AdapterForm;
  return {
    host_id: hostId,
    forms,
    render(source: RenderSource, form: AdapterForm = defaultForm): RenderOutcome {
      return implementation.render(hostId, source, form);
    },
    plan(source: RenderSource, form: AdapterForm = defaultForm): PlacementPlan {
      const outcome = implementation.render(hostId, source, form);
      return assemblePlan({
        hostId,
        targetId: hostId,
        skillId: source.id,
        form,
        degraded: outcome.degraded,
        capabilityGaps: outcome.capability_gaps,
        artifacts: outcome.files,
        findings: outcome.findings,
      });
    },
    verify(outcome: RenderOutcome): Finding[] {
      return implementation.verify(hostId, outcome);
    },
  };
}

/** 取宿主适配器；不适用宿主（deepseek）没有适配器，返回 undefined */
export function adapterFor(hostId: string): HostAdapter | undefined {
  const implementation = formImplementationOf(hostId);
  return implementation === undefined ? undefined : bind(hostId, implementation);
}

/** 全部可用适配器（按宿主标识排序），供 T5 与验收使用 */
export function allAdapters(): HostAdapter[] {
  return hostIds()
    .filter((hostId) => {
      const entry = hostById(hostId);
      return (
        entry?.adapter_forms !== undefined &&
        (entry.adapter_state === 'implemented' || entry.adapter_state === 'degrade_only')
      );
    })
    .sort()
    .map((hostId) => adapterFor(hostId) as HostAdapter);
}

/**
 * 技能形态产物的结构合规校验（只读）：
 * 前置元数据必须可解析、必填字段齐全、字段集不得超过「标准六字段 + 宿主白名单」。
 */
function verifyRuleArtifacts(hostId: string, outcome: RenderOutcome): Finding[] {
  const findings: Finding[] = [];
  for (const file of outcome.files) {
    if (file.kind !== 'rule_file') continue;
    if (!file.path.endsWith('.mdc')) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${hostId}:${file.path}`,
          message: '规则文件必须以 .mdc 结尾（.md 会被规则系统忽略）',
          remedy: '按 Cursor 规则文档修正扩展名',
        }),
      );
    }
    if (!file.content.includes('alwaysApply:')) {
      findings.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: `${hostId}:${file.path}`,
          message: '规则文件缺少 alwaysApply 前置元数据',
          remedy: '规则文件的 frontmatter 必须给出 description 与 alwaysApply',
        }),
      );
    }
  }
  return findings;
}

function verifySkillArtifacts(hostId: string, outcome: RenderOutcome): Finding[] {
  const findings: Finding[] = [];
  const entry = hostById(hostId);
  const standard = new Set([
    'name',
    'description',
    'license',
    'compatibility',
    'allowed-tools',
    'metadata',
  ]);
  const whitelist = new Set(entry?.render_policy.allowed_extensions ?? []);
  for (const file of outcome.files) {
    if (file.kind !== 'skill_md') continue;
    const parsed = parseFrontmatter(file.content);
    if (parsed === undefined) {
      findings.push(
        finding(CODES.YAML_INVALID, {
          source: SOURCE,
          target: `${hostId}:${file.path}`,
          message: '产物缺少可解析的 YAML 元数据块',
          remedy: '技能形态产物必须以 --- 包裹的 YAML 元数据块开头',
        }),
      );
      continue;
    }
    if (parsed['name'] === undefined || parsed['description'] === undefined) {
      findings.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: `${hostId}:${file.path}`,
          message: '产物缺少必填字段（name / description）',
          remedy: '标准要求 name 与 description 必填；请补齐内部描述后重新渲染',
        }),
      );
    }
    const unexpected = Object.keys(parsed).filter(
      (key) => !standard.has(key) && !whitelist.has(key),
    );
    if (unexpected.length > 0) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${hostId}:${file.path}`,
          message: `产物出现策略之外的字段：${unexpected.join('、')}`,
          remedy: '字段集必须等于「标准六字段 + 宿主白名单」；请检查透传策略',
        }),
      );
    }
  }
  return findings;
}

/** 解析产物的 YAML 元数据块；解析失败或不存在时返回 undefined */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (match === null) return undefined;
  try {
    const value = parseYamlText(match[1] as string);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
