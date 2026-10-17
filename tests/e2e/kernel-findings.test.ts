/**
 * 三项内核缺陷修复的**独立进程**端到端断言（2026-10-17 内核核查批次）。
 *
 * 覆盖：环报告形态与收敛稳定性（含「加/不加无关技能结论一致」的奇偶翻转回归）、
 * 技能元文件 YAML 错误的退出码归位（含索引损坏仍为 3 的反向断言）、
 * 目录名 ≠ id 时的物理归属键。全部断言走真实 CLI 子进程（工程约定④）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(
  new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  'kernel',
  'entry',
  'cli.ts',
);

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const meta = (id: string, deps: string[] = []) =>
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

function workspaceOf(skills: Array<{ dir: string; meta: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'kernel-findings-'));
  for (const skill of skills) {
    const dir = join(root, 'skills', skill.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# skill\n');
    writeFileSync(join(dir, 'skill_meta.yaml'), skill.meta);
  }
  return root;
}

/** 读索引里的记录（id → 问题码），并返回记录总数 */
function indexRecords(workspace: string) {
  const text = readFileSync(join(workspace, 'skill_index.yaml'), 'utf8');
  const records = text
    .split('\n  - id: ')
    .slice(1)
    .map((block) => {
      const id = block.split('\n')[0]?.trim() ?? '';
      const errors = /errors:\n((?:\s+- [A-Z0-9-]+\n)+)/.exec(block);
      return {
        id,
        errors:
          errors === null
            ? []
            : errors[1]
                .trim()
                .split('\n')
                .map((line) => line.replace(/^\s*-\s*/, '')),
      };
    });
  return { records, text };
}

const errorFindings = (stdout: string) => {
  const parsed = JSON.parse(stdout) as {
    findings: Array<{ code: string; severity: string; target: string }>;
  };
  return parsed.findings
    .filter((item) => item.severity === 'error')
    .map((item) => `${item.code}@${item.target}`);
};

