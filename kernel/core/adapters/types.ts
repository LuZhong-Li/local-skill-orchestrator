/**
 * K-15 适配器层：类型定义。
 *
 * 依据：设计文档 4.1 节（适配器接口）、4.2 节（生命周期）、6.1 与 6.2 节（落位计划与
 * 可推导布局）、6.3 节（重叠消费声明）。
 *
 * 形态与适配器的关系：宿主要么复用既有形态（技能形态 / 指令文件降级形态），
 * 要么新增一个形态实现（例如 Cursor 的规则路径）。因此「新增宿主 = 注册表一行 + 适配器」
 * 成立，但**复用形态的宿主不写任何宿主专有代码**（M5-R7）。
 */
import type { Finding } from '../../store/contract.ts';
import type { RootKind } from '../hosts/types.ts';
import type { RenderOutcome, RenderSource, ArtifactKind } from '../render/types.ts';

/** 产物形态：技能形态、规则路径形态、指令文件降级形态 */
export type AdapterForm = 'skill' | 'rules' | 'entry';

/** 落位计划中的一条落位项：完整目标文件路径 + 内容 + 消费关系声明 */
export interface PlacementEntry {
  artifact_kind: ArtifactKind;
  /** 落位根展开后的目录或文件路径（工作区内为相对路径，形如 .claude/skills/demo-skill） */
  root_path: string;
  /** 完整目标文件路径（规则文件模板即为该路径本身） */
  target_path: string;
  /** 目标文件名（目录类落位根下拼接的文件名；文件类落位根为空串） */
  file_name: string;
  root_kind: RootKind;
  /** 是否位于工作区之外（需由 T5 用外部根配置展开） */
  external: boolean;
  /** 是否可落盘；false 表示只产出片段（例如合并策略未定稿的指令文件） */
  landable: boolean;
  /** 不可落盘时的原因 */
  hold_reason?: string;
  /** 会读取该落位根的宿主集合（M5-R8 的重叠消费） */
  consumed_by: string[];
  content: string;
}

/** 重叠消费声明：同一落位根被多个宿主读取（M5-R8，特性而非缺陷） */
export interface OverlapDeclaration {
  root_path: string;
  consumed_by: string[];
}

/** 落位计划：适配器交给 T5 执行的完整输入（本批不写盘） */
export interface PlacementPlan {
  host_id: string;
  /** 目标标识（DP-01 方案 A：注册项即路径类，目标标识即宿主标识） */
  target_id: string;
  skill_id: string;
  form: AdapterForm;
  degraded: boolean;
  capability_gaps: string[];
  entries: PlacementEntry[];
  overlaps: OverlapDeclaration[];
  findings: Finding[];
}

/**
 * 宿主适配器。
 *
 * render 产出宿主可识别的文本；plan 把产物与落位根组装为落位计划（不写盘）；
 * verify 对产物做结构合规校验（只读）。落盘、受控副本衔接与清理由 T5 承担。
 */
export interface HostAdapter {
  readonly host_id: string;
  /** 该宿主支持的产物形态，第一个为默认形态 */
  readonly forms: readonly AdapterForm[];
  render(source: RenderSource, form?: AdapterForm): RenderOutcome;
  plan(source: RenderSource, form?: AdapterForm): PlacementPlan;
  verify(outcome: RenderOutcome): Finding[];
}
