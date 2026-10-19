/**
 * S-06 YAML 序列化。
 *
 * 契约要求（元数据规范 2.4 节）：UTF-8、单文档流、顶层为映射、禁止锚点与别名、
 * 禁止重复键、字符串引号规则。索引与元文件均由内核生成，因此不保留注释。
 * 序列化保持字段插入顺序，以保证同一份数据产出稳定文本，便于版本控制逐行比对。
 */
import { parse, stringify } from 'yaml';
import { KernelError } from '../errors.ts';
import { CODES } from '@skill-manager/contract';

export interface YamlContext {
  source: string;
  target: string;
}

/** 反序列化 YAML 文本为映射；失败时抛出 E-YAML-001 */
export function parseYaml(text: string, context: YamlContext): Record<string, unknown> {
  let value: unknown;
  try {
    value = parse(text, { uniqueKeys: true, merge: false });
  } catch (error) {
    throw new KernelError({
      code: CODES.YAML_INVALID,
      message: `YAML 无法解析：${error instanceof Error ? error.message : String(error)}`,
      source: context.source,
      target: context.target,
      remedy: '请检查该文件的缩进与语法，必要时重新生成',
      cause: error,
    });
  }
  if (value === null || value === undefined) {
    throw new KernelError({
      code: CODES.YAML_INVALID,
      message: 'YAML 内容为空',
      source: context.source,
      target: context.target,
      remedy: '文件必须包含顶层映射',
    });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError({
      code: CODES.YAML_INVALID,
      message: 'YAML 顶层必须是映射',
      source: context.source,
      target: context.target,
      remedy: '请把顶层结构改写为键值映射',
    });
  }
  return value as Record<string, unknown>;
}

/** 序列化为 YAML 文本，字段顺序与对象键顺序一致 */
export function stringifyYaml(value: Record<string, unknown>): string {
  return stringify(value, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    singleQuote: false,
  });
}
