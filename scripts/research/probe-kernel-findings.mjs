#!/usr/bin/env node
/**
 * M3 内核观察项的**只读探针**（不改内核行为、不写仓库文件）。
 *
 * 用途：为 `docs/research/kernel-findings-m3.md` 的每一条结论提供可复现证据。
 * 做法：在系统临时目录里造最小工作区，用**真实命令行入口**跑 scan / validate / deps，
 * 打印退出码、问题码（含 target）与索引记录，便于与契约原文逐条比对。
 *
 * 用法：`node scripts/research/probe-kernel-findings.mjs`
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { categoryOf } from '../../kernel/store/contract.ts';
import { validateDependencies } from '../../kernel/core/metadata/validate.ts';

const CLI = join(import.meta.dirname, '..', '..', 'kernel', 'entry', 'cli.ts');

/** 以**独立子进程**跑一条指令（与真实用法一致，能拿到 stdout 的 JSON） */
function exec(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const meta = (id, deps = []) =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'status: enabled',
    `path: ./skills/${id}`,
    'source:',
    '  type: local',
    ...(deps.length > 0
      ? ['dependencies:', '  skills:', ...deps.map((dep) => `    - ${dep}`)]
      : []),
    'targets:',
    '  - target: claude',
    '    scope: global',
    `    path: .claude/skills/${id}`,
    '    mode: copy',
    '    enabled: true',
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');

function put(dir, { metaText, skillMd = '# skill\n' } = {}) {
  mkdirSync(dir, { recursive: true });
  if (metaText !== undefined) writeFileSync(join(dir, 'skill_meta.yaml'), metaText);
  if (skillMd !== null) writeFileSync(join(dir, 'SKILL.md'), skillMd);
}

/** 读索引里的记录：id → errors */
function indexErrors(workspace) {
  const text = readFileSync(join(workspace, 'skill_index.yaml'), 'utf8');
  const out = [];
  for (const block of text.split('\n  - id: ').slice(1)) {
    const [idLine] = block.split('\n');
    const id = idLine.trim();
    const errs = /errors:\n((?:\s+- [A-Z0-9-]+\n)+)/.exec(block);
    out.push({
      id,
      errors:
        errs === null
          ? []
          : errs[1]
              .trim()
              .split('\n')
              .map((line) => line.replace(/^\s+- /, '')),
    });
  }
  return out;
}

function section(title) {
  console.log(`\n=== ${title}`);
}

// ---------------------------------------------------------------- 观察项 1：环 + 下游
section('观察项 1：A→B→A 环 + C→A 下游');
{
  const root = mkdtempSync(join(tmpdir(), 'probe-cycle-'));
  try {
    put(join(root, 'skills', 'a'), { metaText: meta('a', ['b']) });
    put(join(root, 'skills', 'b'), { metaText: meta('b', ['a']) });
    put(join(root, 'skills', 'c'), { metaText: meta('c', ['a']) });
    exec(['init', '--workspace', root]);
    const scan = exec(['scan', '--workspace', root]);
    console.log(`scan 退出码=${scan.code}`);
    const codeLines = scan.text
      .split('\n')
      .filter((line) => /\[(错误|警告)\]/.test(line))
      .map((line) => line.trim());
    console.log('scan 报告的问题（按出现顺序）：');
    for (const line of codeLines) console.log(`   ${line}`);
    console.log('索引记录：', JSON.stringify(indexErrors(root)));

    // 连续扫描：若可用性在环上振荡，索引结论会在两次扫描间翻转（同一份磁盘内容）
    const rounds = [indexErrors(root)];
    for (let round = 2; round <= 4; round += 1) {
      exec(['scan', '--workspace', root]);
      rounds.push(indexErrors(root));
    }
    console.log(
      '连续 4 次扫描的索引结论：',
      JSON.stringify(
        rounds.map((records) =>
          records.map((record) => `${record.id}:${record.errors.length === 0 ? 'ok' : 'invalid'}`),
        ),
      ),
    );

    // 机器可读对照：scan 与 validate 对「谁有问题」的结论是否一致
    const brief = (text) =>
      JSON.parse(text)
        .findings.filter((item) => item.severity === 'error')
        .map((item) => `${item.code}@${item.target}`);
    const scanJson = exec(['scan', '--workspace', root, '--json']);
    const validateJson = exec(['validate', '--workspace', root, '--json']);
    console.log('scan(--json) 错误级 findings =', JSON.stringify(brief(scanJson.text)));
    console.log('validate(--json) 错误级 findings =', JSON.stringify(brief(validateJson.text)));

    const validate = exec(['validate', '--workspace', root]);
    console.log(`validate 退出码=${validate.code}`);
    console.log(
      'validate 报告的问题：',
      JSON.stringify(
        validate.text
          .split('\n')
          .filter((line) => /\[(错误|警告)\]/.test(line))
          .map((line) => line.trim()),
        null,
        0,
      ),
    );
    const deps = exec(['deps', 'a', '--workspace', root, '--json']);
    console.log(
      `deps a 退出码=${deps.code}；输出（截断）：${deps.text.slice(0, 300).replace(/\n/g, ' ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 观察项 1b：不动点逐轮状态（复刻 scanWorkspace 的循环）
section('观察项 1b：复刻 scanWorkspace 的不动点循环（3 个候选：a↔b 环 + c→a）');
{
  // 同一份依赖结构，只加一个互不相干的 d：若结论随候选数量翻转，说明结果是「轮数奇偶」而非语义
  for (const extra of [null, 'd']) {
    const metas = [
      { id: 'a', dependencies: { skills: ['b'] } },
      { id: 'b', dependencies: { skills: ['a'] } },
      { id: 'c', dependencies: { skills: ['a'] } },
      ...(extra === null ? [] : [{ id: extra, dependencies: { skills: [] } }]),
    ];
    const dirs = metas.map((meta) => meta.id);
    console.log(`-- 候选数 = ${metas.length}（${extra === null ? '无额外技能' : `+${extra}`}）`);
    simulate(metas, dirs);
  }
}

/** 复刻 scanWorkspace 的不动点循环（与 kernel/core/discovery/index.ts 的 for 循环逐行对应） */
function simulate(metas, dirs) {
  let availability = new Map(dirs.map((dir) => [dir, true]));
  let lastFindings = [];
  const rounds = [];
  for (let round = 0; round <= metas.length; round += 1) {
    lastFindings = validateDependencies(metas, availability);
    const recomputed = new Map();
    for (const dir of dirs) {
      const fromDependencies = lastFindings.some(
        (item) => item.severity === 'error' && (item.target.split('.')[0] ?? '') === dir,
      );
      recomputed.set(dir, !fromDependencies);
    }
    rounds.push({
      round,
      availability: Object.fromEntries(availability),
      findings: lastFindings.map((item) => `${item.code}@${item.target}`),
      recomputed: Object.fromEntries(recomputed),
    });
    const same =
      recomputed.size === availability.size &&
      [...recomputed].every(([key, value]) => availability.get(key) === value);
    if (same) break;
    availability = recomputed;
  }
  for (const entry of rounds) {
    console.log(
      `第 ${entry.round} 轮：availability=${JSON.stringify(entry.availability)} → findings=${JSON.stringify(entry.findings)} → recomputed=${JSON.stringify(entry.recomputed)}`,
    );
  }
  console.log(
    `循环结束时用于写索引的 findings（最后一轮）=${JSON.stringify(lastFindings.map((item) => `${item.code}@${item.target}`))}`,
  );
}

// ---------------------------------------------------------------- 观察项 2：元文件 YAML 损坏
section('观察项 2：技能元文件 YAML 损坏');
{
  const root = mkdtempSync(join(tmpdir(), 'probe-yaml-'));
  try {
    put(join(root, 'skills', 'broken'), { metaText: 'id: broken\n  name: broken\n' });
    put(join(root, 'skills', 'fine'), { metaText: meta('fine') });
    exec(['init', '--workspace', root]);
    const scan = exec(['scan', '--workspace', root]);
    console.log(`scan 退出码=${scan.code}`);
    console.log(
      'scan 错误行：',
      JSON.stringify(
        scan.text
          .split('\n')
          .filter((line) => /\[错误\]/.test(line))
          .map((line) => line.trim()),
      ),
    );
    console.log('E-YAML-001 的类别 =', categoryOf('E-YAML-001'));
    const validate = exec(['validate', '--workspace', root]);
    console.log(`validate 退出码=${validate.code}（专属口径：存在错误级问题 → 1）`);
    const scanJson = exec(['scan', '--workspace', root, '--json']);
    console.log(
      'scan(--json) 的 E-YAML-001 finding 原文 =',
      JSON.stringify(
        JSON.parse(scanJson.text).findings.filter((item) => item.code === 'E-YAML-001'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 观察项 3：目录名 ≠ id
section('观察项 3：目录名 foo / 元文件 id=bar，连扫两次');
{
  const root = mkdtempSync(join(tmpdir(), 'probe-mismatch-'));
  try {
    put(join(root, 'skills', 'foo'), {
      metaText: meta('bar').replace('path: ./skills/bar', 'path: ./skills/foo'),
    });
    exec(['init', '--workspace', root]);
    for (const round of [1, 2, 3]) {
      const scan = exec(['scan', '--workspace', root]);
      const records = indexErrors(root);
      const ids = records.map((record) => record.id);
      const dups = ids.filter((id, index) => ids.indexOf(id) !== index);
      console.log(
        `第 ${round} 次 scan：退出码=${scan.code}；记录数=${records.length}；id=${JSON.stringify(ids)}；重复=${
          dups.length > 0 ? JSON.stringify([...new Set(dups)]) : '无'
        }；errors=${JSON.stringify(records.map((record) => record.errors))}`,
      );
    }
    const validate = exec(['validate', '--workspace', root]);
    console.log(`validate 退出码=${validate.code}`);
    console.log(
      'validate 错误行：',
      JSON.stringify(
        validate.text
          .split('\n')
          .filter((line) => /\[错误\]/.test(line))
          .map((line) => line.trim()),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
