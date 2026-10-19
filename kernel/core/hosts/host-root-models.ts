/** 宿主注册表中的形态、分发默认根与盘点候选根数据；由 registry-data 单点引用。 */
import type {
  HostAdapterForm,
  HostLandingRootDefinition,
  InventoryRootDefinition,
} from '@skill-manager/contract';

export interface HostRootModel {
  adapter_forms: HostAdapterForm[];
  landing_roots: HostLandingRootDefinition[];
  inventory_roots: InventoryRootDefinition[];
}

export const HOST_ROOT_MODELS = {
  claude: {
    adapter_forms: ['skill'],
    landing_roots: [{ kind: 'skill', base: 'home', path_template: '.claude/skills' }],
    inventory_roots: [
      {
        root_id: 'claude/user',
        role: 'user',
        kind: 'skill',
        base: 'home',
        path_template: '.claude/skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['claude', 'cursor'],
      },
      {
        root_id: 'claude/project',
        role: 'project',
        kind: 'skill',
        base: 'workspace',
        path_template: '.claude/skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['claude', 'cursor'],
      },
    ],
  },
  codex: {
    adapter_forms: ['skill'],
    landing_roots: [{ kind: 'skill', base: 'home', path_template: '.agents/skills' }],
    inventory_roots: [
      {
        root_id: 'codex/agents-user',
        role: 'user',
        kind: 'skill',
        base: 'home',
        path_template: '.agents/skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['codex', 'cursor', 'dsh'],
        pending_verification: true,
      },
      {
        root_id: 'codex/legacy-user',
        role: 'user',
        kind: 'skill',
        base: 'home',
        path_template: '.codex/skills',
        depth: 'direct',
        origin: 'legacy',
        consumed_by: ['codex'],
        platform_notes: '旧版本机读取根；分发默认不双写',
        pending_verification: true,
      },
      {
        root_id: 'codex/system',
        role: 'system',
        kind: 'skill',
        base: 'home',
        path_template: '.codex/skills/.system',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['codex'],
        platform_notes: 'Codex 随包/系统技能折叠根；主计数不包含',
        pending_verification: true,
      },
      {
        root_id: 'codex/project',
        role: 'project',
        kind: 'skill',
        base: 'workspace',
        path_template: '.agents/skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['codex', 'cursor', 'dsh'],
      },
    ],
  },
  cursor: {
    adapter_forms: ['skill', 'rules'],
    landing_roots: [
      { kind: 'skill', base: 'home', path_template: '.cursor/skills' },
      { kind: 'rules', base: 'home', path_template: '.cursor/rules' },
    ],
    inventory_roots: [
      {
        root_id: 'cursor/user-skills',
        role: 'user',
        kind: 'skill',
        base: 'home',
        path_template: '.cursor/skills',
        depth: 'recursive',
        origin: 'default',
        consumed_by: ['cursor'],
      },
      {
        root_id: 'cursor/project-skills',
        role: 'project',
        kind: 'skill',
        base: 'workspace',
        path_template: '.cursor/skills',
        depth: 'recursive',
        origin: 'default',
        consumed_by: ['cursor'],
      },
      {
        root_id: 'cursor/user-rules',
        role: 'user',
        kind: 'rules',
        base: 'home',
        path_template: '.cursor/rules',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['cursor'],
      },
      {
        root_id: 'cursor/project-rules',
        role: 'project',
        kind: 'rules',
        base: 'workspace',
        path_template: '.cursor/rules',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['cursor'],
      },
    ],
  },
  doubao: {
    adapter_forms: ['skill'],
    landing_roots: [
      {
        kind: 'external',
        base: 'env',
        env_var: 'LOCALAPPDATA',
        platform: 'win32',
        path_template: 'Doubao/User Data/Default/.doubao/agent_mode/workspace/.user_skills',
      },
    ],
    inventory_roots: [
      {
        root_id: 'doubao/user',
        role: 'user',
        kind: 'external',
        base: 'env',
        env_var: 'LOCALAPPDATA',
        platform: 'win32',
        path_template: 'Doubao/User Data/Default/.doubao/agent_mode/workspace/.user_skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['doubao'],
      },
      {
        root_id: 'doubao/platform',
        role: 'platform',
        kind: 'external',
        base: 'env',
        env_var: 'LOCALAPPDATA',
        platform: 'win32',
        path_template: 'Doubao/User Data/Default/.doubao/agent_mode/workspace/.skills',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['doubao'],
        platform_notes: '平台持有并刷新；只盘点、不视为用户安装',
      },
    ],
  },
  agentskills: {
    adapter_forms: ['skill'],
    landing_roots: [],
    inventory_roots: [],
  },
  'agents-md': {
    adapter_forms: ['entry'],
    landing_roots: [],
    inventory_roots: [
      {
        root_id: 'agents-md/project',
        role: 'project',
        kind: 'rules',
        base: 'workspace',
        path_template: 'AGENTS.md',
        depth: 'direct',
        origin: 'default',
        consumed_by: ['codex', 'cursor'],
        platform_notes: '指令文件载体，不是 Skill 根；盘点标非技能形态',
      },
    ],
  },
} satisfies Record<string, HostRootModel>;

export type HostRootModelId = keyof typeof HOST_ROOT_MODELS;
