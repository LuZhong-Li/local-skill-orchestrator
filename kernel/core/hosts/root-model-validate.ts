/** 宿主注册表扩展结构校验：adapter_forms / landing_roots / inventory_roots。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';

const SOURCE = 'host-registry';
const ADAPTER_FORMS = ['skill', 'rules', 'entry'];
const ROOT_KINDS = ['skill', 'rules', 'external'];
const ROOT_ROLES = ['user', 'system', 'platform', 'project'];
const ROOT_DEPTHS = ['direct', 'recursive'];
const STATIC_ROOT_ORIGINS = ['default', 'legacy'];
const ROOT_BASES = ['home', 'env', 'workspace', 'absolute'];
const PLATFORMS = ['any', 'win32', 'darwin', 'linux'];
const ROOT_ID_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function checkNoUnknownFields(
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
    'adapter_forms',
    'landing_roots',
    'inventory_roots',
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

function error(target: string, message: string, remedy: string): Finding {
  return finding(CODES.FIELD_INVALID_VALUE, { source: SOURCE, target, message, remedy });
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  target: string,
  label: string,
  out: Finding[],
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    out.push(
      error(
        target,
        `${label}取值非法：${String(value ?? '(缺失)')}`,
        `仅允许 ${allowed.join('、')}`,
      ),
    );
  }
}

function checkAdapterForms(entry: Record<string, unknown>, target: string, out: Finding[]): void {
  const forms = entry['adapter_forms'];
  if (!Array.isArray(forms) || forms.length === 0) {
    out.push(error(target, '缺少适配器形态', '给出非空 adapter_forms（skill / rules / entry）'));
    return;
  }
  if (new Set(forms).size !== forms.length) {
    out.push(error(target, '适配器形态重复', 'adapter_forms 每项只能出现一次'));
  }
  for (const form of forms) {
    checkEnum(form, ADAPTER_FORMS, `${target}.adapter_forms`, '适配器形态', out);
  }
}

function checkLandingRoot(root: unknown, target: string, out: Finding[]): void {
  if (!isRecord(root)) {
    out.push(error(target, 'landing_root 必须是映射', '给出 kind / base / path_template'));
    return;
  }
  checkEnum(root['kind'], ROOT_KINDS, `${target}.kind`, '落位根类别', out);
  checkEnum(root['base'], ['home', 'env'], `${target}.base`, '默认根基址', out);
  if (!isNonEmptyString(root['path_template'])) {
    out.push(
      error(`${target}.path_template`, 'path_template 必须是非空字符串', '给出相对基址的路径模板'),
    );
  }
  if (root['base'] === 'env' && !isNonEmptyString(root['env_var'])) {
    out.push(error(`${target}.env_var`, 'env 基址必须给出 env_var', '例如 LOCALAPPDATA'));
  }
  if (root['platform'] !== undefined) {
    checkEnum(root['platform'], PLATFORMS, `${target}.platform`, '平台', out);
  }
}

function checkInventoryRoot(
  root: unknown,
  target: string,
  consumerIds: ReadonlySet<string>,
  out: Finding[],
): void {
  if (!isRecord(root)) {
    out.push(
      error(
        target,
        'inventory_root 必须是映射',
        '给出 root_id / role / kind / base / depth / origin',
      ),
    );
    return;
  }
  checkInventoryIdentity(root, target, out);
  checkInventoryExtras(root, target, consumerIds, out);
}

function checkInventoryIdentity(
  root: Record<string, unknown>,
  target: string,
  out: Finding[],
): void {
  if (!isNonEmptyString(root['root_id']) || !ROOT_ID_PATTERN.test(root['root_id'])) {
    out.push(
      error(`${target}.root_id`, 'root_id 不符合命名规范', '使用小写字母、数字、短横线与斜线'),
    );
  }
  checkEnum(root['role'], ROOT_ROLES, `${target}.role`, '角色', out);
  checkEnum(root['kind'], ROOT_KINDS, `${target}.kind`, '根类别', out);
  checkEnum(root['base'], ROOT_BASES, `${target}.base`, '根基址', out);
  checkEnum(root['depth'], ROOT_DEPTHS, `${target}.depth`, '发现深度', out);
  checkEnum(root['origin'], STATIC_ROOT_ORIGINS, `${target}.origin`, '静态根来源', out);
  if (!isNonEmptyString(root['path_template'])) {
    out.push(
      error(`${target}.path_template`, 'path_template 必须是非空字符串', '给出相对基址的路径模板'),
    );
  }
}

function checkInventoryExtras(
  root: Record<string, unknown>,
  target: string,
  consumerIds: ReadonlySet<string>,
  out: Finding[],
): void {
  if (root['base'] === 'env' && !isNonEmptyString(root['env_var'])) {
    out.push(error(`${target}.env_var`, 'env 基址必须给出 env_var', '例如 LOCALAPPDATA'));
  }
  if (root['platform'] !== undefined) {
    checkEnum(root['platform'], PLATFORMS, `${target}.platform`, '平台', out);
  }
  if (
    root['pending_verification'] !== undefined &&
    typeof root['pending_verification'] !== 'boolean'
  ) {
    out.push(
      error(
        `${target}.pending_verification`,
        'pending_verification 必须是布尔值',
        '给出 true / false',
      ),
    );
  }
  const consumed = root['consumed_by'];
  if (
    consumed !== undefined &&
    (!Array.isArray(consumed) ||
      !consumed.every((item) => isNonEmptyString(item) && consumerIds.has(item)))
  ) {
    out.push(
      error(
        `${target}.consumed_by`,
        'consumed_by 含未登记消费方',
        '只使用 host_id 或 external_consumers.id',
      ),
    );
  }
}

/** 校验单一来源扩展字段；不适用宿主不得声明适配器/根模型。 */
export function validateRootModel(
  entry: Record<string, unknown>,
  target: string,
  consumerIds: ReadonlySet<string>,
  out: Finding[],
): void {
  const exempt = entry['support_state'] === 'not_applicable';
  if (exempt) {
    if (
      entry['adapter_forms'] !== undefined ||
      entry['landing_roots'] !== undefined ||
      entry['inventory_roots'] !== undefined
    ) {
      out.push(
        error(
          target,
          '不适用宿主不得声明适配器或根模型',
          '删除 adapter_forms / landing_roots / inventory_roots',
        ),
      );
    }
    return;
  }
  checkAdapterForms(entry, target, out);
  const landing = entry['landing_roots'];
  if (!Array.isArray(landing)) {
    out.push(error(target, 'landing_roots 必须是数组', '无默认根时给空数组'));
  } else {
    landing.forEach((root, index) =>
      checkLandingRoot(root, `${target}.landing_roots[${String(index)}]`, out),
    );
  }
  const inventory = entry['inventory_roots'];
  if (!Array.isArray(inventory)) {
    out.push(error(target, 'inventory_roots 必须是数组', '无静态候选根时给空数组'));
    return;
  }
  const ids = new Set<string>();
  inventory.forEach((root, index) => {
    const rootTarget = `${target}.inventory_roots[${String(index)}]`;
    checkInventoryRoot(root, rootTarget, consumerIds, out);
    if (isRecord(root) && isNonEmptyString(root['root_id'])) {
      if (ids.has(root['root_id'])) {
        out.push(
          error(`${rootTarget}.root_id`, '同一宿主的 root_id 重复', '为每个候选根给出唯一 root_id'),
        );
      }
      ids.add(root['root_id']);
    }
  });
}
