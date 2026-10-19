/** reconcile 的共享组消费宿主与账本记录选择。 */
import type { ReconcileSelection } from '@skill-manager/contract';
import { adapterFor } from '../../core/adapters/index.ts';
import { hostById } from '../../core/hosts/index.ts';
import type { Candidate } from './candidates.ts';
import { unique } from './candidates.ts';

type ConsumerShape = Pick<Candidate, 'is_plugin' | 'host_ids' | 'consumed_by'>;

/** 内置宿主账本只记录有适配器的注册宿主；外部消费者（如 dsh）不立账。 */
export function builtinConsumerIds(candidate: ConsumerShape): string[] {
  return unique([...candidate.host_ids, ...candidate.consumed_by])
    .filter(
      (id) => !id.startsWith('x-') && hostById(id) !== undefined && adapterFor(id) !== undefined,
    )
    .sort();
}

/** 插件账本的消费宿主是 x- 命名空间；不混入内置 host_landings。 */
export function pluginConsumerIds(candidate: ConsumerShape): string[] {
  return unique([...candidate.host_ids, ...candidate.consumed_by])
    .filter((id) => id.startsWith('x-'))
    .sort();
}

export function ledgerHostIds(candidate: ConsumerShape, selection?: ReconcileSelection): string[] {
  const all = candidate.is_plugin ? pluginConsumerIds(candidate) : builtinConsumerIds(candidate);
  if (selection?.host === undefined || selection.host === 'all') return all;
  return all.includes(selection.host) ? [selection.host] : [];
}
