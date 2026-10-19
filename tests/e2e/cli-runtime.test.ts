import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { parseYaml as parseYamlDocument } from '../../kernel/store/yaml/index.ts';
import semver from 'semver';
import { validMeta } from '../helpers/skill.ts';
import { capture, indexPath, readonlyWorkspace, runCli, skill, workspace } from '../helpers/cli.ts';
test('验收：validate 的内容漂移报告定位到具体文件并给出新旧摘要', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  assert.equal(await run(['scan', '--workspace', root]), 0, '前置：干净工作区');
  const baseline = (
    parseYamlDocument(readFileSync(indexPath(root), 'utf8')) as {
      skills: Array<{
        id: string;
        digests: Record<string, string>;
      }>;
    }
  ).skills.find((item) => item.id === 'alpha');
  const recorded = baseline?.digests['SKILL.md'];
  assert.match(String(recorded), /^sha256:[0-9a-f]{64}$/, '前置：索引内应有逐文件基准');
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# drifted');
  const { code, out } = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(code, 0, '漂移是警告级，不改退出码');
  const result = JSON.parse(out) as {
    findings: Array<{
      code: string;
      target: string;
      message: string;
    }>;
  };
  const located = result.findings.filter(
    (item) => item.code === 'W-DRIFT-001' && item.target.startsWith('alpha/'),
  );
  assert.equal(located.length, 1, '应定位到唯一变化的文件');
  assert.equal(located[0]?.target, 'alpha/SKILL.md', '报告给出文件相对路径');
  assert.match(String(located[0]?.message), /文件内容已变化/);
  assert.match(String(located[0]?.message), new RegExp(String(recorded)), '给出原摘要');
  assert.match(String(located[0]?.message), /现有摘要 sha256:[0-9a-f]{64}/, '给出现有摘要');
  // 修复后重新扫描，基准与磁盘重新对齐，不再报告漂移
  assert.equal(await run(['scan', '--workspace', root]), 0);
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('# drifted'), '索引不含文件内容');
  const after = await capture(['validate', '--workspace', root, '--json']);
  assert.ok(
    !(
      JSON.parse(after.out) as {
        findings: Array<{
          code: string;
        }>;
      }
    ).findings.some((item) => item.code === 'W-DRIFT-001'),
    '重新扫描后漂移消失',
  );
});
test('验收：export 产物不含逐文件摘要，索引内仍保留该基准', async () => {
  const root = await readonlyWorkspace();
  const indexText = readFileSync(indexPath(root), 'utf8');
  assert.ok(indexText.includes('digests:'), '前置：索引派生区内有逐文件摘要');
  const { code, out } = await capture([
    'export',
    'backups/snapshot.yaml',
    '--workspace',
    root,
    '--json',
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(out) as {
    data: {
      entry_count: number;
      stripped: string[];
    };
  };
  assert.equal(payload.data.entry_count, 2);
  assert.ok(
    !payload.data.stripped.some((item) => item.endsWith('digests')),
    '内部派生数据不计入被剥离项清单',
  );
  const document = readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8');
  assert.ok(!document.includes('digests'), '导出物中不含逐文件摘要');
  assert.match(document, /checksum: sha256:/, '聚合指纹仍在导出物中');
  assert.equal(readFileSync(indexPath(root), 'utf8'), indexText, '导出不改动索引');
});
test('验收：deps 呈现运行时维度，缺失的运行时返回退出码 6', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', `${validMeta('alpha')}dependencies:\n  runtime:\n    node: ">=22.0.0"\n`);
  skill(
    root,
    'beta',
    `${validMeta('beta')}dependencies:\n  runtime:\n    skill-manager-no-such-runtime: ">=1.0.0"\n`,
  );
  assert.equal(await run(['scan', '--workspace', root]), 0, '运行时不参与校验结论');
  const satisfied = runCli(['deps', 'alpha', '--workspace', root, '--json']);
  assert.equal(satisfied.code, 0);
  const okRuntime = (
    JSON.parse(satisfied.out) as {
      data: {
        runtime: Array<{
          name: string;
          constraint: string;
          status: string;
          version: string | null;
          command: string | null;
          conclusion: string;
        }>;
      };
    }
  ).data.runtime;
  assert.equal(okRuntime.length, 1, '载荷给出运行时条目');
  assert.equal(okRuntime[0]?.name, 'node');
  assert.equal(okRuntime[0]?.constraint, '>=22.0.0', '载荷保留期望约束原文');
  assert.equal(okRuntime[0]?.status, 'ok');
  assert.equal(okRuntime[0]?.version, semver.coerce(process.versions.node)?.version);
  assert.ok((okRuntime[0]?.command ?? '').length > 0, '命中命令的位置一并呈现');
  const missing = runCli(['deps', 'beta', '--workspace', root, '--json']);
  assert.equal(missing.code, 6, '运行时缺失归入依赖档');
  const missingResult = JSON.parse(missing.out) as {
    findings: Array<{
      code: string;
      target: string;
    }>;
    data: {
      runtime: Array<{
        status: string;
        version: string | null;
      }>;
    };
  };
  assert.equal(missingResult.data.runtime[0]?.status, 'missing');
  assert.equal(missingResult.data.runtime[0]?.version, null);
  assert.deepEqual(
    missingResult.findings.map((item) => item.code),
    ['E-RUN-001'],
  );
});
test('验收五：运行时缺失不改变 scan 与 validate 的判定，也不写入索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(
    root,
    'gamma',
    `${validMeta('gamma')}dependencies:\n  runtime:\n    skill-manager-no-such-runtime: ">=1.0.0"\n`,
  );
  assert.equal(await run(['scan', '--workspace', root]), 0, '运行时缺失不判失效');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('status: ok'), '记录结论为校验通过');
  assert.ok(!index.includes('skill-manager-no-such-runtime'), '探测结果不入索引');
  const validation = await capture(['validate', '--workspace', root, '--json']);
  assert.equal(validation.code, 0, 'validate 判定不受运行时影响');
  assert.ok(
    !(
      JSON.parse(validation.out) as {
        findings: Array<{
          code: string;
        }>;
      }
    ).findings.some((item) => item.code.startsWith('E-RUN-')),
    '校验报告不掺入运行时探测结论',
  );
  // 同一份环境里，依赖检查仍会把运行时问题如实报出来
  assert.equal(runCli(['deps', 'gamma', '--workspace', root]).code, 6);
  assert.equal(readFileSync(indexPath(root), 'utf8'), index, 'deps 不改动索引');
});
