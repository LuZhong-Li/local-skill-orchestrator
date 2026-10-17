import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelBridge } from '../../gui/bridge/commands.ts';
import { checkUpdates } from '../../gui/main/update-check/index.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function snapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else
        result.set(child.replaceAll('\\', '/'), readFileSync(join(root, child)).toString('base64'));
    }
  };
  visit('.');
  return result;
}

test('T1 只读：经 inspect --json 取来源后检查，索引与工作区文件逐字节不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-update-check-'));
  const skillDir = join(root, 'skills', 'remote-review');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# remote review\n');
  writeFileSync(
    join(skillDir, 'skill_meta.yaml'),
    [
      'id: remote-review',
      'name: remote-review',
      'version: 1.2.0',
      'status: enabled',
      'path: ./skills/remote-review',
      'source:',
      '  type: git',
      '  url: https://example.com/remote-review.git',
      '  ref: v1.2.0',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/remote-review',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );

  const bridge = new KernelBridge({
    command: process.execPath,
    entry: ['kernel/entry/cli.ts'],
    workspace: root,
    cwd: REPO,
  });

  try {
    assert.equal((await bridge.init()).ok, true);
    assert.equal((await bridge.scan()).ok, true);
    const before = snapshot(root);
    const indexBefore = readFileSync(join(root, 'skill_index.yaml'));

    const report = await checkUpdates({
      ids: ['remote-review'],
      now: () => '2026-10-17T08:00:00Z',
      inspect: (id) => bridge.inspect(id),
      probe: async () => ({
        ok: true,
        tags: [
          {
            tag: 'v1.2.0',
            commit: '1111111111111111111111111111111111111111',
            peeled: false,
          },
          {
            tag: 'v1.3.0',
            commit: '2222222222222222222222222222222222222222',
            peeled: false,
          },
        ],
      }),
    });

    assert.equal(report.data.items[0]?.state, 'update-available');
    assert.deepEqual(readFileSync(join(root, 'skill_index.yaml')), indexBefore);
    assert.deepEqual(snapshot(root), before, '检查动作不得改动任何工作区文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
