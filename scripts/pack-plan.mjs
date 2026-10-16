/**
 * 打包步骤规划（纯函数模块，导入无副作用）。
 *
 * 依据 M2 设计 4.x / 5.3 与计划 T1：
 *   一、图标在打包前生成——跨平台 `build:icon` 一律执行；`build:icon:icns` 只在 macOS 上执行，
 *       非 macOS 宿主上**跳过且不报错**（跨平台预览打包不应因缺少 iconutil 而中断）；
 *   二、每个平台只打自己的包（dmg 仅 mac、AppImage 仅 linux），架构由参数显式给出（不做 universal）；
 *   三、未签名交付：mac 打包过程设置 CSC_IDENTITY_AUTO_DISCOVERY=false（环境变量而非配置键，
 *       跨 electron-builder 主版本成立），并在打包后要求「产物未签名」成立。
 *
 * 签名预留（仅文档，不实现）：证书就位后由「secrets 存在才运行」的签名 job 接管，
 * 需要配置的官方 secrets 为 APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD / APPLE_ID /
 * APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID。
 */

/** 可打包平台（Windows 沿用既有 pack:win 入口，不经过本规划） */
export const PACK_PLATFORMS = ['mac', 'linux'];

/** 各平台允许的架构（非 universal） */
export const PACK_ARCHS = {
  mac: ['arm64', 'x64'],
  linux: ['x64'],
};

/** 未签名口径的环境变量（mac 打包步骤注入） */
export const UNSIGNED_ENV = { CSC_IDENTITY_AUTO_DISCOVERY: 'false' };

/** 打包器参数：平台开关与架构开关 */
const PLATFORM_FLAGS = { mac: '--mac', linux: '--linux' };
const ARCH_FLAGS = { arm64: '--arm64', x64: '--x64' };

/** 默认架构：按平台惯例给出（CLI 未指定时使用） */
export function defaultArchFor(platform) {
  return platform === 'linux' ? 'x64' : 'arm64';
}

/**
 * 生成打包计划。
 *
 * @param {{ platform: string, arch?: string, hostPlatform?: NodeJS.Platform }} input
 * @returns {{
 *   platform: string,
 *   arch: string,
 *   steps: Array<Record<string, unknown>>,
 *   icnsSkipped: boolean,
 *   icnsSkipReason?: string,
 *   unsignedAssertion: boolean,
 * }}
 */
export function buildPackPlan({ platform, arch, hostPlatform = process.platform }) {
  if (!PACK_PLATFORMS.includes(platform)) {
    throw new Error(
      `不支持的打包平台：${String(platform)}（允许：${PACK_PLATFORMS.join('、')}；Windows 用既有 pack:win 入口）`,
    );
  }
  const effectiveArch = arch ?? defaultArchFor(platform);
  const allowed = PACK_ARCHS[platform];
  if (!allowed.includes(effectiveArch)) {
    throw new Error(
      `平台 ${platform} 不支持架构 ${String(effectiveArch)}（允许：${allowed.join('、')}）`,
    );
  }

  const steps = [];
  steps.push({ kind: 'npm', script: 'build:icon', note: '跨平台图标生成（幂等）' });

  let icnsSkipped = false;
  let icnsSkipReason;
  if (platform === 'mac') {
    if (hostPlatform === 'darwin') {
      steps.push({ kind: 'npm', script: 'build:icon:icns', note: 'iconutil 拼装 .icns' });
    } else {
      icnsSkipped = true;
      icnsSkipReason = `宿主平台为 ${hostPlatform}：.icns 需 macOS 的 iconutil，已跳过（真机验证登记为 T2 矩阵首跑）`;
    }
  }

  steps.push({ kind: 'npm', script: 'build', workspace: '@skill-manager/gui', note: '界面构建' });
  steps.push({
    kind: 'npx',
    bin: 'electron-builder',
    cwd: 'gui',
    args: [
      '--config',
      'packaging/electron-builder.yml',
      PLATFORM_FLAGS[platform],
      ARCH_FLAGS[effectiveArch],
    ],
    env: platform === 'mac' ? { ...UNSIGNED_ENV } : {},
    note: platform === 'mac' ? 'mac 打包（未签名）' : 'linux 打包',
  });

  return {
    platform,
    arch: effectiveArch,
    steps,
    icnsSkipped,
    ...(icnsSkipReason === undefined ? {} : { icnsSkipReason }),
    unsignedAssertion: platform === 'mac',
  };
}
