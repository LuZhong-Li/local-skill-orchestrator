#!/usr/bin/env node
/**
 * 构建期强制检查：分层、依赖方向、循环与 allowlist。
 *
 * 规则来源：需求第 10 章 MNT-R2 / MNT-R5；可维护性设计 2.1 节；
 * docs/research/maintainability-audit-2026-10-18.md。
 *
 * 判定原则：
 *   1. 契约层（schemas/ 及后续 contract/）不依赖任何代码层；
 *   2. kernel 主方向 entry → dispatch → core → store；store 不得 import core；
 *   3. 全 kernel/、gui/ 禁止循环依赖（不设 allowlist）；
 *   4. gui 主进程只通过 KernelBridge / CLI 边界调用内核，不 import kernel 内部；
 *      renderer 不直接访问 kernel / Node；preload 只做桥接；
 *   5. scripts 不 import kernel / gui 内部模块，只经公共入口 / 产物交互；
 *   6. P0-a 仅允许 3 条已知违例进入精确 allowlist；任何新违例失败。
 *
 * 本脚本只做静态分析，不修改业务代码；不引入新依赖。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['contract', 'kernel', 'gui', 'scripts'];
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mjs|js|vue)$/;
const GUI_FRAMEWORK_PATTERN =
  /^(electron|electron-vite|electron-builder|electron-updater|@electron\/|tauri|@tauri-apps\/|react|react-dom|preact|vue|@vue\/|svelte|@sveltejs\/|@angular\/)/;
const KERNEL_INTERNAL_PATTERN = /kernel\/(dispatch|core|store|entry)\//;
const INVENTORY_READONLY_FILES = [
  'contract/src/host-inventory.ts',
  'kernel/core/inventory/discover.ts',
  'kernel/dispatch/reconcile/index.ts',
  'kernel/dispatch/reconcile/options.ts',
  'kernel/dispatch/reconcile/plan.ts',
  'kernel/dispatch/scan/aggregate.ts',
  'kernel/dispatch/scan/inventory.ts',
  'kernel/dispatch/scan/reconcile.ts',
  'kernel/dispatch/scan/types.ts',
];
const FS_READONLY_APIS = new Set([
  'existsSync',
  'lstatSync',
  'readFileSync',
  'readdirSync',
  'realpathSync',
  'statSync',
]);
const INVENTORY_WRITE_CALL =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|saveIndex|savePluginIndex|saveHostLandings|withLock|landPlan|runHostLanding|atomicWriteFile|createBackup|setConfig|commitHostLandings)\s*\(/;
const INVENTORY_WRITE_IMPORT =
  /(saveIndex|savePluginIndex|saveHostLandings|withLock|landPlan|runHostLanding|atomicWriteFile|createBackup|setConfig|commitHostLandings)/;

/** 允许的跨区域边；同区域边不在此表检查。 */
const ALLOWED_EDGES = new Set([
  'kernel-store->contract',
  'kernel-core->kernel-store',
  'kernel-core->contract',
  'kernel-dispatch->kernel-core',
  'kernel-dispatch->kernel-store',
  'kernel-dispatch->contract',
  'kernel-entry->kernel-dispatch',
  'kernel-entry->kernel-core',
  'kernel-entry->kernel-store',
  'kernel-entry->contract',
  'kernel-public->kernel-dispatch',
  'kernel-public->kernel-core',
  'kernel-public->kernel-store',
  'kernel-public->contract',
  'gui-main->gui-bridge',
  'gui-main->contract',
  'gui-bridge->contract',
  'gui-preload->contract',
  'gui-renderer->contract',
  'gui-other->contract',
  'scripts->contract',
  'scripts->kernel-public',
]);

/**
 * P0-b 已清除 P0-a 的 3 条违例，allowlist 为空。
 * 未来新增例外必须带精确文件对、方向、原因、owner、expires、clearedBy；
 * 循环依赖永不进入 allowlist。
 */
const BASELINE_ALLOWLIST = [];

function normalizeRel(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function readJson(relativePath, failures) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
  } catch (error) {
    failures.push(`无法读取 ${relativePath}：${error.message}`);
    return null;
  }
}

function collectSourceFiles(relativeDir) {
  const absolute = join(ROOT, relativeDir);
  const collected = [];
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'out', 'dist', 'build'].includes(entry.name)) continue;
      collected.push(...collectSourceFiles(child));
    } else if (SOURCE_FILE_PATTERN.test(entry.name)) {
      collected.push(normalizeRel(child));
    }
  }
  return collected;
}

function importSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(ROOT, dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.vue`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.mjs'),
    join(base, 'index.js'),
    join(base, 'index.vue'),
  ];
  if (base.endsWith('.js')) {
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return normalizeRel(relative(ROOT, candidate));
      }
    } catch {
      // 候选不可读时继续尝试下一个；最终由 unresolved 报告。
    }
  }
  return null;
}

const KERNEL_REGIONS = {
  store: 'kernel-store',
  core: 'kernel-core',
  dispatch: 'kernel-dispatch',
  entry: 'kernel-entry',
};
const GUI_REGIONS = {
  main: 'gui-main',
  bridge: 'gui-bridge',
  preload: 'gui-preload',
  renderer: 'gui-renderer',
};

function classifyRegion(file) {
  const [top, second] = file.split('/');
  if (top === 'contract' || top === 'schemas' || top === 'scripts') return top;
  if (top === 'kernel') {
    return file === 'kernel/index.ts'
      ? 'kernel-public'
      : (KERNEL_REGIONS[second] ?? 'kernel-other');
  }
  if (top !== 'gui') return 'other';
  return GUI_REGIONS[second] ?? 'gui-other';
}

function buildGraph(files) {
  const edges = [];
  const unresolved = [];
  const adjacency = new Map(files.map((file) => [file, []]));
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target === null) {
        if (specifier.startsWith('.')) unresolved.push({ file, specifier });
        continue;
      }
      edges.push({ from: file, to: target, specifier });
      adjacency.get(file).push(target);
      if (!adjacency.has(target)) adjacency.set(target, []);
    }
  }
  return { edges, unresolved, adjacency };
}

function findCycles(adjacency) {
  const color = new Map();
  const stack = [];
  const found = [];
  const seen = new Set();

  function dfs(node) {
    color.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!adjacency.has(next)) continue;
      const state = color.get(next) ?? 0;
      if (state === 0) {
        dfs(next);
      } else if (state === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          found.push(cycle);
        }
      }
    }
    stack.pop();
    color.set(node, 2);
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? 0) === 0) dfs(node);
  }
  return found;
}

function evaluateArchitecture(edges, allowlist = BASELINE_ALLOWLIST) {
  const failures = [];
  const baselineObserved = [];
  const baseline = new Map(allowlist.map((entry) => [`${entry.from} -> ${entry.to}`, entry]));

  for (const edge of edges) {
    const fromRegion = classifyRegion(edge.from);
    const toRegion = classifyRegion(edge.to);
    if (fromRegion === toRegion) continue;
    if (ALLOWED_EDGES.has(`${fromRegion}->${toRegion}`)) continue;
    const key = `${edge.from} -> ${edge.to}`;
    if (baseline.has(key)) {
      baselineObserved.push(key);
      continue;
    }
    failures.push(`[layer] ${edge.from} -> ${edge.to} (${fromRegion} -> ${toRegion})`);
  }

  for (const entry of allowlist) {
    const key = `${entry.from} -> ${entry.to}`;
    if (!baselineObserved.includes(key)) {
      failures.push(
        `[baseline] ${key} 未观察到；确认是否已在 ${entry.clearedBy} 清除并移除 allowlist`,
      );
    }
  }

  return { failures, baselineObserved };
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

function checkWorkspaceDeclarations(failures) {
  const rootManifest = readJson('package.json', failures);
  if (!rootManifest) return;
  const workspaces = rootManifest.workspaces ?? [];
  for (const expected of ['kernel', 'gui', 'contract']) {
    if (!workspaces.includes(expected)) {
      failures.push(`根清单的 workspaces 未声明 ${expected}/`);
    }
  }
}

function checkKernelManifest(failures) {
  const kernelManifest = readJson('kernel/package.json', failures);
  if (!kernelManifest) return;
  const declared = [
    ...Object.keys(kernelManifest.dependencies ?? {}),
    ...Object.keys(kernelManifest.devDependencies ?? {}),
    ...Object.keys(kernelManifest.peerDependencies ?? {}),
  ];
  const offenders = declared.filter((name) => GUI_FRAMEWORK_PATTERN.test(name));
  if (offenders.length) {
    failures.push(`内核包声明了界面框架依赖：${offenders.join('、')}`);
  }
}

function checkGuiImports(failures) {
  for (const file of collectSourceFiles('gui')) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (KERNEL_INTERNAL_PATTERN.test(specifier)) {
        failures.push(`${file} 直接引用了内核内部模块：${specifier}`);
      }
    }
  }
}

function checkKernelReverseImports(failures) {
  for (const file of collectSourceFiles('kernel')) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (/(^|\/)gui\//.test(specifier) || GUI_FRAMEWORK_PATTERN.test(specifier)) {
        failures.push(`${file} 反向引用了界面侧：${specifier}`);
      }
    }
  }
}

function checkWorkspaceFiles(failures) {
  for (const pkg of ['kernel', 'gui', 'contract']) {
    for (const file of ['package.json', 'tsconfig.json']) {
      try {
        statSync(join(ROOT, pkg, file));
      } catch {
        failures.push(`缺少工作区文件：${pkg}/${file}`);
      }
    }
  }
}

function checkInventoryFsImports(file, source, failures) {
  if (/\bimport\s+\*\s+as\s+fs\s+from\s+['"]node:fs/.test(source)) {
    failures.push(`${file} 不得以 namespace fs 形式引入文件系统`);
  }
  if (/from\s+['"]node:fs\/promises['"]/.test(source)) {
    failures.push(`${file} 不得引入 node:fs/promises`);
  }
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"]/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name !== '' && !FS_READONLY_APIS.has(name)) {
        failures.push(`${file} 引入非只读 fs API：${name}`);
      }
    }
  }
}

function checkInventoryWriteCalls(file, source, failures) {
  if (INVENTORY_WRITE_CALL.test(source)) {
    failures.push(`${file} 包含盘点路径禁止的写调用`);
  }
  for (const specifier of importSpecifiers(source)) {
    if (INVENTORY_WRITE_IMPORT.test(specifier)) {
      failures.push(`${file} 引入盘点路径禁止的写模块：${specifier}`);
    }
  }
}

/** 盘点路径的静态只读守卫：只允许只读 fs API，拒绝写调用与写索引/锁/落位导入。 */
export function checkInventoryReadonly(sources) {
  const failures = [];
  for (const [file, source] of Object.entries(sources)) {
    checkInventoryFsImports(file, source, failures);
    checkInventoryWriteCalls(file, source, failures);
  }
  return failures;
}

function checkArchitectureGraph(failures) {
  const files = SCAN_DIRS.flatMap((dir) => collectSourceFiles(dir)).sort();
  const graph = buildGraph(files);
  const architecture = evaluateArchitecture(graph.edges);
  failures.push(...architecture.failures);
  for (const unresolved of graph.unresolved) {
    failures.push(`[import] ${unresolved.file} -> ${unresolved.specifier} 无法解析`);
  }

  const cycles = findCycles(graph.adjacency);
  for (const cycle of cycles) {
    failures.push(`[cycle] ${cycle.join(' -> ')}`);
  }
  return {
    fileCount: files.length,
    edgeCount: graph.edges.length,
    baselineObserved: architecture.baselineObserved,
  };
}

function reportFailures(failures) {
  console.error('分层/架构校验失败：');
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}

function main() {
  const failures = [];
  checkWorkspaceDeclarations(failures);
  checkKernelManifest(failures);
  checkGuiImports(failures);
  checkKernelReverseImports(failures);
  checkWorkspaceFiles(failures);
  const stats = checkArchitectureGraph(failures);
  const inventorySources = {};
  for (const file of INVENTORY_READONLY_FILES) {
    try {
      inventorySources[file] = readFileSync(join(ROOT, file), 'utf8');
    } catch (error) {
      failures.push(`无法读取盘点只读守卫文件 ${file}：${error.message}`);
    }
  }
  failures.push(...checkInventoryReadonly(inventorySources));
  if (failures.length) {
    reportFailures(failures);
  }

  console.log(
    `分层/架构校验通过：${stats.fileCount} 文件，${stats.edgeCount} 条相对 import 边，0 循环，${stats.baselineObserved.length} 条 allowlist。`,
  );
  if (stats.baselineObserved.length > 0) {
    console.log('allowlist：');
    for (const key of stats.baselineObserved) {
      console.log(`  - ${key}`);
    }
  }
}

export {
  BASELINE_ALLOWLIST,
  buildGraph,
  classifyRegion,
  collectSourceFiles,
  evaluateArchitecture,
  findCycles,
  importSpecifiers,
  resolveSpecifier,
};

if (isEntryPoint()) main();
