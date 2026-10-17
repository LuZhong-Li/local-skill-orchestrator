/** semver 正式版：可带一次 v 前缀与构建元数据，不接受预发布标识。 */
const FORMAL_VERSION =
  /^v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface FormalVersion {
  /** 归一化后的 x.y.z（不含 v 前缀与构建元数据） */
  version: string;
  major: number;
  minor: number;
  patch: number;
}

/** 只接受 semver 正式版；`v1.2.0` 与 `1.2.0` 归一为同一版本。 */
export function normalizeFormalVersion(value: string): FormalVersion | null {
  const match = FORMAL_VERSION.exec(value.trim());
  if (match === null) return null;
  const version = match[1]!;
  return {
    version,
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
}

function compareParsed(left: FormalVersion, right: FormalVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** 比较两个正式版；非法输入直接报错，避免把无法比较的标签静默当成最新。 */
export function compareFormalVersions(left: string, right: string): number {
  const parsedLeft = normalizeFormalVersion(left);
  const parsedRight = normalizeFormalVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    throw new Error(`无法比较非正式 semver：${left} / ${right}`);
  }
  return compareParsed(parsedLeft, parsedRight);
}

export function isNewerFormalVersion(candidate: FormalVersion, baseline: FormalVersion): boolean {
  return compareParsed(candidate, baseline) > 0;
}
