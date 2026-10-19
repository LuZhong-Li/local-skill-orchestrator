/** GUI 冒烟夹具：工作区、宿主根与只读快照；不包含界面断言。 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup } from '../kernel/index.ts';

export function remoteMeta(url, ref, version) {
  return [
    'id: smoke-skill',
    'name: smoke-skill',
    'description: smoke skill',
    `version: ${version}`,
    'status: enabled',
    'path: ./skills/smoke-skill',
    'source:',
    '  type: git',
    `  url: ${url}`,
    `  ref: ${ref}`,
    'targets:',
    '  - target: claude',
    '    scope: global',
    '    path: .claude/skills/smoke-skill',
    '    mode: copy',
    '    enabled: true',
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');
}

export function prepareWorkspace(url) {
  const root = mkdtempSync(join(tmpdir(), 'sm-gui-smoke-'));
  const skill = join(root, 'skills', 'smoke-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# smoke');
  writeFileSync(join(skill, 'skill_meta.yaml'), remoteMeta(url, 'v1.0.0', '1.0.0'));

  const localSkill = join(root, 'skills', 'local-skill');
  mkdirSync(localSkill, { recursive: true });
  writeFileSync(join(localSkill, 'SKILL.md'), '# local');
  writeFileSync(
    join(localSkill, 'skill_meta.yaml'),
    [
      'id: local-skill',
      'name: local-skill',
      'version: 1.0.0',
      'status: enabled',
      'path: ./skills/local-skill',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/local-skill',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );

  const pluginSource = join(root, 'plugin-source');
  mkdirSync(pluginSource, { recursive: true });
  writeFileSync(
    join(pluginSource, 'plugin.json'),
    JSON.stringify(
      {
        manifest_version: '1',
        plugin_id: 'smoke-tools',
        name: 'Smoke Tools',
        version: '1.0.0',
        compatibility: { skill_manager: '>=0.2.0 <1.0.0', plugin_api: '1' },
        capabilities: ['host_profile'],
        hosts: [
          {
            host_key: 'zed',
            display_name: 'Zed',
            form: 'rules',
            roots: [
              {
                kind: 'rules',
                path_template: '<skill_id>.md',
                scope: 'global',
              },
            ],
            render_policy: { field_mode: 'standard6' },
          },
        ],
      },
      null,
      2,
    ),
  );

  const pluginSkillSource = join(root, 'plugin-smoke-source');
  mkdirSync(pluginSkillSource, { recursive: true });
  writeFileSync(join(pluginSkillSource, 'SKILL.md'), '# plugin smoke');
  writeFileSync(
    join(pluginSkillSource, 'skill_meta.yaml'),
    [
      'id: plugin-smoke-skill',
      'name: plugin-smoke-skill',
      'description: plugin smoke skill',
      'version: 1.0.0',
      'status: enabled',
      'path: ./skills/plugin-smoke-skill',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/plugin-smoke-skill',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );

  mkdirSync(join(root, 'backups'), { recursive: true });
  createBackup({
    workspaceRoot: root,
    backupsDir: join(root, 'backups'),
    id: 'smoke-skill',
    sourceDir: skill,
    now: '2026-01-01T00:00:00Z',
    checksum: '',
  });
  // 备份后改动原件：恢复若真的写回，磁盘必须回到备份里的取值。
  writeFileSync(join(skill, 'SKILL.md'), '# tampered after backup');
  return root;
}

function skillFrontmatter(name) {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} smoke fixture`,
    'version: 1.0.0',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n');
}

/** 宿主夹具：临时 HOME / LOCALAPPDATA；用户级 2 份、系统级 201 份、平台级 1 份、损坏 1 份。 */
export function prepareHostFixture(home, local) {
  const writeSkill = (path, name) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), skillFrontmatter(name));
  };
  writeSkill(join(home, '.claude', 'skills', 'history-skill'), 'history-skill');
  writeSkill(join(home, '.agents', 'skills', 'shared-skill'), 'shared-skill');
  writeSkill(join(home, '.codex', 'skills', '.system', 'system-skill'), 'system-skill');
  writeSkill(
    join(
      local,
      'Doubao',
      'User Data',
      'Default',
      '.doubao',
      'agent_mode',
      'workspace',
      '.skills',
      'platform-skill',
    ),
    'platform-skill',
  );
  const broken = join(home, '.claude', 'skills', 'broken-skill');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'SKILL.md'), '---\nname: broken-skill\n---\n# broken');
  for (let index = 0; index < 200; index += 1) {
    const id = `bulk-${String(index).padStart(3, '0')}`;
    writeSkill(join(home, '.codex', 'skills', '.system', id), id);
  }
}

/** 递归目录树哈希：路径、类型、大小与内容，用于盘点前后逐字节一致断言。 */
export function treeHash(root) {
  if (!existsSync(root)) return 'missing';
  const digest = createHash('sha256');
  walkTree(root, '', digest);
  return digest.digest('hex');
}

function walkTree(absolute, relative, digest) {
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const stat = lstatSync(child);
    if (entry.isSymbolicLink()) {
      digest.update(`link:${childRelative}\n`);
    } else if (entry.isDirectory()) {
      digest.update(`dir:${childRelative}\n`);
      walkTree(child, childRelative, digest);
    } else if (entry.isFile()) {
      digest.update(`file:${childRelative}:${String(stat.size)}\n`);
      digest.update(readFileSync(child));
      digest.update('\n');
    }
  }
}

export function fileSnapshot(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return 'absent';
  }
}
