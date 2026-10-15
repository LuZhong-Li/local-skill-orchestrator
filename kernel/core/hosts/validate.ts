/**
 * K-13 宿主注册表的校验：宿主注册表规范第 5 章的 HR-01 至 HR-12。
 *
 * 只读：不写入任何文件；输入为未知形态，先做结构判定再判语义，
 * 因此既能校验随内核交付的数据，也能用于反例测试与外部草稿校验。
 *
 * 与 schema 的分工：schemas/host_registry.schema.json 与 HR 校验覆盖同一组约束，
 * schema 供外部工具与契约测试使用，HR 校验供内核加载时使用；两者由契约测试交叉守住。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import {
  ADAPTER_STATES,
  EVIDENCE_LEVELS,
  FIELD_MODES,
  FIRST_HAND_EVIDENCE_LEVELS,
  FORBIDDEN_TRANSMISSION_FIELD,
  HOST_ID_PATTERN,
  REGISTRY_VERSION,
  ROOT_KINDS,
  SUPPORT_STATES,
  type HostEntry,
  type HostRegistry,
} from './types.ts';

const SOURCE = 'host-registry';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** HR-01：顶层结构与版本 */
function checkTopLevel(registry: unknown, out: Finding[]): void {
  if (!isRecord(registry)) {
    out.push(
      finding(CODES.FIELD_TYPE, {
        source: SOURCE,
        target: 'registry',
        message: '注册表必须是一个映射',
        remedy: '按宿主注册表规范 3.1 节给出 registry_version 与 hosts',
      }),
    );
    return;
  }
  if (registry['registry_version'] !== REGISTRY_VERSION) {
    out.push(
      finding(CODES.VERSION_UNSUPPORTED, {
        source: SOURCE,
        target: String(registry['registry_version'] ?? '(缺失)'),
        message: `注册表格式版本必须为 ${REGISTRY_VERSION}`,
        remedy: '使用与本内核版本匹配的注册表；更高版本按 HR-12 拒绝加载',
      }),
    );
  }
  const hosts = registry['hosts'];
  if (!Array.isArray(hosts) || hosts.length === 0) {
    out.push(
      finding(CODES.FIELD_REQUIRED, {
        source: SOURCE,
        target: 'hosts',
        message: '宿主条目列表缺失或为空',
        remedy: '至少登记一个宿主条目（规范 3.1 节）',
      }),
    );
  }
}

/** HR-02：宿主标识命名与唯一性 */
function checkIdentity(entry: Record<string, unknown>, index: number, out: Finding[]): void {
  const id = entry['host_id'];
  if (!isNonEmptyString(id) || !HOST_ID_PATTERN.test(id) || id.length > 64) {
    out.push(
      finding(CODES.ID_INVALID, {
        source: SOURCE,
        target: isNonEmptyString(id) ? id : `hosts[${String(index)}]`,
        message: '宿主标识缺失或不符合命名规范（小写字母、数字与短横线，不超过 64 字符）',
        remedy: '按规范 3.2 节的 host_id 规则修正；该取值同时是 --target 取值',
      }),
    );
  }
}

/** HR-03：注册表由内核维护，未登记字段判为不合规 */
function checkNoUnknownFields(
  entry: Record<string, unknown>,
  target: string,
  out: Finding[],
): void {
  const known = new Set([
    'host_id',
    'display_name',
    'adapter_state',
    'support_state',
    'evidence',
    'classification',
    'roots',
    'capability',
    'render_policy',
    'adapter_ref',
    'open_items',
  ]);
  const unknown = Object.keys(entry).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `出现未登记的字段：${unknown.join('、')}`,
        remedy: '注册表由内核维护，不支持扩展字段；新增字段须先更新宿主注册表规范',
      }),
    );
  }
}

