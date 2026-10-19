/**
 * S-02 索引持久化。
 *
 * 只负责索引文件的原始读写：读出 YAML 映射、原样写回索引文件。
 * 索引的语义结构由内核层负责组装，本模块不认识任何字段含义，
 * 但会保留未识别字段，避免改写时丢弃未知内容。
 */
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../atomic/index.ts';
import { stringifyYaml } from '../yaml/index.ts';
import { parseYaml } from '../yaml/index.ts';
import { KernelError } from '../errors.ts';
import { CODES } from '@skill-manager/contract';

export interface RawIndexRead {
  exists: boolean;
  raw: Record<string, unknown> | null;
}

/** 读取索引文件的原始映射；文件不存在时返回 exists=false 而非抛错 */
export function readRawIndex(indexFile: string): RawIndexRead {
  let text: string;
  try {
    text = readFileSync(indexFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, raw: null };
    throw new KernelError({
      code: CODES.IO_FAILED,
      message: `读取索引失败：${error instanceof Error ? error.message : String(error)}`,
      source: 'registry-store',
      target: indexFile,
      remedy: '请检查索引文件是否可读',
      cause: error,
    });
  }
  return { exists: true, raw: parseYaml(text, { source: 'registry-store', target: indexFile }) };
}

/** 原子写入索引文件 */
export function writeRawIndex(indexFile: string, raw: Record<string, unknown>): void {
  atomicWriteFile(indexFile, stringifyYaml(raw));
}
