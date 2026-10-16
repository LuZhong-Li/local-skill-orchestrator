# M2 跨平台打包设计

| 项目 | 内容 |
|---|---|
| 文档名称 | M2 跨平台打包设计（矩阵、打包配置、图标管线、发布、依赖与冒烟） |
| 文档路径 | `docs/design/m2-packaging.md` |
| 文档状态 | 设计稿（待评审；不含实现，不修改既有定稿与 `docs/reviews/` 快照） |
| 依据 | [`docs/requirements.md`](../requirements.md) 9.3.2（M2-R1 ~ M2-R5）、9.4.2（NFR-M2-01）、9.6（M-R-02 / M-R-05 / M-R-08）、9.7 交付物清单；[`docs/design/m1-ci.md`](m1-ci.md)（步骤集合与门禁口径）；[`docs/plan/m1-ci.md`](../plan/m1-ci.md)（M1 已收官状态） |
| 证据口径 | 沿用第五份契约规范（[`host-registry.spec.md`](../specification/host-registry.spec.md)）的证据分级：一手官方文档记 [已查证]，本机 / 仓库实测记 [已查证·本机实测]，未取证项标 [待确认] 并给出确认方法 |
| 说明 | 本文档只描述设计与可验证标准；工作流 YAML、打包命令与脚本属实现阶段产物，不在本文档出现 |

---

## 1. 前置裁决（已定，作为设计约束）

| # | 裁决点 | 结论 | 设计体现 |
|---|---|---|---|
| 1 | 产物格式 | macOS：`.dmg`（arm64 + x64 两架构，**不做 universal**）；Linux：`.AppImage`（x64）；Windows 现状不动 | 第 4.2 / 4.3 节；矩阵按架构分列（第 3.2 节） |
| 2 | 签名与公证 | M2 产出**未签名包**（无 Apple 开发者证书）；README 明确 macOS Gatekeeper 绕过说明；签名 + 公证留待证书就位后以 CI secrets 接入，**不阻塞 M2** | 第 4.5、7.3 节；开放项 ③（预留设计） |
| 3 | 矩阵触发 | `push` / `PR` 保持现有 Win/Linux 快速 CI，**不扩矩阵**；`release tag`（`v*`）与手动 `workflow_dispatch` 触发全平台矩阵 | 第 3.1、3.3 节 |
| 4 | 产物发布 | tag 触发时上传 GitHub Releases（含校验与版本说明，沿用既有版本号口径） | 第 6 节 |
| 5 | 图标 | 扩展程序化图标管线：生成 `.icns`（macOS iconset）与 512×512 PNG（Linux）；**不引入图形库**（PNG 已有，iconset 用系统 `iconutil` / 脚本拼装） | 第 5 节 |
| 6 | 冒烟 | Linux 用 `xvfb` 做 GUI 冒烟（跑不通则降级为「内核可执行 + 产物结构校验」并登记）；macOS 做产物结构校验 + 内核可执行；**完整 GUI 交互不纳入 CI** | 第 8.2、8.3 节 |

---

## 2. 目标、范围与需求映射

### 2.1 目标

在不改动宿主本体与内核语义的前提下，让三启动方式（开发产物 / 免安装目录 / 便携单文件）之外的**打包与分发链路**在三平台上可重复产出、可验证、可发布：macOS arm64 与 x64 产出 `.dmg`，Linux x64 产出 `.AppImage`，Windows x64 沿用二期结论作为对照基线。

### 2.2 需求映射

| 需求 | 本设计落点 |
|---|---|
| M2-R1 目标平台（macOS arm64 / x64、Linux x64；Windows 不重复验证） | 第 3.2 节矩阵；第 8.1 节验收映射表 |
| M2-R2 三启动方式验证（不适用须登记） | 第 8.2 节步骤表；第 8.4 节登记表（含 CI 与本地口径的归属） |
| M2-R3 内核独立可执行形态的行为验证 | 第 8.2 节「内核可执行」断言组（复用 M1 的缩减冒烟口径，改为从产物内取内核） |
| M2-R4 打包配置差异验证 | 第 4 节（配置增量）＋第 7 节（差异与排错）＋第 8.4 节（差异登记表） |
| M2-R5 验证方式与 M1 的关系（步骤集合复用，不得为单平台维护独立序列） | 第 3.1 节（可复用校验工作流）＋第 3.4 节（依赖关系） |
| 9.4.2 跨平台一致性（允许差异须逐条登记） | 第 8.4 节 |
| 9.7 交付物清单（产物验证报告） | 第 8.5 节 |

### 2.3 边界与排除

1. 不含代码签名、公证与凭据管理（裁决 2）；不含应用商店与包管理器分发；不含自动更新通道（属 M4a）；不含 Linux 非 x64 架构（9.3.2 范围）；
2. 不改内核语义与指令行为：发现的平台缺陷按缺陷处理，不得以打包配置绕过（9.3.2 约束第 4 条）；
3. 不新增内核依赖（内核仍是零界面依赖的单文件可执行形态）；不引入图形库（裁决 5）；
4. 不修改 `docs/reviews/` 既有快照与一期 / 二期定稿内容；步骤集合复用 M1 定义，不为其维护第二套序列。

