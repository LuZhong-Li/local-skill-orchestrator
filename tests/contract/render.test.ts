import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEGRADED_CAPABILITY_GAPS,
  renderEntry,
  renderSkill,
  renderStandardSkill,
  renderWithPolicy,
} from '../../kernel/core/render/index.ts';
import type { RenderSource } from '../../kernel/core/render/types.ts';
import { FORBIDDEN_TRANSMISSION_FIELD } from '../../kernel/core/hosts/types.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function sample(overrides: Partial<RenderSource> = {}): RenderSource {
  return {
    id: 'demo-skill',
    description: '演示用技能：渲染层契约测试',
    license: 'MIT',
    compatibility: 'Designed for Agent Skills',
    allowed_tools: 'Read Grep',
    version: '1.2.0',
    author: 'demo',
    homepage: 'https://example.invalid/demo',
    tags: ['beta', 'alpha'],
    runtime_dependencies: { node: '>=22' },
    skill_dependencies: ['other-skill >=1.0.0'],
    trigger_keywords: ['演示', '渲染'],
    body: '# demo-skill\n\n正文内容。',
    ...overrides,
  };
}

/** 拆出产物的 frontmatter 映射与正文 */
function splitArtifact(content: string): { front: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(content);
  assert.ok(match !== null, `产物应含 YAML 元数据块：${content.slice(0, 80)}`);
  return {
    front: parseYaml(match[1] as string) as Record<string, unknown>,
    body: match[2] as string,
  };
}

test('契约：标准六字段渲染与 Agent Skills 标准一致', () => {
  const outcome = renderStandardSkill(sample());
  assert.equal(outcome.files.length, 1);
  const artifact = outcome.files[0]!;
  assert.equal(artifact.kind, 'skill_md');
  assert.equal(artifact.path, 'SKILL.md');

  const { front, body } = splitArtifact(artifact.content);
  assert.deepEqual(
    Object.keys(front).sort(),
    ['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name'],
    '标准模式产物只含标准六字段',
  );
  assert.equal(front['name'], 'demo-skill');
  assert.match(String(front['description']), /演示用技能/);
  assert.match(String(front['description']), /触发关键词/, '触发关键词并入描述');
  assert.equal(front['license'], 'MIT');
  assert.match(String(front['compatibility']), /依赖运行时：node >=22/, '运行时依赖并入兼容性文本');
  assert.equal(front['allowed-tools'], 'Read Grep');
  assert.deepEqual(front['metadata'], {
    version: '1.2.0',
    author: 'demo',
    homepage: 'https://example.invalid/demo',
    tags: 'alpha,beta',
    dependencies: 'other-skill >=1.0.0',
  });
  assert.equal(body, '# demo-skill\n\n正文内容。\n');
  assert.deepEqual(outcome.ledger.dropped, []);
  assert.deepEqual(outcome.ledger.extensions, []);
  assert.equal(outcome.degraded, false);
  assert.deepEqual(outcome.capability_gaps, []);
});

test('契约：确定性——同一输入重复渲染产出同一文本', () => {
  const first = renderStandardSkill(sample()).files[0]!.content;
  const second = renderStandardSkill(sample()).files[0]!.content;
  assert.equal(first, second, '渲染必须确定性');
});

test('契约：host_declared 白名单命中透传、未命中回报 W-FIELD-004 警告', () => {
  const source = sample({
    extensions: {
      provenance: 'manual',
      version: '9.9.9',
      unknown_field: 'x',
      [FORBIDDEN_TRANSMISSION_FIELD]: 'true',
    },
  });

  const codex = renderSkill('codex', source);
  const { front } = splitArtifact(codex.files[0]!.content);
  assert.equal(front['provenance'], 'manual', 'Codex 白名单内字段应透传');
  assert.equal(front['version'], '9.9.9', 'Codex 白名单内字段应透传（顶层 version）');
  assert.equal('unknown_field' in front, false, '白名单外字段不得写入产物');
  assert.equal(FORBIDDEN_TRANSMISSION_FIELD in front, false, '禁用字段不得写入产物');
  assert.deepEqual(codex.ledger.extensions, ['provenance', 'version']);
  assert.deepEqual(codex.ledger.dropped, ['disable-model-invocation', 'unknown_field']);

  const warnings = codex.findings.filter((item) => item.code === 'W-FIELD-004');
  assert.equal(warnings.length, 1, '白名单外字段应回报一条警告');
  assert.equal(warnings[0]!.severity, 'warning');
  assert.match(warnings[0]!.message, /unknown_field/, '警告须点名被忽略的字段（不静默）');
  assert.ok(
    codex.findings.some(
      (item) => item.severity === 'error' && item.message.includes(FORBIDDEN_TRANSMISSION_FIELD),
    ),
    '禁用字段应回报错误级问题',
  );

  // 豆包白名单同样生效（含平台自有字段）
  const doubao = renderSkill('doubao', sample({ extensions: { bins: 'ffmpeg', license: 'MIT' } }));
  const doubaoFront = splitArtifact(doubao.files[0]!.content).front;
  assert.equal(doubaoFront['bins'], 'ffmpeg', '豆包白名单内字段应透传');
  assert.deepEqual(doubao.ledger.extensions, ['bins']);
  assert.equal(
    doubao.findings.filter((item) => item.code === 'W-FIELD-004').length,
    1,
    '标准字段不进白名单，声明为扩展时按未命中处理',
  );
});

