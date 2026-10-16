import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import {
  consumersOfRoot,
  hostById,
  hostIds,
  listHosts,
  loadHostRegistry,
  resolveExtensions,
  selectableHostIds,
} from '../../kernel/core/hosts/index.ts';
import { validateHostRegistry } from '../../kernel/core/hosts/validate.ts';
import { SECURITY_CONTROL_FIELDS, type HostEntry } from '../../kernel/core/hosts/types.ts';
import type { Finding } from '../../kernel/store/contract.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** HR-09 的安全控制字段（当前登记为 `disable-model-invocation`） */
const SECURITY_FIELD = SECURITY_CONTROL_FIELDS[0];

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

/** 深拷贝注册表数据，便于构造反例而不污染内核内的冻结实例 */
function cloneRegistry(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(loadHostRegistry())) as Record<string, unknown>;
}

function hostsOf(registry: Record<string, unknown>): Array<Record<string, unknown>> {
  return registry['hosts'] as Array<Record<string, unknown>>;
}

function entryOf(registry: Record<string, unknown>, hostId: string): Record<string, unknown> {
  const found = hostsOf(registry).find((entry) => entry['host_id'] === hostId);
  assert.ok(found !== undefined, `注册表应包含宿主 ${hostId}`);
  return found;
}

function errorMessages(findings: readonly Finding[]): string[] {
  return findings.filter((item) => item.severity === 'error').map((item) => item.message);
}

test('契约：宿主注册表数据通过 schema 校验，且加载期 HR 校验无错', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(read('schemas/host_registry.schema.json')) as object;
  const validate = ajv.compile(schema);
  const registry = cloneRegistry();
  assert.equal(
    validate(registry),
    true,
    `注册表数据应通过 host_registry.schema.json：${JSON.stringify(validate.errors)}`,
  );

  assert.deepEqual(errorMessages(validateHostRegistry(registry)), [], '加载期不应有错误级问题');

  // 加载接口本身可用，且返回同一份事实源
  const loaded = loadHostRegistry();
  assert.equal(loaded.hosts.length, 7, '首批应有 7 条注册项');
  assert.deepEqual(
    [...hostIds()].sort(),
    ['agents-md', 'agentskills', 'claude', 'codex', 'cursor', 'deepseek', 'doubao'],
    '首批宿主标识应与设计名单一致',
  );
});

test('契约：每条注册项字段完整（证据等级、三维分类、落位根、渲染策略）', () => {
  for (const entry of loadHostRegistry().hosts) {
    assert.ok(entry.evidence.level.length > 0, `${entry.host_id} 缺少证据等级`);
    assert.equal(typeof entry.classification.skill_mechanism, 'boolean');
    assert.equal(typeof entry.classification.rules_only, 'boolean');
    assert.equal(typeof entry.render_policy.field_mode, 'string');
    if (entry.support_state === 'not_applicable') {
      assert.equal(entry.roots ?? undefined, undefined, '不适用宿主不应给出落位根');
      assert.equal(
        entry.classification.skill_mechanism || entry.classification.rules_only,
        false,
        '不适用宿主两类机制皆无',
      );
      continue;
    }
    assert.ok((entry.roots ?? []).length > 0, `${entry.host_id} 缺少落位根`);
    assert.ok(entry.adapter_ref !== undefined, `${entry.host_id} 缺少适配器引用`);
  }
});