---

## 3. 矩阵设计

### 3.1 工作流划分与触发

| 工作流 | 触发 | 矩阵 | 状态 |
|---|---|---|---|
| `ci.yml`（现状） | `push` 到 `main` / `release/**` / `hotfix/**`；`PR → main`（打开 / 同步 / 重开）；`workflow_dispatch` | `ubuntu-24.04` + `windows-latest` × Node（取自 `.nvmrc`） | **触发与矩阵不变**（裁决 3）；其「校验 job」改为调用可复用工作流，行为逐条等价 |
| `verify.yml`（**新增·可复用**，`workflow_call`） | 仅被调用 | 同上（内容即现 `ci.yml` 的校验 job：版本守卫 → 依赖安装 → 契约与分层 → 类型检查 → 规范 → 格式 → 测试 → 构建 → 缩减冒烟） | 新增；M2-R5 的「步骤集合唯一」由它承载 |
| `pack.yml`（**新增**） | `push` tag `v*`；`workflow_dispatch`（带 tag / ref 输入） | `macos-15`(arm64) ＋ `macos-15-intel`(x64) ＋ `ubuntu-22.04`(x64) | 新增；按需触发，不进每次提交门禁 |

**为什么用可复用工作流而不是在打包工作流里重抄步骤**：M2-R5 要求「步骤集合必须复用 M1 的步骤定义，不得为单个平台维护独立的步骤序列」。把校验 job 抽为 `verify.yml` 后，`ci.yml`（每次提交门禁）与 `pack.yml`（打包前门禁）消费**同一份定义**；若改为在 `pack.yml` 内重写同一串命令，则形成第二份步骤序列，后续任何步骤变更都要改两处，属设计上应避免的重复。

**为什么不改用 `workflow_run` 串联**：`ci.yml` 不在 tag 上触发，tag 运行不会有对应的 CI 运行可供 `workflow_run` 触发；且 `workflow_run` 会引入跨运行的隐式依赖，失败定位更难（M1 的「10 分钟内定位」口径要求链路显式）。

### 3.2 runner 选型

| 目标平台 | 架构 | 工作流标签 | 规格（官方表） | 选型理由与证据 |
|---|---|---|---|---|
| macOS arm64 | arm64 | `macos-15` | 3 vCPU / 7 GB / 14 GB SSD | 官方标签集为 `macos-latest, macos-14, macos-15, macos-26`（arm64）；显式选 **15** 而非 `-latest`，与 DP-E 同原则（镜像升级应是显式决策）[R-1] |
| macOS x64 | Intel x64 | `macos-15-intel` | 4 vCPU / 14 GB / 14 GB SSD | 官方 x64 标签集为 `macos-15-intel, macos-26-intel`；**`macos-13` 已不在表中**（M2 早期设想需按此更正）[R-1] |
| Linux x64 | x64 | `ubuntu-22.04` | 4 vCPU / 16 GB / 14 GB SSD | 官方标签集为 `ubuntu-latest, ubuntu-24.04, ubuntu-22.04, ubuntu-26.04`；打包基座越旧，AppImage 依赖的 glibc 下界越低、可运行范围越广（第 9 节开放项 ④）[R-1] |
| （对照基线）Windows x64 | x64 | `windows-latest` | — | 沿用 M1 现状与二期结论，不重复验证（M2-R1） |

**额度与排队**：官方说明「标准 GitHub-hosted runner 对公开仓库免费且不限量」[R-1]；因此 macOS 三平台的分钟成本不构成额度风险，M-R-02 的剩余风险是**排队时长**——以「按需触发（tag / dispatch）＋同 ref 取消旧运行」缓解。

### 3.3 触发条件与并发

1. **tag 触发**：`v*` 推送到仓库即触发；tag 与版本一致性由门禁断言（第 6.1 节），不一致即失败，不产出 Release；
2. **手动触发**：`workflow_dispatch` 允许指定 tag 或分支，用于重跑与预演（例如只想验证 arm64 打包）；
3. **并发**：`concurrency` 组按 `ref`（tag 或分支）分组并 `cancel-in-progress: true`，与 M1 同口径——同 ref 只保留最新一次结论；
4. **额度节流**：`push` / `PR` 路径**不触发**打包矩阵（裁决 3），因此日常提交的运行时长与 M1 现状一致。

### 3.4 job 依赖与产物传递

