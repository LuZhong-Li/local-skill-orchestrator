import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapterFor, allAdapters, formImplementationOf } from '../../kernel/core/adapters/index.ts';
import { selectableHostIds, hostById } from '../../kernel/core/hosts/index.ts';
import { FORBIDDEN_TRANSMISSION_FIELD } from '../../kernel/core/hosts/types.ts';
import { renderWithPolicy } from '../../kernel/core/render/index.ts';
import type { RenderSource } from '../../kernel/core/render/types.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function sample(overrides: Partial<RenderSource> = {}): RenderSource {
  return {
    id: 'demo-skill',
    description: '演示用技能：适配器契约测试',
    license: 'MIT',
    compatibility: 'Designed for Agent Skills',
    allowed_tools: 'Read Grep',
    version: '1.0.0',
    author: 'demo',
    body: '# demo-skill\n\n正文。',
    ...overrides,
  };
}

function frontmatterOf(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(match !== null, '产物应有 YAML 元数据块');
  const lines = (match[1] as string).split('\n');
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const key = /^([A-Za-z0-9_-]+):/.exec(line);
    if (key !== null) result[key[1] as string] = true;
  }
  return result;
}

test('契约：六个宿主适配器产物结构合规（verify 无错误）', () => {
  const source = sample({ extensions: { provenance: 'manual', bins: 'ffmpeg' } });
  for (const hostId of ['claude', 'codex', 'cursor', 'doubao', 'agentskills', 'agents-md']) {
    const adapter = adapterFor(hostId);
    assert.ok(adapter !== undefined, `${hostId} 应有适配器`);
    const outcome = adapter.render(source);
    assert.ok(outcome.files.length > 0, `${hostId} 应产出至少一个文件`);
    const errors = adapter.verify(outcome).filter((item) => item.severity === 'error');
    assert.deepEqual(errors, [], `${hostId} 产物应通过结构合规校验`);
  }

  // 逐宿主形态
  assert.equal(adapterFor('claude')?.forms[0], 'skill');
  assert.deepEqual(adapterFor('cursor')?.forms, ['skill', 'rules']);
  assert.deepEqual(adapterFor('agents-md')?.forms, ['entry']);
  assert.deepEqual(
    allAdapters()
      .map((adapter) => adapter.host_id)
      .sort(),
    ['agents-md', 'agentskills', 'claude', 'codex', 'cursor', 'doubao'],
  );
});

test('契约：字段策略边界（Claude 无扩展、Codex/豆包白名单生效、禁用字段全宿主不出现）', () => {
  const source = sample({
    extensions: {
      provenance: 'manual',
      version: '9.9.9',
      bins: 'ffmpeg',
      unknown_field: 'x',
      [FORBIDDEN_TRANSMISSION_FIELD]: 'true',
    },
  });

  // Claude：白名单为空，任何扩展字段都不进产物（Q-05 硬失败路径）
  const claude = adapterFor('claude')!.render(source);
  const claudeFields = frontmatterOf(claude.files[0]!.content);
  for (const field of ['provenance', 'version', 'bins', 'unknown_field']) {
    assert.equal(field in claudeFields, false, `Claude 产物不得含扩展字段 ${field}`);
  }
  assert.deepEqual(claude.ledger.extensions, []);

  // Codex：白名单内透传，白名单外警告
  const codex = adapterFor('codex')!.render(source);
  const codexFields = frontmatterOf(codex.files[0]!.content);
  assert.equal('provenance' in codexFields, true, 'Codex 白名单内字段应透传');
  assert.equal('version' in codexFields, true, 'Codex 白名单内字段应透传');
  assert.equal('bins' in codexFields, false, '豆包自有字段不在 Codex 白名单内');
  assert.ok(
    codex.findings.some((item) => item.code === 'W-FIELD-004' && item.message.includes('bins')),
    'Codex 应对白名单外字段回报警告并点名字段',
  );

  // 豆包：白名单内透传（含平台自有字段）
  const doubao = adapterFor('doubao')!.render(source);
  const doubaoFields = frontmatterOf(doubao.files[0]!.content);
  assert.equal('bins' in doubaoFields, true, '豆包白名单内字段应透传');
  assert.equal('provenance' in doubaoFields, false, 'Codex 侧字段不在豆包白名单内');

  // 禁用字段：任何宿主、任何形态的产物中都不出现
  for (const adapter of allAdapters()) {
    for (const form of adapter.forms) {
      const outcome = adapter.render(
        sample({ extensions: { [FORBIDDEN_TRANSMISSION_FIELD]: 'true' } }),
        form,
      );
      for (const file of outcome.files) {
        assert.equal(
          file.content.includes(`${FORBIDDEN_TRANSMISSION_FIELD}:`),
          false,
          `${adapter.host_id}/${form} 产物不得含禁用字段`,
        );
      }
    }
  }
});

test('契约：复用形态的宿主共享同一实现（同核验证）', () => {
  const implementations = ['claude', 'codex', 'doubao', 'agentskills'].map((hostId) =>
    formImplementationOf(hostId),
  );
  for (const implementation of implementations) {
    assert.equal(
      implementation,
      implementations[0],
      '复用技能形态的宿主必须共享同一实现对象（无宿主专有代码，M5-R7）',
    );
  }
  assert.notEqual(
    formImplementationOf('cursor'),
    implementations[0],
    'Cursor 需要规则路径形态，是本批唯一新增的形态实现',
  );
  assert.notEqual(formImplementationOf('agents-md'), implementations[0]);

  // 同一策略下产物深度相等：通用标准目标与逐宿主（Claude）同核
  const source = sample();
  const byPolicy = renderWithPolicy(
    'skill',
    { host_id: 'agentskills', field_mode: 'standard6', allowed_extensions: [] },
    source,
  );
  assert.deepEqual(adapterFor('agentskills')!.render(source).files, byPolicy.files);
  assert.deepEqual(adapterFor('claude')!.render(source).files, byPolicy.files);
});

