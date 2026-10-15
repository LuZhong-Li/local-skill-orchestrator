/**
 * K-01 元数据模型：类型定义。
 *
 * 字段名与 YAML 键逐一对应（含下划线形式），不做大小写转换，
 * 以便代码与契约逐字比对，减少映射层引入的偏差。
 * 权威定义见 docs/specification/skill-meta-spec.md 第 3、4 章。
 */

export type SkillStatus = 'enabled' | 'disabled';
export type SourceType = 'local' | 'git' | 'archive' | 'unknown';
export type TargetScope = 'global' | 'project';
export type TargetMode = 'copy' | 'link';
export type ValidationStatus = 'ok' | 'invalid';

/** 来源信息块（元文件的声明区字段） */
export interface SkillSource {
  type: SourceType;
  url?: string;
  ref?: string;
  subpath?: string;
}

/** 依赖声明（元文件的声明区字段） */
export interface SkillDependencies {
  skills?: string[];
  runtime?: Record<string, string>;
}

/** 元文件声明的一条外部运行时依赖：名称为可执行文件名，约束为语义化版本范围表达式 */
export interface SkillRuntimeDependency {
  name: string;
  constraint: string;
}

/** 落位目标（元文件的声明区字段） */
export interface SkillTarget {
  target: string;
  scope: TargetScope;
  path: string;
  mode: TargetMode;
  enabled: boolean;
  file_map: Record<string, string>;
}

/** skill_meta.yaml 的完整结构 */
export interface SkillMeta {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  status: SkillStatus;
  path: string;
  trigger_keywords?: string[];
  dependencies?: SkillDependencies;
  source: SkillSource;
  targets: SkillTarget[];
  // 派生区
  created_at: string;
  updated_at: string;
  checksum: string;
}

/** 落位目标摘要：索引只保留目标标识、作用域与启用状态 */
export interface IndexTargetSummary {
  target: string;
  scope: TargetScope;
  enabled: boolean;
}

/** 运行期结论：由扫描动作计算生成，不是元文件的投影 */
export interface IndexValidation {
  status: ValidationStatus;
  errors: string[];
  /**
   * 最近一次扫描写入运行期结论的时间，只有扫描动作维护。
   * 可选：安装新登记的记录在首次扫描之前没有该取值，缺失按「尚未扫描」处理。
   */
  last_scan_at?: string;
}

/** 索引中的单条 Skill 记录 */
export interface IndexRecord {
  // 声明区引用字段
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  status: SkillStatus;
  path: string;
  trigger_keywords?: string[];
  dependencies?: string[];
  source_type: SourceType;
  targets: IndexTargetSummary[];
  // 派生区
  created_at: string;
  updated_at: string;
  checksum: string;
  /**
   * 派生区：逐文件内容摘要，键为文件相对 Skill 目录的路径。
   *
   * 可选：本字段引入之前生成的旧索引没有它，缺失表示待内核回填，由下一次登记与刷新补齐；
   * 补齐之前内容一致性校验退化为聚合级报告（元数据规范 4.4 与 5.4）。只存于索引，
   * 元文件与导出物都不承载该字段。
   */
  digests?: Record<string, string>;
  // 运行期结论
  validation: IndexValidation;
}

/** 索引的配置区 */
export interface IndexConfig {
  skill_roots: string[];
  default_target?: string;
  default_mode?: TargetMode;
  [key: string]: unknown;
}

/** 全局索引 skill_index.yaml 的顶层结构 */
export interface SkillIndex {
  schema_version: string;
  tool_version: string;
  generated_at: string;
  config: IndexConfig;
  skills: IndexRecord[];
  [key: string]: unknown;
}
