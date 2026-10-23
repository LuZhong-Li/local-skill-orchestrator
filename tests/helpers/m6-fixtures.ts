import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HostRootRole,
  ReconcileApplyData,
  ReconcilePlanSummary,
  ReconcilePreviewData,
  ReconcileResultItem,
  ReconcileSelection,
} from '@skill-manager/contract';
import { run } from '../../kernel/entry/cli.ts';
import { buildReconcilePreview } from '../../kernel/dispatch/reconcile/plan.ts';
import { executeReconcilePlan } from '../../kernel/dispatch/reconcile/execute.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { inventorySnapshotOf } from '../../kernel/dispatch/scan/inventory.ts';

export async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

export async function initWorkspace(
  root: string,
  hosts: Array<[string, string]> = [],
): Promise<void> {
  const initialized = await capture(['init', '--workspace', root]);
  if (initialized.code !== 0) throw new Error(initialized.out);
  for (const [host, hostRoot] of hosts) {
    const configured = await capture([
      'config',
      'set',
      `host.${host}.root`,
      hostRoot,
      '--workspace',
      root,
    ]);
    if (configured.code !== 0) throw new Error(configured.out);
  }
}

export function writeM6Skill(
  root: string,
  directoryName: string,
  options: {
    name?: string;
    description?: string;
    version?: string;
    metadataVersion?: string;
  } = {},
): string {
  const directory = join(root, directoryName);
  mkdirSync(directory, { recursive: true });
  const fields = [
    `name: ${options.name ?? directoryName}`,
    `description: ${options.description ?? `${directoryName} fixture`}`,
  ];
  if (options.version !== undefined) fields.push(`version: ${options.version}`);
  if (options.metadataVersion !== undefined) {
    fields.push('metadata:', `  version: ${options.metadataVersion}`);
  }
  writeFileSync(join(directory, 'SKILL.md'), `---\n${fields.join('\n')}\n---\n\n# skill\n`);
  return directory;
}

export function bulkSelection(input: {
  roles?: HostRootRole[];
  limit?: number;
  conflict?: ReconcileSelection['conflict'];
  apply?: boolean;
}): ReconcileSelection {
  return {
    mode: 'batch',
    action: 'adopt',
    roots: [],
    apply: input.apply ?? true,
    bulk: true,
    roles: input.roles ?? ['user'],
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
  };
}

export function applyDataOf(plan: ReconcilePreviewData): ReconcileApplyData {
  return {
    mode: plan.mode,
    action: plan.action,
    selection: plan.selection,
    apply_requested: plan.apply_requested,
    applied: false,
    items: plan.items,
    transaction_groups: plan.transaction_groups,
    summary: plan.summary,
    notes: plan.notes,
    results: [],
  };
}

export function executeBulk(
  root: string,
  selection: ReconcileSelection,
): {
  plan: ReconcilePreviewData;
  execution: { results: ReconcileResultItem[]; summary: ReconcilePlanSummary };
} {
  const layout = layoutOf(root);
  const snapshot = inventorySnapshotOf(root);
  const plan = buildReconcilePreview(snapshot, selection);
  if (!selection.apply) return { plan, execution: { results: [], summary: plan.summary } };
  const executed = executeReconcilePlan({
    plan: applyDataOf(plan),
    layout,
    index: snapshot.workspace.index,
    now: '2026-10-23T05:00:00Z',
  });
  return { plan, execution: { results: executed.data.results, summary: executed.data.summary } };
}
