import type { UpdateCheckItem, UpdateCheckState } from './types.ts';

export const UPDATE_STATE_LABELS: Record<UpdateCheckState, string> = {
  'update-available': '可更新',
  'up-to-date': '已是最新',
  'not-checkable': '不可检查',
  failed: '检查失败',
};

export interface UpdateItemView {
  label: string;
  primary: string;
  detail: string;
  canUpdate: boolean;
}

/** 四态到可读文案的唯一映射，组件不得自行推导状态。 */
export function updateItemView(item: UpdateCheckItem): UpdateItemView {
  if (item.state === 'update-available') {
    const baseline = item.baseline_version ?? item.provenance.ref ?? '未知基线';
    return {
      label: UPDATE_STATE_LABELS[item.state],
      primary: `${baseline} → ${item.available?.ref ?? '未知目标'}`,
      detail: item.summary,
      canUpdate: true,
    };
  }
  if (item.state === 'up-to-date') {
    return {
      label: UPDATE_STATE_LABELS[item.state],
      primary: '远端没有更高的正式版',
      detail: item.summary,
      canUpdate: false,
    };
  }
  if (item.state === 'not-checkable') {
    return {
      label: UPDATE_STATE_LABELS[item.state],
      primary: item.reason ?? '不可检查',
      detail: item.summary,
      canUpdate: false,
    };
  }
  return {
    label: UPDATE_STATE_LABELS[item.state],
    primary: '检查失败',
    detail: [item.code, item.summary, item.remedy].filter((text) => text !== undefined).join('；'),
    canUpdate: false,
  };
}