test('契约：非法注册项被 HR 规则拒绝（HR-04/05/08/09 等）', () => {
  // HR-04：机制已确认却只有待确认级证据
  const hr04 = cloneRegistry();
  Object.assign(entryOf(hr04, 'claude'), {
    support_state: 'confirmed',
    evidence: { level: 'pending' },
  });
  assert.ok(
    errorMessages(validateHostRegistry(hr04)).some((message) => message.includes('机制已确认')),
    'HR-04 应拒绝「已确认 + 待确认级证据」',
  );

  // HR-05：非不适用宿主的三维分类两项同时为假
  const hr05 = cloneRegistry();
  entryOf(hr05, 'cursor')['classification'] = { skill_mechanism: false, rules_only: false };
  assert.ok(
    errorMessages(validateHostRegistry(hr05)).some((message) => message.includes('同时为假')),
    'HR-05 应拒绝三维分类两项同假',
  );

  // HR-08：透传模式却没有白名单
  const hr08 = cloneRegistry();
  entryOf(hr08, 'codex')['render_policy'] = { field_mode: 'host_declared' };
  assert.ok(
    errorMessages(validateHostRegistry(hr08)).some((message) => message.includes('没有白名单')),
    'HR-08 应拒绝透传模式缺白名单',
  );

  // HR-09：安全控制字段进入白名单但未登记语义证据
  const hr09 = cloneRegistry();
  entryOf(hr09, 'codex')['render_policy'] = {
    field_mode: 'host_declared',
    allowed_extensions: ['version', SECURITY_FIELD],
  };
  assert.ok(
    errorMessages(validateHostRegistry(hr09)).some((message) => message.includes(SECURITY_FIELD)),
    'HR-09 应拒绝未登记语义证据的安全控制字段',
  );

  // HR-09：登记了语义证据但字段不在白名单 → 失效登记同样不合规
  const hr09Stale = cloneRegistry();
  entryOf(hr09Stale, 'codex')['render_policy'] = {
    field_mode: 'host_declared',
    allowed_extensions: ['version'],
    security_control_evidence: {
      [SECURITY_FIELD]: {
        semantics: '示例语义',
        level: 'verified_official',
        sources: ['https://example.test/spec'],
      },
    },
  };
  assert.ok(
    errorMessages(validateHostRegistry(hr09Stale)).some((message) =>
      message.includes('未进入白名单'),
    ),
    'HR-09 应拒绝未进入白名单的语义证据登记',
  );

  // HR-13：外部消费方标识与宿主标识重复
  const hr13 = cloneRegistry();
  hr13['external_consumers'] = [
    {
      id: 'claude',
      display_name: '重名消费方',
      evidence: { level: 'verified_official', sources: ['https://example.test/spec'] },
    },
  ];
  assert.ok(
    errorMessages(validateHostRegistry(hr13)).some((message) => message.includes('与宿主标识重复')),
    'HR-13 应拒绝与宿主标识重复的外部消费方',
  );

  // HR-13：外部消费方证据非一手
  const hr13Evidence = cloneRegistry();
  hr13Evidence['external_consumers'] = [
    {
      id: 'other-product',
      display_name: '证据不足的消费方',
      evidence: { level: 'secondhand' },
    },
  ];
  assert.ok(
    errorMessages(validateHostRegistry(hr13Evidence)).some((message) =>
      message.includes('一手等级'),
    ),
    'HR-13 应拒绝非一手证据的外部消费方',
  );

  // HR-01：版本不受支持
  const hr01 = cloneRegistry();
  hr01['registry_version'] = '2';
  assert.ok(
    errorMessages(validateHostRegistry(hr01)).some((message) => message.includes('格式版本')),
    'HR-01 应拒绝不受支持的版本',
  );

  // HR-02：宿主标识重复
  const hr02 = cloneRegistry();
  hostsOf(hr02).push(entryOf(hr02, 'claude'));
  assert.ok(
    errorMessages(validateHostRegistry(hr02)).some((message) => message.includes('重复')),
    'HR-02 应拒绝重复的宿主标识',
  );

  // HR-03：出现未登记字段
  const hr03 = cloneRegistry();
  entryOf(hr03, 'claude')['contract_note'] = '未登记字段';
  assert.ok(
    errorMessages(validateHostRegistry(hr03)).some((message) => message.includes('未登记的字段')),
    'HR-03 应拒绝未登记字段',
  );

  // HR-06：声明 skill 机制却没有技能根
  const hr06 = cloneRegistry();
  entryOf(hr06, 'claude')['roots'] = [
    { kind: 'rules', path_template: 'AGENTS.md', scope: 'project' },
  ];
  assert.ok(
    errorMessages(validateHostRegistry(hr06)).some((message) => message.includes('没有技能根')),
    'HR-06 应拒绝「有 skill 机制无技能根」',
  );

  // HR-07：消费宿主不在注册表内
  const hr07 = cloneRegistry();
  (entryOf(hr07, 'claude')['classification'] as Record<string, unknown>)['root_consumed_by'] = [
    'unknown-host',
  ];
  assert.ok(
    errorMessages(validateHostRegistry(hr07)).some((message) => message.includes('不在本注册表内')),
    'HR-07 应拒绝未登记的消费宿主',
  );

  // HR-11：官方等级未给出来源
  const hr11 = cloneRegistry();
  entryOf(hr11, 'claude')['evidence'] = { level: 'verified_official', sources: [] };
  assert.ok(
    errorMessages(validateHostRegistry(hr11)).some((message) => message.includes('来源 URL')),
    'HR-11 应拒绝官方等级缺来源',
  );
});

