/**
 * K-01 元数据模型服务：目标落位根约定。
 *
 * 受控副本的位置必须能由「工作区根 + 目标标识 + Skill 标识」直接推导，**不依赖中心库原件是否存在**：
 * 原件缺失时，卸载仍要能按约定找到并回收副本。因此副本位置不交由元文件自由指定，
 * 而是由本文件给出的约定唯一决定；元文件里的 `path` 必须与该约定一致，否则按字段取值问题拒绝。
 *
 * 约定的形态：落位根 = `.<目标标识>/skills`，副本目录 = `<落位根>/<Skill 标识>`。
 * 该形态与宿主真实的技能目录布局一致（例如 claude 读取 `.claude/skills/`），
 * 因此没有引入任何平行的新目录。
 */

/** 目标落位根：相对工作区根目录 */
export function targetRootOf(target: string): string {
  return `.${target}/skills`;
}

/** 某 Skill 在某目标下的副本目录：相对工作区根目录 */
export function copyPathOf(target: string, id: string): string {
  return `${targetRootOf(target)}/${id}`;
}

/** 判断一个声明路径是否等于约定路径 */
export function matchesConvention(declared: unknown, target: string, id: string): boolean {
  if (typeof declared !== 'string') return false;
  const normalized = declared.replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === copyPathOf(target, id);
}
