import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONFIG_PATH = 'gui/packaging/electron-builder.yml';
const raw = readFileSync(join(root, CONFIG_PATH), 'utf8');
const config = parseYaml(raw) as Record<string, Record<string, unknown>>;

test('契约：mac 段——dmg 目标、图标与类别就位，且不写任何签名配置', () => {
  assert.deepEqual(config.mac.target, ['dmg'], 'mac 目标为 dmg（两架构由 CLI 参数分列）');
  assert.equal(config.mac.icon, 'packaging/icon.icns', '图标指向构建期生成的 icns');
  assert.match(String(config.mac.category), /^public\.app-category\./, '类别用 macOS 约定的取值');
  assert.match(String(config.mac.artifactName), /\$\{arch\}/, '产物名须含架构以区分两个 dmg');

  for (const key of ['identity', 'forceCodeSigning', 'hardenedRuntime', 'notarize', 'sign']) {
    assert.equal(key in config.mac, false, `mac 段不得出现签名相关键：${key}`);
  }
  assert.equal('identity' in config, false, '顶层也不得出现签名键');
  assert.equal('minimumSystemVersion' in config.mac, false, '最低系统版本仍是开放项，不预设');
});

test('契约：linux 段——AppImage 目标、图标目录与打包者标识就位', () => {
  assert.deepEqual(config.linux.target, ['AppImage']);
  assert.equal(config.linux.icon, 'packaging/icons', '图标指向 NxN.png 目录');
  assert.equal(typeof config.linux.category, 'string');
  assert.notEqual(String(config.linux.category).trim(), '');
  assert.match(String(config.linux.synopsis), /\S/, 'synopsis 用于 desktop 条目单行描述');
  assert.match(String(config.linux.description), /\S/);
  assert.match(
    String(config.linux.maintainer),
    /^.+ <.+@.+>$/,
    'maintainer 须为「名称 <邮箱>」形态（沿用仓库既有提交身份）',
  );
  assert.match(String(config.linux.artifactName), /\$\{arch\}/);
});

test('契约：win 段与共享骨架未被本次增量改动', () => {
  assert.deepEqual(config.win.target, ['nsis', 'portable'], 'Windows 两形态沿用二期口径');
  assert.equal(config.win.icon, 'packaging/icon.ico');
  assert.match(String(config.portable.artifactName), /portable/, '便携产物命名不变');
  assert.equal(config.directories.output, '../build/desktop');
  assert.equal(Array.isArray(config.extraResources), true, '内核随包分发的路径声明不变');
  assert.equal(String(config.electronVersion), '44.7.2', '打包器版本仍固定');
});

test('契约：三平台段同层组织，共享骨架不在平台段内重复', () => {
  for (const platform of ['win', 'mac', 'linux']) {
    assert.equal(typeof config[platform], 'object', `缺少平台段：${platform}`);
  }
  for (const shared of ['files', 'extraResources', 'electronLanguages', 'directories']) {
    assert.equal(typeof config[shared], 'object', `${shared} 应为共享字段`);
  }
  for (const platform of ['win', 'mac', 'linux']) {
    for (const shared of ['files', 'extraResources', 'electronLanguages']) {
      assert.equal(
        shared in config[platform],
        false,
        `${platform} 段不得重复定义共享字段 ${shared}`,
      );
    }
  }
});

test('契约：签名预留已文档化（五个官方 secrets 名与未签名环境变量在配置注释中）', () => {
  for (const secret of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]) {
    assert.ok(raw.includes(secret), `配置注释应登记 secret：${secret}`);
  }
  assert.match(raw, /CSC_IDENTITY_AUTO_DISCOVERY/, '未签名口径须写明由环境变量表达');
});