test('契约：安全控制字段按宿主语义证据准入、白名单命中透传、未命中不静默', () => {
  // 命中：Codex 白名单内的字段
  const hit = resolveExtensions('codex', ['version', 'provenance']);
  assert.deepEqual(hit.transmitted, ['version', 'provenance'], '白名单内字段应透传');
  assert.deepEqual(hit.findings, [], '白名单内字段不应产生问题');

  // 未命中：标准字段不进白名单，应被忽略并回报警告
  const miss = resolveExtensions('codex', ['description', 'unknown-field']);
  assert.deepEqual(miss.transmitted, [], '非白名单字段不得透传');
  assert.equal(miss.findings.length, 2, '两个被忽略字段都应回报警告');
  assert.ok(
    miss.findings.every((item) => item.severity === 'warning' && item.code === 'W-FIELD-004'),
    '被忽略字段应回报白名单警告而非静默丢弃',
  );

  // 安全控制字段：Codex 已登记语义证据 → 准入透传
  const permitted = resolveExtensions('codex', [SECURITY_FIELD]);
  assert.deepEqual(permitted.transmitted, [SECURITY_FIELD], 'Codex 已登记语义证据，应准入透传');
  assert.deepEqual(permitted.findings, [], '已准入的字段不应产生问题');
  assert.ok(
    (hostById('codex')?.render_policy.allowed_extensions ?? []).includes(SECURITY_FIELD),
    'Codex 白名单应包含该字段',
  );
  assert.ok(
    hostById('codex')?.render_policy.security_control_evidence?.[SECURITY_FIELD]?.semantics !==
      undefined,
    'Codex 应登记该字段的已确认语义',
  );

  // 安全控制字段：其余宿主未登记语义证据 → 一律拒绝，且白名单不含该字段
  for (const entry of loadHostRegistry().hosts) {
    if (entry.host_id === 'codex') continue;
    const resolution = resolveExtensions(entry.host_id, [SECURITY_FIELD]);
    assert.deepEqual(resolution.transmitted, [], `${entry.host_id} 不得透传安全控制字段`);
    assert.ok(
      resolution.findings.some((item) => item.severity === 'error'),
      `${entry.host_id} 透传安全控制字段应报错误级问题`,
    );
    assert.equal(
      (entry.render_policy.allowed_extensions ?? []).includes(SECURITY_FIELD),
      false,
      `${entry.host_id} 的白名单不得登记安全控制字段`,
    );
  }

  // 标准 6 字段模式：任何扩展字段都被忽略（Claude 白名单为空）
  const claude = resolveExtensions('claude', ['version', 'compatibility']);
  assert.deepEqual(claude.transmitted, [], 'Claude 白名单为空，扩展字段不得透传');

  // 未登记宿主：抛出明确错误，而非静默按空策略处理
  assert.throws(
    () => resolveExtensions('not-registered', ['version']),
    /未登记的宿主标识/,
    '未登记宿主标识应报错',
  );
});

test('契约：Codex 落位根改为官方 agents 根，dsh 仅作为外部消费方登记', () => {
  const codex = hostById('codex');
  const skillRoot = (codex?.roots ?? []).find((item) => item.kind === 'skill');
  assert.ok(skillRoot !== undefined, 'Codex 应登记技能根');
  assert.match(String(skillRoot?.path_template), /\.agents\/skills/, '默认落位根应为 agents 根');
  assert.deepEqual(
    consumersOfRoot('codex', 'skill'),
    ['codex', 'cursor', 'dsh'],
    'agents 根的一次落位服务 codex / cursor / dsh 三个消费方（M5-R8 重叠声明）',
  );
  assert.deepEqual(codex?.classification.root_consumed_by, ['cursor', 'dsh']);

  const registry = loadHostRegistry();
  assert.deepEqual(
    (registry.external_consumers ?? []).map((item) => item.id),
    ['dsh'],
    'dsh 以外部消费方登记',
  );
  assert.equal(hostById('dsh'), undefined, 'dsh 不新增宿主条目（不立注册项）');
  assert.equal(hostIds().includes('dsh'), false, '宿主标识集合不含 dsh');
  assert.equal(hostById('deepseek')?.support_state, 'not_applicable', 'deepseek 维持不适用');
  assert.equal(selectableHostIds().includes('deepseek'), false, '不适用宿主不可落位');
});

