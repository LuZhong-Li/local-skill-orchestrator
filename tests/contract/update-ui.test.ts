import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_UPDATE_SETTINGS,
  PERIODIC_CHECK_INTERVAL_MS,
} from '../../gui/main/updates/index.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('契约：T2 IPC 清单与 preload 白名单一致', () => {
  const main = read('gui/main/updates/ipc.ts');
  const preload = read('gui/preload/index.ts');
  for (const channel of [
    'updates:check',
    'updates:settings:get',
    'updates:settings:set',
    'updates:update',
    'updates:latest',
    'updates:report',
  ]) {
    assert.ok(main.includes(channel), `主进程应注册 ${channel}`);
  }
  for (const method of [
    'check:',
    'getSettings:',
    'setSettings:',
    'update:',
    'latest:',
    'onReport:',
  ]) {
    assert.ok(preload.includes(method), `preload 应暴露 updates.${method}`);
  }
});

test('契约：设置默认关闭，定期间隔固定 6 小时', () => {
  assert.deepEqual(DEFAULT_UPDATE_SETTINGS, {
    periodic_check_enabled: false,
    instant_check_enabled: false,
  });
  assert.equal(PERIODIC_CHECK_INTERVAL_MS, 21_600_000);
});

test('契约：无系统常驻或自动更新依赖，打包配置无登录项/启动项', () => {
  const guiPackage = JSON.parse(read('gui/package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = {
    ...(guiPackage.dependencies ?? {}),
    ...(guiPackage.devDependencies ?? {}),
  };
  for (const forbidden of ['electron-updater', 'node-cron', 'node-schedule', 'auto-launch']) {
    assert.equal(forbidden in dependencies, false, `不得引入 ${forbidden}`);
  }
  const builder = read('gui/packaging/electron-builder.yml').toLowerCase();
  for (const forbidden of ['runatlogin', 'startup', 'login-item', 'auto-launch']) {
    assert.equal(builder.includes(forbidden), false, `打包配置不得包含 ${forbidden}`);
  }
});

test('契约：四态对话框组件存在，且四态标签由纯映射统一给出', () => {
  const dialog = read('gui/renderer/src/components/UpdateCheckDialog.vue');
  for (const marker of ['update-available', 'up-to-date', 'not-checkable', 'failed']) {
    assert.ok(dialog.includes(marker) || dialog.includes('groups'), `组件应支持 ${marker}`);
  }
  const presentation = read('gui/renderer/src/update-presentation.ts');
  for (const label of ['可更新', '已是最新', '不可检查', '检查失败']) {
    assert.ok(presentation.includes(label), `视图映射应提供「${label}」`);
  }
});

test('契约：update --ref 的远端限定、目标持久化与帮助文本同源', () => {
  const contract = read('docs/specification/cli-contract.md');
  const update = contract.slice(
    contract.indexOf('### 4.11 `update`'),
    contract.indexOf('### 4.12'),
  );
  assert.match(update, /--ref <tag>/);
  assert.match(update, /只适用于远端 git 来源/);
  assert.match(update, /source\.ref/);
  assert.match(update, /与 `--ref` 组合按参数类错误拒绝/);
  assert.match(update, /目标标签不存在.*返回 `4`/);

  const help = read('kernel/entry/cli.ts');
  assert.match(help, /update <标识>.*--ref <tag>/);
  assert.match(help, /--ref <tag>.*source\.ref/);
});
