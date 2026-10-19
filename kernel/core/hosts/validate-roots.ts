/** host 分类与落位根校验。 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { isNonEmptyString, isRecord, ROOT_KINDS, SOURCE } from './validate-shared.ts';

export function checkClassificationAndRoots(
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
