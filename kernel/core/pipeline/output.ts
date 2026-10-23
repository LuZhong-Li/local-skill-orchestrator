/** 文档包写出器。 */

import type { DeliverableDoc } from './types.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把文档包写出到磁盘。
 */
export function writeDocumentPackage(outDir: string, docs: DeliverableDoc[]): void {
  // 创建输出目录
  mkdirSync(outDir, { recursive: true });

  // 写出每个文档
  for (const doc of docs) {
    const filename = `${doc.stage}.md`;
    const filepath = join(outDir, filename);
    writeFileSync(filepath, doc.content, 'utf-8');
  }

  // 写出 INDEX.md
  const indexContent = [
    '# 文档包索引',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '## 文档列表',
    '',
    ...docs.map((doc) => `- [${doc.stage}](./${doc.stage}.md) (${doc.docType}) - ${doc.source}`),
  ].join('\n');

  writeFileSync(join(outDir, 'INDEX.md'), indexContent, 'utf-8');
}