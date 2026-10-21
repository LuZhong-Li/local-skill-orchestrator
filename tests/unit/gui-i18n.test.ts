import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, UpdateSettingsStore } from '../../gui/main/updates/settings.ts';
import en from '../../gui/renderer/src/i18n/locales/en.ts';
import zhCN from '../../gui/renderer/src/i18n/locales/zh-CN.ts';
import { localizedFindingText } from '../../gui/renderer/src/i18n/error-text.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function flatten(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return item !== null && typeof item === 'object' && !Array.isArray(item)
      ? flatten(item as Record<string, unknown>, path)
      : [path];
  });
}

test('T6 i18n：en / zh-CN key 集合完全一致', () => {
  assert.deepEqual(flatten(en).sort(), flatten(zhCN).sort());
  assert.ok(flatten(en).length > 50, '基础资源应覆盖导航、动作、状态、空态与错误');
});

test('T6 i18n：错误码保留，解释按当前语言本地化，原始 message 可诊断', () => {
  const finding = {
    code: 'E-RECONCILE-002',
    severity: 'error' as const,
    source: 'reconcile',
    target: 'alpha',
    message: 'preview is stale',
    remedy: 'rerun preview',
  };
  const english = localizedFindingText(finding, 'en');
  const chinese = localizedFindingText(finding, 'zh-CN');
  assert.match(english, /E-RECONCILE-002/);
  assert.match(english, /preview is stale/);
  assert.notEqual(english, chinese);
  assert.match(chinese, /E-RECONCILE-002/);
});

test('T6 设置：语言跟随系统、手动语言持久化且不丢更新设置', () => {
  let text: string | null = JSON.stringify({
    periodic_check_enabled: true,
    instant_check_enabled: false,
  });
  const writes: string[] = [];
  const store = new UpdateSettingsStore('C:/tmp/settings.json', {
    readText: () => text,
    writeText: (next) => {
      text = next;
      writes.push(next);
    },
  });

  assert.deepEqual(store.read(), {
    periodic_check_enabled: true,
    instant_check_enabled: false,
    language: DEFAULT_APP_SETTINGS.language,
  });
  store.set({
    periodic_check_enabled: true,
    instant_check_enabled: false,
    language: { mode: 'manual', value: 'en' },
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!), {
    periodic_check_enabled: true,
    instant_check_enabled: false,
    language: { mode: 'manual', value: 'en' },
  });
});

test('T6 i18n：renderer 用户可见源码不保留中文字符串字面量', () => {
  const files = [
    ...readdirSync(join(root, 'gui', 'renderer', 'src'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((file) => file.endsWith('.ts') || file.endsWith('.vue'))
      .map((file) => join(root, 'gui', 'renderer', 'src', file)),
  ].filter((file) => !file.includes(`${join('i18n', 'locales')}`));

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\/.*$/gm, '');
    if (/[\p{Script=Han}]/u.test(source)) offenders.push(file.replace(root, ''));
  }
  assert.deepEqual(offenders, []);
});
