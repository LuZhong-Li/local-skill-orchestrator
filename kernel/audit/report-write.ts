/** CLI 报告文件原子写入；不参与审计事实计算。 */
import { atomicWriteFile } from '../store/atomic/index.ts';

export interface WrittenAuditReport {
  path: string;
  bytes: number;
}

export function writeAuditReport(path: string, content: string): WrittenAuditReport {
  atomicWriteFile(path, content);
  return { path, bytes: Buffer.byteLength(content, 'utf8') };
}
