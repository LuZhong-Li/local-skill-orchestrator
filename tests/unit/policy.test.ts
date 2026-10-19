import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRMATION_TABLE,
  buildPrompt,
  confirmLevelOf,
  decideConfirmation,
  isAffirmative,
  type ConfirmPlan,
  type Interaction,
} from '../../kernel/dispatch/policy/index.ts';
import { REGISTERED_COMMANDS } from '../../kernel/dispatch/registry/index.ts';
import { CODES } from '@skill-manager/contract';

const PLAN: ConfirmPlan = {
  action: '卸载',
  subject: 'code-review',
  writes: [
    { action: 'remove', kind: 'target_copy', path: 'C:/ws/.claude/skills/code-review' },
    { action: 'remove', kind: 'library', path: 'C:/ws/skills/code-review' },
  ],
  notes: ['中心库原件将被永久删除'],
};

function channel(interactive: boolean): Interaction {
  return { interactive, write: () => undefined, read: () => Promise.resolve('') };
}

test('C-03 确认级别登记表覆盖全部已注册指令，且与契约总表一致', () => {
  for (const command of REGISTERED_COMMANDS) {
    assert.ok(command in CONFIRMATION_TABLE, `指令 ${command} 未登记确认级别`);
  }
  assert.equal(confirmLevelOf('install'), 'light', '安装为轻确认');
  assert.equal(confirmLevelOf('uninstall'), 'standard', '卸载为强制二次确认');
  assert.equal(confirmLevelOf('import'), 'light', '导入备份为轻确认');
  assert.equal(confirmLevelOf('update'), 'light', '更新为轻确认');
  for (const command of ['init', 'scan', 'list', 'inspect', 'enable', 'disable', 'validate']) {
    assert.equal(confirmLevelOf(command), 'none', `${command} 无需确认`);
  }
  assert.equal(confirmLevelOf('nosuch'), 'none', '未登记的指令不得被误挡');
});

test('C-03 只有卸载带 --hard 时升档，其余指令不受影响', () => {
  assert.equal(confirmLevelOf('uninstall', { hard: true }), 'strict');
  assert.equal(confirmLevelOf('uninstall', { hard: false }), 'standard');
  assert.equal(confirmLevelOf('install', { hard: true }), 'light', '硬删除选项不改安装的级别');
});

test('C-03 无需确认、给出跳过选项、预演三种情形一律跳过', () => {
  assert.deepEqual(
    decideConfirmation({
      level: 'none',
      yes: false,
      dryRun: false,
      interaction: channel(false),
      plan: PLAN,
    }),
    { kind: 'skip', reason: 'none' },
  );
  for (const level of ['light', 'standard', 'strict'] as const) {
    assert.deepEqual(
      decideConfirmation({
        level,
        yes: true,
        dryRun: false,
        interaction: channel(false),
        plan: PLAN,
      }),
      { kind: 'skip', reason: 'yes' },
      `${level} 应被跳过确认选项跳过`,
    );
    assert.deepEqual(
      decideConfirmation({
        level,
        yes: false,
        dryRun: true,
        interaction: channel(false),
        plan: PLAN,
      }),
      { kind: 'skip', reason: 'dry-run' },
      `${level} 的预演不应要求确认`,
    );
  }
});

test('C-03 无终端且未给出跳过选项时拒绝执行，问题码归参数类', () => {
  const decision = decideConfirmation({
    level: 'light',
    yes: false,
    dryRun: false,
    interaction: channel(false),
    plan: PLAN,
  });
  assert.equal(decision.kind, 'reject');
  if (decision.kind !== 'reject') return;
  assert.equal(decision.finding.code, CODES.INPUT_MISSING_ARG);
  assert.equal(decision.finding.severity, 'error');
  assert.equal(decision.finding.target, '--yes');
  assert.match(decision.finding.remedy, /--yes/);
});

test('C-03 有终端时要求确认，轻确认为单行、常规与强制为独立清单', () => {
  const light = decideConfirmation({
    level: 'light',
    yes: false,
    dryRun: false,
    interaction: channel(true),
    plan: PLAN,
  });
  assert.equal(light.kind, 'prompt');
  if (light.kind === 'prompt') {
    assert.ok(!light.text.includes('\n'), '轻确认为行内单行触发');
    assert.match(light.text, /确认执行？\[y\/N\]/);
  }

  const standard = buildPrompt(PLAN, 'standard');
  assert.match(standard, /影响范围/);
  for (const write of PLAN.writes) assert.ok(standard.includes(write.path), '逐条列出影响范围');
  assert.match(standard, /共 2 处变更/);
  assert.match(standard, /\[y\/N\]/, '默认聚焦取消');
});

test('C-03 强制的提示内容与常规不同，须单独指明永久删除', () => {
  const standard = buildPrompt(PLAN, 'standard');
  const strict = buildPrompt(PLAN, 'strict');
  assert.notEqual(standard, strict);
  assert.match(strict, /永久删除/);
});

test('C-03 肯定回答才继续；空白与无法识别的回答按取消处理', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' yes ']) {
    assert.equal(isAffirmative(answer), true, `${answer} 应视为肯定`);
  }
  for (const answer of ['', ' ', 'n', 'no', 'yeah', '1', '是', '取消']) {
    assert.equal(isAffirmative(answer), false, `${answer} 应视为取消`);
  }
});
