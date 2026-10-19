import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UNSIGNED_MARKER,
  assertUnsignedApp,
  classifyCodeSignature,
} from '../../scripts/unsigned-check.mjs';

/** 造一个「看起来像 .app」的路径，供存在性检查通过 */
function fakeApp(): string {
  const dir = makeTempDir('sm-unsigned-');
  const app = join(dir, 'skill-manager.app');
  writeFileSync(app, 'placeholder');
  return app;
}

test('未签名断言：codesign 报「未签名」时通过', () => {
  const app = fakeApp();
  const result = assertUnsignedApp({
    appPath: app,
    platform: 'darwin',
    run: () => ({ status: 1, stdout: '', stderr: `${app}: ${UNSIGNED_MARKER}` }),
  });
  assert.equal(result.kind, 'unsigned');
  assert.equal(result.appPath, app);
  assert.equal(classifyCodeSignature({ status: 1, stderr: `x: ${UNSIGNED_MARKER}` }), 'unsigned');
});

test('未签名断言：产物已签名时失败（判定与输出一并给出）', () => {
  const app = fakeApp();
  assert.equal(
    classifyCodeSignature({
      status: 0,
      stdout: 'Executable=/x/skill-manager\nIdentifier=local.skill-manager.desktop',
    }),
    'signed',
  );
  assert.throws(
    () =>
      assertUnsignedApp({
        appPath: app,
        platform: 'darwin',
        run: () => ({ status: 0, stdout: 'Identifier=local.skill-manager.desktop', stderr: '' }),
      }),
    /应为「未签名或仅 ad-hoc」，实际判定为 signed[\s\S]*Identifier/,
    '已签名必须判失败，且信息里带上 codesign 输出',
  );
});

test('未签名断言：ad-hoc 签名视为通过（Apple Silicon 的平台要求）', () => {
  const adhocOutput = [
    'Executable=/build/desktop/mac-arm64/skill-manager.app/Contents/MacOS/skill-manager',
    'Identifier=local.skill-manager.desktop',
    'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=61+3 location=embedded',
    'Signature=adhoc',
    'TeamIdentifier=not set',
  ].join('\n');

  assert.equal(classifyCodeSignature({ status: 0, stderr: adhocOutput }), 'adhoc');
  const result = assertUnsignedApp({
    appPath: fakeApp(),
    platform: 'darwin',
    run: () => ({ status: 0, stdout: '', stderr: adhocOutput }),
  });
  assert.equal(result.kind, 'adhoc');
});

test('未签名断言：带 Developer ID 的产物仍被拒绝', () => {
  const developerId = [
    'Executable=/Applications/skill-manager.app/Contents/MacOS/skill-manager',
    'Authority=Developer ID Application: Example Corp (ABCDE12345)',
    'TeamIdentifier=ABCDE12345',
  ].join('\n');
  assert.equal(classifyCodeSignature({ status: 0, stderr: developerId }), 'signed');
  assert.throws(
    () =>
      assertUnsignedApp({
        appPath: fakeApp(),
        platform: 'darwin',
        run: () => ({ status: 0, stderr: developerId }),
      }),
    /实际判定为 signed/,
    '带开发者证书的产物不得通过「未签名交付」断言',
  );
});

test('未签名断言：codesign 无输出时按无法确认处理（失败）', () => {
  assert.equal(classifyCodeSignature({ status: 2, stdout: '', stderr: '' }), 'unknown');
  assert.throws(
    () =>
      assertUnsignedApp({
        appPath: fakeApp(),
        platform: 'darwin',
        run: () => ({ status: 2, stdout: '', stderr: '' }),
      }),
    /实际判定为 unknown[\s\S]*无输出/,
    '无法确认必须判失败，不得默认通过',
  );
});

test('未签名断言：非 macOS 平台或产物缺失时先拒绝、不调用 codesign', () => {
  let calls = 0;
  assert.throws(
    () =>
      assertUnsignedApp({
        appPath: '/tmp/x.app',
        platform: 'linux',
        run: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    /仅适用于 macOS/,
  );
  assert.equal(calls, 0, '非 macOS 不得调用 codesign');
  assert.throws(
    () =>
      assertUnsignedApp({
        appPath: join(tmpdir(), 'sm-not-exist-xyz.app'),
        platform: 'darwin',
        run: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    /待断言的产物不存在/,
  );
  assert.equal(calls, 0, '产物缺失时不得调用 codesign');
});
