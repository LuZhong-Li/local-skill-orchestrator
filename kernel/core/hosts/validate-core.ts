/** host 注册表顶层、身份、状态与消费关系校验。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import {
  EVIDENCE_LEVELS,
  FIRST_HAND_EVIDENCE_LEVELS,
  HOST_ID_PATTERN,
  REGISTRY_VERSION,
  SUPPORT_STATES,
  checkNoUnknownFields,
  isNonEmptyString,
  isRecord,
  SOURCE,
  validateRootModel,
  type HostEntry,
  type HostRegistry,
} from './validate-shared.ts';
import { checkClassificationAndRoots } from './validate-roots.ts';
import { checkExternalConsumers, checkPolicy } from './validate-policy.ts';

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

/** HR-08、HR-09、HR-10、HR-11：渲染策略、安全控制字段准入、可落位性、证据来源形式 */
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
  // HR-13：外部消费方登记；其标识与宿主标识共同构成 HR-07 的合法集合
  const consumerIds = new Set<string>([
    ...identifiers,
    ...checkExternalConsumers(registry, identifiers, out),
  ]);
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
    validateRootModel(entry, id, consumerIds, out);
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
    checkConsumption(entry, id, consumerIds, out);
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
