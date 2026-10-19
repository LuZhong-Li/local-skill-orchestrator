import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('契约：M4c-7 三平台探针接入可复用 verify 工作流', () => {
  const workflow = read('.github/workflows/verify.yml');
  const job = workflow.slice(workflow.indexOf('  inventory-probe:'));
  assert.ok(job.length > 0, 'verify.yml 应包含 inventory-probe job');
  for (const runner of ['ubuntu-24.04', 'windows-latest', 'macos-15']) {
    assert.ok(job.includes(runner), `探针矩阵应包含 ${runner}`);
  }
  assert.match(job, /fail-fast: false/);
  assert.match(job, /npm ci/);
  assert.match(job, /npm run probe:inventory/);
  assert.match(workflow, /inventory-probe:[\s\S]*actions\/checkout@v5/);
  const cli = read('kernel/entry/cli.ts');
  assert.match(cli, /process\.exitCode = code/);
  assert.equal(cli.includes('process.exit(code)'), false, '大 JSON 输出必须等待 stdout 排空');
  const releaseSmoke = read('.github/workflows/release-smoke.yml');
  assert.match(releaseSmoke, /SHA256SUMS\.txt/);
  assert.match(releaseSmoke, /gui-smoke\.mjs --app/);
  assert.match(releaseSmoke, /probe-production-kernel\.mjs/);
  assert.match(releaseSmoke, /resources/);
  const releaseVerify = read('.github/workflows/release-verify.yml');
  assert.match(releaseVerify, /gh release download/);
  assert.match(releaseVerify, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(releaseVerify, /macos-15/);
  assert.match(releaseVerify, /codesign -dv/);
  assert.match(releaseVerify, /gui-smoke\.mjs --app/);
  assert.match(releaseVerify, /probe-production-kernel\.mjs/);
});

test('契约：探针覆盖路径展开、发现、四分类、插件 .md 与未初始化', () => {
  const probe = read('scripts/probe-host-inventory.mjs');
  for (const marker of [
    "['claude/user', join(fixture.home, '.claude', 'skills')]",
    "['codex/agents-user', join(fixture.home, '.agents', 'skills')]",
    "['cursor/user-skills', join(fixture.home, '.cursor', 'skills')]",
    "process.platform !== 'win32'",
    'managed_consistent',
    "'drift'",
    "'missing 权威'",
    'classification_groups.untracked',
    '未初始化工作区可运行',
    '未初始化不产生 missing',
    'x- 宿主 rules .md 兼容',
  ]) {
    assert.ok(probe.includes(marker), `探针应覆盖 ${marker}`);
  }
  assert.match(probe, /symlinkSync\(shared, cursorLink, 'dir'\)/);
  assert.match(probe, /x- 宿主 rules \.md 兼容/);
});

test('契约：pending_verification 按机制验证与真实事实精确区分', () => {
  const model = read('kernel/core/hosts/host-root-models.ts');
  const claude = model.slice(model.indexOf('claude: {'), model.indexOf('codex: {'));
  const codex = model.slice(model.indexOf('codex: {'), model.indexOf('cursor: {'));
  const cursor = model.slice(model.indexOf('cursor: {'), model.indexOf('doubao: {'));
  assert.equal(claude.includes('pending_verification'), false, 'Claude 机制根已由 CI 验证');
  assert.equal(cursor.includes('pending_verification'), false, 'Cursor 机制根已由 CI 验证');
  assert.equal(
    codex.match(/pending_verification: true/g)?.length,
    3,
    'Codex 三个事实根仍待真机/官方口径',
  );
});