test('环：每个环成员各一条 E-DEP-003、下游 E-VALIDATION-002，scan 退出码 6 且紧随 validate 无过期告警', () => {
  const root = workspaceOf([
    { dir: 'a', meta: meta('a', ['b']) },
    { dir: 'b', meta: meta('b', ['a']) },
    { dir: 'c', meta: meta('c', ['a']) },
  ]);
  try {
    cli(['init', '--workspace', root]);
    const scan = cli(['scan', '--workspace', root, '--json']);
    assert.equal(scan.code, 6, '环属 DEP 类 → 按派生规则返回 6');
    assert.deepEqual(errorFindings(scan.stdout).sort(), [
      'E-DEP-003@a',
      'E-DEP-003@b',
      'E-VALIDATION-002@c.dependencies',
    ]);

    const { records } = indexRecords(root);
    const byId = new Map(records.map((record) => [record.id, record.errors]));
    assert.deepEqual(byId.get('a'), ['E-DEP-003']);
    assert.deepEqual(byId.get('b'), ['E-DEP-003']);
    assert.deepEqual(byId.get('c'), ['E-VALIDATION-002']);

    const validate = cli(['validate', '--workspace', root, '--json']);
    assert.equal(validate.code, 1, 'validate 走专属口径');
    assert.deepEqual(
      errorFindings(validate.stdout).sort(),
      errorFindings(scan.stdout).sort(),
      'scan 与 validate 归因一致',
    );
    const parsed = JSON.parse(validate.stdout) as { findings: Array<{ code: string }> };
    assert.equal(
      parsed.findings.some((item) => item.code === 'W-INDEX-002'),
      false,
      '刚扫完的结论必须能被紧随的校验确认（不得出现过期告警）',
    );

    // deps 的环结论必须与索引侧逐成员一致（每个环成员都能在 deps 里看到 E-DEP-003）
    for (const member of ['a', 'b']) {
      const deps = cli(['deps', member, '--workspace', root, '--json']);
      const cycleCodes = errorFindings(deps.stdout).filter((item) => item.startsWith('E-DEP-003'));
      assert.equal(cycleCodes.length > 0, true, `deps ${member} 应看到 E-DEP-003（与索引一致）`);
    }
    const outside = cli(['deps', 'c', '--workspace', root, '--json']);
    assert.equal(
      errorFindings(outside.stdout).some((item) => item.startsWith('E-DEP-003')),
      false,
      '环外下游自身不在环上（其结论是 E-VALIDATION-002）',
    );

    for (let round = 2; round <= 3; round += 1) {
      cli(['scan', '--workspace', root]);
      const next = indexRecords(root).records;
      assert.deepEqual(
        next.map((record) => `${record.id}:${record.errors.join(',')}`),
        records.map((record) => `${record.id}:${record.errors.join(',')}`),
        `第 ${round} 次扫描结论必须与首次一致（无振荡）`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('环：同一依赖结构加/不加无关技能，结论完全一致（奇偶翻转回归）', () => {
  const build = (extra: boolean) =>
    workspaceOf([
      { dir: 'a', meta: meta('a', ['b']) },
      { dir: 'b', meta: meta('b', ['a']) },
      { dir: 'c', meta: meta('c', ['a']) },
      ...(extra ? [{ dir: 'd', meta: meta('d') }] : []),
    ]);
  const roots = [build(false), build(true)];
  try {
    const results = roots.map((root) => {
      cli(['init', '--workspace', root]);
      const scan = cli(['scan', '--workspace', root, '--json']);
      return { code: scan.code, findings: errorFindings(scan.stdout).sort() };
    });
    assert.deepEqual(results[1], results[0], '加一个无关技能不得改变归因与退出码');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('元文件 YAML 损坏：scan 与 validate 退出码一致（1），不再落到索引损坏档', () => {
  const root = workspaceOf([
    { dir: 'broken', meta: 'id: broken\n  name: broken\n' },
    { dir: 'fine', meta: meta('fine') },
  ]);
  try {
    cli(['init', '--workspace', root]);
    const scan = cli(['scan', '--workspace', root]);
    const validate = cli(['validate', '--workspace', root]);
    assert.equal(scan.code, 1, '技能元文件 YAML 问题属技能级 → 1');
    assert.equal(validate.code, 1);
    assert.match(scan.stdout, /E-YAML-001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('索引损坏（不是技能元文件）：仍按索引类问题返回 3（反向断言，防过修）', () => {
  const root = workspaceOf([{ dir: 'a', meta: meta('a') }]);
  try {
    cli(['init', '--workspace', root]);
    writeFileSync(join(root, 'skill_index.yaml'), 'schema_version: "1"\n  bad: [unclosed\n');
    const scan = cli(['scan', '--workspace', root]);
    assert.equal(scan.code, 3, '索引文件本身损坏 → 3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录名 ≠ id：任意重扫始终一条记录，逻辑错误照常报告且索引物理唯一', () => {
  const root = workspaceOf([
    { dir: 'foo', meta: meta('bar').replace('path: ./skills/bar', 'path: ./skills/foo') },
  ]);
  try {
    cli(['init', '--workspace', root]);
    for (let round = 1; round <= 3; round += 1) {
      const scan = cli(['scan', '--workspace', root]);
      assert.equal(scan.code, 1, `第 ${round} 次扫描：只剩技能级错误（E-ID-003/E-FIELD-002）→ 1`);
      const { records } = indexRecords(root);
      assert.equal(records.length, 1, `第 ${round} 次扫描后仍是一条记录`);
      assert.equal(records[0].id, 'bar');
      assert.deepEqual([...records[0].errors].sort(), ['E-FIELD-002', 'E-ID-003']);
    }
    const validate = cli(['validate', '--workspace', root]);
    assert.equal(validate.code, 1);
    assert.equal(
      /E-ID-002|E-INDEX-002|E-PATH-001/.test(validate.stdout),
      false,
      '修复后不得出现重复标识 / 悬空记录 / 目录不存在的噪声',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('两个目录使用同一 id：显式报 E-ID-002，记录数仍为 2（物理唯一）', () => {
  const root = workspaceOf([
    { dir: 'one', meta: meta('same').replace('path: ./skills/same', 'path: ./skills/one') },
    { dir: 'two', meta: meta('same').replace('path: ./skills/same', 'path: ./skills/two') },
  ]);
  try {
    cli(['init', '--workspace', root]);
    const scan = cli(['scan', '--workspace', root]);
    const { records } = indexRecords(root);
    assert.equal(records.length, 2, '一目录一条记录（物理唯一）');
    assert.deepEqual(
      records.map((record) => record.id),
      ['same', 'same'],
    );
    for (const record of records)
      assert.ok(record.errors.includes('E-ID-002'), '重复 id 必须显式报告');
    assert.equal(scan.code, 1, 'E-ID-002 属 ID 类 → 1');
    const validate = cli(['validate', '--workspace', root]);
    assert.match(validate.stdout, /E-ID-002/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
