/**
 * K-13 宿主注册表服务。
 *
 * 职责：把随内核交付的注册表数据加载为唯一事实源，供后续的渲染层（T3）、
 * 适配器（T4）与落位（T5）按宿主标识查询，并提供透传白名单的判定原语。
 *
 * 依据：宿主注册表规范 docs/specification/host-registry.spec.md（第五份契约规范）；
 * 需求 9.3.6 的 M5-R1（唯一事实源）、M5-R2（渲染与降级）、M5-R7（新增宿主零内核改动）、
 * M5-R8（落位根重叠消费）；设计 5.2 节（DP-04 透传白名单细则）。
 *
 * 边界：本模块不含任何渲染、落位与适配器逻辑（属 T3 / T4 / T5）。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { HOST_REGISTRY_DATA } from './registry-data.ts';
import { asHostRegistry, errorsOf, isSelectable, validateHostRegistry } from './validate.ts';
import {
  isSecurityControlEvidenceComplete,
  isSecurityControlField,
  type HostEntry,
  type HostRenderPolicy,
  type HostRegistry,
  type RootKind,
} from './types.ts';

const SOURCE = 'host-registry';

/** 三维分类的查询条件；留空表示不过滤（M5-R1 的三维分类） */
export interface HostFilter {
  /** 是否支持 skill 机制 */
  skillMechanism?: boolean;
  /** 是否仅支持规则文件 */
  rulesOnly?: boolean;
  /** 该宿主的落位根是否被指定宿主消费（落位根重叠，M5-R8） */
  consumedBy?: string;
  /** 落位根类别过滤 */
  rootKind?: RootKind;
  /** 仅返回可参与落位的宿主（HR-10） */
  selectableOnly?: boolean;
}

/** 透传判定结果：命中即透传，未命中回报警告（不静默丢弃） */
export interface ExtensionResolution {
  /** 实际写入宿主产物的非标准字段 */
  transmitted: string[];
  /** 被忽略或拒绝的字段及其原因 */
  findings: Finding[];
}

let cached: HostRegistry | null = null;
let cachedIndex: Map<string, HostEntry> | null = null;

/** 校验失败的加载错误：把全部错误级问题折进消息，便于定位 */
function loadFailure(findings: readonly Finding[]): KernelError {
  const first = findings[0];
  return new KernelError({
    code: first?.code ?? CODES.FIELD_INVALID_VALUE,
    source: SOURCE,
    target: first?.target ?? 'registry',
    message: `宿主注册表校验失败（${String(findings.length)} 项）：${findings
      .map((item) => item.message)
      .join('；')}`,
    remedy: '注册表随内核交付，出现非法即为内核缺陷；请更新内核版本或提交问题',
  });
}

/**
 * 加载注册表：校验 HR-01 至 HR-13，全部通过才返回。
 * 结果被冻结并缓存：注册表是只读事实源，调用方不得就地修改。
 */
export function loadHostRegistry(): HostRegistry {
  if (cached !== null) return cached;
  const findings = validateHostRegistry(HOST_REGISTRY_DATA);
  const errors = errorsOf(findings);
  if (errors.length > 0) throw loadFailure(errors);
  const registry = asHostRegistry(HOST_REGISTRY_DATA);
  for (const entry of registry.hosts) Object.freeze(entry);
  Object.freeze(registry.hosts);
  cached = Object.freeze(registry);
  cachedIndex = new Map(registry.hosts.map((entry) => [entry.host_id, entry]));
  return cached;
}

/** 按宿主标识查询；未登记时返回 undefined（调用方决定如何报错） */
export function hostById(hostId: string): HostEntry | undefined {
  loadHostRegistry();
  return cachedIndex?.get(hostId);
}

