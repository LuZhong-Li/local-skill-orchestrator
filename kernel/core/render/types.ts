/**
 * K-14 渲染层：类型定义。
 *
 * 依据：设计文档 5.2 节（渲染模式与 DP-04 透传白名单细则）、5.3 节（共用渲染核心）、
 * 5.4 节（降级渲染与能力差异声明）；宿主注册表规范 3.7 节（渲染与透传策略）。
 *
 * 渲染与落位解耦：本层的产物是**内存中的文件集合**（路径 + 文本），一律不写盘；
 * 落盘与受控副本由 T5 的落位扩展处理，适配器不自己写盘。
 */
import type { Finding } from '../../store/contract.ts';
import type { DegradeForm, FieldMode, SecurityControlEvidence } from '../hosts/types.ts';

/** 规范化的内部技能表示：渲染层的唯一输入形态 */
export interface RenderSource {
  /** 内部标识；同时是标准字段 name 的来源（须与目录名一致） */
  id: string;
  description?: string;
  license?: string;
  /** 兼容性说明；来自内部 SKILL.md 元数据块 */
  compatibility?: string;
  /** 允许工具；来自内部 SKILL.md 元数据块（标准中为实验性字段） */
  allowed_tools?: string;
  version?: string;
  author?: string;
  homepage?: string;
  tags?: string[];
  /** 依赖声明：其他 Skill 及其版本约束 */
  skill_dependencies?: string[];
  /** 依赖声明：外部运行时及其版本约束（渲染进兼容性文本） */
  runtime_dependencies?: Record<string, string>;
  /** 触发关键词：标准无对应字段，按降级规则并入描述 */
  trigger_keywords?: string[];
  /** 用户显式声明透传的扩展字段（键值均为字符串） */
  extensions?: Record<string, string>;
  /** 指令正文；SKILL.md 产物中位于元数据块之后 */
  body?: string;
}

/** 产物形态：技能形态、规则文件形态、指令文件降级形态 */
export type ArtifactKind = 'skill_md' | 'rule_file' | 'agents_md_fragment';

/** 渲染产物：单个文件（路径为宿主侧相对路径模板，落位由 T5 完成） */
export interface ArtifactFile {
  kind: ArtifactKind;
  /** 相对路径（未展开落位根）；例如 `<Skill 标识>/SKILL.md` */
  path: string;
  content: string;
}

/** 一次渲染的字段级台账：用于输出、审计与契约测试 */
export interface RenderLedger {
  /** 实际渲染的标准字段（按渲染顺序） */
  standard: string[];
  /** 实际渲染的透传扩展字段（按字母序） */
  extensions: string[];
  /** 被忽略或被拒的声明字段 */
  dropped: string[];
}

/** 渲染结果 */
export interface RenderOutcome {
  host_id: string;
  /** 实际生效的渲染模式；降级形态记为 degrade_entry */
  field_mode: FieldMode | 'degrade_entry';
  /** 是否处于降级形态 */
  degraded: boolean;
  /** 降级形态缺少的能力（自动发现 / 按需加载 / 工具预授权），非降级为空数组 */
  capability_gaps: string[];
  files: ArtifactFile[];
  ledger: RenderLedger;
  findings: Finding[];
}

/** 渲染策略：来自宿主注册项，或在测试中显式给出 */
export interface RenderPolicyInput {
  host_id: string;
  field_mode: FieldMode;
  allowed_extensions?: string[];
  degrade_form?: DegradeForm;
  max_description_chars?: number;
  /** 安全控制字段的语义证据（注册表透传；HR-09 的准入判定依据） */
  security_control_evidence?: Record<string, SecurityControlEvidence>;
}

/** 渲染层使用的问题条目类型（与内核统一的 Finding 一致） */
export type { Finding };
