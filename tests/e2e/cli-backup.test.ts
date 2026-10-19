import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { validMeta } from '../helpers/skill.ts';
import {
  capture,
  indexPath,
  interactionOf,
  readonlyWorkspace,
  skill,
  sourceSkill,
  workspace,
} from '../helpers/cli.ts';
test('验收：validate 在干净工作区返回 0，且不改写索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['validate', '--workspace', root]), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '校验全程只读');
});
test('验收：validate 仅警告时返回 0，--strict 时返回 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const meta = join(root, 'skills', 'code-review', 'skill_meta.yaml');
  writeFileSync(meta, readFileSync(meta, 'utf8').replace('name: code-review', 'name: renamed'));
  assert.equal(await run(['validate', '--workspace', root]), 0);
  assert.equal(await run(['validate', '--workspace', root, '--strict']), 1);
  assert.equal(readFileSync(indexPath(root), 'utf8').includes('name: renamed'), false);
});
test('验收：validate 存在错误级问题时返回 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  assert.equal(await run(['validate', '--workspace', root]), 1);
});
test('验收：validate 指定未知对象返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['validate', 'nosuch', '--workspace', root]), 2);
});
test('验收：未初始化的工作区执行 validate 返回环境类错误', async () => {
  const root = workspace();
  assert.equal(await run(['validate', '--workspace', root]), 1);
});
test('验收：uninstall 生成备份并在载荷中给出备份位置', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const { code, out } = await capture([
    'uninstall',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(out) as {
    data: {
      backup_path?: string;
      backup_file_count?: number;
      backup_timestamp?: string;
    };
  };
  assert.match(String(result.data.backup_path), /^backups\/code-review\//);
  assert.equal(result.data.backup_file_count, 2);
  const backupRoot = join(root, 'backups', 'code-review');
  const stamps = readdirSync(backupRoot);
  assert.equal(stamps.length, 1);
  const dir = join(backupRoot, stamps[0]!);
  assert.ok(existsSync(join(dir, 'backup_meta.yaml')), '应写出备份清单');
  assert.ok(existsSync(join(dir, 'content', 'SKILL.md')), '应复制内容');
  assert.ok(existsSync(join(dir, 'content', 'skill_meta.yaml')), '应复制元文件');
});
test('验收：备份失败时卸载中止并返回文件系统类退出码', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  // 用同名文件占住备份目录，使备份无法创建
  writeFileSync(join(root, 'backups', 'code-review'), 'occupied');
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--yes']), 5);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '副本不得被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '原件不得被删除');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '记录不得被移除');
});
test('验收：--hard 卸载先备份再删除原件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--hard', '--yes']), 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '原件应被删除');
  const backupRoot = join(root, 'backups', 'code-review');
  const stamps = readdirSync(backupRoot);
  assert.ok(
    existsSync(join(backupRoot, stamps[0]!, 'content', 'SKILL.md')),
    '删除原件后仍能从备份回溯内容',
  );
});
test('验收：仅落库安装后 validate 不再报告启用状态与落位摘要的投影不一致', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run([
    'install',
    sourceSkill('code-review'),
    '--workspace',
    root,
    '--library-only',
    '--yes',
  ]);
  const { code, out } = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(code, 0);
  const result = JSON.parse(out) as {
    findings: Array<{
      code: string;
      target: string;
    }>;
  };
  assert.deepEqual(result.findings, [], 'status 与 targets.enabled 不参与投影判定');
});
test('验收：非终端环境未传 --yes 时拒绝执行且不写入', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { code, out } = await capture(['install', sourceSkill('code-review'), '--workspace', root]);
  assert.equal(code, 2, '参数类退出码');
  assert.match(out, /E-INPUT-001/);
  assert.match(out, /--yes/);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '拒绝后不得写入中心库');
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('code-review'), '不得登记记录');
});
test('验收：交互确认答 y 后执行，提示含预期变更摘要', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { written, channel } = interactionOf('y');
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root], channel), 0);
  assert.equal(written.length, 1, '应输出一次提示');
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '确认后应写入中心库');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '确认后应分发到目标位置');
});
test('验收：交互确认答 n 后中止，不产生任何变更', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  const { channel } = interactionOf('n');
  const { code, out } = await capture(
    ['install', sourceSkill('code-review'), '--workspace', root, '--json'],
    channel,
  );
  assert.equal(code, 0, '用户取消不是执行失败');
  const result = JSON.parse(out) as {
    data: {
      aborted?: string;
    };
  };
  assert.equal(result.data.aborted, 'user_declined');
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '取消后不得写入任何内容');
});
test('验收：卸载的确认提示逐条列出影响范围与文件数量，--hard 另行指明永久删除', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const normal = interactionOf('y');
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root], normal.channel),
    0,
    '常规卸载确认后执行',
  );
  const normalPrompt = normal.written[0] ?? '';
  assert.match(normalPrompt, /影响范围/);
  assert.match(normalPrompt, /\.claude[\\/]skills[\\/]code-review/, '须列出具体路径');
  assert.match(normalPrompt, /合计将移除 \d+ 个副本位置、\d+ 个文件/, '须给出文件数量');
  assert.ok(!normalPrompt.includes('永久删除'), '常规卸载不应出现永久删除提示');
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const strict = interactionOf('y');
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root, '--hard'], strict.channel),
    0,
    '强制确认后执行',
  );
  const strictPrompt = strict.written[0] ?? '';
  assert.match(strictPrompt, /永久删除/, '--hard 须单独指明永久删除');
  assert.match(strictPrompt, /强制确认级别/);
  assert.notEqual(strictPrompt, normalPrompt, '两档确认的提示内容必须不同');
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '--hard 应删除原件');
});
test('验收：--dry-run 不要求确认也不写盘，载荷含预演信息', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const { code, out } = await capture(
    ['uninstall', 'code-review', '--workspace', root, '--dry-run', '--json'],
    interactionOf('', false).channel,
  );
  assert.equal(code, 0, '预演不需要终端也不需要确认');
  const result = JSON.parse(out) as {
    preview?: boolean;
    data: {
      would_remove?: string[];
      would_remove_file_count?: number;
      backup_planned?: boolean;
    };
  };
  assert.equal(result.preview, true);
  assert.equal(result.data.would_remove?.length, 1);
  // 元文件的逐文件映射只列出 SKILL.md，副本因此只有一个文件
  assert.equal(result.data.would_remove_file_count, 1, '应给出文件数量');
  assert.equal(result.data.backup_planned, true);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得删除内容');
});
test('验收：list 给出分组计数与过滤结果', async () => {
  const root = await readonlyWorkspace();
  const all = await capture(['list', '--workspace', root, '--json']);
  assert.equal(all.code, 0);
  const summary = JSON.parse(all.out) as {
    data: {
      total: number;
      filtered: number;
      by_state: {
        enabled: number;
        disabled: number;
      };
      by_validation: {
        ok: number;
        invalid: number;
      };
      records: Array<{
        id: string;
      }>;
    };
  };
  assert.equal(summary.data.total, 2);
  assert.equal(summary.data.filtered, 2);
  assert.deepEqual(summary.data.by_state, { enabled: 2, disabled: 0 });
  assert.deepEqual(summary.data.by_validation, { ok: 1, invalid: 1 });
  assert.deepEqual(
    summary.data.records.map((item) => item.id),
    ['alpha', 'beta'],
  );
  const filtered = await capture(['list', '--workspace', root, '--state', 'disabled', '--json']);
  assert.equal(filtered.code, 0);
  assert.equal(
    (
      JSON.parse(filtered.out) as {
        data: {
          filtered: number;
        };
      }
    ).data.filtered,
    0,
  );
  assert.equal(await run(['list', '--workspace', root, '--state', 'paused']), 2);
});
test('验收：list 在未初始化的工作区返回引导性结果而非错误', async () => {
  const root = workspace();
  const { code, out } = await capture(['list', '--workspace', root, '--json']);
  assert.equal(code, 0, '契约 4.5：索引不存在时是引导性结果，不是错误');
  const data = (
    JSON.parse(out) as {
      data: {
        initialized: boolean;
        guide: string;
      };
    }
  ).data;
  assert.equal(data.initialized, false);
  assert.match(data.guide, /init/);
});
test('验收：inspect 输出完整元信息，未登记标识返回退出码 2', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['inspect', 'beta', '--workspace', root, '--json']);
  assert.equal(code, 0, '元文件本身合格时没有问题；失效结论由索引的运行期结论承载');
  const data = (
    JSON.parse(out) as {
      data: {
        meta_path: string;
        dependencies: {
          skills: string[];
        };
        targets: Array<{
          file_map: Record<string, string>;
        }>;
        checksum: {
          match: boolean;
        };
        validation: {
          status: string;
          errors: string[];
        };
      };
    }
  ).data;
  assert.equal(data.meta_path, 'skills/beta/skill_meta.yaml');
  assert.deepEqual(data.dependencies, { skills: ['ghost'] });
  assert.equal(data.targets[0]?.file_map['SKILL.md'], 'SKILL.md');
  assert.equal(data.checksum.match, true);
  assert.equal(data.validation.status, 'invalid', '索引内已有的校验结论照实呈现');
  assert.deepEqual(data.validation.errors, ['E-DEP-001']);
  assert.equal(await run(['inspect', 'nosuch', '--workspace', root]), 2);
  assert.equal(await run(['inspect', '--workspace', root]), 2);
  // 元文件本身不合格时按错误级返回
  const broken = workspace();
  await run(['init', '--workspace', broken]);
  skill(broken, 'bad-one', 'id: bad-one\nstatus: paused\n');
  await run(['scan', '--workspace', broken]);
  assert.equal(await run(['inspect', 'bad-one', '--workspace', broken]), 1);
});
test('验收：config get 原样返回配置区', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['config', 'get', '--workspace', root, '--json']);
  assert.equal(code, 0);
  const data = JSON.parse(out) as {
    command: string;
    data: {
      skill_roots: string[];
      default_target: string;
      default_mode: string;
    };
  };
  assert.equal(data.command, 'config get');
  assert.deepEqual(data.data.skill_roots, ['./skills']);
  assert.equal(data.data.default_target, 'claude');
  assert.equal(data.data.default_mode, 'copy');
});
test('验收：deps 区分依赖状态，未满足时返回退出码 6', async () => {
  const root = await readonlyWorkspace();
  const missing = await capture(['deps', 'beta', '--workspace', root, '--json']);
  assert.equal(missing.code, 6, '契约 4.13：存在未满足的依赖时返回 6');
  const data = (
    JSON.parse(missing.out) as {
      data: {
        entries: Array<{
          name: string;
          status: string;
        }>;
      };
    }
  ).data;
  assert.deepEqual(data.entries, [
    { name: 'ghost', constraint: null, status: 'missing', conclusion: '不在索引中' },
  ]);
  skill(root, 'gamma', `${validMeta('gamma')}dependencies:\n  skills:\n    - beta\n`);
  await run(['scan', '--workspace', root]);
  const invalid = await capture(['deps', 'gamma', '--workspace', root, '--json']);
  assert.equal(invalid.code, 6);
  const invalidData = (
    JSON.parse(invalid.out) as {
      data: {
        entries: Array<{
          name: string;
          status: string;
        }>;
      };
    }
  ).data;
  assert.equal(invalidData.entries[0]?.status, 'invalid', '依赖目标校验不通过单独区分');
  assert.equal(await run(['deps', 'alpha', '--workspace', root]), 0, '依赖已满足时返回 0');
  assert.equal(await run(['deps', 'nosuch', '--workspace', root]), 2);
});
test('验收：export 导出文件与索引一致，载荷含路径与条目数', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture([
    'export',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: {
        path: string;
        entry_count: number;
        stripped: string[];
        backup_format_version: string;
      };
    }
  ).data;
  assert.equal(data.path, 'backups/snapshot.yaml');
  assert.equal(data.entry_count, 2);
  assert.deepEqual(data.stripped, []);
  assert.equal(data.backup_format_version, '1');
  const exported = readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.match(exported, /backup_format_version: "1"/);
  for (const id of ['alpha', 'beta']) {
    assert.ok(exported.includes(`id: ${id}`), `导出应包含 ${id}`);
  }
  assert.ok(index.includes('id: alpha'), '索引未被导出动作改写');
  assert.equal(await run(['export', '../outside.yaml', '--workspace', root]), 1);
  assert.equal(await run(['export', 'nodir/out.yaml', '--workspace', root]), 5);
});
test('验收：本批五条指令执行前后索引文件字节完全一致', async () => {
  const root = await readonlyWorkspace();
  const before = readFileSync(indexPath(root), 'utf8');
  await run(['list', '--workspace', root]);
  await run(['inspect', 'beta', '--workspace', root]);
  await run(['config', 'get', '--workspace', root]);
  await run(['deps', 'beta', '--workspace', root]);
  await run(['export', 'backups/readonly.yaml', '--workspace', root]);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '只读指令不得写入索引');
});
