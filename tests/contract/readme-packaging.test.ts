import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

test('契约：README 登记跨平台产物清单与下载入口', () => {
  for (const token of [
    'Releases',
    'arm64.dmg',
    'x64.dmg',
    'AppImage',
    'portable.exe',
    'SHA256SUMS.txt',
  ]) {
    assert.ok(readme.includes(token), `README 应登记产物或入口：${token}`);
  }
});

test('契约：README 登记 macOS 未签名绕行、Linux 运行前提与自行打包入口', () => {
  for (const token of [
    '未做代码签名与公证',
    '右键点应用',
    'xattr -cr',
    'glibc 下界 2.39',
    'libfuse2t64',
    'appimage-extract-and-run',
    'pack:mac',
    'pack:mac:x64',
    'pack:linux',
    'pack:win',
  ]) {
    assert.ok(readme.includes(token), `README 应写明：${token}`);
  }
});