test('契约：agents-md 降级片段与不落盘声明', () => {
  const adapter = adapterFor('agents-md')!;
  const outcome = adapter.render(sample());
  assert.equal(outcome.degraded, true);
  assert.deepEqual(outcome.capability_gaps, [
    'auto_discovery',
    'progressive_loading',
    'tool_preapproval',
  ]);
  const plan = adapter.plan(sample());
  assert.equal(plan.entries.length, 1);
  const entry = plan.entries[0]!;
  assert.equal(entry.artifact_kind, 'agents_md_fragment');
  assert.equal(entry.landable, false, '合并策略未定稿前不落盘');
  assert.match(String(entry.hold_reason), /合并策略未定稿/);
  assert.equal(entry.target_path, 'AGENTS.md');
  assert.equal(entry.content.startsWith('---'), false, '片段不得携带元数据块');
});

test('契约：Cursor 规则路径形态（.mdc）结构合规', () => {
  const adapter = adapterFor('cursor')!;
  const rules = adapter.render(sample(), 'rules');
  const file = rules.files[0]!;
  assert.equal(file.kind, 'rule_file');
  assert.equal(file.path, 'demo-skill.mdc');
  const fields = frontmatterOf(file.content);
  assert.equal('description' in fields, true);
  assert.equal('alwaysApply' in fields, true);
  assert.deepEqual(adapter.verify(rules), []);

  const plan = adapter.plan(sample(), 'rules');
  assert.equal(plan.entries[0]!.target_path, '.cursor/rules/demo-skill.mdc');
  assert.equal(plan.entries[0]!.file_name, '', '文件类落位根不再拼文件名');
  assert.equal(plan.entries[0]!.landable, true);
});

test('契约：落位计划的数据结构（目标路径展开与重叠消费声明）', () => {
  const claude = adapterFor('claude')!.plan(sample());
  const entry = claude.entries[0]!;
  assert.equal(entry.root_path, '.claude/skills/demo-skill');
  assert.equal(entry.target_path, '.claude/skills/demo-skill/SKILL.md');
  assert.equal(entry.file_name, 'SKILL.md');
  assert.equal(entry.root_kind, 'skill');
  assert.equal(entry.external, false);
  assert.equal(entry.landable, true);
  assert.deepEqual(entry.consumed_by, ['claude', 'cursor']);
  assert.deepEqual(
    claude.overlaps,
    [{ root_path: '.claude/skills/demo-skill', consumed_by: ['claude', 'cursor'] }],
    '同一落位根被多宿主读取时应如实声明（M5-R8）',
  );
  assert.equal(claude.target_id, 'claude', '遵守 DP-01：目标标识即宿主标识');

  const agentsMd = adapterFor('agents-md')!.plan(sample());
  assert.deepEqual(
    agentsMd.overlaps,
    [{ root_path: 'AGENTS.md', consumed_by: ['codex', 'cursor'] }],
    '指令文件载体被多个宿主读取，同样声明重叠',
  );

  const cursorRules = adapterFor('cursor')!.plan(sample(), 'rules');
  assert.deepEqual(cursorRules.overlaps, [], 'Cursor 规则路径只被自身读取，无重叠');

  const doubao = adapterFor('doubao')!.plan(sample());
  assert.equal(doubao.entries[0]!.external, true, '豆包落位根位于工作区之外');
  assert.match(doubao.entries[0]!.root_path, /\.user_skills\/demo-skill$/);
});

test('契约：不适用宿主（deepseek）无适配器且登记表达正确', () => {
  assert.equal(adapterFor('deepseek'), undefined, '不适用宿主不产出适配器');
  const entry = hostById('deepseek');
  assert.ok(entry !== undefined);
  assert.equal(entry.support_state, 'not_applicable');
  assert.equal(entry.roots, undefined, '不适用宿主无落位根');
  assert.equal(entry.adapter_ref, undefined, '不适用宿主无适配器引用');
  assert.equal(
    entry.classification.skill_mechanism || entry.classification.rules_only,
    false,
    '两类机制皆无，依赖 not_applicable 豁免通过校验',
  );
});

test('契约：adapter_state 置 implemented 后可落位集合生效', () => {
  const selectable = [...selectableHostIds()].sort();
  assert.deepEqual(selectable, ['agents-md', 'agentskills', 'claude', 'codex', 'cursor', 'doubao']);
  assert.equal(selectable.includes('deepseek'), false);
  for (const hostId of selectable) {
    assert.ok(adapterFor(hostId) !== undefined, `${hostId} 可落位即应有适配器`);
  }
});

test('契约：适配器层不写盘（以源码检索守住）', () => {
  const sources = [
    'kernel/core/adapters/index.ts',
    'kernel/core/adapters/plan.ts',
    'kernel/core/adapters/rules.ts',
  ]
    .map((file) => read(file))
    .join('\n');
  for (const forbidden of [
    'writeFileSync',
    'writeFile',
    'createWriteStream',
    'renameSync',
    'rmSync',
    'mkdirSync',
    'cpSync',
  ]) {
    assert.equal(sources.includes(forbidden), false, `适配器层不得调用 ${forbidden}：落盘属 T5`);
  }
});
