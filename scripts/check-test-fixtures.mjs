#!/usr/bin/env node
/** P0-d：测试目录直接 mkdtemp 的反回潮检查；唯一允许的 mkdtemp 在 tests/helpers/temp.ts。 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'architecture', 'test-fixture-baseline.json');

function collectTests(relativeDir, output) {
  const absolute = join(ROOT, relativeDir);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) collectTests(child, output);
    else if (entry.name.endsWith('.test.ts')) output.push(child.split(sep).join('/'));
  }
}

function directTempCalls() {
  const files = [];
  collectTests('tests', files);
  return files.filter((file) => /\bmkdtempSync?\s*\(/.test(readFileSync(join(ROOT, file), 'utf8')));
}

if (!existsSync(BASELINE)) {
  console.error(`缺少夹具基线：${relative(ROOT, BASELINE)}`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const files = directTempCalls();
if (files.length > baseline.direct_mkdtemp) {
  console.error('测试夹具反回潮失败：');
  for (const file of files)
    console.error(`  - ${file} 直接使用 mkdtemp；改用 tests/helpers/temp.ts`);
  process.exit(1);
}
if (files.length < baseline.direct_mkdtemp) {
  console.error(
    `测试夹具基线已过期：${String(baseline.direct_mkdtemp)} -> ${String(files.length)}；更新 ${relative(ROOT, BASELINE)}`,
  );
  process.exit(1);
}
console.log(
  `测试夹具反回潮通过：直接 mkdtemp 基线 ${String(baseline.direct_mkdtemp)}，当前 ${String(files.length)}。`,
);
