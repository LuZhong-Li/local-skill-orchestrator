/**
 * `linux.maintainer` 是否被 AppImage 形态消费的实测工具（纯逻辑 + 可注入）。
 *
 * 方法：用「仅 maintainer 不同」的两次构建产物（各自解包后的目录）做比对——
 * 若该字符串只在含 maintainer 的那一版出现，说明打包器把它写进了产物；
 * 两版都出现说明命中的是别处的同名文本；两版都不出现则判定为不消费。
 *
 * 真机执行（需要 Linux 与 electron-builder）登记为 T2 矩阵首跑项；本模块只做判定逻辑，
 * 可在任意平台用临时目录单测。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 单次扫描读取的文件数上限（防止误扫巨大目录时失控） */
export const MAX_FILES = 4000;

/** 文本类扩展名：只在这些文件里找 maintainer 字符串 */
const TEXT_EXTENSIONS = [
  '.desktop',
  '.xml',
  '.json',
  '.txt',
  '.md',
  '.yml',
  '.yaml',
  '.cfg',
  '.ini',
];

/**
 * 在目录树中查找 needle，返回命中文件与命中行（最多保留每条 3 行）。
 * 只读文本类文件；二进制文件跳过。
 */
export function findNeedleInTree({ root, needle, maxFiles = MAX_FILES }) {
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    if (scanned >= maxFiles) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (scanned >= maxFiles) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const isText = TEXT_EXTENSIONS.some((extension) => entry.name.endsWith(extension));
      if (!isText) continue;
      scanned += 1;
      const text = readFileSync(path, 'utf8');
      if (!text.includes(needle)) continue;
      hits.push({
        path,
        lines: text
          .split('\n')
          .filter((line) => line.includes(needle))
          .slice(0, 3)
          .map((line) => line.trim()),
      });
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return { hits, scanned };
}

/**
 * 判定 maintainer 是否被消费：
 *   `consumed`     —— 含 maintainer 的产物命中、不含的那版未命中；
 *   `not-consumed` —— 含 maintainer 的产物也没有命中；
 *   `ambiguous`    —— 两版都命中（字符串来自别处，不能据此判定）。
 */
export function maintainerConsumptionVerdict({ withHits, withoutHits }) {
  if (withHits.length === 0) return 'not-consumed';
  if (withoutHits.length > 0) return 'ambiguous';
  return 'consumed';
}

/**
 * 单侧判定（只拿到「含该字段」的那一版产物时使用，T2 矩阵的 Linux leg 属此情形）：
 * 命中即认定该字段被写入产物，未命中即认定未写入。单侧结论比双侧弱——
 * 命中理论上可能来自别处的同名文本，因此命令行会把这一点写在结论旁边，
 * 需要排除干扰时改用 `--without` 做双侧比对。
 */
export function maintainerSingleSideVerdict({ withHits }) {
  return withHits.length > 0 ? 'consumed' : 'not-consumed';
}
