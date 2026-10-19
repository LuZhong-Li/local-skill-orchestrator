/** host 渲染策略、安全字段与外部消费方校验。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import {
  ADAPTER_STATES,
  FIRST_HAND_EVIDENCE_LEVELS,
  FIELD_MODES,
  HOST_ID_PATTERN,
  SECURITY_CONTROL_FIELDS,
  isNonEmptyString,
  isRecord,
  isSecurityControlEvidenceComplete,
  isSecurityControlField,
  SOURCE,
} from './validate-shared.ts';

export function checkPolicy(entry: Record<string, unknown>, target: string, out: Finding[]): void {
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
  checkSecurityControlFields(policy, list, target, out);

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
 * HR-09：安全控制字段准入。
 *
 * 安全控制字段（`disable-model-invocation` 等）不再「全宿主禁止」，而是**按宿主语义证据准入**：
 *   一、白名单中的每个安全控制字段，必须在该宿主的 `security_control_evidence` 中登记
 *       `semantics`（非空）+ 一手 `level` + 非空 `sources`；
 *   二、该结构的键必须是安全控制字段，且必须出现在白名单中——防止失效或"先登记后移除"的残留；
 *   三、缺任一项即判不合规：白名单不允许「先加字段、后补证据」。
 */
function checkSecurityControlFields(
  policy: Record<string, unknown>,
  list: unknown[] | undefined,
  target: string,
  out: Finding[],
): void {
  const evidence = policy['security_control_evidence'];
  const evidenceMap = isRecord(evidence) ? evidence : undefined;
  if (evidence !== undefined && evidenceMap === undefined) {
    out.push(
      finding(CODES.FIELD_TYPE, {
        source: SOURCE,
        target,
        message: '安全控制字段证据必须是映射（按字段名索引）',
        remedy: '按规范 3.8 节给出 { <字段名>: { semantics, level, sources } }',
      }),
    );
  }
  const whitelist = new Set(
    (list ?? []).filter((item): item is string => typeof item === 'string'),
  );
  for (const field of whitelist) {
    if (!isSecurityControlField(field)) continue;
    if (!isSecurityControlEvidenceComplete(evidenceMap?.[field])) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.render_policy`,
          message: `安全控制字段的语义证据缺失或不完整：${field}`,
          remedy:
            '在 render_policy.security_control_evidence 中给出 semantics（非空语义）+ 一手 level + 非空 sources（HR-09）',
        }),
      );
    }
  }
  if (evidenceMap === undefined) return;
  for (const key of Object.keys(evidenceMap)) {
    if (!isSecurityControlField(key)) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.security_control_evidence.${key}`,
          message: `该结构只用于安全控制字段：${key}`,
          remedy: `仅允许 ${SECURITY_CONTROL_FIELDS.join('、')} 使用该结构（规范 3.8）`,
        }),
      );
      continue;
    }
    if (!whitelist.has(key)) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${target}.security_control_evidence.${key}`,
          message: `登记了语义证据但未进入白名单：${key}`,
          remedy: '把该字段加入 allowed_extensions，或删除这条失效登记（HR-09）',
        }),
      );
    }
  }
}

/**
 * HR-13：外部消费方登记完整。
 *
 * `external_consumers[]` 登记「会读取落位根、但不作为适配对象」的外部产品（如开发者预览期的
 * `dsh`）：必须有 `id`（命名同 HR-02）、`display_name` 与非空一手 `evidence`；`id` 不得与任何
 * `host_id` 或彼此重复。返回值供 HR-07 的消费关系判定使用。
 */
export function checkExternalConsumers(
  registry: Record<string, unknown>,
  hostIds: Set<string>,
  out: Finding[],
): Set<string> {
  const ids = new Set<string>();
  const consumers = registry['external_consumers'];
  if (consumers === undefined) return ids;
  if (!Array.isArray(consumers)) {
    out.push(
      finding(CODES.FIELD_TYPE, {
        source: SOURCE,
        target: 'external_consumers',
        message: '外部消费方必须是数组',
        remedy: '按规范 3.8 节给出 external_consumers 数组',
      }),
    );
    return ids;
  }
  for (const [index, consumer] of consumers.entries()) {
    const target = `external_consumers[${String(index)}]`;
    if (!isRecord(consumer)) {
      out.push(
        finding(CODES.FIELD_TYPE, {
          source: SOURCE,
          target,
          message: '外部消费方条目必须是映射',
          remedy: '按规范 3.8 节给出 id / display_name / evidence',
        }),
      );
      continue;
    }
    const id = consumer['id'];
    if (typeof id !== 'string' || !HOST_ID_PATTERN.test(id)) {
      out.push(
        finding(CODES.ID_INVALID, {
          source: SOURCE,
          target,
          message: `外部消费方标识不符合命名规范：${String(id ?? '(缺失)')}`,
          remedy: '全小写字母、数字与短横线，不超过 64 字符（HR-13）',
        }),
      );
    } else {
      if (hostIds.has(id)) {
        out.push(
          finding(CODES.ID_DUPLICATED, {
            source: SOURCE,
            target: id,
            message: '外部消费方标识与宿主标识重复',
            remedy: '外部消费方标识不得与任何 host_id 重复（HR-13）',
          }),
        );
      }
      if (ids.has(id)) {
        out.push(
          finding(CODES.ID_DUPLICATED, {
            source: SOURCE,
            target: id,
            message: '外部消费方标识重复',
            remedy: '每个外部消费方标识在注册表内唯一（HR-13）',
          }),
        );
      }
      ids.add(id);
    }
    if (!isNonEmptyString(consumer['display_name'])) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: id === undefined ? target : String(id),
          message: '缺少展示名称',
          remedy: '给出 display_name（HR-13）',
        }),
      );
    }
    const evidence = consumer['evidence'];
    if (!isRecord(evidence)) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: id === undefined ? target : String(id),
          message: '缺少证据结构',
          remedy: '给出 evidence.level 与来源（规范 3.3 / HR-13）',
        }),
      );
      continue;
    }
    const level = evidence['level'];
    if (typeof level !== 'string' || !FIRST_HAND_EVIDENCE_LEVELS.includes(level as never)) {
      out.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: id === undefined ? target : String(id),
          message: `外部消费方证据必须为一手等级：${String(level ?? '(缺失)')}`,
          remedy: `仅允许 ${FIRST_HAND_EVIDENCE_LEVELS.join('、')}（HR-13）`,
        }),
      );
    }
    const sources = evidence['sources'];
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((item) => isNonEmptyString(item))
    ) {
      out.push(
        finding(CODES.FIELD_REQUIRED, {
          source: SOURCE,
          target: id === undefined ? target : String(id),
          message: '外部消费方缺少来源',
          remedy: '至少给出一条来源（官方给 URL，实测给路径或命令）',
        }),
      );
    }
  }
  return ids;
}

/**
 * 全量校验：HR-01 至 HR-15。
 *
 * HR-10（可落位性）与 HR-12（版本兼容）不单独产出问题条目：
 *   前者是查询语义（planned 宿主不进可落位集合），后者按「拒绝加载」处理（HR-01）。
 */
