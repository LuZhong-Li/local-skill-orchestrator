import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/temp.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';

test('单元：落账摘要与 update --check 使用同一 computeChecksum 口径', () => {
  const dir = makeTempDir('sm-digest-');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: digest-skill\ndescription: digest\n---\n\n# digest\n',
  );
  writeFileSync(join(dir, 'assets', 'notes.txt'), 'asset body\n');
  writeFileSync(join(dir, 'skill_meta.yaml'), 'id: digest-skill\n');

  const visible = computeLandingChecksum({ targetPath: dir, format: 'skill' });
  assert.equal(
    visible,
    computeChecksum(dir),
    '可见副本的落账摘要必须与 update --check 的目录摘要完全相同',
  );

  renameSync(join(dir, 'SKILL.md'), join(dir, 'SKILL.md.disabled'));
  assert.equal(
    computeLandingChecksum({ targetPath: dir, format: 'skill' }),
    visible,
    '可见性切换不得改变内容摘要',
  );
});

test('单元：规则文件摘要使用相对文件名 + NUL + 文件字节', () => {
  const dir = makeTempDir('sm-digest-rule-');
  const file = join(dir, 'digest-rule.mdc');
  writeFileSync(file, '---\ndescription: digest\n---\n\n# rule\n');
  assert.equal(
    computeLandingChecksum({ targetPath: file, format: 'rules' }),
    computeChecksum(dir),
    '规则文件摘要必须与同一目录的 computeChecksum 一致',
  );
});

test('单元：可见与禁用标记同时存在时拒绝计算摘要', () => {
  const dir = makeTempDir('sm-digest-conflict-');
  writeFileSync(join(dir, 'SKILL.md'), '# visible\n');
  writeFileSync(join(dir, 'SKILL.md.disabled'), '# disabled\n');
  assert.throws(
    () => computeLandingChecksum({ targetPath: dir, format: 'skill' }),
    /可见性标记冲突/,
  );
});