| 顺序 | job | 依赖 | 产出 |
|---|---|---|---|
| 1 | `verify`（复用 `verify.yml`） | — | 门禁结论（无产物）；失败即整体失败，不进入打包 |
| 2 | `pack-macos-arm64` / `pack-macos-x64` / `pack-linux-x64` | `needs: verify`；`strategy.fail-fast: false` | 各平台单一产物（dmg / dmg / AppImage）＋ 每平台产物验证报告 |
| 3 | `release` | `needs: [pack-macos-arm64, pack-macos-x64, pack-linux-x64]`；仅 tag 触发时执行 | `SHA256SUMS.txt` ＋ GitHub Release 资产 |

1. 打包 job 的 `timeout-minutes` 沿用 M1 的硬上限口径（60 分钟）；单次运行墙钟仍受 9.4.1 约束；
2. 三个打包 job 互不依赖（并行），`fail-fast: false` 保证一个平台失败不掩盖其他平台结论（与 M1 同口径）；
3. `release` job 只在**三个打包 job 全绿**且触发源为 tag 时执行；`workflow_dispatch` 预演不发布（以输入开关控制，默认不发布）。

---

## 4. electron-builder 配置增量

### 4.1 现状与组织方式

现状（本机实测）：单一配置文件 `gui/packaging/electron-builder.yml`，含 `appId` / `productName` / `electronVersion`（固定 44.7.2）/ `directories.output = ../build/desktop` / `files`（排除 `node_modules`）/ `electronLanguages`（仅 `zh-CN`、`en-US`）/ `extraResources`（把 `build/kernel` 落到资源目录 `kernel/`）与 `win` / `nsis` / `portable` 段；打包入口为 `npm run pack:win -w @skill-manager/gui`。electron-builder 版本为 **26.15.3**，Electron 为 **44.7.2** [R-8]。

**组织方式（裁决 1 的落点）**：仍用**同一份配置文件**，在 `win` 段之外新增 `mac` 与 `linux` 段，不拆分为多份平台配置。理由：三平台共享 `files` / `extraResources` / `electronLanguages` / `directories` 这些与平台无关的骨架，拆文件会让这三项出现多份副本（M2-R5 同类问题）。

### 4.2 `mac` 段（新增）

| 键 | 取值 | 依据与说明 |
|---|---|---|
| `mac.target` | `dmg` | 裁决 1；官方文档把 dmg 定位为「标准消费者分发形态」[R-3] |
| `mac.category` | `public.app-category.developer-tools` | 官方定义：`category` 对应 Finder「按应用类别排列」所用的应用类别类型（LSApplicationCategoryType）[R-3] |
| `mac.icon` | `packaging/icon.icns` | 与 `win.icon` 显式给路径的做法一致（默认只在 `buildResources` 下按约定名查找）[R-8]；icns 由第 5 节管线在 macOS 上生成 |
| `mac.artifactName` | `${productName}-${version}-${arch}.${ext}` | 两个 macOS 架构必须靠文件名区分；沿用 `win` 段已有模板 [R-8] |
| `mac.minimumSystemVersion` | 待定（开放项 ⑧） | 与 runner 镜像（macOS 15）无强绑定，留待实现期按 Electron 44 的下界声明 |

**架构选择方式**：不写进配置，由打包命令的 CLI 参数给出——官方提供 `--x64` / `--arm64` / `--universal` 三个架构开关 [R-3]；本设计只用前两个（裁决 1 明确不做 universal），使「哪个 job 跑哪个架构」在矩阵层显式可读。

### 4.3 `linux` 段（新增）

| 键 | 取值 | 依据与说明 |
|---|---|---|
| `linux.target` | `AppImage` | 裁决 1 |
| `linux.category` | `Utility` | 官方定义：`category` 为 freedesktop.org 类别，用于生成 `.desktop` 条目 [R-4] |
| `linux.synopsis` | 一句话说明（与 README 首行一致） | 官方：`.desktop` 的单行描述 [R-4] |
| `linux.description` | 较长说明（与 README 简介一致） | 官方：`.desktop` 的详细描述 [R-4] |
| `linux.maintainer` | 取仓库既有提交身份（`skill-manager <3338004299@qq.com>`） | 官方：打包者标识 `Name <email>`；采用仓库既有 git 作者身份，**不新造个人信息**；如需更换由维护者决定（开放项 ⑨）[R-4] [R-8] |
| `linux.icon` | `packaging/icons`（目录） | 官方：可给一个按尺寸命名的 PNG 目录（`NxN.png`），推荐尺寸含 **512**；不给目录时 electron-builder 会尝试从 icns / ico 自动生成，本设计显式给出以避免平台间隐式回退 [R-4] |
| `linux.artifactName` | `${productName}-${version}-${arch}.${ext}` | 与 `win` / `mac` 模板一致，便于 Release 校验脚本统一解析 |

### 4.4 与 `win` 段的关系

1. `win` / `nsis` / `portable` 段**不改动**（裁决 1）；
2. 三平台共用同一份 `files` 排除规则与 `extraResources`（内核可执行文件随包分发，AD-09），因此「内核在哪、谁调用」在三平台一致；
3. 各平台产物统一落到 `build/desktop/`（`directories.output` 不变），CI 上传 artifact 时按「平台-架构」重命名（第 8.4 节）。