/** HR-04：状态与证据绑定 */
function checkStateAndEvidence(
  entry: Record<string, unknown>,
  target: string,
  out: Finding[],
): void {
  const support = entry['support_state'];
  if (typeof support !== 'string' || !SUPPORT_STATES.includes(support as never)) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `支持状态取值非法：${String(support ?? '(缺失)')}`,
        remedy: `仅允许 ${SUPPORT_STATES.join('、')}`,
      }),
    );
    return;
  }
  const evidence = entry['evidence'];
  if (!isRecord(evidence)) {
    out.push(
      finding(CODES.FIELD_REQUIRED, {
        source: SOURCE,
        target,
        message: '缺少证据结构',
        remedy: '按规范 3.3 节给出 level（与 sources / note）',
      }),
    );
    return;
  }
  const level = evidence['level'];
  if (typeof level !== 'string' || !EVIDENCE_LEVELS.includes(level as never)) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `证据等级取值非法：${String(level ?? '(缺失)')}`,
        remedy: `仅允许 ${EVIDENCE_LEVELS.join('、')}`,
      }),
    );
    return;
  }
  if (support === 'confirmed' && !FIRST_HAND_EVIDENCE_LEVELS.includes(level as never)) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `机制已确认却只有 ${level} 级证据`,
        remedy: `「机制已确认」必须携带一手证据（${FIRST_HAND_EVIDENCE_LEVELS.join('、')}）`,
      }),
    );
  }
}

/** HR-05、HR-06：三维分类自洽与落位根完整（not_applicable 宿主豁免） */
function checkClassificationAndRoots(
  entry: Record<string, unknown>,
  target: string,
  out: Finding[],
): void {
  const exempt = entry['support_state'] === 'not_applicable';
  const classification = entry['classification'];
  if (!isRecord(classification)) {
    if (!exempt) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target,
          message: '缺少三维分类',
          remedy: '按规范 3.4 节给出 skill_mechanism 与 rules_only',
        }),
      );
    }
  } else {
    const skill = classification['skill_mechanism'];
    const rules = classification['rules_only'];
    if (typeof skill !== 'boolean' || typeof rules !== 'boolean') {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target,
          message: '三维分类的取值必须为布尔',
          remedy: 'skill_mechanism 与 rules_only 均为布尔字段',
        }),
      );
    } else if (!exempt && skill === false && rules === false) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target,
          message: '三维分类两项同时为假（无任何机制，却非不适用宿主）',
          remedy: '标注实际支持的机制；两类机制皆无时支持状态应为 not_applicable（HR-05）',
        }),
      );
    }
  }

  const roots = entry['roots'];
  if (roots === undefined || roots === null) {
    if (!exempt) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target,
          message: '缺少落位根列表',
          remedy: '每个可适配宿主至少登记一条落位根（HR-06）',
        }),
      );
    }
    return;
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    if (!exempt) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target,
          message: '落位根列表为空',
          remedy: '至少登记一条落位根；不适用宿主可省略该字段（HR-06）',
        }),
      );
    }
    return;
  }
  const kinds = new Set<string>();
  for (const [index, root] of roots.entries()) {
    if (!isRecord(root)) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target: `${target}.roots[${String(index)}]`,
          message: '落位根必须是映射',
          remedy: '按规范 3.5 节给出 kind 与 path_template',
        }),
      );
      continue;
    }
    const kind = root['kind'];
    if (typeof kind !== 'string' || !ROOT_KINDS.includes(kind as never)) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.roots[${String(index)}]`,
          message: `落位根类别取值非法：${String(kind ?? '(缺失)')}`,
          remedy: `仅允许 ${ROOT_KINDS.join('、')}`,
        }),
      );
    } else if (kinds.has(kind)) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.roots[${String(index)}]`,
          message: `同一宿主的落位根类别重复：${kind}`,
          remedy: '同一类别只保留一条；技能根与规则路径分条登记（HR-06）',
        }),
      );
    } else {
      kinds.add(kind);
    }
    if (!isNonEmptyString(root['path_template'])) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: `${target}.roots[${String(index)}]`,
          message: '缺少落位路径模板',
          remedy: '给出 path_template（技能根沿用可推导布局模板）',
        }),
      );
    }
  }
  if (
    !exempt &&
    isRecord(classification) &&
    classification['skill_mechanism'] === true &&
    !kinds.has('skill') &&
    !kinds.has('external')
  ) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: '声明支持 skill 机制却没有技能根',
        remedy: '补一条 kind 为 skill 或 external 的落位根（HR-06）',
      }),
    );
  }
}

