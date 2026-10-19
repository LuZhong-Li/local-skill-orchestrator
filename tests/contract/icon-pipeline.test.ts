import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICNS_PLATFORM_MESSAGE, assembleIcns, iconutilArgs } from '../../scripts/icon-icns.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 生成物路径（设计 5.3：非入库产物） */
const GENERATED_PATHS = [
  'gui/packaging/icons/512x512.png',
  'gui/packaging/icon.iconset/icon_512x512@2x.png',
  'gui/packaging/icon.icns',
];

test('契约：图标生成物不入库（.gitignore 覆盖生成路径）', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  for (const rule of [
    'gui/packaging/icons/',
    'gui/packaging/icon.iconset/',
    'gui/packaging/icon.icns',
  ]) {
    assert.ok(ignore.includes(rule), `.gitignore 应声明 ${rule}`);
  }

  // 不只比对文本：用 git 自身的忽略判定复核（路径不存在也应命中规则）
  const result = spawnSync('git', ['check-ignore', '-v', ...GENERATED_PATHS], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git check-ignore 应判定三条生成路径被忽略：${String(result.stderr ?? '')}`,
  );
  for (const path of GENERATED_PATHS) {
    assert.ok(String(result.stdout).includes(path), `${path} 应出现在 git 的忽略判定结果中`);
  }
});

test('契约：iconutil 参数拼装与非 macOS 平台准入', () => {
  assert.deepEqual(
    iconutilArgs('/tmp/icon.iconset', '/tmp/icon.icns'),
    ['-c', 'icns', '/tmp/icon.iconset', '-o', '/tmp/icon.icns'],
    'iconutil 参数拼装应为固定形态',
  );
  assert.match(ICNS_PLATFORM_MESSAGE, /macOS/, '拒绝说明须点明仅 macOS 生成');

  // 非 macOS：先于任何检查与写盘抛出，且不得调用外部命令
  let calls = 0;
  assert.throws(
    () =>
      assembleIcns({
        iconsetDir: '/tmp/icon.iconset',
        outPath: '/tmp/icon.icns',
        platform: 'linux',
        run: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    (error: unknown) => error instanceof Error && error.message === ICNS_PLATFORM_MESSAGE,
    '非 macOS 应以明确说明拒绝',
  );
  assert.equal(calls, 0, '非 macOS 不得调用 iconutil');
});

test('契约：iconutil 封装在 macOS 分支按参数调用并校验产出', () => {
  const dir = makeTempDir('sm-icns-');
  const iconsetDir = join(dir, 'icon.iconset');
  mkdirSync(iconsetDir);
  const outPath = join(dir, 'icon.icns');
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = assembleIcns({
    iconsetDir,
    outPath,
    platform: 'darwin',
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      writeFileSync(outPath, 'fake-icns');
      return { status: 0, stderr: '' };
    },
  });
  assert.deepEqual(
    calls,
    [{ command: 'iconutil', args: iconutilArgs(iconsetDir, outPath) }],
    'macOS 分支应以 iconutil 与拼装参数调用一次',
  );
  assert.equal(result.command, 'iconutil');
  assert.equal(result.bytes, 'fake-icns'.length, '返回值应给出产出字节数');

  // iconutil 非零退出 → 明确失败并带 stderr
  assert.throws(
    () =>
      assembleIcns({
        iconsetDir,
        outPath: join(dir, 'x.icns'),
        platform: 'darwin',
        run: () => ({ status: 1, stderr: 'boom' }),
      }),
    /退出码 1[\s\S]*boom/,
    'iconutil 失败应带上退出码与 stderr',
  );

  // iconutil 成功但未产出文件 → 同样视为失败（不得产出缺图标的包）
  assert.throws(
    () =>
      assembleIcns({
        iconsetDir,
        outPath: join(dir, 'y.icns'),
        platform: 'darwin',
        run: () => ({ status: 0, stderr: '' }),
      }),
    /未产出有效的 \.icns/,
    '缺少产出应失败',
  );

  // iconset 缺失 → 给出可执行的下一步
  assert.throws(
    () =>
      assembleIcns({
        iconsetDir: join(dir, 'missing.iconset'),
        outPath: join(dir, 'z.icns'),
        platform: 'darwin',
        run: () => ({ status: 0, stderr: '' }),
      }),
    /npm run build:icon/,
    'iconset 缺失应提示先运行 build:icon',
  );
});

test('契约：icns 命令行入口在非 macOS 明确拒绝且不写盘', () => {
  // macOS 上该入口是正常路径，其真机验证登记在 T2 矩阵首跑（EX-03）；此处覆盖非 macOS 口径
  if (process.platform === 'darwin') return;

  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-icon-icns.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, '非 macOS 应以非零退出码拒绝');
  assert.match(String(result.stderr), /macOS/, '错误信息须说明 icns 仅 macOS 生成');
  assert.equal(
    existsSync(join(root, 'gui', 'packaging', 'icon.icns')),
    false,
    '非 macOS 不得产出 .icns',
  );
});