### 4.5 未签名口径（裁决 2）

1. 配置里**不出现任何签名相关键**（不设 `identity`、不设 `forceCodeSigning`）；签名身份自动发现以环境变量关闭——官方文档给出 `CSC_IDENTITY_AUTO_DISCOVERY`（默认 `true`，macOS 上会自动从钥匙串选取有效身份；置 `false` 即不自动选取）[R-5]；
2. **不**设 `forceCodeSigning: true`：官方说明该键会把「缺少签名凭据」由静默告警转为构建失败 [R-5]；我们主动选择未签名交付，因此需要的是「未签名不失败 + 产物确实未签名」这两个可验证事实；
3. 可验证断言：打包后对 `.app` 执行 `codesign -dv` 断言输出为「未签名」；该断言使「未签名」成为**被检查的事实**而不是默认结果；
4. 官方文档说明 macOS 上未签名应用会被 Gatekeeper 阻止、需用户在系统设置中放行 [R-5]——对应 README 的绕过说明（第 7.3 节）。

---

## 5. 图标管线

### 5.1 现状

`scripts/build-icon.mjs` 程序化绘制并**自编码** PNG 与 ICO（形状用带符号距离场 + 解析抗锯齿，无任何图形库），产出 `gui/packaging/icon.ico`（16 / 24 / 32 / 48 / 64 / 128 / 256 七档）与 `gui/packaging/icon.png`（256×256）[R-8]。

### 5.2 增量产出

| 产物 | 路径 | 用途 | 生成方式 |
|---|---|---|---|
| Linux 图标目录 | `gui/packaging/icons/256x256.png`、`gui/packaging/icons/512x512.png` | `linux.icon` 指向的目录（官方要求 `NxN.png` 命名，推荐尺寸含 512）[R-4] | 由同一渲染函数**直接按目标尺寸绘制**（不是位图缩放），编码沿用既有最小 PNG 编码器 |
| macOS iconset | `gui/packaging/icon.iconset/` 共 10 个文件 | `iconutil` 的输入 | 同上，逐尺寸直接绘制 |
| macOS 图标 | `gui/packaging/icon.icns` | `mac.icon` | 由系统 `iconutil -c icns` 从 iconset 拼装（裁决 5） |

**iconset 尺寸清单**（`iconutil` 约定的文件名，@2x 为同名 2 倍尺寸）：

| 逻辑尺寸 | 文件名 | 像素 |
|---|---|---|
| 16 | `icon_16x16.png` | 16×16 |
| 16 | `icon_16x16@2x.png` | 32×32 |
| 32 | `icon_32x32.png` | 32×32 |
| 32 | `icon_32x32@2x.png` | 64×64 |
| 128 | `icon_128x128.png` | 128×128 |
| 128 | `icon_128x128@2x.png` | 256×256 |
| 256 | `icon_256x256.png` | 256×256 |
| 256 | `icon_256x256@2x.png` | 512×512 |
| 512 | `icon_512x512.png` | 512×512 |
| 512 | `icon_512x512@2x.png` | 1024×1024 |

### 5.3 构建期调用点与失败口径

| 场景 | 调用 | 说明 |
|---|---|---|
| 任意平台本地构建图标 | `npm run build:icon` | 产出 ico + png + `icons/` + `icon.iconset/`；**幂等**（重复运行结果一致，全部由渲染函数决定） |
| macOS 打包前 | `npm run build:icon` →（新增）`npm run build:icon:icns` → `electron-builder` | `build:icon:icns` 调用系统 `iconutil`；**仅在 macOS 可用**，非 macOS 直接以明确错误退出（不静默跳过，避免产出缺图标的包） |
| Linux 打包前 | `npm run build:icon` → `electron-builder` | 只需 `icons/` 目录 |
| Windows | 现状不变（`icon.ico` 已入库且被 `win.icon` 引用） | 裁决 1「Windows 现状不动」 |

**入库策略（设计决定）**：`icon.ico` 与 `icon.png` 维持现状入库；新增的 `icons/`、`icon.iconset/`、`icon.icns` **不入库**，由构建期脚本生成并在 `.gitignore` 中登记——保持「图标的唯一来源是脚本」这一现有属性（避免二进制产物漂移）；若维护者偏好入库以保证离线可复现，属开放项 ⑦。

**验证标准**：`build:icon` 后断言 `icons/512x512.png` 与 10 个 iconset 文件存在且尺寸正确（PNG 头解析，不依赖图形库）；macOS 上 `iconutil` 退出码为 0 且 `icon.icns` 非空。

---

## 6. 发布流程

### 6.1 tag 与版本口径

