import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACK_ARCHS,
  UNSIGNED_ENV,
  buildPackPlan,
  defaultArchFor,
} from '../../scripts/pack-plan.mjs';

const CONFIG_ARGS = ['--config', 'packaging/electron-builder.yml'];

test('打包计划：mac arm64（宿主 macOS）——图标链含 icns、只打 mac、未签名口径齐备', () => {
  const plan = buildPackPlan({ platform: 'mac', arch: 'arm64', hostPlatform: 'darwin' });

  assert.deepEqual(
    plan.steps.filter((step) => step.kind === 'npm').map((step) => step.script),
    ['build:icon', 'build:icon:icns', 'build'],
    'mac 宿主上应先生成跨平台图标、再拼 icns、再构建界面',
  );
  const builder = plan.steps.at(-1);
  assert.deepEqual(builder.args, [...CONFIG_ARGS, '--mac', '--arm64'], '只打 mac 且架构显式');
  assert.deepEqual(builder.env, UNSIGNED_ENV, 'mac 打包注入未签名环境变量');
  assert.equal(builder.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(plan.icnsSkipped, false);
  assert.equal(plan.unsignedAssertion, true, 'mac 打包后必须断言未签名');
  assert.equal(
    plan.steps.some((step) => (step.args ?? []).includes('--linux')),
    false,
    '不得打包其它平台',
  );
});

test('打包计划：mac x64 使用 --x64 架构开关', () => {
  const plan = buildPackPlan({ platform: 'mac', arch: 'x64', hostPlatform: 'darwin' });
  assert.equal(plan.arch, 'x64');
  assert.deepEqual(plan.steps.at(-1).args, [...CONFIG_ARGS, '--mac', '--x64']);
});

test('打包计划：mac 在非 macOS 宿主上跳过 icns 且不中断', () => {
  const plan = buildPackPlan({ platform: 'mac', arch: 'arm64', hostPlatform: 'win32' });

  assert.equal(plan.icnsSkipped, true);
  assert.match(String(plan.icnsSkipReason), /iconutil|macOS/, '跳过原因须点明 icns 需 macOS');
  assert.equal(
    plan.steps.some((step) => step.script === 'build:icon:icns'),
    false,
    '非 macOS 不执行 icns 步骤',
  );
  assert.equal(
    plan.steps.some((step) => step.script === 'build:icon'),
    true,
    '跨平台图标生成仍应执行',
  );
  assert.equal(plan.steps.at(-1).kind, 'npx', '打包步骤仍存在（跳过 icns 不影响后续）');
});

test('打包计划：linux x64——无 icns、无未签名口径与断言', () => {
  const plan = buildPackPlan({ platform: 'linux', arch: 'x64' });

  assert.deepEqual(
    plan.steps.filter((step) => step.kind === 'npm').map((step) => step.script),
    ['build:icon', 'build'],
  );
  const builder = plan.steps.at(-1);
  assert.deepEqual(builder.args, [...CONFIG_ARGS, '--linux', '--x64']);
  assert.deepEqual(builder.env, {}, 'linux 打包不注入未签名环境变量');
  assert.equal(plan.unsignedAssertion, false, '未签名断言仅用于 macOS 产物');
  assert.equal(plan.icnsSkipped, false);
});

test('打包计划：默认架构按平台惯例，非法平台与架构被明确拒绝', () => {
  assert.equal(defaultArchFor('mac'), 'arm64');
  assert.equal(defaultArchFor('linux'), 'x64');
  assert.deepEqual(PACK_ARCHS.linux, ['x64'], 'linux 只支持 x64');

  assert.throws(() => buildPackPlan({ platform: 'win' }), /不支持的打包平台/, 'win 走既有入口');
  assert.throws(
    () => buildPackPlan({ platform: 'linux', arch: 'arm64' }),
    /不支持架构/,
    'linux arm64 不在 M2 范围内',
  );
});
