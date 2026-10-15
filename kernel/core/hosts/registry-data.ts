/**
 * K-13 宿主注册表的数据（随内核交付，不位于工作区）。
 *
 * 依据：宿主注册表规范 docs/specification/host-registry.spec.md（第五份契约规范）；
 *      事实来源 docs/research/host-mechanisms.md（各宿主机制调研，含证据等级）；
 *      设计决策 docs/design/m5-host-adapter.md（DP-03 载体、DP-04 透传白名单）。
 *
 * 数据与规范的一致性由 tests/contract/host-registry.test.ts 双重守住：
 *   一、整份数据通过 schemas/host_registry.schema.json 校验；
 *   二、加载时的 HR-01 ~ HR-12 校验全部通过。
 *
 * 适配器实现状态（adapter_state）：T4 落地适配器后，六个有适配器的宿主置为 implemented，
 * 可落位集合随之开放（HR-10）；`deepseek` 为「不适用 / 模型提供方」，保持 planned 且
 * 不产出适配器（其登记依赖 not_applicable 豁免）。
 */
import type { HostRegistry } from './types.ts';

/**
 * 允许透传的非标准字段（Codex）：本机实测 27 种 frontmatter 字段，
 * 去掉标准 6 字段（name、description、license、compatibility、metadata、allowed-tools）
 * 与禁用字段（disable-model-invocation）后为 20 项；标准字段由渲染模式直接输出，
 * 不进白名单。HR-09 由加载校验兜底，防止后续误加。
 */
const CODEX_TRANSMITTABLE_FIELDS = [
  'abstract',
  'activation',
  'approval_status',
  'author',
  'created',
  'date',
  'dependencies',
  'last_reviewed',
  'lifecycle',
  'maintainer',
  'organization',
  'owners',
  'provenance',
  'references',
  'review_interval_days',
  'short-description',
  'source_references',
  'type',
  'url',
  'version',
];

/**
 * 允许透传的非标准字段（豆包）：实测 21 种字段，去掉标准 6 字段后为 15 项。
 * 平台自有字段（requires、bins、cliHelp、permissions 等）不由本工具自动生成，
 * 仅在用户于扩展元数据中显式声明时才透传（DP-04）。
 */
const DOUBAO_TRANSMITTABLE_FIELDS = [
  'author',
  'bins',
  'capability_count',
  'cliHelp',
  'dependency',
  'domain',
  'hub',
  'permissions',
  'product',
  'python',
  'requires',
  'short-description',
  'skills',
  'tools',
  'version',
];

/**
 * 注册表正文。
 *
 * 注意：`.<目标标识>/skills/<Skill 标识>` 是可推导落位布局的模板（元数据规范 3.5），
 * 本文件只登记模板，不登记具体宿主目录名之外的信息。
 */
