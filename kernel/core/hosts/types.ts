/**
 * K-13 宿主注册表的数据类型。
 *
 * 依据（第五份契约规范）：docs/specification/host-registry.spec.md
 *   第 3 章字段定义、第 4 章支持状态与证据等级、第 5 章校验规则 HR-01 至 HR-13。
 *
 * 取值域以联合类型表达，使「新增宿主 = 注册表条目 + 适配器」在类型层面成立（M5-R7）：
 * 新增宿主只扩充数据，不新增分支逻辑。
 */

/** 规范 3.1：注册表格式版本，当前为 1（HR-01） */
export const REGISTRY_VERSION = '1';

/** 规范 4.1：宿主机制支持状态 */
export type SupportState = 'confirmed' | 'pending_evidence' | 'degrade_only' | 'not_applicable';

/** 规范 3.2：适配器实现状态（HR-10 决定可落位性） */
export type AdapterState = 'implemented' | 'planned' | 'degrade_only';

/** 规范 4.2：证据等级 */
export type EvidenceLevel =
  'verified_official' | 'verified_local' | 'verified_runtime' | 'secondhand' | 'pending';

/** 规范 3.5：落位根类别 */
export type RootKind = 'skill' | 'rules' | 'external';

/** 规范 3.5：落位根作用域 */
export type RootScope = 'global' | 'project';

/** 规范 3.7：字段渲染模式 */
export type FieldMode = 'standard6' | 'host_declared';

/** 规范 3.7：降级形态 */
export type DegradeForm = 'entry' | 'rule_file' | 'none';

/** 规范 3.3：证据等级与来源（HR-11 约束来源形式） */
export interface HostEvidence {
  level: EvidenceLevel;
  sources?: string[];
  note?: string;
}

/** 规范 3.4：三维分类（HR-05 约束自洽性） */
export interface HostClassification {
  skill_mechanism: boolean;
  rules_only: boolean;
  root_consumed_by?: string[];
}

/** 规范 3.5：落位根；技能根与规则路径分条登记（M5-R3、M5-R8） */
export interface HostRoot {
  kind: RootKind;
  path_template: string;
  scope?: RootScope;
  consumed_by?: string[];
  platform_notes?: string;
}

/** 规范 3.6：能力声明 */
export interface HostCapability {
  auto_discovery?: boolean;
  progressive_loading?: boolean;
  strict_filename?: boolean;
  accepted_fields?: string[];
  max_description_chars?: number;
  requires_yaml_name_description?: boolean;
}

/** 规范 3.7：渲染与透传策略（HR-08、HR-09 约束白名单） */
export interface HostRenderPolicy {
  field_mode: FieldMode;
  allowed_extensions?: string[];
  drop?: string[];
  degrade_form?: DegradeForm;
  /** 规范 3.8：安全控制字段的语义证据（按字段名索引）；缺项的字段不得进入白名单（HR-09） */
  security_control_evidence?: Record<string, SecurityControlEvidence>;
}

/** 规范 3.8：单个安全控制字段的语义证据 */
export interface SecurityControlEvidence {
  /** 已确认的字段语义（HR-09 要求非空且可判定） */
  semantics: string;
  /** 一手证据等级（HR-09 限定） */
  level: EvidenceLevel;
  /** 来源清单：官方等级给 URL，实测等级给路径或命令 */
  sources: string[];
  /** 跨宿主一致性、残余不确定性等补充说明 */
  note?: string;
}

/** 规范 3.8：非适配对象、但会读取落位根的外部消费方（HR-13） */
export interface ExternalConsumer {
  id: string;
  display_name: string;
  evidence: HostEvidence;
  note?: string;
}

/** 规范 3.2：宿主条目；roots 与 adapter_ref 对 not_applicable 宿主可省略（HR-06） */
export interface HostEntry {
  host_id: string;
  display_name: string;
  adapter_state: AdapterState;
  support_state: SupportState;
  evidence: HostEvidence;
  classification: HostClassification;
  roots?: HostRoot[];
  capability: HostCapability;
  render_policy: HostRenderPolicy;
  adapter_ref?: string;
  open_items?: string[];
}

/** 规范 3.1：顶层结构 */
export interface HostRegistry {
  registry_version: string;
  generated_at?: string;
  /** 规范 3.8：外部消费方登记（HR-13）；可出现在 consumed_by 中但不作为适配对象 */
  external_consumers?: ExternalConsumer[];
  hosts: HostEntry[];
}

/** 规范 4.1 的取值域（校验用） */
export const SUPPORT_STATES: readonly SupportState[] = [
  'confirmed',
  'pending_evidence',
  'degrade_only',
  'not_applicable',
];

/** 规范 3.2 的取值域（校验用） */
export const ADAPTER_STATES: readonly AdapterState[] = ['implemented', 'planned', 'degrade_only'];

/** 规范 4.2 的取值域（校验用） */
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'verified_official',
  'verified_local',
  'verified_runtime',
  'secondhand',
  'pending',
];

/** 规范 4.2：一手证据等级（HR-04 允许置 confirmed 的集合） */
export const FIRST_HAND_EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'verified_official',
  'verified_local',
  'verified_runtime',
];

/** 规范 3.5 的取值域（校验用） */
export const ROOT_KINDS: readonly RootKind[] = ['skill', 'rules', 'external'];

/** 规范 3.7 的取值域（校验用） */
export const FIELD_MODES: readonly FieldMode[] = ['standard6', 'host_declared'];

/** 规范 3.7 的取值域（校验用） */
export const DEGRADE_FORMS: readonly DegradeForm[] = ['entry', 'rule_file', 'none'];

/** 规范 3.2：宿主标识不得重复（HR-02） */
export const HOST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * HR-09：安全控制字段——控制模型自动调用行为的字段。
 *
 * 这类字段的准入不再"全宿主禁止"，而是**按宿主语义证据准入**：只有在
 * `render_policy.security_control_evidence` 中逐字段登记了已确认语义与一手证据的宿主，
 * 才允许其进入透传白名单；未登记者一律禁止（2026-10-16 裁决）。
 */
export const SECURITY_CONTROL_FIELDS = ['disable-model-invocation'] as const;

/** 安全控制字段名 */
export type SecurityControlField = (typeof SECURITY_CONTROL_FIELDS)[number];

/** 判定某字段是否为安全控制字段（HR-09 的适用对象） */
export function isSecurityControlField(field: string): boolean {
  return (SECURITY_CONTROL_FIELDS as readonly string[]).includes(field);
}

/**
 * HR-09 的准入判据（**唯一实现**：注册表加载期与渲染期共用，避免两层漂移）：
 * 语义证据须为 `semantics` 非空 + 一手等级 + 非空 `sources`。
 */
export function isSecurityControlEvidenceComplete(
  value: unknown,
): value is SecurityControlEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const semantics = record['semantics'];
  const level = record['level'];
  const sources = record['sources'];
  return (
    typeof semantics === 'string' &&
    semantics.trim() !== '' &&
    typeof level === 'string' &&
    (FIRST_HAND_EVIDENCE_LEVELS as readonly string[]).includes(level) &&
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}
