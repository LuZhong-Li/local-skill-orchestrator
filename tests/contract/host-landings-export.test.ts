import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeBackup } from '../helpers/backup.ts';
import { installSkill, restoreSkill } from '../../kernel/core/lifecycle/index.ts';
import { exportIndex } from '../../kernel/core/backup/index.ts';
import { computeChecksum } from '../../kernel/core/integrity/index.ts';
import { createInitialIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { ensureWorkspaceDirs, layoutOf } from '../../kernel/store/workspace/index.ts';
import {
  createInitialHostLandings,
  loadHostLandings,
  saveHostLandings,
} from '../../kernel/store/host-landings/index.ts';
import type { HostLanding } from '../../contract/src/index.ts';

const NOW = '2026-10-18T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function record(root: string): HostLanding {
  return {
    skill_id: 'export-skill',
    host_id: 'doubao',
    target_path: join(root, 'host', 'export-skill'),
    format: 'skill',
    visibility: 'visible',
    state: 'active',
    origin: 'distributed',
    source_checksum: DIGEST,
    content_digest: DIGEST,
    adapter_ref: 'doubao',
    registry_version: '1',
    created_at: NOW,
    updated_at: NOW,
  };
}

test('契约：export 包不包含 host_landings，restore 不恢复账本', async () => {
  const root = makeTempDir('sm-export-ledger-');
  ensureWorkspaceDirs(layoutOf(root));
  const layout = layoutOf(root);
  const source = makeSkillSource('export-skill', { description: '导出边界' });
  const installed = await installSkill({
    layout,
    index: createInitialIndex(NOW),
    sourcePath: source,
    now: NOW,
  });
  saveIndex(layout.indexFile, installed.index);

  const ledger = {
    ...createInitialHostLandings(NOW, '0.3.0'),
    landings: [record(root)],
  };
  saveHostLandings(layout.hostLandingsFile, ledger);
  const ledgerBeforeRestore = readFileSync(layout.hostLandingsFile);

  const exported = exportIndex({
    layout,
    index: installed.index,
    target: 'backups/export-skill.yaml',
    now: NOW,
  });
  assert.deepEqual(exported.findings, []);
  const document = parseYaml(
    readFileSync(join(root, 'backups/export-skill.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal('host_landings' in document, false);
  assert.equal('landings' in document, false);
  assert.equal(readFileSync(layout.hostLandingsFile).equals(ledgerBeforeRestore), true);

  makeBackup(
    root,
    'export-skill',
    join(root, 'skills', 'export-skill'),
    NOW,
    computeChecksum(join(root, 'skills', 'export-skill')),
  );
  const restored = restoreSkill({
    layout,
    index: installed.index,
    id: 'export-skill',
    now: NOW,
  });
  assert.deepEqual(restored.findings, []);
  assert.equal(readFileSync(layout.hostLandingsFile).equals(ledgerBeforeRestore), true);
  assert.equal(loadHostLandings(layout.hostLandingsFile).index?.landings.length, 1);
});