export const HOST_REGISTRY_DATA: HostRegistry = {
  registry_version: '1',
  generated_at: '2026-10-15T00:00:00Z',
  hosts: [
    {
      host_id: 'claude',
      display_name: 'Claude Code',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_official',
        sources: ['https://docs.claude.com/en/docs/claude-code/skills'],
        note: '官方文档给出 frontmatter 全表与加载目录；跨产品路径（claude.ai / Skills API）只接受标准 6 字段，故透传白名单为空',
      },
      classification: {
        skill_mechanism: true,
        rules_only: false,
        root_consumed_by: ['cursor'],
      },
      roots: [
        {
          kind: 'skill',
          path_template: '.<目标标识>/skills/<Skill 标识>',
          scope: 'project',
          consumed_by: ['claude', 'cursor'],
          platform_notes:
            '个人级技能根位于用户主目录（~/.claude/skills），不在工作区内；工作区内的落位使用可推导布局',
        },
      ],
      capability: {
        auto_discovery: true,
        progressive_loading: true,
        strict_filename: true,
        max_description_chars: 1024,
        accepted_fields: [
          'agent',
          'allowed-tools',
          'argument-hint',
          'arguments',
          'background',
          'compatibility',
          'context',
          'description',
          'disable-model-invocation',
          'disallowed-tools',
          'effort',
          'hooks',
          'license',
          'metadata',
          'model',
          'name',
          'paths',
          'shell',
          'user-invocable',
          'when_to_use',
        ],
      },
      render_policy: {
        field_mode: 'standard6',
        allowed_extensions: [],
        drop: ['trigger_keywords'],
        degrade_form: 'none',
      },
      adapter_ref: 'claude',
      open_items: [],
    },
    {
      host_id: 'codex',
      display_name: 'Codex',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_local',
        sources: ['~/.codex/skills/**/SKILL.md、~/.codex/plugins/cache/**/skills/**/SKILL.md'],
        note: '本机实测 165 个已装载技能文件、27 种 frontmatter 字段；官方规范页自本环境不可达（403），字段全集与技能根优先级待补（HD-06）',
      },
      classification: {
        skill_mechanism: true,
        rules_only: false,
        root_consumed_by: ['cursor'],
      },
      roots: [
        {
          kind: 'skill',
          path_template: '.<目标标识>/skills/<Skill 标识>',
          scope: 'project',
          consumed_by: ['codex', 'cursor'],
          platform_notes:
            '用户级技能根为 ~/.codex/skills（工作区外）；项目级技能根与目录优先级待官方文档确认',
        },
      ],
      capability: {
        auto_discovery: true,
        progressive_loading: true,
        strict_filename: true,
        accepted_fields: [
          ...CODEX_TRANSMITTABLE_FIELDS,
          'disable-model-invocation',
          'description',
          'allowed-tools',
          'compatibility',
          'license',
          'metadata',
          'name',
        ],
      },
      render_policy: {
        field_mode: 'host_declared',
        allowed_extensions: CODEX_TRANSMITTABLE_FIELDS,
        drop: ['trigger_keywords'],
        degrade_form: 'none',
      },
      adapter_ref: 'codex',
      open_items: ['HD-02', 'HD-06'],
    },
    {
      host_id: 'cursor',
      display_name: 'Cursor',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_official',
        sources: [
          'https://cursor.com/docs/context/skills',
          'https://cursor.com/docs/context/rules',
        ],
        note: '兼容读取 Claude 与 Codex 的技能根；标准外字段接受度未确认（HD-01），透传白名单保守为空',
      },
      classification: {
        skill_mechanism: true,
        rules_only: true,
      },
      roots: [
        {
          kind: 'skill',
          path_template: '.<目标标识>/skills/<Skill 标识>',
          scope: 'project',
          consumed_by: ['cursor'],
          platform_notes: '仓库内任意层级的技能根都会被递归发现；嵌套技能按目录自动作用域',
        },
        {
          kind: 'rules',
          path_template: '.cursor/rules/<Skill 标识>.mdc',
          scope: 'project',
          consumed_by: ['cursor'],
          platform_notes: '仅 .mdc 被规则系统识别，.md 被忽略；纯 Markdown 场景改用 AGENTS.md',
        },
      ],
      capability: {
        auto_discovery: true,
        progressive_loading: true,
        strict_filename: true,
        accepted_fields: ['color', 'description', 'globs', 'icon', 'name', 'paths'],
      },
      render_policy: {
        field_mode: 'standard6',
        allowed_extensions: [],
        drop: ['allowed-tools', 'compatibility', 'license', 'metadata', 'trigger_keywords'],
        degrade_form: 'rule_file',
      },
      adapter_ref: 'cursor',
      open_items: ['HD-01'],
    },
    {
      host_id: 'doubao',
      display_name: '豆包（Doubao）',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_runtime',
        sources: [
          '%LOCALAPPDATA%/Doubao/User Data/Default/.doubao/agent_mode/workspace/.user_skills',
          '%LOCALAPPDATA%/Doubao/User Data/Default/.doubao/agent_mode/workspace/.skills',
        ],
        note: '本环境实测：agent 模式工作区两级技能根（.skills 为平台持有只读、.user_skills 为用户根）；客户端内 174 个技能文件实测 21 种字段；非公开文档',
      },
      classification: {
        skill_mechanism: true,
        rules_only: false,
      },
      roots: [
        {
          kind: 'external',
          path_template: '<豆包 agent 模式工作区>/.user_skills/<Skill 标识>',
          consumed_by: ['doubao'],
          platform_notes:
            '平台自有根 .skills/ 由平台维护并会刷新，禁止写入；.agents/skills 是否为第三根待确认（HD-07）',
        },
      ],
      capability: {
        auto_discovery: true,
        strict_filename: true,
        requires_yaml_name_description: true,
        accepted_fields: [
          ...DOUBAO_TRANSMITTABLE_FIELDS,
          'allowed-tools',
          'compatibility',
          'description',
          'license',
          'metadata',
          'name',
        ],
      },
      render_policy: {
        field_mode: 'host_declared',
        allowed_extensions: DOUBAO_TRANSMITTABLE_FIELDS,
        drop: ['trigger_keywords'],
        degrade_form: 'none',
      },
      adapter_ref: 'doubao',
      open_items: ['HD-05', 'HD-07'],
    },
    {
      host_id: 'agentskills',
      display_name: '通用 Agent Skills 标准目标',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_official',
        sources: ['https://agentskills.io/specification'],
        note: '标准符合型产物：缺省不落位，落位根由调用方指定',
      },
      classification: {
        skill_mechanism: true,
        rules_only: false,
      },
      roots: [
        {
          kind: 'skill',
          path_template: '<调用方指定的技能根>/<Skill 标识>',
          platform_notes: '不绑定具体宿主；仅在调用方给出目标根时产出并落位',
        },
      ],
      capability: {
        auto_discovery: true,
        progressive_loading: true,
        max_description_chars: 1024,
        accepted_fields: [
          'allowed-tools',
          'compatibility',
          'description',
          'license',
          'metadata',
          'name',
        ],
      },
      render_policy: {
        field_mode: 'standard6',
        allowed_extensions: [],
        degrade_form: 'none',
      },
      adapter_ref: 'agentskills',
      open_items: [],
    },
    {
      host_id: 'agents-md',
      display_name: '通用指令文件载体（AGENTS.md）',
      adapter_state: 'implemented',
      support_state: 'confirmed',
      evidence: {
        level: 'verified_official',
        sources: ['https://agents.md/'],
        note: '由 Agentic AI Foundation（Linux Foundation）治理的开放格式；非 Anthropic 标准',
      },
      classification: {
        skill_mechanism: false,
        rules_only: true,
        root_consumed_by: ['codex', 'cursor'],
      },
      roots: [
        {
          kind: 'rules',
          path_template: 'AGENTS.md',
          scope: 'project',
          consumed_by: ['codex', 'cursor'],
          platform_notes:
            '写入宿主既有文件前必须具备合并策略；策略未定稿前只产出待合并片段、不落盘',
        },
      ],
      capability: {},
      render_policy: {
        field_mode: 'standard6',
        degrade_form: 'entry',
      },
      adapter_ref: 'agents-md',
      open_items: [],
    },
    {
      host_id: 'deepseek',
      display_name: 'DeepSeek（模型提供方）',
      adapter_state: 'planned',
      support_state: 'not_applicable',
      evidence: {
        level: 'verified_official',
        sources: ['https://api-docs.deepseek.com/quick_start/agent_integrations/codex'],
        note: '官方文档体系内无技能 / 插件机制；官方定位为模型提供方（把 DeepSeek 接入其他宿主）。DeepSeek Harness 线索为非官方来源，待一手确认',
      },
      classification: {
        skill_mechanism: false,
        rules_only: false,
      },
      capability: {},
      render_policy: {
        field_mode: 'standard6',
        degrade_form: 'none',
      },
      open_items: [],
    },
  ],
};
