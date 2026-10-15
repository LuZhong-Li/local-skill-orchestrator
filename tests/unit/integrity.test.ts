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
import { CODES } from '../../kernel/store/contract.ts';

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

test('S-07 目录不存在时抛错，不得返回空内容哈希', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'sm-hash-')), 'not-there');
  assert.throws(
    () => computeChecksum(missing),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CODES.PATH_INVALID);
      assert.match(String((error as { message?: string }).message), /不存在/);
      return true;
    },
  );
  // 空内容哈希是空文件与空目录的合法指纹，不得用它表示「目录不存在」
  const emptyHash = computeChecksum(skillDir({ [META_FILE_NAME]: 'id: a\n' }));
  assert.equal(emptyHash.startsWith('sha256:'), true);
  assert.notEqual(emptyHash, '', '目录存在时照常计算，含不含参与文件由内容缺失判定负责');
});

test('S-07 目标不是目录时抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-hash-'));
  const file = join(dir, 'plain.txt');
  writeFileSync(file, 'x');
  assert.throws(
    () => computeChecksum(file),
    (error: unknown) => (error as { code?: string }).code === CODES.PATH_INVALID,
  );
});