test('契约：保守渲染——standard6 宿主忽略全部扩展声明（含 Claude 白名单为空）', () => {
  const source = sample({ extensions: { provenance: 'manual', version: '9.9.9' } });
  const claude = renderSkill('claude', source);
  const { front } = splitArtifact(claude.files[0]!.content);
  assert.equal('provenance' in front, false);
  assert.equal('version' in front, false, 'Claude 白名单为空，扩展字段一律不渲染');
  assert.deepEqual(claude.ledger.extensions, []);
  assert.equal(claude.ledger.dropped.length, 2);
  assert.equal(claude.findings.filter((item) => item.code === 'W-FIELD-004').length, 2);
});

test('契约：禁用字段双层防线（注册表加载期拒绝登记 + 渲染期无条件拒绝）', () => {
  const source = sample({ extensions: { [FORBIDDEN_TRANSMISSION_FIELD]: 'true' } });

  // 一、注册表策略路径：任何宿主都不出现该字段
  for (const hostId of ['claude', 'codex', 'cursor', 'doubao', 'agentskills', 'agents-md']) {
    const outcome = renderSkill(hostId, source);
    for (const file of outcome.files) {
      assert.equal(
        file.content.includes(`${FORBIDDEN_TRANSMISSION_FIELD}:`),
        false,
        `${hostId} 产物不得含禁用字段`,
      );
    }
    assert.ok(
      outcome.findings.some((item) => item.severity === 'error'),
      `${hostId} 应对禁用字段报错误级问题`,
    );
  }

  // 二、渲染期防线：即使策略被显式构造为「白名单包含该字段」，渲染仍无条件拒绝
  const hostile = renderWithPolicy(
    'skill',
    {
      host_id: 'claude',
      field_mode: 'host_declared',
      allowed_extensions: [FORBIDDEN_TRANSMISSION_FIELD],
    },
    source,
  );
  assert.equal(
    hostile.files[0]!.content.includes(`${FORBIDDEN_TRANSMISSION_FIELD}:`),
    false,
    '渲染期防线：即使白名单被构造为包含禁用字段，也不写入产物',
  );
  assert.deepEqual(hostile.ledger.extensions, [], '禁用字段不得进入透传台账');
  assert.ok(
    hostile.ledger.dropped.includes(FORBIDDEN_TRANSMISSION_FIELD),
    '禁用字段应进入被丢弃台账',
  );
  assert.ok(
    hostile.findings.some(
      (item) => item.severity === 'error' && item.message.includes(FORBIDDEN_TRANSMISSION_FIELD),
    ),
    '渲染期应回报错误级问题（与注册表加载期的第一层防线相互独立）',
  );
});

test('契约：通用标准目标与逐宿主适配器共用同一渲染核心', () => {
  const source = sample();
  const standard = renderStandardSkill(source);
  const byHostId = renderSkill('agentskills', source);
  const byPolicy = renderWithPolicy(
    'skill',
    { host_id: 'agentskills', field_mode: 'standard6', allowed_extensions: [] },
    source,
  );
  assert.deepEqual(standard.files, byHostId.files, '通用目标与按标识渲染应产出同一结果');
  assert.deepEqual(standard.files, byPolicy.files, '两条路径应经过同一渲染核心');
  assert.deepEqual(standard.ledger, byPolicy.ledger);

  // 换宿主只换策略：同一输入下 Claude 与通用目标的差异只在策略，渲染核心相同
  const claude = renderSkill('claude', source);
  assert.deepEqual(claude.files, standard.files, '同为 standard6 策略时应产出相同产物');
});

test('契约：降级渲染产出 AGENTS.md 片段且不落盘、声明能力差异', () => {
  const outcome = renderEntry('agents-md', sample());
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.field_mode, 'degrade_entry');
  assert.deepEqual(outcome.capability_gaps, [...DEGRADED_CAPABILITY_GAPS]);
  const fragment = outcome.files[0]!;
  assert.equal(fragment.kind, 'agents_md_fragment');
  assert.equal(fragment.path, 'AGENTS.md');
  assert.ok(fragment.content.startsWith('### demo-skill'), '片段以技能标识作为条目标题');
  assert.match(fragment.content, /演示用技能/, '片段含描述');
  assert.equal(
    fragment.content.includes('---'),
    false,
    '降级片段不含 YAML 元数据块（AGENTS.md 无字段约定）',
  );
});

test('契约：渲染层不写盘（以源码检索守住）', () => {
  const sources = ['kernel/core/render/index.ts', 'kernel/core/render/fields.ts']
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
    assert.equal(
      sources.includes(forbidden),
      false,
      `渲染层不得调用 ${forbidden}：渲染与落位解耦，落盘属 T5`,
    );
  }
});
