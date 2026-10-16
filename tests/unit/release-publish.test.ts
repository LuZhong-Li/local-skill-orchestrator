import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKSUM_FILE,
  buildChecksumManifest,
  expectedAssets,
  ghArgs,
  publishRelease,
  stageReleaseAssets,
} from '../../scripts/release-publish.mjs';

const VERSION = '0.1.0';

/** 造一个「打包产物目录」：5 个交付物 + 可选的额外文件 */
function fixture(extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sm-release-'));
  for (const name of [...expectedAssets(VERSION), ...extra]) {
    writeFileSync(join(dir, name), `content:${name}`);
  }
  return dir;
}

/** ghArgs 的标准入参（资产与清单按「汇总目录 + 文件名」给出） */
function ghInput(exists: boolean) {
  return {
    exists,
    tag: 'v0.1.0',
    title: 'v0.1.0',
    notesFile: 'RELEASE_NOTES.md',
    assets: expectedAssets(VERSION).map((name) => join('release', name)),
    checksumFile: join('release', CHECKSUM_FILE),
  };
}

test('发布资产：恰好 5 个交付物（缺失或混入非交付物即失败）', () => {
  const assets = expectedAssets(VERSION);
  assert.equal(assets.length, 5);
  assert.deepEqual(assets, [
    'skill-manager-0.1.0-x64.exe',
    'skill-manager-0.1.0-portable.exe',
    'skill-manager-0.1.0-x86_64.AppImage',
    'skill-manager-0.1.0-arm64.dmg',
    'skill-manager-0.1.0-x64.dmg',
  ]);
  assert.deepEqual(stageReleaseAssets({ present: assets, version: VERSION }), assets);
  assert.deepEqual(
    stageReleaseAssets({ present: [...assets, CHECKSUM_FILE], version: VERSION }),
    assets,
    '已生成的校验清单不算非交付物',
  );
  assert.throws(
    () => stageReleaseAssets({ present: assets.slice(1), version: VERSION }),
    /发布资产缺失：skill-manager-0\.1\.0-x64\.exe/,
  );
  assert.throws(
    () =>
      stageReleaseAssets({ present: [...assets, 'diagnostics-pack-linux.zip'], version: VERSION }),
    /非交付物：diagnostics-pack-linux\.zip/,
    '诊断包不得进入发布目录',
  );
});

test('发布资产：校验清单只含交付物且哈希可复算', () => {
  const dir = fixture();
  const manifest = buildChecksumManifest({ dir, files: expectedAssets(VERSION) });
  const lines = manifest.split('\n');

  assert.equal(lines.length, 5, '清单行数等于交付物数量');
  for (const [index, line] of lines.entries()) {
    const [hash, name] = line.split('  ');
    assert.equal(name, expectedAssets(VERSION)[index]);
    const expected = createHash('sha256')
      .update(`content:${String(name)}`)
      .digest('hex');
    assert.equal(hash, expected, `${String(name)} 的哈希应可复算`);
  }
});

test('发布：gh 命令序列——新建时四步、复用时三步，且必定收敛发布态与 latest', () => {
  const created = ghArgs(ghInput(false));
  assert.deepEqual(
    created.map((command) => command.step),
    ['create', 'publish', 'edit', 'upload'],
  );
  assert.deepEqual(created[0]!.args.slice(0, 3), ['release', 'create', 'v0.1.0']);
  assert.ok(created[0]!.args.includes('--verify-tag'), 'create 校验 tag 存在');

  const reused = ghArgs(ghInput(true));
  assert.deepEqual(
    reused.map((command) => command.step),
    ['publish', 'edit', 'upload'],
    'Release 已存在时不重复创建',
  );

  // 收敛发布态：draft / prerelease 一律置否，latest 显式标记（首跑实测的 422 即由此而来）
  for (const commands of [created, reused]) {
    const publish = commands.find((command) => command.step === 'publish')!;
    assert.deepEqual(publish.args.slice(0, 3), ['release', 'edit', 'v0.1.0']);
    assert.ok(publish.args.includes('--draft=false'));
    assert.ok(publish.args.includes('--prerelease=false'));
    const edit = commands.find((command) => command.step === 'edit')!;
    for (const flag of ['--title', '--notes-file', '--latest']) {
      assert.ok(edit.args.includes(flag), `edit 应含 ${flag}`);
    }
    assert.equal(
      edit.args.some((argument) => argument === '--prerelease'),
      false,
      '不得把 release 标成 prerelease',
    );
  }
});

test('发布：上传资产必须以「目录 + 文件名」给出（裸文件名会让 gh 报 no matches found）', () => {
  for (const exists of [false, true]) {
    const upload = ghArgs(ghInput(exists)).find((command) => command.step === 'upload')!;
    assert.deepEqual(upload.args.slice(0, 4), ['release', 'upload', 'v0.1.0', '--clobber']);
    for (const argument of upload.args.slice(4)) {
      // 分隔符随平台（Windows 为反斜杠），断言只要求「带汇总目录前缀」
      assert.match(argument, /^release[\\/]/, `上传路径应带汇总目录前缀：${argument}`);
    }
  }
});

test('发布：dry-run 只打印命令、不执行任何 gh 调用', () => {
  let calls = 0;
  const result = publishRelease({
    ...ghInput(false),
    dryRun: true,
    run: () => {
      calls += 1;
      return { status: 0 };
    },
  });
  assert.equal(calls, 0, 'dry-run 不得调用 gh');
  assert.equal(result.dryRun, true);
  assert.equal(result.commands.length, 4, 'create + publish + edit + upload');
});

test('发布：非 dry-run 按序执行，失败即中止（不静默继续）', () => {
  const seen: string[] = [];
  publishRelease({
    ...ghInput(false),
    run: (command: string, args: string[]) => {
      seen.push([command, ...args].join(' '));
      return { status: 0 };
    },
  });
  assert.equal(seen.length, 4);
  assert.match(seen[0] ?? '', /^gh release create v0\.1\.0 /);
  assert.match(seen[1] ?? '', /^gh release edit v0\.1\.0 --draft=false --prerelease=false$/);
  assert.match(seen[2] ?? '', /^gh release edit v0\.1\.0 --title /);
  assert.match(seen[3] ?? '', /^gh release upload v0\.1\.0 --clobber /);

  assert.throws(
    () =>
      publishRelease({
        ...ghInput(true),
        run: () => ({ status: 1 }),
      }),
    /publish 失败（退出码 1）/,
    '第一步失败即中止',
  );
});
