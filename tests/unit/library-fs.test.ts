import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  disabledMarkerName,
  isCopyDisabled,
  setCopyVisibility,
} from '../../kernel/store/library-fs/index.ts';
import { SKILL_MD_NAME } from '@skill-manager/contract';
import { KernelError } from '../../kernel/store/errors.ts';
import { CODES } from '@skill-manager/contract';

function copyDir(): string {
  const dir = makeTempDir('sm-copy-');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, SKILL_MD_NAME), '# skill');
  writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi');
  writeFileSync(join(dir, 'skill_meta.yaml'), 'id: a');
  return dir;
}

test('S-08 禁用只改名技能元数据文件', () => {
  const dir = copyDir();
  assert.equal(setCopyVisibility(dir, false), 'changed');
  assert.equal(isCopyDisabled(dir), true);
  assert.ok(existsSync(join(dir, disabledMarkerName())));
  assert.ok(!existsSync(join(dir, SKILL_MD_NAME)));
  // 其余内容与目录结构原样保留
  assert.ok(existsSync(join(dir, 'scripts', 'run.sh')));
  assert.ok(existsSync(join(dir, 'skill_meta.yaml')));
  assert.deepEqual(
    readdirSync(dir).sort(),
    ['scripts', 'skill_meta.yaml', disabledMarkerName()].sort(),
  );
});

test('S-08 启用把文件名改回原名', () => {
  const dir = copyDir();
  setCopyVisibility(dir, false);
  assert.equal(setCopyVisibility(dir, true), 'changed');
  assert.equal(isCopyDisabled(dir), false);
  assert.ok(existsSync(join(dir, SKILL_MD_NAME)));
});

test('S-08 切换幂等：重复禁用或启用不产生变更', () => {
  const dir = copyDir();
  assert.equal(setCopyVisibility(dir, true), 'unchanged');
  setCopyVisibility(dir, false);
  assert.equal(setCopyVisibility(dir, false), 'unchanged');
});

test('S-08 禁用与启用往复后内容与目录结构不变', () => {
  const dir = copyDir();
  const before = readdirSync(dir).sort();
  setCopyVisibility(dir, false);
  setCopyVisibility(dir, true);
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test('S-08 副本缺少技能元数据文件时报明确问题', () => {
  const dir = makeTempDir('sm-copy-empty-');
  assert.throws(
    () => setCopyVisibility(dir, true),
    (error: unknown) => error instanceof KernelError && error.code === CODES.PATH_INVALID,
  );
});