test('契约：查询接口按标识与三维分类过滤正确', () => {
  const claude = hostById('claude');
  assert.equal(claude?.display_name, 'Claude Code');
  assert.equal(hostById('not-registered'), undefined);

  // 三维之一：支持 skill 机制
  const withSkill = listHosts({ skillMechanism: true }).map((entry) => entry.host_id);
  assert.deepEqual(
    [...withSkill].sort(),
    ['agentskills', 'claude', 'codex', 'cursor', 'doubao'],
    '支持 skill 机制的宿主集合应与注册表一致',
  );

  // 三维之二：仅支持规则文件
  const rulesOnly = listHosts({ rulesOnly: true, skillMechanism: false }).map(
    (entry) => entry.host_id,
  );
  assert.deepEqual(rulesOnly, ['agents-md'], '仅规则文件宿主应只有通用指令文件载体');

  // 三维之三：消费关系（落位根重叠）
  const consumedByCursor = listHosts({ consumedBy: 'cursor' }).map((entry) => entry.host_id);
  assert.deepEqual(
    [...consumedByCursor].sort(),
    ['agents-md', 'claude', 'codex', 'cursor'],
    'Cursor 读取 Claude / Codex 的技能根、通用指令文件与自身落位根',
  );
  const consumedByDoubao = listHosts({ consumedBy: 'doubao' }).map((entry) => entry.host_id);
  assert.deepEqual(consumedByDoubao, ['doubao'], '豆包的用户技能根只被自身消费（无重叠）');
  assert.deepEqual(
    consumersOfRoot('claude', 'skill'),
    ['claude', 'cursor'],
    'Claude 技能根的消费宿主集合应与登记一致',
  );

  // 落位根类别
  assert.deepEqual(
    listHosts({ rootKind: 'rules' }).map((entry) => entry.host_id),
    ['cursor', 'agents-md'],
    '规则路径宿主应含 Cursor 与通用指令文件载体',
  );

  // HR-10：可落位集合由 adapter_state 决定（T4 落地适配器后六个宿主生效，deepseek 仍不适用）
  assert.deepEqual(
    [...selectableHostIds()].sort(),
    ['agents-md', 'agentskills', 'claude', 'codex', 'cursor', 'doubao'],
    'T4 后六个宿主可落位；deepseek 为不适用宿主，不进该集合',
  );
});

test('契约：新增宿主只扩充注册表数据，查询由数据驱动且事实源只读', () => {
  const registry = cloneRegistry();
  const synthetic: HostEntry = {
    host_id: 'synthetic-host',
    display_name: '合成宿主',
    adapter_state: 'implemented',
    support_state: 'confirmed',
    evidence: { level: 'verified_official', sources: ['https://example.invalid/spec'] },
    classification: { skill_mechanism: true, rules_only: false },
    roots: [
      {
        kind: 'skill',
        path_template: '.<目标标识>/skills/<Skill 标识>',
        scope: 'project',
        consumed_by: ['synthetic-host'],
      },
    ],
    capability: { strict_filename: true },
    render_policy: { field_mode: 'standard6', allowed_extensions: [] },
    adapter_ref: 'synthetic-host',
  };
  hostsOf(registry).push(JSON.parse(JSON.stringify(synthetic)) as Record<string, unknown>);
  assert.deepEqual(
    errorMessages(validateHostRegistry(registry)),
    [],
    '新增宿主只需给出注册表条目，校验规则不做任何特判',
  );

  // 只有合成宿主的最小注册表同样通过校验：判定路径与首批条目一致
  const onlySynthetic = { ...registry, hosts: [synthetic] } as Record<string, unknown>;
  assert.deepEqual(
    errorMessages(validateHostRegistry(onlySynthetic)),
    [],
    '同一校验路径适用于任意宿主集合',
  );

  // 查询结果由数据推导：每个登记宿主都可按标识查到，三维分类与可落位集合与数据一致
  const data = loadHostRegistry();
  for (const entry of data.hosts) {
    assert.equal(hostById(entry.host_id)?.host_id, entry.host_id, '每个登记宿主都应按标识查到');
  }
  assert.deepEqual(
    listHosts({ skillMechanism: true })
      .map((entry) => entry.host_id)
      .sort(),
    data.hosts
      .filter((entry) => entry.classification.skill_mechanism)
      .map((entry) => entry.host_id)
      .sort(),
    '三维分类过滤结果应与数据一致',
  );
  assert.deepEqual(
    [...selectableHostIds()].sort(),
    data.hosts
      .filter(
        (entry) => entry.adapter_state === 'implemented' || entry.adapter_state === 'degrade_only',
      )
      .map((entry) => entry.host_id)
      .sort(),
    '可落位集合应由 adapter_state 推导（HR-10）',
  );

  // 事实源只读：加载结果被冻结，调用方无法就地改写宿主差异
  assert.equal(Object.isFrozen(data), true, '注册表应被冻结');
  assert.equal(Object.isFrozen(data.hosts), true, '宿主列表应被冻结');
});
