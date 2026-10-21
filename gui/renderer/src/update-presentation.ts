import type { UpdateCheckItem, UpdateCheckState } from './types.ts';
import { t } from './i18n/index.ts';

export function updateStateLabel(state: UpdateCheckState): string {
  if (state === 'update-available') return t('updates.status.available');
  if (state === 'up-to-date') return t('updates.status.upToDate');
  if (state === 'not-checkable') return t('updates.status.notCheckable');
  return t('updates.status.failed');
}

export interface UpdateItemView {
  label: string;
  primary: string;
  detail: string;
  canUpdate: boolean;
}

/** 四态到可读文案的唯一映射，组件不得自行推导状态。 */
export function updateItemView(item: UpdateCheckItem): UpdateItemView {
  if (item.state === 'update-available') {
    const baseline = item.baseline_version ?? item.provenance.ref ?? t('updates.defaultBaseline');
    return {
      label: updateStateLabel(item.state),
      primary: `${baseline} → ${item.available?.ref ?? t('updates.defaultTarget')}`,
      detail: item.summary,
      canUpdate: true,
    };
  }
  if (item.state === 'up-to-date') {
    return {
      label: updateStateLabel(item.state),
      primary: t('updates.upToDateReason'),
      detail: item.summary,
      canUpdate: false,
    };
  }
  if (item.state === 'not-checkable') {
    return {
      label: updateStateLabel(item.state),
      primary: item.reason ?? t('updates.status.notCheckable'),
      detail: item.summary,
      canUpdate: false,
    };
  }
  return {
    label: updateStateLabel(item.state),
    primary: t('updates.checkFailed'),
    detail: [item.code, item.summary, item.remedy].filter((text) => text !== undefined).join(' | '),
    canUpdate: false,
  };
}