1. tag 形如 `v<version>`，`<version>` 取自仓库版本声明（现状 `0.1.0`）；
2. **门禁断言**：tag 名（去掉前缀 `v`）必须等于版本声明；且 `CHANGELOG.md` 中存在对应的版本段（现状只有 `## 未发布`，因此首次发布的**前置动作**是先把 `未发布` 段定版为 `## <version>` 段）。三者不一致即失败，不产出 Release；
3. 该断言实现为一个可本地执行的守卫步骤（与 M1 的版本守卫同构：本地给出提示、流水线以 `--expect` 断言），使「版本口径」成为可失败检查而非人工核对。

### 6.2 Release 生成与产物上传

| 步骤 | 内容 | 依据 |
|---|---|---|
| 收集产物 | `release` job 用官方 `actions/download-artifact` 取回三个打包 job 的产物 | 官方动作；与 M1 已用的 `upload-artifact` 同族 |
| 生成校验 | 在 `release` job 内计算 `SHA256SUMS.txt`（对全部产物逐文件 sha256） | 9.7「产物化」要求：可保存的产物与日志；校验信息随 Release 交付 |
| 生成说明 | 优先取 `CHANGELOG.md` 中该版本段作为 Release 正文（6.1 已断言其存在）；无该段时**不发布** | 裁决 4「沿用既有版本号口径」与「版本说明」 |
| 创建 Release | 用 runner 预装的官方 GitHub CLI（ubuntu-24.04 镜像含 `gh` 2.102.0）创建 Release 并上传资产 | [R-2]；目标 tag；上传 `dmg`×2、`AppImage`×1、`SHA256SUMS.txt` |
| 权限 | 工作流声明 `permissions: contents: write`（仅 `release` job 需要） | 最小权限：打包 job 保持只读 |
| 重跑策略 | 同一 tag 重跑时覆盖同名资产（幂等），不产生第二个 Release | 可验证：重跑后资产集合与 sha256 一致 |

**说明**：`gh release create` 的具体参数（`--verify-tag` / `--notes-file` / 资产覆盖方式）属实现细节，**待 T3 实现期以 GitHub CLI 官方手册核对**并登记（当前只引用「runner 预装 gh」这一已查证事实）[R-2]。

### 6.3 产物清单（每次 tag 发布）

| 平台 | 架构 | 文件 | 备注 |
|---|---|---|---|
| macOS | arm64 | `skill-manager-<version>-arm64.dmg` | 未签名（附绕行说明） |
| macOS | x64 | `skill-manager-<version>-x64.dmg` | 未签名 |
| Linux | x64 | `skill-manager-<version>-x64.AppImage` | 需 FUSE 或 `--appimage-extract-and-run`（第 7.1 节） |
| 全部 | — | `SHA256SUMS.txt` | 校验清单 |

Windows 产物是否随 Release 一并上传见开放项 ⑤（现状：`pack:win` 可产出，但 M2 不重复验证 Windows）。

---

## 7. 系统依赖与排错

### 7.1 Linux

| 事项 | 事实与依据 | 处置 |
|---|---|---|
| AppImage 运行需要 FUSE | 官方：AppImages 依赖 FUSE；**Ubuntu 24.04 起包名改为 `libfuse2t64`** | 运行/冒烟优先使用运行时内置的 `--appimage-extract-and-run`（官方给出的「无 FUSE 环境」办法）；若确有需要再安装 `libfuse2t64` |
| runner 镜像是否自带 FUSE | ubuntu-24.04 镜像清单中**没有** fuse / libfuse 相关包（清单含 `xvfb`）[R-2] | 按上一条走 `--appimage-extract-and-run`；不假设 FUSE 可用 |
| Electron AppImage 的沙箱 | 官方：Electron 版 AppImage 需要内核允许非特权 user namespaces，否则沙箱无法按预期工作，可退化为 `--no-sandbox` | CI 冒烟命令显式加沙箱相关参数并在运行记录中登记（属 **CI 环境差异**，与交付给用户的产物行为区分登记） |
| AppImage 构建期工具链 | electron-builder 自带 `app-builder` 下载与 `appimagetool` 调用 | 若构建期出现 FUSE 相关报错，按「先 `--appimage-extract-and-run`、必要时装 `libfuse2t64`、最终登记为已知项」的顺序处理 |
| 打包基座与 glibc 下界 | 打包基座越新，产物要求的目标机 glibc 越新 | 矩阵选 `ubuntu-22.04`（第 3.2 节）；基座版本属开放项 ④ |

### 7.2 macOS

| 事项 | 事实与依据 | 处置 |
|---|---|---|
| 未签名应用的 Gatekeeper 行为 | 官方：未签名时 Gatekeeper 会阻止应用，用户需自行放行 [R-5] | README 给出绕行说明（`xattr -cr "<app 路径>"` 清除隔离属性，或右键「打开」）；说明属**用户侧操作**，不是绕过安全检查 |
| CI 内产物的可执行性 | CI 构建产物由构建机直接产出，**不带 quarantine 属性** | 产物结构校验可在 CI 内直接执行 `.app` 内的内核可执行文件；这与「用户下载后首次打开被拦」是两件事，分别登记 |
| 签名关闭方式 | 官方环境变量 `CSC_IDENTITY_AUTO_DISCOVERY=false` 关闭身份自动发现 [R-5] | 以环境变量而非配置键表达（规避 electron-builder v26/v27 之间签名键位迁移的差异——官网当前展示的是 v27 文档，其中签名选项已移入 `mac.sign` 组 [R-3]） |
| `iconutil` 可用性 | 系 macOS 自带工具，用于由 iconset 生成 icns | T0（图标管线）在 macOS runner 上实测并登记；不可用时按裁决 5 的备选（脚本自行拼装 icns）处理 |

