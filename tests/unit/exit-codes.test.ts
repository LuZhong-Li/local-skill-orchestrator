import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor } from '../../kernel/dispatch/result/index.ts';
import type { Finding } from '@skill-manager/contract';

const error = (code: string, source: string, target = 'x'): Finding => ({
  code,
  severity: 'error',
  source,
  target,
  message: 'probe',
  remedy: 'probe',
});

test('退出码：技能元文件的 YAML 问题属技能级 → 1（不落索引损坏档）', () => {
  assert.equal(exitCodeFor([error('E-YAML-001', 'meta')]), 1);
});

test('退出码：索引/配置文件的 YAML 与索引版本问题仍为 3（反向断言，防过修）', () => {
  assert.equal(exitCodeFor([error('E-YAML-001', 'config', 'config')]), 3);
  assert.equal(exitCodeFor([error('E-YAML-001', 'registry', 'skill_index.yaml')]), 3);
  assert.equal(exitCodeFor([error('E-VER-001', 'registry', 'schema_version')]), 3);
  assert.equal(exitCodeFor([error('E-INDEX-002', 'registry', 'gone')]), 3);
});

test('退出码：其余类别按派生顺序归位（INPUT→2、SRC→4、IO→5、DEP→6、其余→1）', () => {
  assert.equal(exitCodeFor([error('E-INPUT-002', 'input')]), 2);
  assert.equal(exitCodeFor([error('E-SRC-001', 'source')]), 4);
  assert.equal(exitCodeFor([error('E-IO-001', 'atomic')]), 5);
  assert.equal(exitCodeFor([error('E-DEP-003', 'meta')]), 6);
  assert.equal(exitCodeFor([error('E-ID-003', 'meta')]), 1);
  assert.equal(exitCodeFor([]), 0);
});

test('退出码：技能级 YAML 与依赖环并存时，DEP 档优先（6）', () => {
  assert.equal(exitCodeFor([error('E-YAML-001', 'meta'), error('E-DEP-003', 'meta', 'a')]), 6);
});

test('退出码：插件问题码复用现有档位（ID/冲突→1、API 版本→3）', () => {
  assert.equal(exitCodeFor([error('E-ID-004', 'plugin-manifest')]), 1);
  assert.equal(exitCodeFor([error('E-ID-005', 'plugin-registry')]), 1);
  assert.equal(exitCodeFor([error('E-CONFLICT-004', 'plugin-catalog')]), 1);
  assert.equal(exitCodeFor([error('E-VER-002', 'plugin-manifest')]), 3);
});
