#!/usr/bin/env node
/**
 * P0-c：complexity 与文件规模棘轮。
 *
 * - 不扫描 / 不修改业务代码；只读取 ESLint JSON 与文件文本；
 * - 基线是 scripts/architecture/complexity-baseline.json；
 * - `--write` 重新生成基线（必须显式执行并审阅 diff）；
 * - `npm run check` 调用 check 模式，任何棘轮退化都会失败。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'architecture', 'complexity-baseline.json');
const ESLINT = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const COMPLEXITY_THRESHOLD = 10;
const SIZE_THRESHOLDS = { core: 500, vue: 800, tests: 1000, scripts: 500 };
const SOURCE_FILE = /\.(ts|tsx|mjs|js|vue)$/;

function normalizeRel(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function lineCount(file) {
  return readFileSync(join(ROOT, file), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0).length;
}

function walk(relativeDir, output) {
  const absolute = join(ROOT, relativeDir);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (['node_modules', 'out', 'dist', 'build'].includes(entry.name)) continue;
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) walk(child, output);
    else if (SOURCE_FILE.test(entry.name)) output.push(normalizeRel(child));
  }
}

function categoryOf(file) {
  if (file.startsWith('tests/')) return 'tests';
  if (file.endsWith('.vue')) return 'vue';
  if (file.startsWith('scripts/')) return 'scripts';
  if (file.startsWith('kernel/') || file.startsWith('gui/') || file.startsWith('contract/')) {
    return 'core';
  }
  return null;
}

function coreOwnership(parts) {
  if (parts[2] === 'lifecycle') return { owner: 'lifecycle', clearedBy: 'P1-c' };
  if (parts[2] === 'plugins' && parts[3] === 'manifest.ts') {
    return { owner: 'plugins-manifest', clearedBy: 'P1-d' };
  }
  if (parts[2] === 'adapters' || parts[2] === 'hosts') {
    return { owner: 'host', clearedBy: 'P1-a' };
  }
  return { owner: 'kernel-core', clearedBy: 'P2' };
}

function ownershipOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'kernel') {
    return parts[1] === 'dispatch'
      ? { owner: 'dispatch', clearedBy: 'P1-b' }
      : parts[1] === 'core'
        ? coreOwnership(parts)
        : { owner: 'kernel-core', clearedBy: 'P2' };
  }
  if (parts[0] === 'gui') return { owner: 'gui', clearedBy: 'P2' };
  if (parts[0] === 'scripts') return { owner: 'scripts', clearedBy: 'P2' };
  return { owner: 'tests', clearedBy: 'P2' };
}

function scopeFor(file, line) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
  const start = Math.max(0, line - 80);
  for (let index = line - 1; index >= start; index -= 1) {
    const text = lines[index] ?? '';
    const match =
      /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text) ??
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text) ??
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (match !== null) return match[1] ?? '<module>';
  }
  return '<module>';
}

function signatureFor(file, line) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
  return (lines[line - 1] ?? '<unknown>').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function functionNameOf(message) {
  return (
    /(?:Async function|Function|Async arrow function|Arrow function) '([^']+)'/.exec(
      message,
    )?.[1] ?? '<anonymous>'
  );
}

function identityOf(file, line, message) {
  const name = functionNameOf(message);
  const scope = scopeFor(file, line);
  const signature = signatureFor(file, line);
  const hash = createHash('sha256')
    .update(`${name}\0${scope}\0${signature}`)
    .digest('hex')
    .slice(0, 12);
  return {
    id: `${file}#${name}#${hash}`,
    file,
    function: name,
    scope,
    signature,
  };
}

function collectReport(report, entries, duplicates) {
  const file = normalizeRel(relative(ROOT, report.filePath));
  for (const message of report.messages ?? []) {
    if (message.ruleId !== 'complexity') continue;
    const complexity = Number(/complexity of (\d+)/.exec(message.message)?.[1] ?? 0);
    if (complexity <= COMPLEXITY_THRESHOLD) continue;
    const base = identityOf(file, message.line, message.message);
    const seen = (duplicates.get(base.id) ?? 0) + 1;
    duplicates.set(base.id, seen);
    const id = seen === 1 ? base.id : `${base.id}#${seen}`;
    entries.push({ ...base, id, complexity, ...ownershipOf(file) });
  }
}

function collectComplexity() {
  const result = spawnSync(
    process.execPath,
    [
      ESLINT,
      'kernel',
      'gui',
      'scripts',
      'tests',
      '--rule',
      '{"complexity":["warn",10]}',
      '--format',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // ESLint 在存在 warning 时也可能返回 1；只要拿到可解析的 JSON 就继续。
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    throw new Error(`ESLint complexity 采集失败：${result.stderr || result.stdout}`);
  }
  const entries = [];
  const duplicates = new Map();
  for (const report of reports) collectReport(report, entries, duplicates);
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function collectSizes() {
  const files = [];
  for (const dir of ['kernel', 'gui', 'scripts', 'tests', 'contract']) walk(dir, files);
  const entries = [];
  for (const file of files.sort()) {
    const category = categoryOf(file);
    if (category === null) continue;
    const lines = lineCount(file);
    if (lines <= SIZE_THRESHOLDS[category]) continue;
    entries.push({ file, lines, category, ...ownershipOf(file) });
  }
  return entries;
}

function buildBaseline() {
  return {
    schema_version: '1',
    generated_at: new Date().toISOString(),
    complexity: {
      threshold: COMPLEXITY_THRESHOLD,
      entries: collectComplexity(),
    },
    file_size: {
      thresholds: SIZE_THRESHOLDS,
      entries: collectSizes(),
    },
  };
}

function writeBaseline() {
  const data = buildBaseline();
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `已写入基线：${data.complexity.entries.length} 个复杂函数，${data.file_size.entries.length} 个超阈值文件。`,
  );
}

function readBaseline() {
  if (!existsSync(BASELINE)) {
    throw new Error(`缺少基线：${relative(ROOT, BASELINE)}；先运行 npm run arch:baseline`);
  }
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

function checkComplexity(baseline, failures) {
  const complexity = collectComplexity();
  const baseComplexity = new Map(baseline.complexity.entries.map((entry) => [entry.id, entry]));
  const actualComplexity = new Map(complexity.map((entry) => [entry.id, entry]));
  for (const [id, entry] of actualComplexity) {
    const base = baseComplexity.get(id);
    if (base === undefined) {
      failures.push(`[complexity-new] ${id} = ${String(entry.complexity)}`);
    } else if (entry.complexity > base.complexity) {
      failures.push(
        `[complexity-up] ${id}: ${String(base.complexity)} -> ${String(entry.complexity)}`,
      );
    } else if (entry.complexity < base.complexity) {
      failures.push(
        `[complexity-down] ${id}: ${String(base.complexity)} -> ${String(entry.complexity)}；更新基线`,
      );
    }
  }
  for (const id of baseComplexity.keys()) {
    if (!actualComplexity.has(id)) {
      failures.push(`[complexity-missing] ${id}；函数已拆分/改名，更新基线`);
    }
  }
  return complexity.length;
}

function checkSizes(baseline, failures) {
  const sizes = collectSizes();
  const baseSizes = new Map(baseline.file_size.entries.map((entry) => [entry.file, entry]));
  const actualSizes = new Map(sizes.map((entry) => [entry.file, entry]));
  for (const [file, entry] of actualSizes) {
    const base = baseSizes.get(file);
    if (base === undefined) {
      failures.push(
        `[size-new] ${file}: ${String(entry.lines)} 行 > ${String(entry.category)} 阈值`,
      );
    } else if (entry.lines > base.lines) {
      failures.push(`[size-up] ${file}: ${String(base.lines)} -> ${String(entry.lines)} 行`);
    } else if (entry.lines < base.lines) {
      failures.push(
        `[size-down] ${file}: ${String(base.lines)} -> ${String(entry.lines)} 行；更新基线`,
      );
    }
  }
  for (const file of baseSizes.keys()) {
    if (!actualSizes.has(file)) {
      failures.push(`[size-missing] ${file}；文件已拆分/降到阈值内，更新基线`);
    }
  }
  return sizes.length;
}

function checkThresholds(baseline, failures) {
  if (baseline.complexity.threshold !== COMPLEXITY_THRESHOLD) {
    failures.push(`[baseline] complexity 阈值应为 ${String(COMPLEXITY_THRESHOLD)}`);
  }
  for (const [category, threshold] of Object.entries(SIZE_THRESHOLDS)) {
    if (baseline.file_size.thresholds[category] !== threshold) {
      failures.push(`[baseline] ${category} 文件阈值应为 ${String(threshold)}`);
    }
  }
}

function check() {
  const baseline = readBaseline();
  const failures = [];
  const complexityCount = checkComplexity(baseline, failures);
  const sizeCount = checkSizes(baseline, failures);
  checkThresholds(baseline, failures);
  if (failures.length) {
    console.error('复杂度/规模 ratchet 失败：');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `复杂度/规模 ratchet 通过：${String(complexityCount)} 个复杂函数基线，${String(sizeCount)} 个超阈值文件基线；新代码红线 complexity <= ${String(COMPLEXITY_THRESHOLD)}，文件阈值 ${JSON.stringify(SIZE_THRESHOLDS)}。`,
  );
}

if (process.argv.includes('--write')) writeBaseline();
else check();