### 7.3 跨平台与已知项

| 已知项 | 说明 |
|---|---|
| 工具链下载失败（证书） | 本机打包时曾出现 electron-builder 下载工具链的证书验证失败（根证书只在系统存储中），处置方式为 `NODE_OPTIONS=--use-system-ca`；**该事实不写入仓库配置**（会影响其他环境），CI 侧若复现按同一办法处理并登记 [R-7] |
| runner 标签漂移 | 矩阵使用**固定标签**（`macos-15` / `macos-15-intel` / `ubuntu-22.04`），不使用 `-latest`；镜像升级按开放项 ⑥ 显式决策 |
| macOS runner 排队（M-R-02） | 打包矩阵只在 tag / dispatch 触发，不进每次提交门禁；同 ref 取消旧运行 |
| 首启动网络依赖 | 打包与冒烟步骤不访问外网（除依赖下载与工具链下载）；GUI 冒烟沿用既有本地回环口径（M1 已定） |

---

## 8. 冒烟与验收

### 8.1 每平台步骤表（可执行、可验证）

| 阶段 | macOS arm64（`macos-15`） | macOS x64（`macos-15-intel`） | Linux x64（`ubuntu-22.04`） |
|---|---|---|---|
| 前置门禁 | 复用 `verify.yml`（M1 步骤集合，唯一实现） | 同左 | 同左 |
| 图标 | `build:icon` ＋ `build:icon:icns`（`iconutil`） | 同左 | `build:icon` |
| 内核 | `build:kernel`（既有脚本） | 同左 | 同左 |
| 打包 | `electron-builder --mac dmg --arm64` | `electron-builder --mac dmg --x64` | `electron-builder --linux AppImage` |
| 产物结构断言 | dmg 存在；`hdiutil attach` 成功；`.app` 内 `resources/kernel/` 存在；架构断言（`lipo -archs` 或 `file`）＝ arm64；`codesign -dv` 报**未签名** | 同左，架构断言 ＝ x86_64 | AppImage 存在；`--appimage-extract-and-run` 可解包；解包目录含内核 |
| 内核行为断言 | 从产物内取内核可执行文件，运行 `--version` ＋ 最小闭环（`init` → `scan` → `list --json`，沿用 M1 缩减冒烟口径） | 同左 | 同左 |
| GUI 冒烟 | **不纳入 CI**（裁决 6）：登记为本地 / 人工口径 | 同左 | `xvfb-run -a npm run smoke:gui -- --app "<AppImage>"`；跑不通则降级（见 8.3） |
| 产物验证报告 | 生成并随 artifact 上传（体积、断言结果、runner 标识、时间戳） | 同左 | 同左 |

### 8.2 三启动方式在各平台的归属（M2-R2）

| 启动方式 | Windows（基线，二期结论） | macOS | Linux |
|---|---|---|---|
| 开发产物 | 本地已验 | 本地（`npm run dev` ＋ `smoke:gui`） | 本地 |
| 免安装目录 | 已验（`win-unpacked`） | CI：`.app` 内可执行文件直接运行（结构 + 内核断言）；GUI 交互留本地 | CI：解包目录内可执行文件（结构 + 内核断言）；GUI 交互留本地 |
| 便携单文件 | 已验（portable exe） | CI：dmg 挂载后运行（结构断言）；GUI 交互留本地 | CI：AppImage 直接运行（`xvfb` GUI 冒烟，或降级） |

**登记口径**：CI 未覆盖的形态（三平台的完整 GUI 交互）不是「未验证」，而是**归属已登记的本地口径**——依据 M1 已定的边界（完整三模式界面冒烟留本地）与 M-R-08 的处置。

### 8.3 降级口径（裁决 6）

Linux GUI 冒烟失败或超时（示例阈值：单次尝试 10 分钟内未通过）时，按以下顺序处理并**逐条登记**：

1. 先在运行记录中记录失败现象与日志摘要（属兼容性问题登记，不计为未验证）；
2. 降级为「AppImage 解包结构校验 ＋ 内核可执行最小闭环」，在产物验证报告中标记 `gui_smoke: degraded` 并写明原因与后续动作（本地复验 / 排入后续批次）；
3. 不得因降级而把「未验证项」计数弄成非零——降级是**已登记的结论**，未验证项指「既没有结论也没有登记」的项（M2 验收第 5 条）。

