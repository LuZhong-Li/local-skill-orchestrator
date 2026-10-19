import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import {
  createInitialHostLandings,
  landingKey,
  loadHostLandings,
  loadHostLandingsForWrite,
  removeHostLanding,
  saveHostLandings,
  syncActiveHostLandings,
  upsertHostLanding,
} from '../../kernel/store/host-landings/index.ts';
import type { HostLanding, HostLandingIndex } from '../../contract/src/index.ts';

const NOW = '2026-10-18T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const TARGET = join(process.cwd(), 'virtual-host', 'alpha');

function landing(overrides: Partial<HostLanding> = {}): HostLanding {
  return {
    skill_id: 'alpha',
    host_id: 'claude',
    target_path: TARGET,
    format: 'skill',
    visibility: 'visible',
    state: 'active',
    origin: 'distributed',
    source_checksum: DIGEST,
    content_digest: DIGEST,
    adapter_ref: 'claude',
    registry_version: '1',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function ledger(landings: HostLanding[] = []): HostLandingIndex {
  return { ...createInitialHostLandings(NOW, '0.3.0'), landings };
}

test('单元：host_landings 原子往返保留未知字段，缺失按空账本', () => {
  const file = join(makeTempDir('sm-host-ledger-'), 'host_landings.yaml');
  assert.deepEqual(loadHostLandings(file), { exists: false, index: null, findings: [] });
  const missing = loadHostLandingsForWrite(file, NOW, '0.3.0');
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.index?.landings, []);

  saveHostLandings(file, {
    ...ledger([landing()]),
    extension: { keep: true },
  });
  const loaded = loadHostLandings(file);
  assert.equal(loaded.index?.landings[0]?.skill_id, 'alpha');
  assert.deepEqual((loaded.index as unknown as { extension: unknown }).extension, { keep: true });
  const parsed = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(parsed['landings'], [
    {
      skill_id: 'alpha',
      host_id: 'claude',
      target_path: TARGET,
      format: 'skill',
      visibility: 'visible',
      state: 'active',
      origin: 'distributed',
      source_checksum: DIGEST,
      content_digest: DIGEST,
      adapter_ref: 'claude',
      registry_version: '1',
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
});

test('单元：host_landings 损坏、主键重复、坏枚举与相对路径均返回 E-LANDING-001', () => {
  const file = join(makeTempDir('sm-host-ledger-'), 'host_landings.yaml');
  writeFileSync(file, 'schema_version: "1"\nlandings: [\n');
  const corrupt = loadHostLandings(file);
  assert.equal(corrupt.index, null);
  assert.ok(corrupt.findings.some((item) => item.code === 'E-LANDING-001'));

  const cases: Array<{ name: string; index: HostLandingIndex }> = [
    { name: '重复主键', index: ledger([landing(), landing()]) },
    {
      name: '坏枚举',
      index: ledger([landing({ visibility: 'enabled' as 'visible' })]),
    },
    {
      name: '相对路径',
      index: ledger([landing({ target_path: 'relative/alpha' })]),
    },
    {
      name: 'rules 禁用',
      index: ledger([landing({ format: 'rules', visibility: 'disabled' })]),
    },
    {
      name: '根属性混入',
      index: ledger([landing({ root_role: 'user' } as Partial<HostLanding>)]),
    },
    {
      name: '时间倒置',
      index: ledger([landing({ updated_at: '2026-10-17T00:00:00Z' })]),
    },
  ];
  for (const item of cases) {
    saveHostLandings(file, item.index);
    const loaded = loadHostLandings(file);
    assert.equal(loaded.index, null, `${item.name} 应被拒绝`);
    assert.ok(
      loaded.findings.some((finding) => finding.code === 'E-LANDING-001'),
      `${item.name} 应返回 E-LANDING-001`,
    );
  }
});

test('单元：host_landings 主键 CRUD 与共享根同步', () => {
  const first = landing();
  const second = landing({ host_id: 'cursor', adapter_ref: 'cursor' });
  const other = landing({
    skill_id: 'beta',
    target_path: join(process.cwd(), 'virtual-host', 'beta'),
  });
  let index = ledger([first, second, other]);

  const updated = upsertHostLanding(index, {
    ...first,
    content_digest: `sha256:${'b'.repeat(64)}`,
    created_at: '2026-10-19T00:00:00Z',
  });
  assert.equal(
    updated.landings.find((item) => item.skill_id === 'alpha' && item.host_id === 'claude')
      ?.created_at,
    NOW,
  );
  assert.equal(
    updated.landings.find((item) => item.skill_id === 'alpha' && item.host_id === 'claude')
      ?.content_digest,
    `sha256:${'b'.repeat(64)}`,
  );

  index = syncActiveHostLandings(index, TARGET, {
    visibility: 'disabled',
    content_digest: `sha256:${'c'.repeat(64)}`,
    updated_at: '2026-10-19T00:00:00Z',
  });
  const shared = index.landings.filter((item) => item.target_path === TARGET);
  assert.deepEqual(
    shared.map((item) => item.visibility),
    ['disabled', 'disabled'],
    '共享根两条活跃记录必须同步',
  );
  assert.equal(index.landings.find((item) => item.skill_id === 'beta')?.visibility, 'visible');
  assert.equal(new Set(shared.map(landingKey)).size, 2);

  const removed = removeHostLanding(index, first);
  assert.equal(
    removed.landings.some((item) => item.skill_id === 'alpha' && item.host_id === 'claude'),
    false,
  );
});
