import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import {
  backupDirOf,
  capture,
  importScenario,
  indexPath,
  interactionOf,
  readonlyWorkspace,
  restoreScenario,
  sourceSkill,
  workspace,
} from '../helpers/cli.ts';
test('验收：enable 按需补齐副本并更新索引状态，disable 只改名', async () => {
  const root = await readonlyWorkspace();
  assert.equal(await run(['enable', 'alpha', '--workspace', root]), 0);
  assert.deepEqual(readdirSync(join(root, '.claude', 'skills', 'alpha')).sort(), ['SKILL.md']);
  assert.ok(
    readFileSync(indexPath(root), 'utf8').includes('status: enabled'),
    '索引状态应已是已启用',
  );
  assert.equal(await run(['disable', 'alpha', '--workspace', root]), 0);
  assert.deepEqual(readdirSync(join(root, '.claude', 'skills', 'alpha')).sort(), [
    'SKILL.md.disabled',
  ]);
  assert.equal(await run(['disable', 'alpha', '--workspace', root]), 0, '重复禁用幂等');
  assert.equal(await run(['enable', 'alpha', '--workspace', root]), 0);
  assert.ok(readdirSync(join(root, '.claude', 'skills', 'alpha')).includes('SKILL.md'));
});
test('验收：enable 拒绝校验不通过的记录，且不表述为已禁用', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['enable', 'beta', '--workspace', root, '--json']);
  assert.equal(code, 1, '校验类问题按错误级返回');
  const findings = (
    JSON.parse(out) as {
      findings: Array<{
        code: string;
        remedy: string;
      }>;
    }
  ).findings;
  assert.equal(findings[0]?.code, 'E-VALIDATION-001');
  assert.ok(!JSON.stringify(findings).includes('该 Skill 已被禁用'));
  assert.equal(await run(['enable', 'nosuch', '--workspace', root]), 2);
});
test('验收：update 需要确认，--check 只报告不写盘', async () => {
  const root = await readonlyWorkspace();
  const checked = await capture(['update', 'alpha', '--workspace', root, '--check', '--json']);
  assert.equal(checked.code, 0, '检查模式不需要确认');
  assert.equal(
    (
      JSON.parse(checked.out) as {
        preview?: boolean;
      }
    ).preview,
    true,
  );
  assert.equal(await run(['update', 'alpha', '--workspace', root]), 2, '非终端且未给 --yes');
  assert.equal(await run(['update', 'alpha', '--workspace', root, '--yes']), 0);
  assert.equal(await run(['update', 'alpha', '--workspace', root, '--target', 'claude']), 2);
  assert.equal(await run(['update', 'nosuch', '--workspace', root, '--yes']), 2);
});
test('验收：update 刷新版本与指纹，首次登记时间不变', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const meta = join(root, 'skills', 'code-review', 'skill_meta.yaml');
  writeFileSync(
    meta,
    readFileSync(meta, 'utf8').replace('id: code-review', 'id: code-review\nversion: 2.0.0'),
  );
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# code-review changed');
  const before = await capture(['inspect', 'code-review', '--workspace', root, '--json']);
  const recordBefore = (
    JSON.parse(before.out) as {
      data: {
        record: {
          created_at: string;
          checksum: string;
        };
      };
    }
  ).data.record;
  const { code, out } = await capture([
    'update',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: Record<string, unknown>;
    }
  ).data;
  assert.equal(data['version_after'], '2.0.0');
  assert.equal(data['version_changed'], true);
  assert.equal(data['created_at'], recordBefore.created_at, '首次登记时间不变');
  assert.notEqual(data['checksum_after'], recordBefore.checksum, '指纹按磁盘重算');
});
test('验收：config set 写入并拒绝非法取值，写入前后索引可解析', async () => {
  const root = await readonlyWorkspace();
  const set = await capture([
    'config',
    'set',
    'default_target',
    'codex',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(set.code, 0);
  const data = (
    JSON.parse(set.out) as {
      data: Record<string, unknown>;
    }
  ).data;
  assert.equal(data['previous_value'], 'claude');
  assert.equal(data['new_value'], 'codex');
  const read = await capture(['config', 'get', '--workspace', root, '--json']);
  assert.equal(
    (
      JSON.parse(read.out) as {
        data: {
          default_target: string;
        };
      }
    ).data.default_target,
    'codex',
  );
  assert.equal(await run(['config', 'set', 'default_mode', '硬链接', '--workspace', root]), 2);
  assert.equal(await run(['config', 'set', 'nosuchkey', 'x', '--workspace', root]), 2);
  assert.equal(await run(['config', 'set', 'default_target', '--workspace', root]), 2);
});
test('验收：export --no-config 不含配置区并记入剥离清单', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture([
    'export',
    'backups/no-config.yaml',
    '--no-config',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: {
        config_included: boolean;
        stripped: string[];
      };
    }
  ).data;
  assert.equal(data.config_included, false);
  assert.deepEqual(data.stripped, ['config']);
  assert.ok(!readFileSync(join(root, 'backups', 'no-config.yaml'), 'utf8').includes('skill_roots'));
});
test('验收：deps --tree 给出嵌套依赖树', async () => {
  const root = await readonlyWorkspace();
  const { code, out } = await capture(['deps', 'beta', '--tree', '--workspace', root, '--json']);
  assert.equal(code, 6, '依赖未满足仍按专属口径返回 6');
  const tree = (
    JSON.parse(out) as {
      data: {
        tree: {
          name: string;
          status: string;
          children: unknown[];
        };
      };
    }
  ).data.tree;
  assert.equal(tree.name, 'beta');
  assert.equal(tree.status, 'invalid', '该记录自身的运行期结论为校验不通过');
  assert.deepEqual(tree.children, [{ name: 'ghost', status: 'missing', children: [] }]);
});
test('验收：未知选项按参数类错误拒绝', async () => {
  const root = await readonlyWorkspace();
  assert.equal(await run(['list', '--workspace', root, '--sttae', 'enabled']), 2);
  assert.equal(await run(['scan', '--workspace', root, '--frobnicate']), 2);
});
test('验收：import 需要轻确认，非终端未给 --yes 时拒绝', async () => {
  const root = await importScenario();
  assert.equal(await run(['import', 'backups/snapshot.yaml', '--workspace', root]), 2);
  assert.equal(await run(['import', 'backups/snapshot.yaml', '--workspace', root, '--yes']), 0);
});
test('验收：import 的确认提示给出将登记的记录条数', async () => {
  const root = await importScenario();
  const { written, channel } = interactionOf('n');
  const code = await run(['import', 'backups/snapshot.yaml', '--workspace', root], channel);
  assert.equal(code, 0, '用户取消不是执行失败');
  assert.match(written[0] ?? '', /将登记 1 条记录/);
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('id: alpha'), '取消后不登记');
});
test('验收：import 恢复记录并跳过既有标识，扫描后与磁盘实况一致', async () => {
  const root = await importScenario();
  const { code, out } = await capture([
    'import',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: {
        imported: number;
        conflicts: number;
        ids: string[];
        roundtrip: string;
      };
    }
  ).data;
  assert.equal(data.imported, 1, 'alpha 的原目录已删除，仍按清单登记');
  assert.equal(data.conflicts, 1, 'beta 已在索引中，跳过不覆盖');
  assert.deepEqual(data.ids, ['alpha']);
  assert.equal(data.roundtrip, 'consistent');
  // 导入后 alpha 的记录未经验证，扫描按磁盘实况给出结论
  await run(['scan', '--workspace', root]);
  const listed = await capture(['list', '--workspace', root, '--json']);
  const summary = (
    JSON.parse(listed.out) as {
      data: {
        total: number;
        by_validation: {
          ok: number;
          invalid: number;
        };
      };
    }
  ).data;
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.by_validation, { ok: 1, invalid: 1 }, 'alpha 的目录缺失判为不通过');
});
test('验收：import 重复执行时全部按冲突跳过且不改动索引', async () => {
  const root = await importScenario();
  await run(['import', 'backups/snapshot.yaml', '--workspace', root, '--yes']);
  const before = readFileSync(indexPath(root), 'utf8');
  const { code, out } = await capture([
    'import',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const data = (
    JSON.parse(out) as {
      data: {
        imported: number;
        conflicts: number;
      };
    }
  ).data;
  assert.equal(data.imported, 0);
  assert.equal(data.conflicts, 2);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '无新增时不改写索引');
});
test('验收：import 格式非法时返回退出码 3 且详情可见', async () => {
  const root = await importScenario();
  const bad = join(root, 'backups', 'bad.yaml');
  writeFileSync(
    bad,
    ['backup_format_version: "1"', 'skills:', '  - id: UPPER', '    status: paused', ''].join('\n'),
  );
  const { code, out } = await capture([
    'import',
    'backups/bad.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 3, '契约 4.15：备份格式校验失败返回 3');
  const result = JSON.parse(out) as {
    findings: Array<{
      code: string;
    }>;
    data: {
      rejected?: string;
      problem_codes?: string[];
    };
  };
  assert.equal(result.data.rejected, 'invalid_format');
  assert.ok((result.data.problem_codes ?? []).includes('E-FIELD-001'));
  assert.ok(result.findings.some((item) => item.code === 'E-STATUS-001'));
  assert.equal(await run(['import', '../outside.yaml', '--workspace', root, '--yes']), 1);
  assert.equal(await run(['import', 'backups/nosuch.yaml', '--workspace', root, '--yes']), 4);
  assert.equal(
    await run(['import', 'backups/snapshot.yaml', '--on-conflict', 'keep', '--workspace', root]),
    2,
  );
});
/** 造出「已安装并留下一份卸载备份」的现场，供恢复指令用例复用 */
test('验收：restore 需要常规确认，非终端未给 --yes 时拒绝执行且不写盘', async () => {
  const root = await restoreScenario({ hard: true });
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '前置：原件已被硬卸载删除');
  const { code, out } = await capture(['restore', 'code-review', '--workspace', root]);
  assert.equal(code, 2, '参数类退出码');
  assert.match(out, /E-INPUT-001/);
  assert.match(out, /--yes/);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '拒绝后不得写回原件');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '拒绝后不得创建副本');
  assert.equal(await run(['restore', 'code-review', '--workspace', root, '--yes']), 0);
});
test('验收：restore 的确认提示写明覆盖现有原件，答 n 时中止', async () => {
  const root = await restoreScenario();
  const { written, channel } = interactionOf('n');
  const outcome = await capture(['restore', 'code-review', '--workspace', root, '--json'], channel);
  assert.equal(outcome.code, 0, '用户取消不是执行失败');
  assert.match(written[0] ?? '', /覆盖/);
  assert.match(written[0] ?? '', /扫描/);
  assert.match(written[0] ?? '', /确认执行？\[y\/N\]/);
  const result = JSON.parse(outcome.out) as {
    data: {
      aborted?: string;
    };
  };
  assert.equal(result.data.aborted, 'user_declined');
  const { channel: accept } = interactionOf('y');
  assert.equal(
    await run(['restore', 'code-review', '--workspace', root], accept),
    0,
    '答 y 后应执行',
  );
});
test('验收：restore 缺省取最新备份，重建记录后由 scan 判定为合格', async () => {
  const root = await restoreScenario({ hard: true });
  const { code, out } = await capture([
    'restore',
    'code-review',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(out) as {
    data: {
      record_action?: string;
      file_count?: number;
      files?: string[];
      backup_timestamp?: string;
      backup_type?: string;
      library_path?: string;
    };
  };
  assert.equal(result.data.record_action, 'rebuilt', '已卸载的标识应重建记录');
  assert.equal(result.data.file_count, 2);
  assert.deepEqual(result.data.files, [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);
  assert.equal(result.data.backup_type, 'full');
  assert.equal(result.data.library_path, 'skills/code-review');
  assert.match(String(result.data.backup_timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '内容应写回中心库');
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md')), '副本应重分发');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('id: code-review'), '索引记录应重建');
  assert.ok(index.includes('E-INDEX-002'), '重建记录的结论取保守值');
  assert.equal(await run(['scan', '--workspace', root]), 0, '扫描后应无不合格项');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('status: ok'), '扫描应把结论刷新为合格');
});
test('验收：restore 无备份返回 5，时间戳不存在返回 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const missing = await capture(['restore', 'code-review', '--workspace', root, '--yes', '--json']);
  assert.equal(missing.code, 5, '备份类问题按通用派生落 5');
  assert.match(missing.out, /E-BAK-003/);
  await run(['uninstall', 'code-review', '--workspace', root, '--yes']);
  const stamped = await capture([
    'restore',
    'code-review',
    '--timestamp',
    '2020-01-01T00:00:00Z',
    '--workspace',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(stamped.code, 2, '时间戳不存在属参数类');
  const result = JSON.parse(stamped.out) as {
    data: {
      rejected?: string;
      available?: string[];
    };
  };
  assert.equal(result.data.rejected, 'timestamp_not_found');
  assert.equal(result.data.available?.length, 1, '应列出可用时间戳');
});
test('验收：restore 载体损坏返回 5，目标被占用返回 1', async () => {
  const damaged = await restoreScenario({ hard: true });
  rmSync(join(backupDirOf(damaged, 'code-review'), 'content', 'SKILL.md'), { force: true });
  const broken = await capture([
    'restore',
    'code-review',
    '--workspace',
    damaged,
    '--yes',
    '--json',
  ]);
  assert.equal(broken.code, 5);
  assert.match(broken.out, /E-BAK-004/);
  assert.ok(!existsSync(join(damaged, 'skills', 'code-review')), '载体不可信时不得写回');
  const occupied = await restoreScenario({ hard: true });
  writeFileSync(join(occupied, 'skills', 'code-review'), 'occupied');
  const conflict = await capture([
    'restore',
    'code-review',
    '--workspace',
    occupied,
    '--yes',
    '--json',
  ]);
  assert.equal(conflict.code, 1, '目标占用冲突按默认档落 1');
  assert.match(conflict.out, /E-CONFLICT-003/);
  assert.equal(readFileSync(join(occupied, 'skills', 'code-review'), 'utf8'), 'occupied');
});
test('验收：restore --dry-run 不要求确认也不写盘，载荷含将写回的清单', async () => {
  const root = await restoreScenario({ hard: true });
  const before = readFileSync(indexPath(root), 'utf8');
  const { code, out } = await capture([
    'restore',
    'code-review',
    '--workspace',
    root,
    '--dry-run',
    '--json',
  ]);
  assert.equal(code, 0, '预演不要求确认');
  const result = JSON.parse(out) as {
    preview?: boolean;
    data: {
      preview?: boolean;
      file_count?: number;
      files?: string[];
      library_exists?: boolean;
    };
  };
  assert.equal(result.preview, true);
  assert.equal(result.data.preview, true);
  assert.equal(result.data.file_count, 2);
  assert.deepEqual(result.data.files, [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);
  assert.equal(result.data.library_exists, false);
  const notes =
    (
      JSON.parse(out) as {
        data: {
          notes?: string[];
        };
      }
    ).data.notes ?? [];
  assert.ok(
    notes.some((note) => /没有原件/.test(note)),
    '预演载荷写明目标位置现状，供确认弹窗如实展示',
  );
  assert.ok(
    notes.some((note) => /扫描/.test(note)),
    '预演载荷写明结论由扫描判定',
  );
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写回原件');
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '预演不得改写索引');
});
test('验收：restore --list 列出可用备份，空工作区与过滤各归正常结果', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  // 未产生任何备份时：正常结果而不是错误
  const empty = await capture(['restore', '--list', '--workspace', root, '--json']);
  assert.equal(empty.code, 0, '列表为空不是失败');
  const emptyData = JSON.parse(empty.out) as {
    data: {
      backups: unknown[];
      total: number;
      filtered_by: string | null;
      notes: string[];
    };
  };
  assert.equal(emptyData.data.total, 0);
  assert.deepEqual(emptyData.data.backups, []);
  assert.equal(emptyData.data.filtered_by, null);
  assert.ok(
    emptyData.data.notes.some((note) => /没有可用备份/.test(note)),
    '无备份时给出引导文案',
  );
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  await run(['uninstall', 'code-review', '--workspace', root, '--yes']);
  const all = await capture(['restore', '--list', '--workspace', root, '--json']);
  assert.equal(all.code, 0);
  const rows = (
    JSON.parse(all.out) as {
      data: {
        backups: Array<{
          id: string;
          timestamp: string;
          type: string;
          file_count: number;
          path: string;
        }>;
        total: number;
      };
    }
  ).data;
  assert.equal(rows.total, 1);
  assert.equal(rows.backups[0]?.id, 'code-review');
  assert.equal(rows.backups[0]?.type, 'full');
  assert.equal(rows.backups[0]?.file_count, 2);
  assert.match(String(rows.backups[0]?.path), /^backups\/code-review\//);
  assert.match(String(rows.backups[0]?.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  // 按标识过滤：命中的给出条目，未命中的给出空列表
  const hit = await capture(['restore', 'code-review', '--list', '--workspace', root, '--json']);
  assert.equal(
    (
      JSON.parse(hit.out) as {
        data: {
          total: number;
        };
      }
    ).data.total,
    1,
  );
  const miss = await capture(['restore', 'nosuch', '--list', '--workspace', root, '--json']);
  assert.equal(miss.code, 0);
  assert.equal(
    (
      JSON.parse(miss.out) as {
        data: {
          total: number;
        };
      }
    ).data.total,
    0,
  );
  // 标识不合规按参数类问题拒绝，不做路径拼接
  const bad = await capture(['restore', 'Bad_ID', '--list', '--workspace', root, '--json']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /E-INPUT-002/);
});