/** 按三维分类等条件过滤宿主条目（M5-R1、M5-R8） */
export function listHosts(filter: HostFilter = {}): HostEntry[] {
  const registry = loadHostRegistry();
  return registry.hosts.filter((entry) => {
    const classification = entry.classification;
    if (
      filter.skillMechanism !== undefined &&
      classification.skill_mechanism !== filter.skillMechanism
    ) {
      return false;
    }
    if (filter.rulesOnly !== undefined && classification.rules_only !== filter.rulesOnly) {
      return false;
    }
    if (filter.rootKind !== undefined) {
      const kinds = (entry.roots ?? []).map((root) => root.kind);
      if (!kinds.includes(filter.rootKind)) return false;
    }
    if (filter.consumedBy !== undefined) {
      const consumedBy: string = filter.consumedBy;
      const declared =
        classification.root_consumed_by?.includes(consumedBy) === true ||
        (entry.roots ?? []).some((root) => root.consumed_by?.includes(consumedBy) === true);
      if (!declared) return false;
    }
    if (filter.selectableOnly === true && !isSelectable(entry)) return false;
    return true;
  });
}

/**
 * 可参与落位的宿主标识集合（HR-10）。
 * 适配器实现状态为 implemented 或 degrade_only 的宿主才可落位；planned 宿主不进该集合。
 */
export function selectableHostIds(): string[] {
  return listHosts({ selectableOnly: true }).map((entry) => entry.host_id);
}

/**
 * 判定某个落位根被哪些宿主消费（M5-R8 的落位根重叠）。
 * 未登记的落位根返回空数组，由调用方按登记缺陷处理。
 */
export function consumersOfRoot(hostId: string, kind: RootKind): string[] {
  const entry = hostById(hostId);
  const root = (entry?.roots ?? []).find((item) => item.kind === kind);
  return root?.consumed_by === undefined ? [] : [...root.consumed_by];
}

/**
 * 透传白名单判定的**唯一实现**（DP-04）：
 * 白名单命中即透传；未命中忽略并回报警告（不静默丢弃）；
 * 安全控制字段（如 `disable-model-invocation`）**按宿主语义证据准入**（HR-09，2026-10-16 裁决）：
 * 命中所属宿主的白名单即透传；未命中则该宿主未登记语义证据，一律拒绝且给出可定位的问题条目。
 *
 * 由注册表查询路径与渲染层共用，保证「先查注册表」与「显式给出策略」两种调用
 * 不会出现两套判定逻辑。
 */
export function resolveDeclaredExtensions(
  policy: HostRenderPolicy,
  declared: readonly string[],
): ExtensionResolution {
  const whitelist = new Set(policy.allowed_extensions ?? []);
  const transmitted: string[] = [];
  const findings: Finding[] = [];
  for (const field of declared) {
    const permitted = whitelist.has(field);
    if (isSecurityControlField(field)) {
      const admitted =
        permitted && isSecurityControlEvidenceComplete(policy.security_control_evidence?.[field]);
      if (admitted) {
        transmitted.push(field);
        continue;
      }
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: field,
          message: `安全控制字段未通过准入，已拒绝透传：${field}`,
          remedy:
            '该字段既可能未进入宿主白名单，也可能缺少语义证据（需 semantics + 一手 level + 非空 sources）；补登记后再启用（HR-09）',
        }),
      );
      continue;
    }
    if (permitted) {
      transmitted.push(field);
      continue;
    }
    findings.push(
      finding(CODES.FIELD_WHITELIST, {
        source: SOURCE,
        target: field,
        message: `字段不在透传白名单内，已忽略：${field}`,
        remedy:
          policy.field_mode === 'standard6'
            ? '该宿主只输出标准六字段；如需扩展字段，须先在注册表中登记其白名单'
            : '在宿主注册表的 allowed_extensions 中登记该字段后再启用透传',
      }),
    );
  }
  return { transmitted, findings };
}

/**
 * 按宿主标识判定透传白名单（DP-04）：查注册表后委托唯一实现。
 * 未登记的宿主标识抛出 KernelError，不静默按空策略处理。
 */
export function resolveExtensions(
  hostId: string,
  declared: readonly string[],
): ExtensionResolution {
  const entry = hostById(hostId);
  if (entry === undefined) {
    throw new KernelError({
      code: CODES.ID_INVALID,
      source: SOURCE,
      target: hostId,
      message: `未登记的宿主标识：${hostId}`,
      remedy: '取值必须来自宿主注册表；未登记取值按未登记处理，不静默落位',
    });
  }
  return resolveDeclaredExtensions(entry.render_policy, declared);
}

/** 宿主标识全集，供取值校验与错误提示使用 */
export function hostIds(): string[] {
  return loadHostRegistry().hosts.map((entry) => entry.host_id);
}