### 8.4 平台差异与登记表（M2-R4 / 9.4.2）

| 差异项 | 影响 | 处理方式 |
|---|---|---|
| Windows 专属资源（图标内嵌、版本资源、安装包形态） | 非 Windows 平台无对应物 | macOS 用 `icns`、Linux 用图标目录；版本资源不内嵌（macOS 侧由 `Info.plist` 承载）；登记为允许差异 |
| 路径分隔符与大小写敏感性 | 内核与产物内的路径表达 | 内核侧已用跨平台表达（9.3.6 约束）；macOS 默认大小写不敏感卷上验证同义路径 |
| 换行符 | 索引与备份文本 | 统一 LF（9.4.2）；M5 的 EOL 批次已把仓库侧统一为 LF |
| 可执行权限位 | Linux 下内核可执行文件与 AppImage | 打包后断言可执行位存在（`-x`）；dmg 内的内核由 macOS 安装形态承载，不需要位断言 |
| 启动脚本形态 | `.cmd` 与 shell 脚本 | 现有 Windows 启动脚本保持；非 Windows 平台以可执行文件直接启动（登记为允许差异，不在 M2 引入新启动脚本） |
| 未签名 vs 已签名 | macOS 首次打开拦截 | README 绕行说明；CI 断言「未签名」 |

### 8.5 产物验证报告（9.7）

每次打包 job 产出一份报告（Markdown），字段固定：`平台` / `架构` / `产物名` / `体积` / `sha256` / `结构断言结果` / `内核断言结果` / `GUI 冒烟结果（含降级标记）` / `runner 标识` / `时间戳`。报告与产物一同作为 Actions artifact 上传（保留期沿用 M1 的 14 天口径），并作为里程碑验收的交付物之一；「启动成功率与启停日志」按 9.7 属**人工记录**，在本地复验时补入里程碑交付物。

### 8.6 验收映射（M2 里程碑七条）

| # | 验收标准 | 承载 | 验证方式 |
|---|---|---|---|
| 1 | 三个目标平台各有产物清单与启动结论 | 第 3.4 / 6.3 / 8.1 节 | Release 资产清单 ＋ 三份产物验证报告 |
| 2 | 三启动方式结论逐平台可见，不适用项已登记 | 第 8.2 节 | 归属表（CI / 本地）＋本地复验记录 |
| 3 | 内核在三平台的启动、指令、退出码与输出结构一致 | 第 8.1 节内核断言组 | 三平台同一最小闭环的退出码与结果封装比对 |
| 4 | 平台差异逐条登记且不影响构建成功 | 第 8.4 节 | 差异表 ＋ 三平台构建均成功 |
| 5 | 未验证项为零（无法验证项有显式登记与原因） | 第 8.3 节 + 登记表 | 登记表逐条对应；降级项写明原因 |
| 6 | 每平台三种启动方式最小冒烟 ≥ 95% 断言通过，失败项归类为兼容性问题并登记 | 第 8.1 / 8.3 节 | 断言统计（通过/失败计数）＋兼容性问题列表 |
| 7 | 每平台提交产物验证报告（体积、启动成功率与启停日志） | 第 8.5 节 | 报告文件（自动部分）＋本地人工记录 |

---

## 9. 开放决策点（不实现，登记待定）

| # | 决策点 | 现状 | 影响 |
|---|---|---|---|
| ① | universal binary（单包双架构） | 裁决 1 明确不做（两个 dmg 分开） | 若改为 universal：产物数减半但体积翻倍、构建耗时增加；需重新裁定 |
| ② | `deb` / `rpm` 等 Linux 包格式 | 只做 AppImage | 增加矩阵与依赖（`maintainer` 等元数据要求更严）；按需另立批次 |
| ③ | 签名与公证接入 | 本批次不做 | 预留：secrets 命名、job 条件（tag 且存在 secrets 时才签名）、文档段；证书就位后以独立批次接入，并在 README 移除绕行说明 |
| ④ | Linux 打包基座 | 设计取 `ubuntu-22.04` | 基座与 glibc 下界的取舍；退役或失效时迁 `ubuntu-24.04` 并登记可运行范围变化 |
| ⑤ | Windows 产物是否随 Release 上传 | 未定 | 影响 Release 资产集合与「Windows 现状不动」的边界解释 |
| ⑥ | macOS 镜像升级节奏（`macos-15` → `macos-26`） | 固定 15 | 与 DP-E 同原则：升级须显式决策并重跑验收 |
| ⑦ | 新增图标产物是否入库 | 设计取「不入库，构建期生成」 | 入库可离线复现但引入二进制漂移；不入库要求构建链可跑通 |
| ⑧ | macOS `minimumSystemVersion` | 待定 | 影响可运行系统范围与 Electron 44 的下界声明 |
| ⑨ | `linux.maintainer` 取值 | 取仓库既有提交身份 | 更换为项目邮箱需维护者确认 |
| ⑩ | Release notes 生成方式 | 取 CHANGELOG 版本段 | 若要改用自动生成（`--generate-notes`），需同步登记口径 |