/** HR-07：消费关系取值必须指向本注册表内的宿主 */
function checkConsumption(
  entry: Record<string, unknown>,
  target: string,
  hostIds: Set<string>,
  out: Finding[],
): void {
  const groups: Array<[string, unknown]> = [];
  const classification = entry['classification'];
  if (isRecord(classification)) {
    groups.push(['classification.root_consumed_by', classification['root_consumed_by']]);
  }
  const roots = entry['roots'];
  if (Array.isArray(roots)) {
    for (const [index, root] of roots.entries()) {
      if (isRecord(root)) {
        groups.push([`roots[${String(index)}].consumed_by`, root['consumed_by']]);
      }
    }
  }
  for (const [where, value] of groups) {
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target: `${target}.${where}`,
          message: '消费宿主集合必须是字符串数组',
          remedy: '逐项给出本注册表内存在的宿主标识',
        }),
      );
      continue;
    }
    const unknown = value.filter((item) => !hostIds.has(item as string));
    if (unknown.length > 0) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.${where}`,
          message: `消费宿主不在本注册表内：${unknown.join('、')}`,
          remedy: '先登记该宿主，或从消费集合中移除（HR-07）',
        }),
      );
    }
  }
}

/** HR-08、HR-09、HR-10、HR-11：渲染策略、透传禁列、可落位性、证据来源形式 */
function checkPolicy(entry: Record<string, unknown>, target: string, out: Finding[]): void {
  const adapter = entry['adapter_state'];
  if (typeof adapter !== 'string' || !ADAPTER_STATES.includes(adapter as never)) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `适配器实现状态取值非法：${String(adapter ?? '(缺失)')}`,
        remedy: `仅允许 ${ADAPTER_STATES.join('、')}`,
      }),
    );
  }
  const exempt = entry['support_state'] === 'not_applicable';
  if (!exempt && !isNonEmptyString(entry['adapter_ref'])) {
    out.push(
      finding(CODES.FIELD_REQUIRED, {
        source: SOURCE,
        target,
        message: '缺少适配器引用',
        remedy: '给出 adapter_ref（与 host_id 一对一）；不适用宿主可省略（规范 3.2）',
      }),
    );
  }

  const policy = entry['render_policy'];
  if (!isRecord(policy)) {
    out.push(
      finding(CODES.FIELD_REQUIRED, {
        source: SOURCE,
        target,
        message: '缺少渲染与透传策略',
        remedy: '按规范 3.7 节给出 field_mode（与 allowed_extensions / drop / degrade_form）',
      }),
    );
    return;
  }
  const mode = policy['field_mode'];
  if (typeof mode !== 'string' || !FIELD_MODES.includes(mode as never)) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `渲染模式取值非法：${String(mode ?? '(缺失)')}`,
        remedy: `仅允许 ${FIELD_MODES.join('、')}`,
      }),
    );
    return;
  }
  const extensions = policy['allowed_extensions'];
  const list = Array.isArray(extensions) ? extensions : undefined;
  if (list !== undefined && !list.every((item) => isNonEmptyString(item))) {
    out.push(
      finding(CODES.FIELD_TYPE, {
        source: SOURCE,
        target,
        message: '透传白名单必须是字符串数组',
        remedy: '逐项给出字段名',
      }),
    );
  }
  const size = list === undefined ? 0 : list.length;
  if (mode === 'host_declared' && size === 0) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: '透传模式却没有白名单',
        remedy: '给出非空的 allowed_extensions，或改回 standard6（HR-08）',
      }),
    );
  }
  if (mode === 'standard6' && size > 0) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: '标准字段模式却给出透传白名单',
        remedy: 'standard6 模式的白名单必须为空或缺省（HR-08）',
      }),
    );
  }
  if (list?.includes(FORBIDDEN_TRANSMISSION_FIELD) === true) {
    out.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: SOURCE,
        target,
        message: `透传白名单包含禁止字段：${FORBIDDEN_TRANSMISSION_FIELD}`,
        remedy: '该字段在任何宿主下都不得透传（HR-09、DP-04）',
      }),
    );
  }

  const evidence = entry['evidence'];
  if (isRecord(evidence)) {
    const level = evidence['level'];
    const sources = evidence['sources'];
    if (sources !== undefined && !Array.isArray(sources)) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target,
          message: '证据来源必须是字符串数组',
          remedy: '官方等级给 URL，实测等级给路径或命令（HR-11）',
        }),
      );
    } else if (Array.isArray(sources)) {
      const empty = sources.length === 0;
      if (empty && level === 'verified_official') {
        out.push(
          finding(CODES.FIELD_REQUIRED, {
            source: SOURCE,
            target,
            message: '官方等级未给出来源 URL',
            remedy: '补充官方文档链接（HR-11）',
          }),
        );
      }
      if (empty && (level === 'verified_local' || level === 'verified_runtime')) {
        out.push(
          finding(CODES.FIELD_REQUIRED, {
            source: SOURCE,
            target,
            message: '实测等级未给出实测路径或命令',
            remedy: '补充可复现的路径或命令（HR-11）',
          }),
        );
      }
    }
  }
}

/**
 * 全量校验：HR-01 至 HR-12。
 *
 * HR-10（可落位性）与 HR-12（版本兼容）不单独产出问题条目：
 *   前者是查询语义（planned 宿主不进可落位集合），后者按「拒绝加载」处理（HR-01）。
 */
export function validateHostRegistry(registry: unknown): Finding[] {
  const out: Finding[] = [];
  checkTopLevel(registry, out);
  if (!isRecord(registry)) return out;
  const hosts = registry['hosts'];
  if (!Array.isArray(hosts)) return out;

  const seen = new Set<string>();
  const identifiers = new Set<string>();
  for (const entry of hosts) {
    if (isRecord(entry) && isNonEmptyString(entry['host_id'])) identifiers.add(entry['host_id']);
  }
  for (const [index, entry] of hosts.entries()) {
    if (!isRecord(entry)) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target: `hosts[${String(index)}]`,
          message: '宿主条目必须是映射',
          remedy: '按规范 3.2 节给出条目字段',
        }),
      );
      continue;
    }
    const id = typeof entry['host_id'] === 'string' ? entry['host_id'] : `hosts[${String(index)}]`;
    checkIdentity(entry, index, out);
    checkNoUnknownFields(entry, id, out);
    if (isNonEmptyString(entry['host_id'])) {
      if (seen.has(entry['host_id'])) {
        out.push(
          finding(CODES.ID_DUPLICATED, {
            source: SOURCE,
            target: id,
            message: '宿主标识重复',
            remedy: '每个宿主标识在注册表内唯一（HR-02）',
          }),
        );
      }
      seen.add(entry['host_id']);
    }
    if (!isNonEmptyString(entry['display_name'])) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: id,
          message: '缺少展示名称',
          remedy: '给出 display_name',
        }),
      );
    }
    if (!isRecord(entry['capability'])) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: id,
          message: '缺少能力声明',
          remedy: '给出 capability（可为空映射）',
        }),
      );
    }
    checkStateAndEvidence(entry, id, out);
    checkClassificationAndRoots(entry, id, out);
    checkPolicy(entry, id, out);
    checkConsumption(entry, id, identifiers, out);
    const openItems = entry['open_items'];
    if (
      openItems !== undefined &&
      (!Array.isArray(openItems) || !openItems.every((item) => isNonEmptyString(item)))
    ) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target: id,
          message: '待确认项编号必须是字符串数组',
          remedy: '逐项给出形如 HD-01 的编号',
        }),
      );
    }
  }
  return out;
}

/** 取错误级问题（加载判定用） */
export function errorsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter((item) => item.severity === 'error');
}

/** 校验通过后按注册表类型使用；调用方需先确认无错误级问题 */
export function asHostRegistry(registry: unknown): HostRegistry {
  return registry as HostRegistry;
}

/** HR-10：该条目是否可参与落位 */
export function isSelectable(entry: HostEntry): boolean {
  return entry.adapter_state === 'implemented' || entry.adapter_state === 'degrade_only';
}
