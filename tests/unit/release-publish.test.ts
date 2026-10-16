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

test('发布资产：恰好 5 个交付物（缺失或混入非交付物即失败）', () => {
  const assets = expectedAssets(VERSION);
  assert.equal(assets.length, 5);
  assert.deepEqual(assets, [
    'skill-manager-0.1.0-x64.exe',
    'skill-manager-0.1.0-portable.exe',
    'skill-manager-0.1.0-x64.AppImage',
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
      stageReleaseAssets({ present: [...assets, 'pack-diagnostics-linux.zip'], version: VERSION }),
    /非交付物：pack-diagnostics-linux\.zip/,
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

test('发布：gh 参数拼装——create 与 edit 两分支（含 --clobber 幂等覆盖）', () => {
  const input = {
    tag: 'v0.1.0',
    title: 'v0.1.0',
    notesFile: 'release/RELEASE_NOTES.md',
    assets: expectedAssets(VERSION),
    checksumFile: CHECKSUM_FILE,
  };

  const created = ghArgs({ ...input, exists: false });
  assert.deepEqual(created[0].args.slice(0, 3), ['release', 'create', 'v0.1.0']);
  for (const flag of ['--title', '--notes-file', '--verify-tag', '--latest']) {
    assert.ok(created[0].args.includes(flag), `create 应含 ${flag}`);
  }
  assert.equal(created[0].args.includes('--prerelease'), false, '不打 prerelease 标记');

  const edited = ghArgs({ ...input, exists: true });
  assert.deepEqual(edited[0].args.slice(0, 3), ['release', 'edit', 'v0.1.0']);
  assert.equal(
    edited[0].args.includes('--verify-tag'),
    false,
    'edit 不带 --verify-tag（手册无此参数）',
  );
  assert.deepEqual(edited[1].args.slice(0, 4), ['release', 'upload', 'v0.1.0', '--clobber']);
  assert.deepEqual(edited[1].args.slice(4), [CHECKSUM_FILE, ...expectedAssets(VERSION)]);
});

test('发布：dry-run 只打印命令、不执行任何 gh 调用', () => {
  let calls = 0;
  const result = publishRelease({
    tag: 'v0.1.0',
    title: 'v0.1.0',
    notesFile: 'release/RELEASE_NOTES.md',
    assets: expectedAssets(VERSION),
    checksumFile: CHECKSUM_FILE,
    exists: false,
    dryRun: true,
    run: () => {
      calls += 1;
      return { status: 0 };
    },
  });

  assert.equal(calls, 0, 'dry-run 不得调用 gh');
  assert.equal(result.dryRun, true);
  assert.equal(result.commands.length, 2, 'create + upload 两条命令');
});

test('发布：非 dry-run 按序执行，失败即中止（不静默继续）', () => {
  const seen: string[] = [];
  const okRun = (command: string, args: string[]) => {
    seen.push([command, ...args].join(' '));
    return { status: 0 };
  };
  publishRelease({
    tag: 'v0.1.0',
    title: 'v0.1.0',
    notesFile: 'release/RELEASE_NOTES.md',
    assets: expectedAssets(VERSION),
    checksumFile: CHECKSUM_FILE,
    exists: false,
    run: okRun,
  });
  assert.equal(seen.length, 2);
  assert.match(seen[0] ?? '', /^gh release create v0\.1\.0 /);
  assert.match(seen[1] ?? '', /^gh release upload v0\.1\.0 --clobber /);

  assert.throws(
    () =>
      publishRelease({
        tag: 'v0.1.0',
        title: 'v0.1.0',
        notesFile: 'release/RELEASE_NOTES.md',
        assets: expectedAssets(VERSION),
        checksumFile: CHECKSUM_FILE,
        exists: true,
        run: () => ({ status: 1 }),
      }),
    /edit 失败（退出码 1）/,
  );
});