---

## 10. 证据与出处（2026-10-16 浏览器会话取证）

| 编号 | 来源 | 类型 / 证据等级 | 结果 |
|---|---|---|---|
| R-1 | https://docs.github.com/en/actions/reference/runners/github-hosted-runners | 官方文档 [已查证] | runner 标签与规格：macOS arm64 = `macos-latest` / `macos-14` / `macos-15` / `macos-26`；macOS Intel = `macos-15-intel` / `macos-26-intel`；Linux x64 = `ubuntu-latest` / `ubuntu-24.04` / `ubuntu-22.04` / `ubuntu-26.04`；「标准 GitHub-hosted runner 对公开仓库免费且不限量」 |
| R-2 | https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2404-Readme.md | 官方镜像清单 [已查证] | 预装 `xvfb`（2:21.1.12）；**无** fuse / libfuse 相关包；GitHub CLI 2.102.0；Node.js 22.23.3 |
| R-3 | https://www.electron.build/docs/mac/ | 官方文档 [已查证] | `category`（LSApplicationCategoryType）、`icon`、`target`、`artifactName`、`minimumSystemVersion`；架构 CLI 开关 `--x64` / `--arm64` / `--universal`；dmg 定位为标准消费者分发形态；**官网当前展示 v27 文档**，v27 起签名选项移入 `mac.sign` |
| R-4 | https://www.electron.build/docs/linux/ | 官方文档 [已查证] | `linux.target`（含 AppImage）、`category`（freedesktop）、`synopsis` / `description`、`maintainer: "Name <email>"`、`vendor`；图标可给 `NxN.png` 目录，推荐尺寸含 512；未给目录时会尝试从 icns / ico 自动生成 |
| R-5 | https://www.electron.build/docs/features/code-signing/ | 官方文档 [已查证] | `CSC_IDENTITY_AUTO_DISCOVERY`（默认 `true`，置 `false` 关闭身份自动发现）、`CSC_LINK` / `CSC_NAME` / `CSC_KEYCHAIN`；未签名时 macOS 由 Gatekeeper 阻止、需用户放行；`forceCodeSigning: true` 会把缺失凭据由静默告警转为失败 |
| R-6 | https://docs.appimage.org/user-guide/troubleshooting/fuse.html | 官方文档 [已查证] | AppImage 依赖 FUSE；**Ubuntu 24.04 的包名为 `libfuse2t64`**；无 FUSE 时可用 `--appimage-extract-and-run`（官方标注为「无其他办法时才用」） |
| R-7 | https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html ＋ 仓库既有登记 | 官方文档 [已查证] ＋ 本机实测 [已查证·本机实测] | Electron 版 AppImage 需要内核允许非特权 user namespaces，否则沙箱无法按预期工作（可退化为 `--no-sandbox`）；本机 electron-builder 工具链下载需 `NODE_OPTIONS=--use-system-ca`（CHANGELOG 既有条目） |
| R-8 | 仓库现况 | 本机实测 [已查证·本机实测] | electron-builder 26.15.3、Electron 44.7.2；`gui/packaging/electron-builder.yml` 的 `win` / `nsis` / `portable` 段与共享骨架；`scripts/build-icon.mjs` 产出 ico（七档）+ png（256）；`scripts/gui-smoke.mjs` 支持 `--app <产物>`；CI 步骤七执行 `npm run build` |
| R-9 | 官方 `gh` 手册（`gh release create` 参数细节） | **待确认** | 确认方法：T3 实现期读 https://cli.github.com/manual/gh_release_create 并登记（本设计只依赖「runner 预装 gh 2.102.0」这一已查证事实） |
| R-10 | `iconutil` 在 macOS runner 上的可用性 | **待确认** | 确认方法：T0 在 `macos-15` 上执行 `iconutil --help` 与一次 iconset → icns 转换并登记 |

---

## 11. 与 M1 的衔接

1. **步骤集合复用**：打包工作流的前置门禁直接调用 M1 的可复用校验工作流，不复制步骤序列（M2-R5）；
2. **口径继承**：并发取消旧运行、`fail-fast: false`、任务级 60 分钟硬上限、产物命名含平台 / 架构 / 运行标识、失败诊断产物、非 macOS/Linux 的 `-latest` 谨慎使用原则，全部沿用 M1 已定口径；
3. **边界继承**：完整三模式界面冒烟仍留本地（M1-R6 口径），CI 承担可自动化部分并在文档中同时登记归属（M-R-08）；
4. **产物关系**：M1 的两平台内核与桌面构建产物是本设计的对照基线；M2 的 Release 资产是 M4a（自动更新）后续接入的输入，但本批次不设计更新通道。

---

**设计结束**。本文档只描述设计；工作流 YAML、打包命令与脚本属实现阶段产物。
