/**
 * Node 单文件可执行（SEA）的注入参数：**唯一实现**，供构建脚本与测试共用。
 *
 * 依据：Node 官方 single-executable-applications 文档的「每个平台所需的命令」——
 *   - Linux / Windows：`postject <bin> NODE_SEA_BLOB <blob> --sentinel-fuse <fuse>`；
 *   - **macOS 还必须给出 `--macho-segment-name NODE_SEA`**（blob 要注入到 `NODE_SEA` 段内的
 *     `NODE_SEA_BLOB` 节，否则 Node 的 SEA 加载器找不到它）。
 *
 * EX-13（2026-10-17 实测）：漏掉该参数时，注入后的 macOS 二进制**启动即崩溃**
 * （`--version` 退出码 139 = SIGSEGV，arm64 与 x64 都一样）；同一 runner 上裸 node 副本正常、
 * `codesign --verify --deep --strict` 也判定签名有效——即**不是签名/授权问题**，而是注入位置问题。
 * 该缺陷同时解释了「M2 只验过签名可读与架构、从未在 macOS 上执行过内核」为何没被发现。
 *
 * macOS x64 的补充事实（官方文档明示）：SEA 在 CI 上「macOS 只测 arm64；x64 目前不支持并在测试中跳过」，
 * 因此 x64 dmg 内嵌 SEA 内核属**官方未支持形态**，需在验证轮实测其可执行性（登记，不外推）。
 */

/** Node 的单文件可执行注入所用的哨兵值（取自 Node 文档，非本项目自定） */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** 注入资源 / 节名（三个平台一致） */
export const SEA_BLOB_RESOURCE = 'NODE_SEA_BLOB';

/** macOS 专用的 Mach-O 段名（必须与 Node SEA 加载器约定一致） */
export const MACHO_SEGMENT_NAME = 'NODE_SEA';

/**
 * 组装 postject 参数（纯函数）。
 *
 * `platform` 可注入以便单测；默认取当前平台。**只有 darwin 才加段名参数**——
 * 这是官方口径，其它平台加上反而可能被 postject 拒绝。
 */
export function postjectArgs({ executable, blob, platform = process.platform }) {
  const args = [executable, SEA_BLOB_RESOURCE, blob, '--sentinel-fuse', SEA_FUSE];
  if (platform === 'darwin') args.push('--macho-segment-name', MACHO_SEGMENT_NAME);
  return args;
}
