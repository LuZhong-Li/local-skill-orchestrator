import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InventoryClassificationGroups } from '@skill-manager/contract';
import {
  authorityLabel,
  classificationGroupRows,
  classificationKind,
  classificationLabel,
  reasonText,
  roleFoldNote,
  roleLabel,
  roleVisualClass,
  rootStateHint,
  rootStateVisualClass,
} from '../../gui/renderer/src/host-inventory-presentation.ts';

test('盘点展示：角色与分类标签由统一映射给出', () => {
  assert.equal(roleLabel('user'), '用户安装');
  assert.equal(roleLabel('system'), '系统内置');
  assert.equal(roleLabel('platform'), '平台内置');
  assert.match(roleFoldNote('platform'), /不参与用户主计数/);
  assert.equal(classificationLabel('managed_consistent'), '账本一致');
  assert.equal(classificationLabel('inferred_drift'), '推断漂移');
  assert.equal(classificationKind('managed_consistent'), 'managed');
  assert.equal(classificationKind('inferred_drift'), 'drift');
  assert.equal(classificationKind('untracked'), 'untracked');
  assert.equal(classificationKind('missing'), 'missing');
  assert.equal(authorityLabel('authoritative'), '权威');
  assert.equal(authorityLabel('inferred'), '推断');
  assert.equal(authorityLabel('insufficient'), '证据不足');
});

test('盘点展示：分类分组保留权威/推断拆分，不抹平证据等级', () => {
  const groups: InventoryClassificationGroups = {
    managed: { total: 5, authoritative: 3, inferred: 2 },
    drift: { total: 2, authoritative: 1, inferred: 1 },
    missing: 1,
    untracked: 4,
    undetermined: 2,
    unreadable: 1,
    not_distributed: 0,
    orphaned: { total: 2, with_workspace: 1, without_workspace: 1 },
  };
  const rows = classificationGroupRows(groups);
  assert.equal(rows.find((row) => row.key === 'managed')?.detail, '权威 3 / 推断 2');
  assert.equal(rows.find((row) => row.key === 'drift')?.detail, '权威 1 / 推断 1');
  assert.equal(rows.find((row) => row.key === 'orphaned')?.count, 2);
  assert.equal(
    reasonText({ reasons: ['ledger_active'], drift_reasons: ['content_digest'] }),
    'ledger_active; content_digest',
  );
});

test('盘点展示：角色与根状态视觉类、空根提示由统一映射给出', () => {
  assert.equal(roleVisualClass('user'), 'role-user');
  assert.equal(roleVisualClass('system'), 'role-system');
  assert.equal(rootStateVisualClass('missing'), 'root-state-missing');
  assert.equal(rootStateVisualClass('not_applicable'), 'root-state-not-applicable');
  assert.match(rootStateHint('missing') ?? '', /不存在/);
  assert.match(rootStateHint('unreadable') ?? '', /不可读/);
  assert.equal(rootStateHint('ok'), null);
});
