/** reconcile 计划中的账本变化：共享根逐宿主展开，clean/forget 读取实际状态。 */
import type {
  ReconcileAction,
  ReconcileLedgerChange,
  ReconcileLedgerState,
  ReconcileSelection,
  ReconciliationLedgerSource,
} from '@skill-manager/contract';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import { collectUnifiedLandings } from '../../core/host-landings/uninstall.ts';
import { loadHostLandings } from '../../store/host-landings/index.ts';
import { loadPluginIndex } from '../../store/plugin-registry/index.ts';
import type { InventorySnapshot } from '../scan/inventory.ts';
import type { Candidate } from './candidates.ts';
import { ledgerHostIds } from './group.ts';

export function ledgerSourceOf(
  candidate: Candidate,
  action: ReconcileAction,
): Exclude<ReconciliationLedgerSource, 'none'> | undefined {
  const existing = candidate.reconciliation.ledger_source;
  if (existing !== 'none') return existing;
  if (action === 'adopt' || action === 'track' || action === 'repair') {
    return candidate.is_plugin ? 'plugin_landings' : 'host_landings';
  }
  return undefined;
}

function ledgerStateOf(candidate: Candidate): ReconcileLedgerState | 'missing' {
  if (candidate.reconciliation.ledger_source === 'none') return 'missing';
  return candidate.reconciliation.classification === 'orphaned' ? 'orphaned' : 'active';
}

function actualLedgerChanges(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  selection: ReconcileSelection,
  action: 'clean' | 'forget',
): ReconcileLedgerChange[] {
  if (candidate.skill_id === undefined) return [];
  const hostIndex = loadHostLandings(snapshot.layout.hostLandingsFile).index;
  const pluginIndex = loadPluginIndex(snapshot.layout.pluginIndexFile).index;
  const physicalKey = inventoryPhysicalKey(candidate.target_path);
  const selected = new Set(ledgerHostIds(candidate, selection));
  return collectUnifiedLandings(hostIndex, pluginIndex, candidate.skill_id)
    .filter(
      (record) =>
        inventoryPhysicalKey(record.physical_path) === physicalKey &&
        selected.has(record.host_id) &&
        (action === 'clean' ? record.state === 'orphaned' : record.state === 'active'),
    )
    .map((record) => ({
      source: record.ledger_source,
      record_key: `${record.host_id}:${candidate.target_path}`,
      from_state: record.state,
      to_state: action === 'clean' ? 'removed' : 'orphaned',
    }));
}

export function ledgerChanges(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  selection: ReconcileSelection,
  action: ReconcileAction,
): ReconcileLedgerChange[] {
  if (action === 'clean' || action === 'forget') {
    const actual = actualLedgerChanges(snapshot, candidate, selection, action);
    if (actual.length > 0) return actual;
  }
  const source = ledgerSourceOf(candidate, action);
  if (source === undefined) return [];
  const next = action === 'clean' ? 'removed' : action === 'forget' ? 'orphaned' : 'active';
  const selected =
    action === 'clean' || action === 'forget'
      ? ledgerHostIds(candidate, selection)
      : ledgerHostIds(candidate);
  return selected.map((hostId) => ({
    source,
    record_key: `${hostId}:${candidate.target_path}`,
    from_state: ledgerStateOf(candidate),
    to_state: next,
  }));
}
