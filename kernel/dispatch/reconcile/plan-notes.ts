import type { ReconcileAction } from '@skill-manager/contract';

export function notesOf(action: ReconcileAction): string[] {
  const base = ['reconcile 默认预览；只有 --apply 才执行写入'];
  if (action === 'adopt') {
    return [
      ...base,
      'adopt 导入磁盘实际内容，合成元文件的 source.type 为 unknown',
      '共享副本只建一份中心库，并为全部消费宿主写账本；插件 x- 不支持 adopt',
    ];
  }
  if (action === 'track') {
    return [
      ...base,
      'track 只补宿主账本，不修改工作区或宿主内容',
      '共享根为全部消费宿主补记；插件宿主写 plugin_index',
    ];
  }
  if (action === 'accept') {
    return [
      ...base,
      'accept 覆盖中心库前写入标准备份；source/version 漂移不接受',
      '接受后的本地内容可能在下次 update 时被远端来源覆盖',
    ];
  }
  if (action === 'clean') {
    return [
      ...base,
      'clean 先移入同卷临时快照；仍有 active 消费者时只清理选中账本记录',
      '禁止仅按 --classification 批量 clean；插件副本只写 plugin_index',
    ];
  }
  return [...base, 'repair/forget 处理共享根整组；插件宿主使用独立 plugin_index 账本'];
}
