/** host 注册表校验共享常量与判定工具。 */
export {
  ADAPTER_STATES,
  EVIDENCE_LEVELS,
  FIELD_MODES,
  FIRST_HAND_EVIDENCE_LEVELS,
  HOST_ID_PATTERN,
  REGISTRY_VERSION,
  ROOT_KINDS,
  SECURITY_CONTROL_FIELDS,
  SUPPORT_STATES,
  isSecurityControlEvidenceComplete,
  isSecurityControlField,
  type HostEntry,
  type HostRegistry,
} from './types.ts';
export { checkNoUnknownFields, validateRootModel } from './root-model-validate.ts';

export const SOURCE = 'host-registry';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
