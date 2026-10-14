import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectHashEntries,
  computeChecksum,
  hasHashableContent,
  isChecksumFormat,
} from '../../kernel/core/integrity/index.ts';
import { META_FILE_NAME } from '../../kernel/core/metadata/constants.ts';

function skillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-hash-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

test('S-07 指纹形式为 sha256 加 64 位小写十六进制', () => {
  const dir = skillDir({ 'SKILL.md': '# a' });
  const checksum = computeChecksum(dir);
  assert.ok(isChecksumFormat(checksum), checksum);
});

test('S-07 元文件自身不参与指纹计算', () => {
  const withoutMeta = skillDir({ 'SKILL.md': '# a' });
  const withMeta = skillDir({ 'SKILL.md': '# a', [META_FILE_NAME]: 'id: a\n' });
  assert.equal(computeChecksum(withoutMeta), computeChecksum(withMeta));
});

test('S-07 内容不同则指纹不同', () => {
  assert.notEqual(
    computeChecksum(skillDir({ 'SKILL.md': '# a' })),
    computeChecksum(skillDir({ 'SKILL.md': '# b' })),
  );
});

test('S-07 相对路径按字节序升序，与创建顺序无关', () => {
  const a = skillDir({ 'b.txt': '1', 'a.txt': '2' });
  const b = skillDir({ 'a.txt': '2', 'b.txt': '1' });
  assert.equal(computeChecksum(a), computeChecksum(b));
  assert.deepEqual(collectHashEntries(a), ['a.txt', 'b.txt']);
});

test('S-07 版本控制目录与临时文件被排除', () => {
  const dir = skillDir({ 'SKILL.md': '# a' });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
  writeFileSync(join(dir, 'scratch.tmp'), 'temp');
  assert.deepEqual(collectHashEntries(dir), ['SKILL.md']);
});

test('S-07 符号链接不参与计算', () => {
  const dir = skillDir({ 'SKILL.md': '# a', 'real.txt': 'x' });
  try {
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
  } catch {
    return; // 平台不支持创建符号链接时跳过
  }
  assert.deepEqual(collectHashEntries(dir), ['SKILL.md', 'real.txt']);
});

test('S-07 无参与内容时判定为内容缺失', () => {
  const dir = skillDir({ [META_FILE_NAME]: 'id: a\n' });
  assert.equal(hasHashableContent(dir), false);
  assert.equal(hasHashableContent(skillDir({ 'SKILL.md': '# a' })), true);
});
