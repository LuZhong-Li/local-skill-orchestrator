# 变更记录

## 0.1.0

首个公开版本：Skill 元信息管理器的核心功能与三平台分发链路就绪。

### 功能概览

- **指令面**：契约清单的 16 条指令全部实现（环境与配置、登记与查询、生命周期、校验与依赖、备份导出导入与恢复），并提供 `--host <宿主>` 宿主分发入口（与一期 `--target` 语义正交）。
- **契约面**：五份规范文档与五份 JSON Schema（元数据、索引格式、指令契约、结果与退出码、宿主注册表），字段一致性由契约测试守住。
- **内核**：TypeScript，零界面依赖，编译为独立可执行文件随应用分发；宿主适配层含注册表、渲染层与适配器三层。
- **桌面外壳**：Electron + Vue 3，覆盖仪表盘、详情、安装、校验报告与确认流程。
- **工程链路**：GitHub Actions 门禁（Windows / Linux × 声明 Node 版本，`verify.yml` 为唯一实现）＋ 三平台打包矩阵（Windows nsis 与便携版、Linux AppImage、macOS dmg ×2）＋ `SHA256SUMS.txt` 校验清单。

### 平台与安装说明

| 平台        | 产物                                                                                           | 说明                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Windows x64 | `skill-manager-0.1.0-x64.exe`（nsis 安装包）、`skill-manager-0.1.0-portable.exe`（便携单文件） | 双击安装或直接运行                                                                                  |
| macOS arm64 | `skill-manager-0.1.0-arm64.dmg`                                                                | 打开 dmg 拖入「应用程序」                                                                           |
| macOS x64   | `skill-manager-0.1.0-x64.dmg`                                                                  | 同上（Intel 机器）                                                                                  |
| Linux x64   | `skill-manager-0.1.0-x86_64.AppImage`                                                          | 赋可执行位后直接运行；需 FUSE（Ubuntu 24.04 起包名 `libfuse2t64`），或 `--appimage-extract-and-run` |
| 全部        | `SHA256SUMS.txt`                                                                               | `sha256sum -c` 或 `shasum -a 256` 校验                                                              |

- **未签名交付**：macOS 与 Linux 产物**不携带开发者身份证书、不做公证**。macOS 首次打开会被 Gatekeeper 拦下（预期行为）：右键点应用 → 打开，或 `xattr -cr "/Applications/skill-manager.app"`。Apple Silicon 的产物按平台要求保留 ad-hoc 签名（x64 为完全未签名）。
- **glibc 下界**：Linux 产物以 ubuntu-24.04 为打包基座，要求目标机 glibc ≥ **2.39**；更老的发行版请从源码使用（内核只需 Node ≥ 22）。

### 已知限制

- 代码签名与公证尚未接入（证书就位后由预留的签名 job 接管，涉及 `APPLE_CERTIFICATE` 等五个 secrets）。
- Cursor 宿主的标准外字段接受度仍待实测，其渲染保持保守裁剪（不透明传）。
- `AGENTS.md` 合并策略未定稿：`agents-md` 只产出待合并片段、不落盘。
- macOS 完整 GUI 交互冒烟不在 CI 口径内，按设计留在本地执行。

### 变更明细（工程批次）

#### M2-T3 发布机制（版本守卫、资产归位与校验清单、gh 幂等发布）

- **版本守卫**（`scripts/release-guard.mjs`）：tag 号 = CHANGELOG 顶部版本段 = 根与 gui 的 `package.json` 版本，三方一致才发布；同时把该版本段写成 Release notes。**严格自测**：临时 tag `v0.1.0-t3run1` 的矩阵四 leg 全绿后，release job 因守卫中止并公开列出三处不一致，**未创建任何 Release**。
- **资产归位与校验清单**（`scripts/release-publish.mjs`）：交付目录必须恰好含 5 个产物，生成 `SHA256SUMS.txt`。自测即抓出真实差异：Linux 产物实名 `skill-manager-0.1.0-x86_64.AppImage`（`${arch}` 在 Linux 取 `x86_64`），已修正清单与 README / CHANGELOG / 设计表述。
- **发布与幂等**：`gh` 参数按官方手册核对（`create`：`--title/--notes-file/--verify-tag/--latest`；`edit`：`--title/--notes-file/--latest`；`upload`：`--clobber`）；已存在则 edit + 覆盖资产，不打 prerelease 标记；仅 release job 具 `contents: write`。
- **口径修正**：Release notes 写在交付目录之外（写进去会被归位检查判为非交付物）；汇总产物改用 `actions/download-artifact@v8`（v6 面向 Node 20）。
- **干跑自测已全绿**（临时 tag `v0.1.0-t3dryrun5` → run 38893295554，**Success 5m12s**：四个打包 leg + release job 全绿）：资产清单（5 个实名）与 `SHA256SUMS` 以运行页注解公开输出，`--dry-run` 只打印 gh 命令、**未创建任何 Release**（复核：`/releases` 为空、`/releases/tags/<tag>` 404）。此前一次干跑被 mac-x64 的 dmg 构建抖动（`hdiutil: couldn't eject "disk2" - Resource busy`，登记 **EX-10**）打断，重跑即恢复，判定为非确定性失败。临时分支与全部临时 tag 已删除。
- **真实发布完成**（`v0.1.0`，2026-10-16）：tag `v0.1.0` → run 38908935080 **Success**；Release 为 **latest、非 prerelease、非 draft**，含 5 个交付资产与 `SHA256SUMS.txt`；**下载后复核**（Release 页公开下载 arm64 dmg 152 MB 与 x86_64 AppImage 164 MB，用 Release 上的校验清单本地复算）**逐字节一致**。发布过程命中并修掉两处真实缺陷：① 上传资产给裸文件名 → gh 报 `no matches found`（改为「汇总目录 + 文件名」路径）；② 新建的 Release 处于 **draft**，`--latest` 被 GitHub 以 422「Latest release cannot be draft or prerelease」拒绝 → 发布流程收敛为 `create → publish(draft=false,prerelease=false) → edit(title/notes/latest) → upload(--clobber)` 四步（幂等，复跑同 tag 亦收敛）。

#### M2-T4 冒烟验收收口（M2 收官）

- **Release 资产级冒烟**（验证发布物而非构建目录）：从 Release 回下载 5 个资产并用其自带的 `SHA256SUMS.txt` 复算——一致；AppImage 解包（12 目录 / 31 文件）确认 `resources/kernel/skill-manager.exe` 为 **ELF64 x86-64**、`resources/app.asar` 与 `AppRun` 就位；两 dmg 解包确认 `.app` 结构与 `Contents/Resources/kernel/skill-manager.exe` 的 **Mach-O 架构分别为 arm64 与 x86_64**；`Info.plist` 复核 `CFBundleShortVersionString=0.1.0`、`LSApplicationCategoryType=public.app-category.developer-tools`、`LSMinimumSystemVersion=13.0`；AppImage 的 `.desktop` **无 `Maintainer=` 行**（发布物上复核 `not-consumed` 结论）。
- **自动化冒烟写入发布流程**：发布 job 新增「Release 资产级冒烟」步骤——回下载 → `sha256sum -c` → AppImage 结构与包内内核最小闭环（`init → scan → list --json`）→ `xvfb` GUI 尝试（跑不通按设计 8.3 降级口径以注解登记，不写「未验证」）；下次发布自动执行。
- **执行受限于宿主环境**：本机为 Windows 且无 WSL、无已登录浏览器会话，无法执行 Linux/macOS 二进制或触发 `workflow_dispatch`——相关项按降级口径登记（环境限制结论 + 自动执行路径 + EX-08），不计为「未验证」。
- **验收映射与口径单列**：M2 七条逐条回填证据（设计 8.6 的 T4 登记表）；三种口径单列——未签名交付（`unsigned` / `adhoc` 三态，ad-hoc 为 arm64 平台要求）、CI 环境差异（FUSE / `--appimage-extract-and-run` / `--no-sandbox`）、降级项（完整 GUI 交互留本地、dispatch 首跑待会话）。
- **README**：下载入口改为指向 [`/releases/latest`](https://github.com/LuZhong-Li/skill-manager/releases/latest) 并标注当前版本 v0.1.0，安装步骤与资产形态一致。
- **M2 收官**：T0（图标管线）→ T1（构建配置）→ T2（矩阵与真机验证）→ T3（发布机制）→ T4（冒烟验收）全部完成；`v0.1.0` 已发布。

### 修复：EX-07（mac-arm64 打包失败）——内核 SEA 补齐 macOS 签名步骤 + 失败自证

**根因**：Node 官方单文件可执行（SEA）流程要求 macOS 上在 `postject` 注入前后处理签名——注入会改动 Node 运行时副本的 Mach-O 内容、使原签名失效，因此需先 `codesign --remove-signature`、注入后再 `codesign --sign -`（ad-hoc）重建有效签名。`scripts/build-kernel.mjs` 此前缺这两步：x64 宽容通过，而 arm64 在打包期签名校验失败（退出码 1，且命令无任何输出，故早前只能看到「见 job 日志」）。依据：nodejs.org 的 single-executable-applications 文档。

#### 修复

- **`scripts/sea-signing.mjs`（新增，纯函数 + 可注入执行器）**：`codesignArgs(action, executable)` 负责参数拼装（remove → `--remove-signature`；sign → `--sign -`）；`runCodesignAction()` 执行单步，**非 macOS 直接返回 `applied: false` 且不调用任何外部命令**；`removeMacSignature()` / `adHocSignMac()` 供构建脚本按序调用。
- **`scripts/build-kernel.mjs`**：在「复制 Node 副本」之后、「postject 注入」之前调用 `removeMacSignature`；注入之后调用 `adHocSignMac`。Linux / Windows 路径不变（两步均为空操作，本机 Windows 上 `build:kernel` 与 `smoke:kernel` 复跑通过）。
- **macOS 真机断言**：pack 的 mac leg 在产物结构校验里增加「包内内核二进制必须带有效签名」的可失败断言（`codesign -dv "$app/Contents/Resources/kernel/skill-manager.exe"`），并以注解公开签名信息——同类回归会直接让 leg 变红而不是留下哑失败。

#### 诊断增强（防止再次盲飞）

- **阶段自证**：`scripts/pack.mjs` 每步开始/结束写 `build/desktop/pack-stage.txt`（本次运行重开该文件），失败注解带出**最后阶段**。
- **打包器完整输出落盘**：electron-builder 的输出以 tee 方式同时进 `build/desktop/pack-debug.log`；Windows leg 的捕获输出同样追加到该日志。两个文件都在诊断产物（`build/desktop/**`）范围内。
- **注解回落**：打包失败时注解依次取「输出关键词命中行 → 打包器日志末 8 行」，并附退出码、输出字节数与最后阶段——未登录会话也能从运行页定位失败点。

#### 可执行名核查（按提示词要求评估，决定不改）

内核产物在三平台同名 `skill-manager.exe`。核查结论：**codesign 按文件内容（Mach-O）判定，不看扩展名**，本次修复后 arm64 包内该文件可正常读出 ad-hoc 签名（真机注解可证）；GUI 主进程固定按 `resources/kernel/skill-manager.exe` 解析路径，改名会牵动 GUI 路径、CI 产物命名与文档。故本批**不改名**，登记为开放项 EX-09（命名规范化属额外变更，收益仅为命名习惯）。

#### 测试（400 → 406 项；单元 +5 / 契约 +1）

- 单元 `tests/unit/sea-signing.test.ts`（5 项）：参数拼装（remove / sign / 未知动作）；非 macOS 不调用外部命令（`calls === 0`）；macOS 上按参数各调用一次；三类失败（非零退出带 stderr、非零退出但无输出写「(无输出)」、命令无法启动与退出码缺失）；构建脚本的调用顺序断言（`remove` 早于 postject 注入、`sign` 晚于注入）。
- 契约 `tests/contract/ci-workflows.test.ts`（+1 项）：pack 失败路径必须引用 `pack-stage.txt` 与 `pack-debug.log`，且 mac leg 对包内内核有 `codesign -dv` 真机断言与错误级注解。

#### 真机口径修正（同一批次内发现的第二处问题）

SEA 签名修复后重跑矩阵（run 38886354657）：mac-arm64 的**打包已经成功**（阶段文件显示已到「未签名断言」阶段），但 leg 仍红——原因是**断言口径过严**。真机实测：mac-x64 的产物**完全未签名**，而 mac-arm64 的产物带 **ad-hoc 签名**（Apple Silicon 上可执行文件必须至少带 ad-hoc 签名才能运行，属平台要求）。

- **`scripts/unsigned-check.mjs`**：判定扩展为三态可辨——`unsigned`（完全未签名，`code object is not signed at all`）、`adhoc`（`Signature=adhoc` / `flags=0x2(adhoc)`）、`signed`（含 Developer ID 等身份签名）。**`unsigned` 与 `adhoc` 均通过**，`signed` 与 `unknown` 仍拒绝；断言文案改为「应为『未签名或仅 ad-hoc』」。
- **`assert-unsigned.mjs`**：输出带上判定（`（判定：unsigned|adhoc）`），pack 的注解直接引用该文本——**交付口径「未使用开发者证书签名与公证」在运行页即可读**。
- 口径澄清（并回写设计 4.5 / 7.2）：本项目的「未签名交付」= 不携带开发者身份证书、不做公证；**ad-hoc 是 arm64 的运行前提，必须保留**，不是「被签名交付」。

#### 验收状态

- 本机：**408 项测试全绿**、`check` / `typecheck` / `lint` / `format:check` 零告警；`build:kernel` 与 `smoke:kernel` 通过（Windows 上签名步骤为空操作的实证）。
- 矩阵（tag `v0.0.1-t2run5` → run 38887140603）：**四 leg 全绿** —— Windows 238 MB、Linux AppImage 156 MB、macOS x64 dmg 149 MB、**macOS arm64 dmg 145 MB**；验证 job 两条亦绿。真机注解：mac-arm64 与 mac-x64 的包内内核均可读出签名（`EX-07 内核 ad-hoc 签名`），未签名断言分别判定 `adhoc` 与 `unsigned`，两端 `iconutil` 均产出 79768 字节 icns。**EX-07 关闭**。

### 工程：M2-T2 打包矩阵（verify.yml 抽取、pack.yml 四 leg、真机验证与 fail-fast 探测）

M2 的第三个实现批次：把校验步骤收敛为唯一实现，并让打包按 tag 触发四平台矩阵。**未新增指令与选项**（16 条不变）、未新增项目依赖（Linux leg 在 runner 上安装 `libfuse2t64` 属 CI 环境依赖，非项目依赖）。

#### 变更

- **`verify.yml`（可复用，`workflow_call`）**：现有 `ci.yml` 的 `prepare` + `verify` 两个 job 原样抽出（步骤名称与顺序逐条不变）；`ci.yml` 改为 `uses: ./.github/workflows/verify.yml`，其触发与并发口径不变，只保留触发层。
- **`pack.yml`（新增）**：触发 tag `v*` 与 `workflow_dispatch`（可选 `platforms` / `arch` 输入）；`verify` 作为打包前门禁（消费同一份 `verify.yml`）；四 leg 矩阵 `windows-latest` / `ubuntu-24.04` / `macos-15`（arm64）/ `macos-15-intel`（x64），`fail-fast: false`、任务级 60 分钟上限；concurrency 仅对手工/分支运行取消旧运行（tag 运行不打断）；每 leg 打包 → 上传产物（命名含平台 leg 与 run id）→ 失败时另附诊断产物。
- **真机结论以注解输出**：mac leg 的 `iconutil` 产物与 `codesign` 未签名断言、linux leg 的 `maintainer` 消费实测，均以 `::notice` 写到运行页注解——**未登录会话也能读到运行结论**（本批的诊断通道，也是后续无人值守排查的基础）。
- **失败可诊断**：三个打包步骤把失败原因（关键词命中行，或末 3 行回落）折进 `::error` 注解，避免「红 leg 但看不到原因」。
- **Linux 打包依赖**：runner 镜像未预装 FUSE 2，AppImage 工具链需要它——leg 内显式 `apt-get install libfuse2t64`（设计 7.1 的处置顺序）。
- **配置修复**：新增 `linux.executableName: skill-manager`——electron-builder 会从包名 `@skill-manager/gui` 推导可执行名（`@skill-managergui`），AppImage 目标据此报「含非法字符」而构建失败。
- **`linux.maintainer` 注解回写**：T2 真机实测结论为 **not-consumed**（AppImage 不消费该字段），按裁决 ⑨ / T1 口径保留字段并注明用途（deb / rpm 等形态才消费）。

#### 实测结果

| 运行                                        | 结论                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| run 38869061706（ci.yml 抽取后）            | **Success 1m 57s**；job 呈现为「校验 / 读取版本声明」「校验 / 验证（…）」，步骤序列由契约测试逐条钉住                                                        |
| run 38869913530（tag 首跑）                 | Failure：Windows ✓ 238 MB、mac-x64 ✓ 148 MB；Linux ✗、mac-arm64 ✗                                                                                            |
| run 38871300587（修复后重跑）               | Failure：Windows ✓ 238 MB、**Linux ✓ 156 MB AppImage**、mac-x64 ✓ 148 MB、mac-arm64 ✗（517 MB 诊断产物）——三项真机注解全部产出                               |
| run 38869954307（fail-fast 探测，临时分支） | linux leg 按探测步骤红，**同一运行里 Windows 与 mac-x64 仍产出并上传产物**（`fail-fast: false` 实证）；探测分支与四个临时 tag 已删除，正式工作流不含探测代码 |

#### 本批发现并修复的缺陷（如实登记）

1. **job 级 `if` 引用 `matrix`** → GitHub 判 `Invalid workflow file`（run 38868806071）。改为步骤级过滤；并新增契约断言禁止任何 job 级 `if` 出现 `matrix.`。
2. **契约测试使用 `any`** 触发 `@typescript-eslint/no-explicit-any`，**本地门禁因「只看输出末行」漏看、由 CI 抓到**。测试改具名接口解析 YAML；方法学教训：门禁以退出码判定，不以末行判定。
3. **AppImage `executableName` 非法字符**（见上）。
4. 本地编辑工作流文件时用 shell 写导致工作副本 CRLF，触发本地 `format:check` 失败（仓库 blob 仍为 LF，CI 不受影响）；已用格式化工具恢复工作副本为 LF，并复用既有 EOL 结论。

#### 测试（389 → 400 项；单元 +2 / 契约 +9）

- 单元：`maintainer` 单侧判定与 CLI（只给 `--with` 时结出 consumed / not-consumed）。
- 契约（`tests/contract/ci-workflows.test.ts`，7 项）：校验命令只在 `verify.yml` 一处（逐行精确比对，避免 `npm run build` 误命中 `npm run build:kernel`）；`verify.yml` 只被调用触发且步骤名称/命令/顺序与抽取前逐条一致、矩阵与超时不变；`.nvmrc` 同源口径不变；`ci.yml` 触发与并发不变；`pack.yml` 只跑打包不发布（无 `gh release`、只读权限）；四 leg 矩阵与 `fail-fast: false`、tag 不取消旧运行、mac/linux 真机证据步骤与注解；三个工作流动作主版本同口径。另有 2 项回归断言：job 级 `if` 不得引用 `matrix`、`platforms` 过滤必须落在步骤级（含上传步骤）。

#### 未做 / 遗留

- **EX-07**：mac-arm64 leg 失败原因待取证（同配置 mac-x64 全绿，已排除配置与依赖层面原因；被包装命令本次无输出，疑 runner 侧中断或 OOM），四 leg 首跑「全绿」这条验收因此未闭合；
- **EX-08**：`workflow_dispatch` 首跑与输入行为待有已登录会话时补测；
- T3 发布（EX-01 CHANGELOG 定版、版本守卫、`gh` 参数核对、SHA256SUMS、EX-02 真实 tag 授权）与 T4 冒烟验收收口。

### 工程：M2-T1 构建配置（mac/linux 段、未签名断言、打包入口与 README）

M2 的第二个实现批次：让打包链路具备 macOS 与 Linux 目标，并把「未签名交付」从默认结果变成被检查的事实。**未新增指令与选项**（16 条不变），**未新增依赖**（全部用既有工具链与自实现脚本）。

#### 变更

- **配置增量（`gui/packaging/electron-builder.yml`）**：新增 `mac` 段（`target: dmg`、`icon: packaging/icon.icns`、`category: public.app-category.developer-tools`、产物名含 `${arch}`、**不出现任何签名键**）与 `linux` 段（`target: AppImage`、`icon: packaging/icons`、`category: Utility`、`synopsis` / `description`、`maintainer: skill-manager <3338004299@qq.com>`——沿用仓库既有提交身份，不新造个人信息）；`win` / `nsis` / `portable` 段与 `files` / `extraResources` / `electronLanguages` / `directories` 共享骨架未动，三平台段同层组织、共享字段不复制。
- **签名预留（仅文档，不实现）**：配置注释登记五个官方 secrets 名（`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）与「secrets 存在才运行的签名 job」说明；未签名口径以环境变量 `CSC_IDENTITY_AUTO_DISCOVERY=false` 表达（不写配置键，跨 electron-builder 主版本成立）。
- **打包入口**：`scripts/pack-plan.mjs`（纯函数计划：图标链 → 界面构建 → electron-builder → 未签名断言；平台分支、架构开关、环境变量、只打本平台包）与 `scripts/pack.mjs`（执行器，参数与计划错误给出可读信息并以非零退出）；`gui/package.json` 新增 `pack:mac` / `pack:mac:x64` / `pack:linux`（与既有 `pack:win` 并列，Windows 入口不变）。非 macOS 宿主上 `build:icon:icns` **跳过且不中断**，提示原因。
- **未签名断言**：`scripts/unsigned-check.mjs`（`codesign` 输出解析与执行器可注入，三口径：未签名 → 通过、已签名 → 失败、无输出 → 按无法确认失败）+ `scripts/assert-unsigned.mjs`（事后复核入口）；mac 打包后自动执行，缺 `.app` 或产物目录缺失都明确失败。
- **`maintainer` 消费实测**：`scripts/maintainer-probe.mjs`（目录树文本扫描 + 三态判定 consumed / not-consumed / ambiguous）与 `scripts/check-maintainer.mjs`（参数解析与结论输出）。
- **README**：新增「跨平台分发与安装」——产物清单与 Releases 下载入口（含 Windows 两形态与 `SHA256SUMS.txt`）、macOS 未签名绕行两步（右键打开 / `xattr -cr`）、Linux glibc 下界 2.39 与 `libfuse2t64` / `--appimage-extract-and-run` 前提、自行打包命令与「图标属构建期产物」说明。

#### 测试（370 → 389 项；单元 +12 / 契约 +7）

- **单元（`tests/unit/`）**：打包计划 5 项（mac/arm64 图标链与 `--mac --arm64`、x64 开关、非 macOS 跳过 icns 且后续步骤仍在、linux 无 icns/无未签名口径、默认架构与非法平台/架构拒绝）；未签名断言 4 项（三口径 + 平台与产物缺失时先拒绝且不调用 `codesign`）；`maintainer` 判定 3 项（consumed / not-consumed / ambiguous，含「二进制文件不被扫描」的旁证）。
- **契约（`tests/contract/`）**：配置结构 5 项（mac 段字段齐全且**不含签名键**、linux 段字段与 `maintainer` 形态、win 段与共享骨架未被改动、三平台段同层且共享字段不重复、签名预留与未签名环境变量在配置注释中）；README 文案 2 项（产物清单与 Releases 入口、绕行步骤 + glibc 版本号 + 打包命令）。

#### 未做（明确登记）

- **真机项保留**：`codesign -dv` 未签名断言的 macOS 真机验证、`maintainer` 消费实测的 Linux 真机执行，均登记为 T2 矩阵首跑项——本批只交付可注入/可单测的逻辑与入口，不伪造平台结论；
- T2 矩阵与 `verify.yml` 抽取、T3 发布、T4 冒烟与验收。

### 工程：M2-T0 图标管线扩展（构建期生成、不入库、零图形库）

M2 的第一个实现批次：把程序化图标管线从「Windows 用的 PNG/ICO」扩展到 macOS iconset 与 Linux 图标目录，并保持「图标的唯一来源是脚本」。**未新增指令与选项**（16 条不变），**未新增依赖**。

#### 变更

- **纯函数模块 `scripts/icon-render.mjs`**：渲染（带符号距离场 + 解析抗锯齿，香槟金配色沿用）、PNG/ICO 最小编码器、iconset 与 Linux 档位清单集中一处；**同一份矢量描述按目标尺寸直接渲染**（不做位图缩放），因此 1024 档与 16 档同源可精确重生成；导入该模块不产生任何副作用。
- **命令行入口**：`npm run build:icon`（`scripts/build-icon.mjs`）写 14 个文件——`icon.ico`（7 档）、`icon.png`（256）、`icons/256x256.png`、`icons/512x512.png`（electron-builder 的 `NxN.png` 约定）与 `icon.iconset/` 的 10 个文件（16/32/64/128/256/512/1024 像素，含 `@2x` 两倍关系）；新增 `npm run build:icon:icns`（`scripts/build-icon-icns.mjs`）。
- **`iconutil` 封装 `scripts/icon-icns.mjs`**：参数拼装独立导出；**平台准入先于任何检查与写盘**——非 macOS 直接以明确错误退出（说明「icns 仅 macOS 构建期生成」），不静默跳过、不产生副作用；执行器可注入，使参数与四类失败口径（平台、缺 iconset、非零退出、未产出文件）可在任意平台单测；产出必须存在且非空，避免打包出缺图标的应用。
- **不入库**：`.gitignore` 新增 `gui/packaging/icons/`、`gui/packaging/icon.iconset/`、`gui/packaging/icon.icns`；`icon.ico` 与 `icon.png` 维持入库（Windows 口径不动）。

#### 实测与证据

- **既有产物零漂移**：重跑 `build:icon` 后 `git status --short gui/packaging` 为空 —— 入库的 `icon.ico` / `icon.png` 与新脚本产出**逐字节一致**（另有哈希相等断言固化）。
- **不入库生效**：`git check-ignore -v` 对三条生成路径均命中新规则（`exit=0`），且生成后 `git status` 只显示源码改动、无生成物。

#### 测试（360 → 370 项；单元 +6 / 契约 +4）

- **单元 `tests/unit/icon-render.test.ts`（6 项）**：各档 PNG 像素尺寸与声明一致（`icon.png` 256、`icons/` 256/512）、iconset 10 文件命名与尺寸完整且 `@2x` 为对应 1x 的两倍、ICO 目录表 7 档与各档负载尺寸匹配、确定性与落盘幂等（两次生成/两次写盘哈希一致）、既有入库 `icon.ico` / `icon.png` 字节不变。
- **契约 `tests/contract/icon-pipeline.test.ts`（4 项）**：生成物不入库（`.gitignore` 文本规则 + `git check-ignore` 双重断言）、`iconutil` 参数拼装与非 macOS 准入（断言未调用外部命令）、macOS 分支以注入执行器校验调用参数与产出（含非零退出、未产出文件、缺 iconset 三种失败口径）、非 macOS 命令行入口以非零退出码拒绝且不写盘。

#### 未做（明确登记）

- T1 构建配置（`mac` / `linux` 段、未签名断言脚本、README 的 Gatekeeper 与 glibc 说明）、T2 矩阵与 `verify.yml` 抽取、T3 发布、T4 冒烟与验收；
- **EX-03 保留**：`iconutil` 真机验证登记为 T2 矩阵首跑项，本批不伪造 macOS 结论。

### 工程：M5 遗留事实点收口（三项裁决 · 规范 + 实现）

把 2026-10-16 取证引出的三项裁决落到契约与实现（**先文档后实现**），并要求 ④ 维持现状。**未新增指令与选项**（16 条不变），**一期 `--target` 语义未动**（其可推导布局不经注册表 `path_template`）。

#### 三项裁定的落地

| #   | 裁定                                                                                                                                      | 落地                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Codex 默认落位根改 `$HOME/.agents/skills`（官方文档 + 与 Cursor、`dsh` 共享）；`~/.codex/skills` 降为**配置覆盖的遗留兼容根**，不默认双写 | 注册表 `codex.roots[]`（`path_template` = `<用户主目录>/.agents/skills/<Skill 标识>`、`consumed_by` = codex / cursor / dsh、`scope` = global、`platform_notes` 写明官方依据与兼容通道）；`kernel/core/adapters/roots.ts` 默认路径表；README 使用说明                                                                                              |
| ②   | `disable-model-invocation` 由「全宿主禁止」改为**按宿主语义证据准入**；**Codex 纳入**（三处独立证据语义一致），其余宿主维持禁止           | 规范 2.2 第 5 条 / 3.7 / 新增 3.8 / **HR-09 改写**；schema 与 `$defs/securityControlEvidence`；注册表 `codex.render_policy.allowed_extensions` + `security_control_evidence`（`semantics` / 一手 `level` / 三条 `sources` / 残余不确定性 `note`）；准入判据 `isSecurityControlEvidenceComplete`（**唯一实现**，注册表加载期与渲染期共用两条防线） |
| ③   | **不为 `dsh` 新立注册项**：登记为 `~/.agents/skills` 的**外部消费方**（零适配器）；`deepseek` 维持 `not_applicable`                       | 规范 2.2 第 6 条 / 3.8 / **HR-07 放宽** / **新增 HR-13**；schema 顶层 `external_consumers`；注册表顶层 `external_consumers: [dsh]`（含官方来源与「预览期不立注册项、GA 后评估」说明）与 `codex.classification.root_consumed_by` = `[cursor, dsh]`                                                                                                 |
| ④   | Cursor 透传白名单**维持现状**（保守为空）                                                                                                 | 仅登记；待 HD-01 实测（本机无 Cursor）                                                                                                                                                                                                                                                                                                            |

#### 规范与契约

- **第五份契约规范修订记录第 5 条**：HR-09 改写、HR-07 放宽、新增 HR-13、新增 3.8 节（`external_consumers` 与 `security_control_evidence`）；`registry_version` 不递增（注册表随内核同版本交付，本次为可选字段新增与规则放宽，无既有取值语义变更）。
- **机器可读形态同步**：`schemas/host_registry.schema.json` 新增顶层 `external_consumers` 与 `render_policy.security_control_evidence`（含 `$defs/externalConsumer`、`$defs/securityControlEvidence`），并把原「白名单不得含 `disable-model-invocation`」的断言改为「含该字段时必须给出语义证据」的条件断言；规范↔schema 字段集一致性测试通过。

#### 测试（358 → 360 项；契约 55 → 57）

- **语义变更项回看**（按工程约定逐条核对用例语义）：`host-registry.test.ts` 的 HR-09 反例改为「白名单含安全控制字段但未登记语义证据」，并新增「登记了证据却未进白名单（失效登记）」反例与两条 HR-13 反例；`render.test.ts` 的白名单用例改为 Codex 命中透传 + 其余宿主拒绝，原「禁用字段双层防线」改写为「安全控制字段两层准入（注册表语义证据 + 渲染期复核）」，并加一条对照：同一策略补上语义证据后即准入（说明拒绝的原因是证据缺失而非字段本身）；`adapters.test.ts` 字段策略边界的同宿主断言同步改写（规则文件形态无字段映射，不产出字段级问题）。
- **新增用例**：`host-registry.test.ts`「Codex 落位根改为官方 agents 根、`dsh` 仅作为外部消费方登记」（消费集合 codex / cursor / dsh、`hostIds()` 不含 `dsh`、`deepseek` 维持不可落位）；`land.test.ts`「Codex 落位计划重定基到官方 agents 根，遗留根仅经配置生效且不双写」（默认根展开、配置覆盖回 `~/.codex/skills`、两种情形各只有一条落位项且不同时出现两个根）、默认路径表的 Codex 行改为 agents 根。

#### 文档同步

- `docs/research/host-mechanisms.md`：新增「补记（2026-10-16，第二批：裁定与逐处引文）」——三项裁定 + **逐处引文表**（Claude / Cursor / dsh 的 `disable-model-invocation` 语义原文、Codex 官方 agents 根原文、dsh 预览状态原文）。
- `docs/design/m5-host-adapter.md`：3.1 字段表补 `external_consumers` 与 `security_control_evidence`；3.2 首批注册项的 Codex 行改为官方 agents 根 + `host_declared` 白名单；新增 9.6「裁决执行」。
- `docs/plan/m5-host-adapter.md`：新增本批次执行状态。
- `docs/one-summary.md`：7.3 交付现状表补「落位根」一行并更新首批宿主行（`deepseek` 维持不适用、`dsh` 为外部消费方）；M5-L-04 **关闭**、M5-L-07 标为 ①②③ 已执行 / ④ 保持开放；测试计数与盘点结论刷新为 360。
- `README.md`：交付面测试计数刷新；宿主分发一节补默认落位根（含 Codex agents 根与遗留兼容根用法）。
- `docs/requirements.md`：新增本批次回写与计数校验（需求正文未改；第 9 章当前态的契约清单表述由 HR-01 ~ HR-12 更新为 HR-01 ~ HR-13）。

#### 未做（明确登记）

- Cursor 白名单是否放宽（HD-01）仍待 Cursor 环境实测，不阻塞；
- `dsh` 是否升级为宿主条目：GA 后评估（当前为开发者预览且官方明示破坏性变更）；
- HD-02 残余：Codex 官方把同类控制放在 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`，SKILL.md 层该键在 Codex 侧的实际运行期效果未实测。

### 调研：M5 遗留事实点取证（浏览器一手 · 只文档）

把 M5 遗留项中三条**被网络 / 环境卡住**的事实点一次取齐：Codex 官方技能规范（原命令行侧 403）、DeepSeek Harness 线索（原不可达）、Cursor 官方字段表。取证经浏览器会话直接读取官方页面及其 `.md` / `raw` 纯文本形态，证据等级 **[已查证·浏览器一手]**。**本批次不改任何实现、不改需求、不动注册表与契约**（16 条指令、五份规范 / 五份 schema、358 项测试均未变）。

#### 取证结论

- **HD-06 / Q-01 关闭（Codex 官方规范）**：`developers.openai.com/codex/skills/` 现可达并重定向到 `learn.chatgpt.com/docs/build-skills`。要点：`SKILL.md` **必需 `name` + `description`**，扩展元数据在 `agents/openai.yaml`（`interface` / `policy.allow_implicit_invocation` / `dependencies.tools[]`）；加载位置为 `.agents/skills` 链（REPO，自 CWD 逐级向上至仓库根）、`$HOME/.agents/skills`（USER）、`/etc/codex/skills`（ADMIN）与随包 SYSTEM；同名技能**不合并**；禁用走 `~/.codex/config.toml` 的 `[[skills.config]]`；上下文预算 `skills.max_context_tokens`。
- **HD-01 部分更新（Cursor）**：官方 frontmatter 字段表较原记录**新增 `disable-model-invocation` 与 `metadata`**（其余为 `name` 必填且须与父目录同名、`description` 必填、`paths` 可选、`icon` / `color` 可选）；「标准外字段被忽略还是报错」官方文档**未述**，仍需 Cursor 环境实测。
- **Q-03 关闭（DeepSeek Harness）**：`deepseek-ai/deepseek-harness` 为 **DeepSeek 官方开源 agent harness**（公开仓库、开发者预览、everything-is-a-plugin，基于 Cordis），其中**技能是一等子系统**（`docs/subsystems/skills.md` + 本机文件系统 provider，仓库以 `.agents/skills/<名称>/SKILL.md` 组织技能、随 `packages/preset/agent-preset/skills/` 分发）。发现根与优先级：`<projectRoot>/.dsh/skills` → `<projectRoot>/.agents/skills` → `Config.customSkillDirs` → `<dshHome>/skills` → `<agentsHome>/skills` → `Config.bundledSkillDir`；接受目录包与扁平 `<名称>.md`，**不支持嵌套递归 `**/SKILL.md` 发现**；调用策略读取 `disable-model-invocation` 与 `user-invocable`。
- **HD-02 取得部分证据**：`disable-model-invocation` 现有**三处独立证据**（Claude 本机实测、Cursor 官方字段表、`dsh` 官方子系统文档）且语义一致（`true` = 排除模型自动调用）；Codex 侧把同类控制放在 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`，未列入 SKILL.md。

#### 待裁决项（登记，不预判；裁定前保持现实现）

| #   | 事项                                            | 现状                                           | 待裁决内容                                                                                                                                    |
| --- | ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Codex 分发落位根                                | 注册项用 `~/.codex/skills`（本机实测应用读取） | 是否改用 / 追加官方 USER 根 `$HOME/.agents/skills`（与 Cursor、`dsh` 的 `agents` 根同路径，可「一次落位、多宿主可见」），或并存并声明消费关系 |
| ②   | `disable-model-invocation` 透传（DP-04 / D-02） | 已实施「全宿主禁止透传」                       | 证据语义一致后，是否解除禁止、改为按宿主白名单透传并登记语义                                                                                  |
| ③   | DeepSeek 分类                                   | `not_applicable`（模型提供方）                 | 是否改判并新增 `dsh` 注册项（或标 `pending_evidence`），是否纳入后续适配批次                                                                  |
| ④   | Cursor 透传白名单                               | 保守为空                                       | 待 HD-01 实测关闭；本次仅更新文档字段表依据                                                                                                   |

#### 文档同步

- `docs/research/host-mechanisms.md`：新增 6.3 补记（2026-10-16）与附录补记 S-19 ~ S-24；更新可访问性表、事实卡 C（Codex）/ D（Cursor）/ F（DeepSeek）、风险表 HR-02、来源表 S-07 与 S-14。
- `docs/design/m5-host-adapter.md`：2.3 节「仍待确认」、2.5 节 HD-01 / HD-02 / HD-06 状态、9.2 节 Codex 补证行、9.4 节第 1 条，新增 9.5 节「取证更新与待裁决项」。
- `docs/plan/m5-host-adapter.md`：第 5 章 HD-01 / HD-06 行更新，并加本批次执行状态。
- `docs/one-summary.md`：7.3 节 M5-L-01 / M5-L-02 / M5-L-04 状态更新，新增 M5-L-07（四项待裁决）；交付现状表 DeepSeek 行加「待复议」。
- `docs/requirements.md`：新增本批次回写与计数校验（需求正文未改动）。

#### 未做（明确登记）

- 未改动内核注册表、渲染层、适配器与任何测试（四项待裁决裁定前保持现实现）；
- 未变更需求 9.3.6 的验收口径与分类表述；
- Cursor 侧仍需具备环境后实测（HD-01）；`dsh` 若纳入适配，需先裁定 ③。

### 工程：CI 接入（M1-T4 验收闭合）

M1 的收口批次：以真实运行证据闭合 9.3.1 的七条验收标准。**未新增指令与选项**（16 条不变）、未改动需求正文与任何门禁，只补齐验收证据与文档同步。

#### 验收证据（四次真实运行）

- **加固后运行 run 38828716615**（提交 `3995367`）：**Success**，墙钟 1m 58s（读取版本声明 4s、Windows 1m 48s、Linux 49s）；动作主版本升级（`checkout@v5` / `setup-node@v5` / `upload-artifact@v6`）与 Linux runner 固定（`ubuntu-24.04`）后**告警清零**，358 项测试在两平台仍全绿，产物 `…-Linux-X64-run38828716615`（41.1 MB）与 `…-Windows-X64-run38828716615`（32.9 MB）产出。
- **刻意失败探测运行 38829261658**（分支 `hotfix/ci-probe`）：Failure，1m 14s，无产物；失败精确定位到「五、格式检查（只读）」（4s，exit 1），日志给出 `[warn] ci-probe-format-violation.mjs` 与「Code style issues found」，其后「六、测试」「七、构建」「八、缩减冒烟」与产物上传全部 0s 跳过 → **验收 2 与 6 通过**（失败可定位、失败即中止且不产出产物）。
- **合并请求运行 38834451784**（PR #1，`hotfix/ci-probe → main`）：事件 `pull_request`（「Pull request #1 opened」），Failure，1m 4s，无产物，两腿停在同一失败环节（`#step:9`）→ **验收 1 通过**（两条触发路径均可自动运行，且与 push 路径同一失败链路）。
- **探测 PR 与分支处置**：仓库为公开仓库，故 PR 标题与描述自解释（「CI 验收探测 / 不合并 / 观察后关闭」）；观察后追加结束评论（含运行编号与失败定位）→ 关闭 PR（**未合并**）→ 删除分支 `hotfix/ci-probe`（远端与本地均删）。仓库分支只剩 `main`，本地工作区干净，**探测文件未进入 `main`**；已关闭的 PR #1 作为公开记录保留。

#### 缓存条目（验收 4）：机制已验证，时长未达成并附原因

- **机制侧（通过）**：冷 / 热双向确证——首次运行两腿均为 `npm cache is not found`，第二次运行两腿均 `Cache hit for: node-cache-<平台>-x64-npm-16daf9b6…` → `Cache Size: ~56 MB` → `Cache restored successfully`，键含平台、Node 版本与依赖锁文件哈希（两腿键彼此独立）；「清空缓存后结论不变」由冷缓存首次运行与热缓存第二次运行**同结论**佐证（两平台 358 项全绿、产物照常产出）；缓存范围不含任何宿主根路径。
- **时长侧（未达成）**：`npm ci` 自报耗时冷 / 热完全一致（Linux `added 450 packages … in 5s`、Windows `… in 12s`）；`安装 Node` 步骤在 Windows 上由 5s 升至 11s（恢复约 56 MB 缓存的固定开销），Windows 腿墙钟 1m 47s → 1m 48s，无可观测下降，**9.4.1 的「相对首次降低 ≥ 30%」目标值未达成**。
- **原因**：450 个包 / 约 56 MB 的量级下，依赖安装的瓶颈是解包与链接而非下载（缓存恢复日志的传输速率为 116.7 / 132.3 MB/s），网络本就不是瓶颈，缓存没有可节约的空间而恢复开销可见；收益在依赖规模增长前不可观测。Linux 腿 46s → 49s **不可比**（同批次把 Linux runner 由 `ubuntu-latest` 固定为 `ubuntu-24.04`）。
- **处置**：**保留缓存**（M1-R4 要求启用，且消除 registry 网络与限流的波动风险），本项按 9.4.1 原文出口「未达成须说明原因」闭合，**不改需求验收措辞**；复测触发器：依赖规模增长，或 `npm ci` 耗时随规模上升时复测——若届时仍无收益，移除缓存属需求变更，走变更记录批次。

#### 文档同步

- `docs/design/m1-ci.md`：第 14 章补 14.2（加固后运行）、14.3（缓存冷 / 热对照与口径）、14.4（两条触发路径与失败可定位性、PR 与分支处置）、14.5（9.3.1 七条闭合状态）。
- `docs/plan/m1-ci.md`：T4 执行状态、3.1「验收结果（T4 闭合）」、第 5 章阻塞项（DP-A 已定、DP-C 已完成、环境限制改由浏览器会话直接读取运行日志）。
- `README.md`：交付面补「持续集成」一行与测试计数刷新（354 → 358：单元 242、契约 55、端到端 61）；常用命令补 `smoke:kernel`、`check:node`；新增「持续集成」一节（触发、矩阵、步骤、产物下载入口与本地复现方式）。
- `docs/one-summary.md`（活文档）：7.4 节 M1 行改为收官状态并附四次运行证据；测试计数刷新为 358 项；盘点结论补 M1 收官。
- `docs/requirements.md`：新增本批次回写与计数校验（需求正文未改动）。

#### 未做（明确登记）

- 夜间完整流水线（CI-Q-01，按需启用）、macOS runner 与跨平台产物验证（归 M2）、发布与签名；
- 多宿主单次分发（M5-L-05）与其他 M5 遗留项维持登记，不在本批次范围内。

### 工程：CI 接入（M1-T1 ~ T3）

后续阶段 M1 的实现批次：把既有的人工验证集合固化为每次提交自动执行的流水线。**未新面向用户的指令或选项**，只新增 CI 支撑物与两个 npm 脚本。

#### 变更

- **工作流定义 `.github/workflows/ci.yml`**：触发为「推送到主干与长期维护分支」「针对主干的合并请求（打开 / 提交同步 / 重新打开）」与手工触发；同一分支的连续提交取消旧运行，结论只以最新提交为准。矩阵为 `ubuntu-latest` 与 `windows-latest` × **Node 取值取自 `.nvmrc`**（矩阵值由前置任务读取版本声明文件生成，并把「矩阵与声明一致」作为可失败的守卫步骤，而不是靠人工核对）。八步依次为：版本守卫 → 依赖安装（按锁文件）→ 契约与分层校验 → 类型检查 → 代码规范 → 格式检查（只读）→ 测试（含用例数核对）→ 构建 → 缩减冒烟。产物上传命名含平台 / 架构 / 运行标识并保留 14 天；失败时另上传诊断产物。`fail-fast: false` 保证一个组合失败不掩盖其他组合的结果，任一组合失败即整次运行失败；任务级硬上限 60 分钟。
- **缩减冒烟（DP-B，不启动 Electron）**：新增 `scripts/smoke-kernel.mjs` 与 `npm run smoke:kernel`——内核可执行文件存在 → `--version` 可用 → `init` → `scan` → `list --json` 最小闭环，三条检查各自可失败且给出可定位信息；工作区用系统临时目录，**不触碰任何真实宿主目录**。完整三启动方式界面冒烟继续在本地执行。
- **版本声明守卫**：新增 `scripts/check-node-version.mjs` 与 `npm run check:node`——本地检查是否满足 `engines` 下界并与 `.nvmrc` 比对（不一致仅提示，因 `engines` 只声明下界）；流水线以 `--expect <矩阵取值>` 断言一致，不一致即失败。
- **本地预校验**：八步在本机全部通过（契约与分层、类型检查、代码规范、格式检查、358 项测试、构建、缩减冒烟、版本守卫）。提示：本机 Node 为 **24** 而 `.nvmrc` 声明 **22**，因此流水线是该套件**首次在 Node 22 上运行**——若首次运行暴露版本相关差异，按「修版本兼容」处理，**不放宽门禁**。
- **决策点处置**：DP-A 按最小覆盖（两 OS × 最低 Node，**夜间完整流水线默认不启用**，待 CI-Q-01 按需开启）；DP-C 已授权由执行端推送 `main`，验收以该次推送触发的真实运行为准。

#### 未做（明确登记）

- 夜间完整流水线、macOS runner、跨平台产物验证与打包产物验证（后三者归 M2）；产物签名与发布不在本阶段任何里程碑。

#### 首次真实运行（run 38769499271，提交 `1d880b6`）

- **结果**：推送 `main` 自动触发，三个 job 齐备；两个矩阵组合（Windows 与 Linux，均为 Node 22）都执行到产物上传步骤，358 项测试在两平台同时通过；产物 `skill-manager-Linux-X64-run38769499271`（41.1 MB）与 `skill-manager-Windows-X64-run38769499271`（32.9 MB）已产出，命名含平台 / 架构 / 运行标识。
- **告警处置（DP-D：官方动作的运行时）**：三个官方动作面向 Node 20 被强制在 Node 24 上运行。经核实各主版本的实际目标运行时（`action.yml` 的 `runs.using`）与输入兼容性后升级：`checkout@v4 → v5`（其变更记录仅「改用 Node 24」一项）、`setup-node@v4 → v5`、`upload-artifact@v4 → v6`（v5 仍面向 Node 20）。两个 job 的检出步骤同步升级，版本保持一致。
- **告警处置（DP-E：runner 标签漂移）**：`ubuntu-latest` 将于 2026-10-19 迁移到 Ubuntu 26。Linux runner 固定为 `ubuntu-24.04`，让操作系统升级成为**显式决策**而非静默变化；Windows 无同类迁移公告，暂用 `windows-latest`。
- **待补验收**：合并请求触发路径（需一次 PR）、刻意失败的可定位性（需一次构造失败）、缓存命中的时长下降（需两次运行时长对比）。

### 行尾符规范化（独立批次：`docs/architecture.md` 工作副本 CRLF → LF）

收尾工程项：把全库唯一的 CRLF 文档转为 LF。执行后发现实际情况与预判不同，如实记录如下。

#### 实测结论

- **仓库侧本就全是 LF**：`git grep -P -l -e '\r' HEAD` 对全部已跟踪文件的 blob 审计结果为**空**——没有被提交的文本文件含 CR。原因是 `.gitattributes` 的 `* text=auto eol=lf` 在入库时已完成规范化，CRLF 只存在于**工作副本**。
- **预判的「约 1398 行纯空白差异」未出现**：该数字来自工作副本的 CR 计数（1398），而 blob 与工作副本在转换前经 eol 过滤器比较即视为一致，因此 `git diff` 为空。转换后工作副本与 `HEAD` blob **逐字节相同**（76971 字节，逐字节比对通过），stat 缓存刷新后 `git status` 干净。
- **本次实际效果**：工作副本的 CRLF 已转为 LF，与 `.editorconfig`（`end_of_line = lf`）一致；文本类文件的工作副本 EOL 复核只剩两个二进制资源（`.ico` / `.png`）含 CR，属预期。

#### 结论与登记

- **M5 遗留项 M5-L-06（`docs/architecture.md` 的 CRLF）关闭**：该项自始只影响工作副本，不影响仓库内容；现已与仓库一致。
- **无内容变更、无功能变更**：本批没有可提交的代码或文档内容差异（`git diff` 与 `git diff --cached` 均为空），因此**未产生提交**；登记以本条说明承接。
- 方法学备注：本批一度用 PowerShell 捕获 `git show` 输出做 blob 审计，因 PowerShell 会用平台换行重组行而产生**全量误报**；改用 `git grep -P` 与逐字节比对后得到上述结论。

### 解析器：选项重复语义硬化（独立小批次）

`--host` 边界审计发现「重复给出取值选项时静默取最后值」并非 `--host` 独有，而是**所有取值选项共有**的隐性丢弃；本批做通用解析器硬化，而非只修 `--host`。

#### 变更

- **解析器行为**：同一命令中重复出现同一选项按**参数类错误**（`E-INPUT-002`）拒绝，**不再静默取最后值**；布尔选项与取值选项同口径（`--yes --yes` 同样报错），避免误写的参数被悄悄丢弃。重复时既不覆盖既有取值，也不产生任何写入。
- **登记表新增可重复性声明**：`REPEATABLE_OPTIONS` 显式声明设计上可重复的取值选项（默认单值），并导出 `isRepeatableOption()` 供审计与测试逐项核对。审计结论：全量取值选项中**仅 `scan` 的 `--root`** 设计上可重复（契约语法标记 `...`），其余均为单值。
- **`--host` 明确为单值**：多宿主分发维持「多次调用」的口径；该项作为遗留项继续登记（多宿主单次分发是未来能力）。
- **指令契约规范（先文档）**：第 2.2 节新增「重复给出的处理」——重复即按参数类错误拒绝、不静默取最后值、可重复选项按数组聚合且可重复性在登记表中显式声明；第 9 节修订记录新增第 35 条。
- **契约测试（354 → 358 项）**：新增 `tests/contract/option-hardening.test.ts` 四项断言——逐选项审计（每个非可重复取值选项重复即报错，且不覆盖既有取值）、布尔选项同口径、可重复选项仍聚合且**登记表与契约语法中的 `...` 一一对应**、契约写明该规则。同时把 M5 收口用例中「重复 `--host` 取最后值」的断言改为「按参数类错误拒绝且不产生写入」。
- **审计结论**：全库无任何既有用例或实现依赖「重复取最后值」的口径（硬化后既有 354 项全部通过）。

### 后续阶段 M5（宿主适配层）收官（T7 测试收口 + T8 文档同步）

M5 的收口批次：不新增功能、不改既有行为，只做验收映射、边界审计补缺与文档同步。

#### T7 测试收口

- **验收映射**：需求 9.3.6 的十条里程碑验收标准逐条挂载到承载测试（文件 / 用例）与验证方式，见 `docs/plan/m5-host-adapter.md` 第 3 章。
- **边界审计（补缺两项，均为实现缺陷，已修）**：① 落位计划**重定基后未更新 `external` 标记**——注册表模板是工作区相对路径，重定基到宿主真实根后应标记为工作区外写入，否则结果载荷误报；② 外部根解析的「不可创建」判定只看直接父级，**隔层父级为文件时漏报**（如 `<文件>/nested/skills`），改为向上找最近的存在祖先再判定。
- **审计新增用例**：`tests/contract/m5-closure.test.ts` 四项——多宿主分发按调用次数独立完成且单次调用只取一个宿主取值（`--host` 为单值选项，重复给出时后者覆盖前者，已登记为遗留项）；`update --host` 在宿主根尚无副本时创建并报告；外部根解析边界（覆盖根为文件、最近上级不是目录、不适用宿主无根）；重叠消费在详情输出中呈现（`consumed_by`）与 `agents-md` 形态不落盘（含 `enable --host` 对不落盘形态给出明确错误）。
- **全量回归**：**354 项测试全绿**（单元 242、契约 51、端到端 61）；用例数与声明一致（沿用核对约定）。

#### T8 文档同步

- **README**：交付面补「宿主分发」一行；快速开始补宿主分发示例（配置覆盖、`install --host`、`disable --host`）并写明 `--host` 与 `--target` 正交、工作区外写入需 `--yes`；测试计数更新为 354。
- **`docs/one-summary.md`（活文档）**：结论补 M5 收官；新增 7.3 节「M5 状态与遗留项」（交付现状表 + 六项遗留项）；规模表刷新（`kernel/` 50 文件 11874 行、`tests/` 35 文件 8190 行、合计 112 文件 22937 行）；验证手段的测试计数更新为 354。
- **契约体系状态**：README / one-summary / architecture 的当前态表述均为**五份规范 + 五份 schema**（历史记录性条目按例不改写）；T1 已同步，本轮复核无残留。
- **遗留项登记（六项，不关闭）**：M5-L-01 Cursor 标准外字段待确认（HD-01）；M5-L-02 Codex 官方字段全集与技能根优先级待确认（403，白名单依据为本机实测）；M5-L-03 AGENTS.md 合并策略未定稿（片段不落盘）；M5-L-04 DeepSeek Harness 线索待一手确认；M5-L-05 `--host` 为单值选项（多宿主用多次调用）；M5-L-06 `docs/architecture.md` 的 CRLF 行尾符（待独立 EOL 规范化批次）。

#### M5 全链路（T0 ~ T8）

调研（宿主机制事实卡与补记）→ 第五份契约规范与 schema → 内核注册表（K-13）→ 渲染层（K-14）→ 适配器层与落位计划（K-15）→ 外部根解析与落位执行器 → 契约登记（`--host` 入口与两配置键）→ 指令层接线 → 收口（验收映射、边界审计、文档同步）。全程遵循先文档后实现、变更批次登记与快照不改动三条纪律；指令总数始终 16 条。

### 指令层：宿主分发接线（M5-T5β）

M5 的第五个批次后半段：把 `--host` 接到四条指令上。**无 `--host` 时四条指令的执行路径与一期一字不改**（既有 345 项测试零回归）。

#### 变更

- **install / update**：给出 `--host` 时，在中心库就位之后按落位计划把内容分发到宿主真实根——落位计划重定基到解析出的真实根（技能根下建 `<Skill 标识>/` 目录、规则路径直接写文件），写前**备份先行**（备份到工作区 `backups/`），写入走既有原子写原语。预演的渲染输入取自来源目录（此时中心库尚未写入），实装取自中心库副本。
- **enable / disable**：给出 `--host` 时只切换宿主真实根内该副本的可见性——技能元数据文件改名 / 还原，**目录与其余文件一律不动**，且**不写索引**（索引状态描述工作区内的目标）。工作区外写入属高影响操作，确认级别由该两条指令的「无需确认」**提升为轻确认**，非终端环境必须给出 `--yes`（否则按参数类错误拒绝），并支持 `--dry-run` 预览将变更的路径。
- **统一确认入口扩展**：`confirmationGate` 新增可选 `escalateTo`（默认沿用指令自身的确认级别），既有调用方行为不变。
- **结果载荷**：宿主分发的结果在 `data.host` 下给出宿主标识、解析后的真实根、是否写入工作区之外、产生的备份、被跳过的落位项，以及**消费宿主集合**（`consumed_by`，供详情输出呈现重叠消费）；预演时另给 `preview_writes`。
- **落位计划新增重定基原语**：`rebasePlan(plan, hostRoot)` 把注册表模板展开的路径改写到解析出的宿主真实根，并重算重叠声明；目录类与文件类落位根分别处理（后者不再拼接文件名）。
- **契约测试（345 → 350 项）**：新增 `tests/contract/host-wiring.test.ts` 五项端到端断言——`install --host` 分发到宿主真实根且无 `--host` 时不触碰真实根（回归）；`enable` / `disable --host` 改名往返后**文件集合不变**（AMB-01 锚点）且索引状态不变；`update --host` 刷新后重分发；非法 `--host` 取值报错并列出可用取值、非终端缺 `--yes` 被拒且不产生写入；`--dry-run` 预览工作区外路径且不落盘、`--target` 与 `--host` 正交各自生效。全部测试以 `config set host.<宿主>.root` 指向临时目录，**不触碰真实宿主根**。
- **实现期发现的语义澄清（非缺陷）**：本地目录来源的刷新语义是「按磁盘现状刷新记录，不重新获取内容」，只有 git 与归档来源才重新获取（见生命周期模块的处理分支）；测试期望据此修正为「改中心库现状后刷新」。

### 契约：宿主分发入口 `--host`（M5-T6）

M5 的第六个批次：**先文档后实现**的契约登记。T5 实现期发现一期的 `--target` 语义（工作区内可推导布局，属冻结数据模型）与 M5 的落位目标（宿主真实根，工作区外）**撞车**——同一取值两个互斥含义。裁决：`--target` 语义一律不动，宿主分发改用**新增选项 `--host <宿主>`**，指令总数仍为 16。

#### 契约变更（先登记）

- **指令契约规范**：第 2.2 节新增「宿主分发的入口」——`--host <宿主>` 仅 `install` / `enable` / `disable` / `update` 接受，取值来自宿主注册表（含按路径类分条的取值，如 `cursor` 与 `cursor-rules`），与 `--target` **正交**（前者决定分发宿主，后者决定工作区目标，可并用）；写工作区之外的路径属高影响操作，沿用确认机制并支持 `--dry-run` 预览。第 4.7 / 4.9 / 4.10 / 4.11 节语法行与选项表同步补入；第 4.9 与 4.10 节写明 `--host` 时只切换宿主根内副本的可见性，**不修改索引状态**、不新建副本。第 9 节修订记录新增第 34 条。
- **配置键登记**：第 4.3 节登记 `host.<宿主标识>.root`（技能根）与 `host.<宿主标识>.rules_root`（规则路径根）——宿主标识必须是注册表中已登记的标识，取值非空；这两项只影响宿主分发的落点，不影响工作区内的目标位置。
- **需求文档**：9.3.6 的 M5-R9 按裁决重写（标题改为「`--host` 宿主分发入口与两级路径粒度」，要求与验收标准同步），M5-R3 的范围项与要求项、里程碑验收标准第 9 条、约束第 1 条共四处同步；新增「M5-R9 修订批次」与计数校验，明确本次属**选项新增 + 条款修订**而非新增指令。

#### 实现登记

- **`--host` 入取值选项表**（`kernel/dispatch/parsers`）：契约中写明的选项与实现登记的一致性由既有契约测试守住。
- **宿主根配置键**（`kernel/core/index`）：`setConfig` 增加形态校验——宿主标识须在注册表内、不适用宿主（如模型提供方）拒绝、类别须与该宿主登记的落位根一致（Claude 不接受 `rules_root`）、取值非空；既有三个固定配置键行为不变。
- **契约测试（342 → 345 项）**：新增 `tests/contract/host-options.test.ts` 三项断言（`--host` 登记与四条指令语法；宿主根配置键的取值校验含五类反例；需求文档修订完成且无旧表述残留）。第三项断言在首次运行即抓到一处遗漏——M5-R3 的范围项与要求项是同一句话的两处，先前只改了一处，已补齐。

#### 未受影响

一期定稿内容（元数据规范 3.5 的落位根不变量、`--target` 语义、附录 A 至 D）、四份既有规范与五份 schema 均未改动；指令总数仍 16，FR-01 至 FR-12 不变。

### 内核：落位扩展（M5-T5α：外部根解析与落位执行器）

M5 的第五个批次按两段推进。本段交付**内核机制**（外部根解析 + 落位执行器 + 宿主根可见性切换）与契约测试；指令层接线（`--target` 绑定、确认与预演入口）留待 T5β，因其依赖 T6 的契约登记与一处语义裁决（见下）。

#### 变更

- **外部根解析器 `kernel/core/adapters/roots.ts`**：宿主落位根 = **默认路径（按宿主惯例与平台展开）+ 配置覆盖**。默认值只在有证据的组合给出（`claude` → `~/.claude/skills`、`codex` → `~/.codex/skills`、`cursor` → `~/.cursor/skills` 与 `~/.cursor/rules`、`doubao` → Windows 的 `%LOCALAPPDATA%\Doubao\...\agent_mode\workspace\.user_skills`）；未列出者（如非 Windows 的豆包、通用标准目标）要求 `config set host.<id>.root|host.<id>.rules_root` 显式给出，**内核不猜测路径**。解析结果做存在性校验（已存在但非目录、父级非目录均报错误级问题），并标记是否位于工作区之外。
- **落位执行器 `kernel/core/adapters/land.ts`**：消费 T4 的落位计划执行写盘，是**本层唯一写盘路径**。写盘纪律：只调用存储层的原子写与备份原语（不新增旁路，检索断言守住）；目录类落位（技能形态）写前**备份先行**，备份失败即中止且不改动环境；同一目标路径**只写一次**（重叠消费不重复产出，M5-R8）；`landable = false` 的落位项（指令文件载体）只登记不落盘；`dryRun` 只产出变更清单。技能形态落位支持按逐文件映射落位中心库资产，随后以渲染产物覆盖元数据文件。
- **宿主根可见性切换**：`setHostSkillVisibility` / `isHostSkillDisabled` 复用受控副本原语——禁用只把宿主副本内的 `SKILL.md` 改名为 `SKILL.md.disabled`，**不移动、不重命名、不删除任何目录**（Q-06 的三端结论）。
- **契约测试（337 → 342 项）**：新增 `tests/contract/land.test.ts` 五项断言（外部根解析的默认值 / 覆盖 / 非法根 / 不适用宿主；落位写盘与原子写无残留；备份先行与失败中止；启用禁用往返且目录不动、文件集合不变；指令文件载体不落盘与预演不落盘）。**测试全程用配置覆盖指向临时目录，绝不触碰真实宿主根**。

#### 待裁决（T5β 前置）

- **`--target` 语义撞车**：一期契约把 `--target` 定义为「目标位置标识」，其落位根是工作区内的可推导布局 `.<目标标识>/skills/<Skill 标识>`（元数据规范 3.5 的不变量、`targets[].path` 不得为绝对路径）；而 T5 的落位目标是**宿主真实根**（工作区之外）。两者使用同一取值，必须裁决其一：① 保留一期语义，宿主分发另立显式通道（如 `--host <宿主>` 或独立指令）；② `--target <宿主>` 在注册表命中的宿主上改指宿主真实根，工作区副本改用非宿主目标标识。该裁决与 T6 的指令契约登记一并处理。

### 内核：首批适配器（M5-T4）

后续阶段 M5 的第四个交付批次：把「形态实现」与「宿主绑定」分离，落地首批六宿主的适配器与落位计划（不含写盘）。

#### 变更

- **新增 `kernel/core/adapters/`**：`types.ts`（`HostAdapter` 接口、`PlacementEntry` / `PlacementPlan` / 重叠声明）、`plan.ts`（落位模板展开、落位项组装、重叠消费声明）、`rules.ts`（Cursor 规则路径形态 `.mdc`）、`index.ts`（形态实现与宿主绑定）。
- **形态与宿主分离（M5-R7 的收益落地）**：复用技能形态的四个宿主（`claude` / `codex` / `doubao` / `agentskills`）**共享同一实现对象**，无任何宿主专有代码；`agents-md` 复用指令文件降级形态；**Cursor 的规则路径形态是本批唯一新增的形态**。形态实现经 `formImplementationOf()` 暴露，供审计与测试断言「同一实现对象」。
- **注册表状态推进**：六个宿主的 `adapter_state` 由 `planned` 置为 `implemented`，可落位集合（HR-10）由空变六项；`deepseek` 保持 `planned` 且无适配器（不适用 / 模型提供方）。
- **落位计划（供 T5 消费）**：落位项含完整目标路径（`.claude/skills/<Skill 标识>/SKILL.md`、`.cursor/rules/<Skill 标识>.mdc`、`AGENTS.md`）、落位根类别、是否位于工作区之外（豆包的用户技能根）、`landable` 与不可落盘原因、消费宿主集合；并在计划层声明**重叠消费**（Claude 技能根被 Claude 与 Cursor 读取；通用指令文件被 Codex 与 Cursor 读取）。
- **只读合规校验**：适配器的 `verify` 解析产物元数据块，断言必填字段齐全且字段集不超过「标准六字段 + 宿主白名单」，并可校验规则文件扩展名与 `alwaysApply` 前置元数据。
- **规范兼容澄清**：明确 `path_template` 的粒度由 `kind` 决定（`skill` / `external` 为技能目录模板，`rules` 为规则文件模板），落位计划据此判定是否需要拼接产物文件名。见 `docs/specification/host-registry.spec.md` 修订记录第 4 条。
- **契约测试扩展（328 → 337 项）**：新增 `tests/contract/adapters.test.ts` 九项断言（六宿主结构合规、字段策略边界、同核验证、降级片段与不落盘、Cursor 规则形态、落位计划结构与重叠声明、不适用宿主、可落位集合生效、适配器层不写盘）；并同步 T2 中因 `adapter_state` 与消费集合变化而语义过期的两条既有断言（改行为回看用例语义）。

### 内核：渲染层核心（M5-T3）

后续阶段 M5 的第三个交付批次：把「内部技能表示 → 宿主可识别产物」渲染为纯函数，接入 T2 的透传白名单，保持渲染与落位解耦。

#### 变更

- **新增 `kernel/core/render/`**：`types.ts`（输入输出类型：`RenderSource` / `RenderOutcome` / `RenderLedger`）、`fields.ts`（内部字段 → 标准六字段的映射与规整）、`index.ts`（共用渲染核心 `renderWithPolicy` 与形态调度 `renderSkill` / `renderEntry` / `renderStandardSkill`）。
- **保守渲染优先**：默认只渲染标准六字段（`name` / `description` / `license` / `compatibility` / `allowed-tools` / `metadata`）；扩展字段仅在宿主策略为 `host_declared` 且命中白名单时渲染。映射细节：触发关键词并入描述（标准无对应字段）、运行时依赖并入兼容性文本、版本 / 作者 / 主页 / 标签 / Skill 依赖落 `metadata`（列表转字符串）。
- **白名单接入（DP-04）**：透传判定收敛为**唯一实现** `resolveDeclaredExtensions`，注册表查询路径与渲染层共用；命中即透传，未命中忽略并回报 `W-FIELD-004` 警告且点名被忽略字段（不静默丢弃）。
- **禁用字段双层防线**：注册表加载期拒绝白名单登记该字段（T2 校验），渲染期无论白名单如何一律拒绝——两层防线相互独立，任何宿主的产物中都不会出现该字段。
- **共用渲染核心**：通用 Agent Skills 标准目标（`renderStandardSkill`）与逐宿主适配器走同一实现，差异只是策略（`standard6` / `host_declared`），不设两套渲染代码；同一策略下两条路径产物深度相等（契约测试守住）。
- **降级形态**：指令文件载体产出 AGENTS.md 条目化片段（无 YAML 元数据块），`degraded = true` 并声明缺少的三项能力（自动发现 / 按需加载 / 工具预授权）；只产出片段、不落盘（合并策略未定稿）。
- **渲染与落位解耦**：本层只返回内存中的文本与结构，不写盘；契约测试以源码检索断言渲染层不得出现写盘 API，落盘属 T5 的落位扩展。
- **契约测试扩展（320 → 328 项）**：新增 `tests/contract/render.test.ts` 八项断言（标准六字段与标准一致、确定性、白名单命中与未命中警告、保守渲染、禁用字段双层防线、同核验证、降级片段、不写盘）。

### 内核：宿主注册表（M5-T2）

后续阶段 M5 的第二个交付批次：把宿主差异收敛为一份可校验的注册表数据，内核侧只保留加载、校验与查询，不含渲染与落位。

#### 变更

- **新增 `kernel/core/hosts/`**：`types.ts`（条目类型与取值域常量）、`registry-data.ts`（首批 7 条注册项）、`validate.ts`（宿主注册表规范第 5 章的 HR-01 ~ HR-12 校验，产出标准问题条目）、`index.ts`（加载与查询接口）。注册表**随内核交付、不位于工作区**，工作区布局不变；加载结果被冻结，作为宿主差异的只读事实源。
- **首批 7 条注册项**：`claude`、`codex`、`cursor`、`doubao`、`agentskills`（通用标准目标）、`agents-md`（通用指令文件载体）、`deepseek`（不适用 / 模型提供方）。每条含证据等级、三维分类（是否支持 skill 机制 / 是否仅支持规则文件 / 落位根被哪些宿主消费）、落位根、能力声明、渲染与透传策略、适配器实现状态（本批均为 `planned`，T4 落地适配器后置为 `implemented`）。落位根重叠消费据实登记（`.claude/skills/` 与 `.codex/skills/` 同为 Cursor 兼容读取）。
- **透传白名单按 DP-04 落位**：白名单只登记标准 6 字段之外的字段（Codex 20 项、豆包 15 项）；命中即透传，未命中忽略并回报 `W-FIELD-004` 警告（不静默丢弃）；`disable-model-invocation` 在任何宿主下都被拒绝（HR-09 兜底，加载校验同时防止白名单误登记该字段）。
- **契约测试扩展（314 → 320 项）**：新增 `tests/contract/host-registry.test.ts` 六项断言——注册表数据同时通过 schema 校验与 HR 校验、字段完整性、HR 反例（HR-01/02/03/04/05/06/07/08/09/11）、白名单行为（含禁用字段全宿主拒绝）、查询接口（按标识与三维分类）、新增宿主零内核改动与事实源只读。
- **实测复核修正**：Codex 的 frontmatter 字段实测量由 26 种更正为 **27 种**（白名单取标准字段之外的 20 项），设计与计划的对应表述同步更正；审批记录以补记承接。
- **规范兼容澄清三处**（见 `docs/specification/host-registry.spec.md` 修订记录第 2、3 条）：① `support_state = not_applicable` 的宿主豁免 HR-05 / HR-06（`roots` 与 `adapter_ref` 改为条件必填）；② HR-06 的技能根判定同时接受 `skill` 与 `external` 类落位根（工作区外技能根此前会被误判为缺技能根）；③ 载体形态补充「类型化数据模块」一档——内核以单文件可执行交付，本期实现用 `kernel/core/hosts/registry-data.ts` 而不引入构建期资源加载，字段契约与 `host_registry.yaml` 等价。

#### 已知项

- **`docs/architecture.md` 的行尾符（EOL）**：该文件是全库唯一的 CRLF 文档（其余文档为 LF），属既有状态、非本批引入。当前处置为**登记已知项、推迟处理**：不在功能批次中混入整文件空白差异，待 M5 收尾后作为独立的 EOL 规范化批次一次完成；若后续某批次必须触碰该文件，可顺势自然转为 LF。`git blame` 可用 `-w` 忽略空白，但整文件 diff 噪声是实际成本，故不提前做。

### 契约：第五份规范（宿主注册表）

后续阶段 M5 的第一个交付批次，按「先文档后实现」推进：只建立契约资产与测试断言，不含内核实现。

#### 变更

- **新增第五份契约规范 `docs/specification/host-registry.spec.md`（规范版本 1）**：宿主注册表成为独立契约资产（设计决策 DP-03）。规范定义载体与全局不变量、条目字段（宿主标识、展示名、适配器实现状态、支持状态、证据、三维分类、落位根、能力声明、渲染与透传策略、适配器引用、待确认项）、证据等级分级、12 条校验规则（HR-01 ~ HR-12）、最小合法示例与版本兼容策略。注册表**随内核交付、不位于工作区**，既有工作区布局不变；透传白名单**禁止**包含 `disable-model-invocation`。
- **新增机器可读形态 `schemas/host_registry.schema.json`**：与规范逐字段对齐，并把「状态与证据绑定」（HR-04）、「三维分类自洽」（HR-05）、「渲染模式与白名单一致」（HR-08）、「透传禁列」（HR-09）编码为可机器校验的约束。
- **契约测试扩展（312 → 314 项）**：新增宿主注册表的功能断言（合法样本通过；缺少必填、状态与证据不符、三维分类两项同假、落位根为空、透传模式缺白名单、白名单含禁止字段、出现未登记字段、版本不受支持均被拒）与「规范文档示例可通过校验」断言；字段集一致性断言扩展至第五份，含顶层与条目的必填集合比对。
- **文档表述同步**：`README.md`、`docs/one-summary.md` 的契约份数与测试计数由「四份 / 312 项」更新为「五份 / 314 项」；`docs/architecture.md` 的头部信息表、仓库树与目录用途同步，并以**新增补充记录**承接（不改写历史条目）；需求文档附录 C 补登新规范，同时修正「指令契约规范」一行残留的「十五条指令」为十六条（表述修正，指令总数自 restore 裁决批次起即为 16）。
- **既有契约未受影响**：原四份规范与四份 JSON Schema 的内容与版本均未改动；指令总数仍为 16、未新增选项。

### 工程：已知选项登记与冒烟脚本可用性

#### 变更

- **内核分发形态的换法登记为已知选项（`N-13`）**：随包产物已在不改架构的前提下下降 7.7%（安装包 119.7 MiB、便携 119.5 MiB）。进一步的空间来自把内核改成随包分发单个脚本包、由 Electron 以 Node 模式运行——实测可省约 23 MB/产物（119.7 → 97.8 MiB）与 92 MB/解包目录。评估结论：**不采用**。AD-09 当初选定独立可执行文件的根本理由是内核与界面框架解耦，为约 19% 的分发体积牺牲架构边界不划算；且体积已由零风险手段达成主要收益，边际收益递减。第 7.3 节标题相应改为「已知缺口与选项登记」，并新增一段说明该类条目的性质：不是缺口，记录以便日后按指标重新评估，不关闭讨论。
- 界面冒烟脚本的 `--app` 支持相对路径：路径在脚本内解析为绝对路径后再交给 Electron 子进程（子进程以 `gui/` 为工作目录，相对路径直接传给 `spawn` 会得到「明明存在却 ENOENT」的假象）；缺取值时给出明确用法提示并以退出码 `2` 结束。

### 工程：内核与随包产物体积优化

纯工程批次：不动任何指令语义、校验、问题码与契约，只做体积构成分析与有依据的裁剪。

#### 体积构成分析（优化前）

**内核可执行文件 `build/kernel/skill-manager.exe` = 88.0 MiB**：Node 运行时副本 87.2 MiB（99.2%）+ SEA 代码块。代码块是由 esbuild 打出的单个 CommonJS 包 **737 KB**（自有代码 326 KB，依赖 479 KB；依赖占比：`tar` 84 KB、`node-stream-zip` 40 KB、`yaml` 约 190 KB、`semver` 约 90 KB）。结论：**内核侧没有可裁剪空间**——产物就是 Node 运行时本体，误打包源码/测试/开发依赖的情况不存在（esbuild 只沿静态引用打包）。

**随包产物 `win-unpacked` = 469.2 MiB**（按顶层项）：

| 项                                                                   | 体积     | 占比  | 说明                                                             |
| -------------------------------------------------------------------- | -------- | ----- | ---------------------------------------------------------------- |
| `skill-manager.exe`                                                  | 245.6 MB | 49.9% | Electron 本体                                                    |
| `resources/`                                                         | 107.3 MB | 21.8% | 其中内核可执行 92.0 MB、`app.asar` 15.2 MB、`elevate.exe` 0.1 MB |
| `locales/`                                                           | 50.6 MB  | 10.3% | 55 个语言包                                                      |
| `dxcompiler.dll`                                                     | 25.7 MB  | 5.2%  | Chromium GPU 组件                                                |
| `LICENSES.chromium.html`                                             | 20.5 MB  | 4.2%  | Chromium 许可全文                                                |
| `resources.pak`                                                      | 12.4 MB  | 2.5%  | Chromium 资源                                                    |
| `icudtl.dat`                                                         | 10.9 MB  | 2.2%  | ICU 数据                                                         |
| 其余（vk_swiftshader、d3dcompiler_47、ffmpeg、dxil、pak、vulkan 等） | 约 26 MB | 5.5%  | Chromium 运行组件                                                |

关键发现：`app.asar` 里 601 个条目有 590 个是 `node_modules`（`vue`、`@vue/*`、`@babel/*`、`postcss` 等），全是**构建期依赖**——渲染层已由 Vite 把 Vue 内联进产物，主进程与预加载只引用 `electron` 与 Node 内置模块（已逐一核对 `out/main/index.js`、`out/preload/index.cjs` 的引用）。这 15 MB 是白带的。

#### 优化清单（有依据的两项）

1. **随包排除构建期依赖**：`files` 增加 `'!node_modules/**'`。`app.asar` 15.2 MB → **239 KB**。
2. **裁剪语言包**：`electronLanguages: [zh-CN, en-US]`。`locales/` 55 个 50.6 MB → **2 个 1.12 MB**（系统语言不在列表时 Chromium 回退 en-US，中文与英文之外的语言包对界面无影响——界面文案是本项目自己的 Vue 组件）。

#### 体积对比（优化前后）

| 产物                    | 优化前                    | 优化后                        | 变化                |
| ----------------------- | ------------------------- | ----------------------------- | ------------------- |
| 内核可执行文件          | 88.0 MiB                  | 88.0 MiB                      | 不变（无内容可裁）  |
| 安装包（NSIS）          | 135,924,849 B / 129.6 MiB | **125,519,722 B / 119.7 MiB** | −10.4 MB（−7.7%）   |
| 便携单文件              | 135,710,634 B / 129.4 MiB | **125,305,517 B / 119.5 MiB** | −10.4 MB（−7.7%）   |
| 解包目录 `win-unpacked` | 469.2 MiB                 | **408.0 MiB**                 | −61.2 MiB（−13.0%） |

#### 评估后未采用的项（附数据与理由）

- **`compression: maximum`**：实测安装包 125,519,722 → 125,519,785 B（相差 63 字节），收益为零而打包耗时增加，**已回退**为默认档位。载荷以已压缩的二进制为主，7z 高压缩档榨不出空间。
- **内核改用「Electron 以 Node 模式运行 .cjs」形态**：实测内核可执行文件在安装包与便携产物中各占 **约 23 MB**（临时移除内核后 119.7 → 97.8 MiB），解包后占 92 MB，换成 0.7 MB 的脚本包可省下这些体积。但这会改变 AD-09 已选定的「独立可执行文件形态」，属架构决议变更，**不在本批次擅动**，留待裁决。
- **裁剪 `dxcompiler.dll`（25.7 MB）、`vk_swiftshader.dll`、`dxil.dll`**：Chromium 的 GPU 组件，裁剪可能在部分显卡/驱动路径上崩溃，属功能风险，不做。
- **移除 `LICENSES.chromium.html`（20.5 MB）**：Chromium 分发所需的许可全文，属合规要求，不做。
- **自建 Node 运行时（small-icu）或对内核可执行去符号**：需要自建工具链，且会牺牲可诊断性，不做。

#### 说明

- **行为零变更**：本批次未改动任何内核或界面源码（`git status` 只有打包配置、冒烟脚本与文档），312 项测试与全部校验口径不变。
- **等价抽查**：同一工作区上，`list`、`inspect <id>`、`validate` 三条指令在「随包内核可执行文件」与「源码入口 `node kernel/entry/cli.ts`」两侧的 JSON 输出**逐字节一致**（799 / 2162 / 445 字节）。
- **三种启动方式回归**：开发产物、免安装目录、便携单文件各跑一遍界面冒烟，均为 **9/9**。
- **打包环境注意**：本机 electron-builder 下载工具链时报证书验证失败（根证书只在系统存储中），需以 `NODE_OPTIONS=--use-system-ca` 打包。属环境事实，未写入仓库配置以免影响其他环境。

#### 界面冒烟扩充（2 项）

- 恢复确认弹窗展示预演的覆盖提示与逐文件清单。
- 确认后恢复执行并写回原件（夹具在造好备份后改写原件，断言磁盘内容真的回到备份取值——这条链路无法被「只点了按钮」蒙混过关）。

### 二期：界面恢复入口（N-12 收口，二期功能面全清）

#### 新增

- `restore --list [<Skill 标识>]`：备份列表的**读取出口**。界面不得直读工作区文件（含备份目录），因此列表由内核读取各载体清单产出——每项给出 Skill 标识、时间戳、载体类型、文件数与载体位置，并给出 `total` 与 `filtered_by`；只读清单、不校验载体内容，工作区未初始化或备份目录不存在时返回空列表（退出码恒为 `0`，空列表是正常结果）。给出标识时按参数类问题校验命名规范，不做路径拼接。
- 备份管理页的**恢复流程**：列出可用备份（标识、时间戳、载体类型、文件数）→ 点「恢复」→ 确认弹窗展示内核 `--dry-run` 的真实预览（将写回的文件清单、目标位置现状与结论提示）→ 确认后由桥接器带 `--yes` 执行 → 结果与问题码进状态栏。取消时不发写请求。
- 确认弹窗新增**逐文件清单**区块（读预演载荷里的 `files`），恢复与安装类预览共用。
- 界面冒烟新增一项检查（共 7 项）：备份管理页经内核列出真实备份并给出恢复入口。

#### 变更

- `restore` 的预演载荷补 `notes`：写明目标位置现状（覆盖现有原件 / 按备份重建）、该标识是否已登记，以及「恢复只读消费备份载体」。确认弹窗只展示内核给出的影响范围，不自行编造。
- 备份管理页移除「一期没有列出既有备份的指令、备份载体目录需要自行查看」的过期提示。
- 桥接层新增 `restoreList(id?)` 门面（`restore` 至此有两条门面方法：恢复与列表）。
- 契约回写：第 4.16 节补 `--list` 的语法、行为、载荷与退出码；第 7.3 节 `N-12` 标记为已完成。
- **固化第四条工程约定**：含子进程的指令断言走独立进程取退出码与标准输出。由来：端到端测试的 `capture()` 就地替换标准输出，被测指令一旦内部 `spawn` 子进程，测试框架自己写往同一管道的协议消息会被一并捕获，表现为「断言无故失败」；`runCli()` 用真实子进程隔离这条路径。

#### 说明

- 内核业务逻辑零改动：本批次只扩展了参数解析（`--list` 登记为布尔选项）与载荷（列表载荷、预演提示），恢复的写路径、原子性与确认级别都沿用既有实现。
- 界面仍遵守「数据源唯一」：备份列表、预览与执行全部经内核子进程与标准输出，渲染层不接触 Node，也不读 `backups/` 目录。
- GUI 侧改动集中在渲染层与桥接门面（备份管理页、确认弹窗、`restoreList`），内核分层校验照常通过。

### 二期：运行时探测与版本比较（N-10 收口）

#### 新增

- `deps` 的**运行时维度**：按平台解析声明的外部运行时（POSIX 用 `command -v`，Windows 用 `where`），执行其 `--version` 并把输出解析为语义化版本，再按元文件里的范围表达式判定；载荷新增运行时条目——运行时名称、期望的约束原文、探测到的版本、命中命令的位置与结论。
- 问题码新增**运行时类**：`E-RUN-001` 运行时不可用、`E-RUN-002` 版本不满足、`E-RUN-003` 版本无法解析、`E-RUN-004` 约束无效、`E-RUN-005` 探测失败；该类与依赖类一并归入退出码 `6`。依赖类中原有的 `W-DEP-005` 标记为已由该类取代（保留编码不复用，不再产出）。
- 探测支持 **PATH 注入与执行器注入**：测试可完全脱离真实外部运行时，分别覆盖 `command -v` 与 `where` 两个分支。

#### 变更

- 内核对第三方依赖新增 `semver`（纯 JS，语义化版本范围判定）与 `@types/semver`（仅构建期类型）。理由：`^1.2.3`、`~1.2.3`、`>=1.0.0 <2.0.0`、`1.2.x` 这类范围表达式自研解析易错，而判定正确性直接影响依赖结论。内核第三方依赖此后为四个：`yaml`、`tar`、`node-stream-zip`、`semver`。
- **探测结果不入索引、不入运行期结论**：运行时是否可用取决于执行环境，索引保持环境无关，同一份索引在不同机器上含义一致。`scan` 与 `validate` 的结论仍只取决于 Skill 自身的内容与声明——运行时缺失不会把内容完好的 Skill 判为校验不通过。
- 文档回写：元数据规范 3.3（`runtime` 的约束写法与「运行时依赖的边界」）、5.3（新增「判定边界」一行，明确本项只判定 Skill 之间的依赖）；指令契约 4.13（行为 1/2 由「一期未实现」改为正式语义，补探测边界、输出载荷与退出码）；结果规范 4.2/4.3/5.2/5.3（新增运行时类与依赖档映射）；需求文档新增「运行时依赖的探测边界」裁决批次条目；`skill_meta.schema.json` 的 `runtime` 描述同步；缺口登记表 `N-10` 关闭。
- 交付盘点文档 `docs/one-summary.md` **整体刷新为二期现状**（标题与文档状态、指令表补第 16 条、问题码与写入权限边界、关键机制、规模与测试计数、缺口登记表、二期 backlog），并注明一期收官时点的快照以 `CHANGELOG.md` 的「一期收官」条目为准。

#### 说明

- 失败面**收窄而非吞掉**：约束不可解析时直接报错且不再探测（拿非法约束去比版本没有意义）；命令解析失败、`--version` 超时或无法执行、输出解析不出语义化版本各归明确问题码。`--version` 输出兼容 `v22.1.0`、`git version 2.43.0.windows.1`、`Python 3.12.1` 等写法，解析不出时不猜版本。
- 命令一律以参数数组调用、**不经 shell**；运行时名称只作为参数传递（POSIX 侧用 `command -v "$1"` 的位置参数，不做文本拼接）。
- 本批次未改动界面：`deps` 载荷只新增字段，对既有消费方向后兼容。

### 二期：内容漂移定位（N-07 收口）与备份时间戳唯一化

#### 新增

- 索引派生区新增**逐文件内容摘要** `digests`：键为文件相对 Skill 目录的路径，值为该文件字节流的摘要，与聚合指纹共用同一参与范围与排除规则（排除元文件、版本控制目录、临时文件与符号链接）。登记、安装、更新、恢复与导入都会写入。
- 内容一致性校验（V-07）由聚合级报告升级为**逐文件定位**：内容变化、新增与删除三种情形各成一条，每条给出文件相对路径与新旧摘要，仍是警告级、不改变退出码。
- 备份载体清单的 `timestamp` 具备**唯一性**：同一 Skill 在同一秒内产出多份备份时，从第二份起按毫秒精度扩展（`.001` 起），清单取值与目录名一一对应；备份枚举按真实先后排序（纯秒级取值等价于该秒的 `.000`，避免字符串比较把毫秒形式误排在前面）。

#### 变更

- 备份载体清单在 schema 中补登 `type` 为必填字段（上一批次已写入该取值，schema 未声明必填），`timestamp` 模式允许毫秒后缀。
- 导出物不含逐文件摘要，且**不计入被剥离项清单**：它是内核内部派生数据，既非敏感信息也非用户自研字段，列入清单只会掩盖真正的剥离项。导出记录的字段集不变，聚合指纹仍在导出物中；导入时按磁盘现状重算两级取值。
- `inspect` 的记录载荷随索引原样带出 `digests`，便于宿主在内容漂移时定位。
- 契约与规范回写：元数据规范 2.2（时间戳唯一性）、2.3（逐文件摘要规范）、4.4（派生区新增可选字段与必填性说明）、5.4（输出要求改为必须逐文件列出）、5.5（说明 `digests` 不参与派生区篡改检测）；索引格式规范 3.2 与 5.3；指令契约 4.6、4.8.1、4.12、4.14 与 7.3（N-07 关闭，新增 N-12）。

#### 说明

- 新增可选字段属**向后兼容**变更，索引规范版本保持为 `1`：旧索引缺 `digests` 照常读取，扫描一次即回填，回填之前内容一致性校验退化为聚合级报告，不猜测具体文件、不误报。
- 时间戳唯一化选择在**写入侧**落地（而非读取侧去重）：时间戳是备份的对外标识与 `restore --timestamp` 的寻址依据，唯一化才让它真正可寻址；目录名与清单取值一一对应，不再出现「一个取值对应多份载体」。毫秒形式只出现在备份载体清单，其余时间字段仍为秒级精度。
- 本批次未引入新的第三方依赖，内核依赖仍为 `yaml`、`tar`、`node-stream-zip`。

### 二期：备份恢复与载体枚举（N-08 收口）

#### 新增

- 第 16 条指令 `restore <标识> [--timestamp <时间戳>] [--dry-run] [--yes]`：从备份载体把内容写回中心库、按落位计划重分发副本、刷新或重建索引记录；省略 `--timestamp` 时取该标识最新的一份备份。载荷给出逐文件路径与文件数量、备份位置与时间戳与载体类型、各目标的重分发结果，以及「请执行扫描」的提示。
- 备份载体枚举：S-08 新增按标识枚举载体（按清单声明的时间戳升序）与载体自身完整性校验（类型是否受支持、内容目录是否存在、文件数与载体摘要是否与清单一致）。
- 备份载体清单新增 `type` 字段，本批次取值域仅 `full`（完整文件载体）；不支持的取值拒绝恢复，扩展留给后续。
- 问题码新增 `E-BAK-003`（没有可恢复的备份）、`E-BAK-004`（载体损坏）、`E-BAK-005`（载体类型不受支持），结果规范同步登记。
- 调度层新增 `restore` 的确认级别（常规确认，目标已有原件时确认内容写明将覆盖）+ 动作标签与预演载荷；命令行帮助新增该指令；`--timestamp` 登记为取值选项。界面桥接层新增 `restore` 门面，指令门面增至十六条。

#### 变更

- **指令清单由 15 条增至 16 条**：契约第 3 节总表新增第 16 行、新增第 4.16 节完整契约（用途、与 `import` 的分工、语法、七条行为、选项语义、输出载荷、退出码、预演与确认）；需求文档 5.2 节、架构文档附录 A、交付盘点文档与 README 同步；构建期契约校验的指令数断言由 15 改为 16。
- 契约第 4.8.1 节载体清单把 `type` 列为必填字段，写明取值域与「不支持的取值拒绝恢复」的语义。
- 缺口登记表 `N-08` 标记为已完成：备份载体的恢复与载体枚举一并收口。备份保留策略不变——不自动清理，恢复只读消费。

#### 说明

- 恢复不判定校验结论：已登记的记录保持原运行期结论不动；未登记时重建记录并取保守值（`invalid` 加 `E-INDEX-002`），两种情况都在载荷里提示执行扫描——判定权仍归扫描。
- 恢复保持副本原有可见性：已存在的副本按磁盘现状保留启用或禁用，不存在的副本按元文件声明创建；载体内容在恢复全过程中不被改动。
- 本批次未引入新的第三方依赖，内核依赖仍为 `yaml`、`tar`、`node-stream-zip`。

### 二期：来源扩展（本地部分）

### 二期：来源扩展（远端部分，N-05 收尾）

### 新增

- 远端来源支持：安装与刷新都接受远端 Git 地址与远端归档地址。远端仓库克隆后复用本地仓库的读取路径，远端归档下载后复用本地归档的解压路径（含单层自动下钻与全部路径穿越防护）。
- 远端问题码补全：`E-SRC-006` 超时、`E-SRC-007` 下载失败、`E-SRC-008` 体积超限、`E-SRC-009` 协议不在白名单、`E-SRC-010` 需要认证。来源类编码至此覆盖本地与远端两种形态。
- 扫描式安装：`install` 的远端地址按路径形态推断类型——以归档扩展名结尾的按归档处理，其余按仓库处理；`update` 以元文件声明的类型为准。

### 变更

- 归档内容根支持**单层自动下钻**：解压后根目录不含元文件时，若根下恰好存在一个子目录且该子目录内直接含元文件，则下钻一层；多个候选或下钻后仍缺失都按获取失败上报并写明原因。
- 远端获取的安全与稳定性约束：协议白名单（https 与 git，另允许指向本机回环地址的 http）、克隆与下载都有超时、下载有体积上限（响应声明与实际接收两处校验）、克隆与下载都在临时目录内完成且失败不残留。
- 克隆不使用浅克隆（`--depth 1`）：浅克隆在 dumb HTTP 上不被支持，而自建镜像常用该协议；代价是克隆体积更大，由超时上限兜底。
- 克隆时禁用交互提示（`GIT_TERMINAL_PROMPT=0`）：私有仓库立即失败并归入认证类问题，不会挂起等待输入。

### 新增

- 来源扩展的本地部分：安装与刷新都接受**本地 Git 仓库路径**与**本地归档文件**（zip、tar、tar.gz）作为来源，与原有的本地目录来源并存。
- 来源声明扩出本地形式：元文件的 `source` 增加 `location` 字段，指向本机的仓库目录或归档文件；给出它之后不再要求 `url` 与 `ref`。远端形式（Git 地址与下载链接）登记为下一批次，传入时按来源类错误拒绝，不静默忽略。
- 问题码新增 `E-SRC-003`（来源获取失败）、`E-SRC-004`（归档或仓库内容不安全）、`E-SRC-005`（来源所需的外部命令不可用），四条来源类编码路径至此完整。
- 刷新语义扩展：来源为本机仓库或归档时，先按声明重新获取内容并替换中心库原件，再重分发副本、最后写索引；任一步失败即整体失败。

### 变更

- **内核对第三方运行时依赖的策略放宽**：新增 `tar` 与 `node-stream-zip` 两个纯 JavaScript 依赖用于归档解压。理由：归档解压无法在不写一个完整解析器的前提下自研，而这两个库都是纯 JS、无原生扩展，随内核一起打包进单文件可执行产物，不引入编译期负担。`git` 走系统命令而不引入库，缺失时给出明确错误与安装引导。内核的第三方依赖此后为三个：`yaml`、`tar`、`node-stream-zip`。
- 安装与刷新的入口改为异步：来源获取涉及子进程与文件解压，必须等待完成；同步主体保持不变，临时目录由异步外壳统一释放。

### 说明

- 安全边界：归档条目逐条校验（拒绝绝对路径、上级目录跳转与链接条目），解压时逐级确认父目录为真实目录以堵住符号链接穿越，来源标识按白名单校验且禁止以短横线开头，`git` 一律以参数数组调用不经 shell。
- 本地仓库读取的是**已提交内容**（`git archive`），不含版本控制目录与未提交改动。该语义已裁决维持：已提交内容确定、可复现，且天然排除版本控制目录与构建产物——「从来源安装与更新」取的是发布态，不是工作区临时状态；未提交改动不可见是该语义的既定取舍，已写入契约。
- 归档不支持内容根外层再套一层目录：内容根必须直接包含元文件，否则按获取失败上报并给出说明。

### 一期收官（2026-10-15）

一期功能面**没有已知的未实现项**。完整盘点见 [docs/one-summary.md](docs/one-summary.md)，要点如下：

| 交付面 | 结论                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 功能   | 契约清单的 15 条指令全部实现；桌面外壳含仪表盘、详情、安装、校验报告与确认流程，并已打包为安装包与便携单文件                 |
| 契约   | 四份规范文档与四份 JSON Schema 齐备，字段一致性由契约测试守住；问题码 42 个、退出码 7 档，专属优先原则已写入规范             |
| 架构   | 内核零界面依赖由构建期检查硬拦；GUI 只经子进程与标准输出通信；副本按约定推导位置，原件缺失仍可回收                           |
| 工程   | 254 项测试、构建期检查、界面冒烟与打包验证；三条工程约定（用例数核对、改行为回看用例语义、选项登记一致性）均来自实际踩过的坑 |

缺口登记表 11 项中 7 项已实现，其余 4 项（来源扩展、每文件漂移定位、备份恢复、运行时探测与版本比较）归入二期；另有 2 项已知限制（内核可执行文件体积、备份载体枚举）不阻塞。二期规划与优先级建议见盘点文档第 7 节。

### 新增

- 内核 L4 存储层：YAML 序列化、原子写入与事务、文件锁、路径解析与越界防护、工作区布局、索引持久化、中心库受控副本。
- 内核 K-01 元数据模型：元文件与索引的类型定义、字段校验、依赖存在性与环路检测、索引版本校验。
- 内核 K-02 发现与登记服务：扫描技能根目录、组装与更新索引记录、计算运行期结论。
- 内核 K-03 索引服务：初始索引构造、索引载入与写回，未识别字段原样保留。
- 内核 K-04 生命周期编排：安装与卸载两条流程，含元数据校验、依赖检查、冲突检测、写入中心库、创建受控副本、登记索引与失败回滚。
- 内核 K-07 冲突检测：落位映射冲突与目标占用冲突，只报告不处置。
- 内核 K-09 完整性指纹：按契约规则计算内容指纹。
- 内核 K-10 目标适配：把元文件声明的落位目标解析为工作区内的绝对路径。
- 内核 K-05 校验引擎：只读校验元数据、配置与索引，产出分级报告；实现 V-07 内容一致性、V-14 派生区篡改、V-16 跨文件投影一致性、V-17 引用路径可达四条规则，并把 V-01 至 V-06、V-08 至 V-13、V-15、V-18 汇总进同一份报告。
- 内核 K-08 备份服务：卸载前把中心库原件完整备份到工作区的备份目录，并输出备份位置、时间戳与文件数；恢复一侧留待二期。
- 存储层 S-08 备份载体读写：备份目录布局、逐文件校验、备份清单、失败清理。
- 调度层 C-03 确认与预演策略：确认级别登记表（指令到级别的唯一事实源）、确认判定、提示渲染与回答判定；交互通道由宿主注入，便于在无终端环境下测试。
- 内核 K-06 依赖分析服务：依赖条目分级（可用、已登记但不通过、不在索引）、传递影响面、牵涉指定标识的依赖环。
- 内核 K-03 查询能力：列表筛选与分组计数、单个 Skill 的完整信息与指纹比对、配置区原样读取。
- 内核 K-08 导出：备份文档组装、敏感与未知字段剥离并登记、目标路径防护、原子写入。
- 指令：新增 `list`、`inspect`、`config get`、`deps`、`export` 五条只读或导出类指令，全部零写入。
- 内核 K-04 生命周期编排补齐启用、禁用与刷新：受控副本按需补齐、副本内技能元数据文件改名切换可见性、索引状态与目标摘要同步，以及按磁盘现状重投影记录并刷新派生区。
- 指令：新增 `enable`、`disable`、`update`、`config set` 四条写操作指令。
- 指令：新增 `import`，从导出的清单恢复索引记录——整体校验后逐条登记，既有标识一律跳过不覆盖，只作用于索引层不触碰磁盘文件，运行期结论交由后续扫描判定。
- 四份 JSON Schema：元数据、索引、结果封装与备份文档的机器可读形态，逐字段对齐四份规范文档；`schemas/` 不再是空占位。
- 桌面外壳（`gui/`）：Electron 主进程窗口与生命周期、预加载白名单、Vue 3 渲染层、electron-vite 构建配置与 electron-builder 打包配置。
- G-02 内核桥接器：以子进程调用内核指令入口并解析结构化结果，提供十五条指令的具名门面；写操作走「预览 → 确认 → 执行」，取消时不发写请求；通道失败映射为宿主通道问题码并保留原始诊断。
- 渲染层页面：仪表盘卡片列表（状态优先级 失效 > 禁用 > 启用）、详情/安装/校验报告/确认弹窗、空工作区引导、底部操作日志。
- 界面冒烟脚本：经 DevTools 协议校验真实界面，支持开发产物与打包产物两种模式。
- 桥接层测试 6 项：以真实子进程联调十五条指令、预览与取消路径、确认拒绝的原样回传、通道失败映射。
- 内核独立可执行文件：构建脚本把内核连同依赖打成单文件、生成单文件可执行代码块并注入 Node 运行时副本，产出 `build/kernel/skill-manager.exe`；打包时随应用复制到 `resources/kernel/`，打包产物无需任何环境变量覆盖即可自洽运行。
- 内核新增可执行形态入口：与源码形态入口共用同一套指令实现，只去掉「是否作为入口被直接执行」的判定。
- 应用图标：程序化绘制，不依赖任何图形库——形状用带符号距离场加解析抗锯齿，PNG 与 ICO 用最小编码器直接写出；产出七档尺寸（16 至 256）的 ICO 与 PNG，配色沿用界面规范的香槟金强调色。
- 图标生成脚本 `build:icon`：图标的唯一来源是脚本本身，任何尺寸都能精确重生成。
- 目标落位根约定：副本位置改为按「工作区根 + 目标标识 + Skill 标识」推导（落位根为 `.<目标标识>/skills`），元文件声明的落位路径必须与该约定一致；副本定位从此不依赖中心库原件是否存在。
- 逐文件落位：元文件的 `file_map` 提供时按映射逐文件落位（支持目标子目录），缺省时整目录复制；落位计划逐文件进入载荷。
- `install` 的 `--target` 与 `--scope` 真实生效，`--mode` 接受 `copy` 并显式拒绝其他取值。
- 卸载与刷新补齐影响范围：卸载给出逐文件路径列表与数量，刷新按落位计划重分发已存在的副本并保持可见性。
- 索引运行期结论区新增最近扫描时间字段，只由扫描动作维护；`inspect` 的「最近扫描时间」取自该字段。
- 依赖判定的职责边界收敛：判定唯一实现在元数据模型服务（依赖判定与环检测），登记与刷新服务是收敛器，依赖分析服务只做呈现，不得另写判定逻辑。
- 跨层契约词汇表：问题码常量与结果形状的唯一定义处，位于依赖方向最底层。
- 指令调度层：参数解析、指令注册与路由、结果装配与退出码派生、三种输出通道渲染。
- 命令行入口：15 条指令的最小闭环，一期指令清单至此全部可用。
- 测试共 268 项（单元 209、契约 9、端到端 50），覆盖原子写入中断与瞬时占用重试、路径穿越注入、幂等扫描、依赖失效级联、不合格记录生成、安装卸载的幂等与依赖冲突判定、校验的比对规则与只读性、备份的校验失败与失败清理路径、确认级别的跳过与拒绝路径、只读指令的分组计数与导出剥离、启用禁用的幂等与往返一致性、刷新的投影与派生区语义、配置写入的取值域、导入的格式校验与冲突跳过、指纹守卫、桥接层的子进程联调、逐文件落位与目标选项、原件缺失时的副本回收、重分发的失败原子性、本地与远端来源的安装与刷新、归档路径穿越与 `git` 缺失的错误分类、协议白名单与体积超限与超时与认证缺口的归类，以及选项登记、schema 样例校验与 schema 与规范文档的字段一致性。

### 变更

- 根配置新增 `typecheck` 与 `test` 脚本；编译配置改为只做类型检查，不产出编译产物。
- 桌面外壳包暂不引入 Electron 相关依赖。
- `install` 支持 `--dry-run` 预演与 `--library-only` 仅落库；`uninstall` 支持 `--dry-run` 预演与 `--keep-library`。
- 内容指纹改为在写入中心库之前计算，使预演与实装得到同一取值。
- 安装登记时的启用状态由安装动作决定：常规安装置为已启用，仅落库置为已禁用。
- `validate` 退出码按指令专属规定实现：存在错误级问题返回 `1`，仅警告返回 `0`，`--strict` 下警告也返回 `1`，参数类问题返回 `2`。
- `uninstall` 改为卸载前强制备份：备份校验通过才允许删除内容，备份失败即中止且不改动环境；`--hard` 与 `--keep-library` 同样先备份。载荷新增备份位置、时间戳、文件数与载体摘要。
- 投影一致性（V-16）的比对集合收窄：`status` 与 `targets.enabled` 属运行期事实而非元文件投影，移出比对，避免合法操作被报为投影不一致。
- 新增 `BAK` 类别问题码 `E-BAK-001` 与 `E-BAK-002`，并归入退出码 `5`。
- 备份目录名把时间戳中的冒号替换为短横线（冒号在部分文件系统上非法），清单内仍保留契约格式的原始时间戳。
- 确认级别落地：`install` 为轻确认、`uninstall` 为强制二次确认、`--hard` 再升一档；`--yes` 跳过全部级别；无终端环境未给出跳过选项时拒绝执行并返回参数类问题，避免脚本在等待输入上挂起。
- 预演与确认解耦：`--dry-run` 不要求确认、不写盘，载荷给出将发生的变更与文件数量。
- 卸载的影响范围说明补齐文件数量：预演载荷新增逐条明细与合计文件数，执行结果新增已移除文件数（部分收口 N-06）。
- `scan` 的依赖结论改为级联：依赖方在其被依赖对象失效时一并判为校验不通过，且沿依赖链传递。此前只报告了被依赖对象自身的问题，依赖方仍被标为通过，与 CON-09 的配套规则、元数据规范 5.3 以及校验与依赖分析的判定都不一致。
- `deps` 采用指令专属退出码：存在未满足的依赖时返回 `6`，其中「被依赖对象校验不通过」按结果规范 5.2 的专属优先条款一并归入未满足，不再落到通用派生的 `1`。
- 元文件的读取与解析抽到元数据模型服务，登记、校验与单个查看共用同一实现。
- 原子写入在替换目标时对瞬时占用做有限重试（Windows 上覆盖既有文件可能因安全软件或索引服务短暂持有而报 EPERM、EACCES、EBUSY）。实测十轮全量测试可复现一次偶发失败，重试后十二轮连续全绿；重试用尽仍按 E-IO-002 报错，真实占用不会被掩盖。
- 参数解析改为显式登记取值选项：未登记的选项一律按参数类问题拒绝，不再当成取值选项吞掉后面的位置参数。此前 `--check`、`--no-config`、`--no-secrets`、`--all`、`--tree` 都因未登记而报错或悄悄改变语义，现已逐项登记并加契约测试守住「文档写明的选项必须已登记」。
- 确认提示的动作名称改为按指令取表：此前刷新操作会显示成「卸载」。
- 轻确认的提示新增可选的单行摘要，导入用它给出「将登记 N 条记录」，其余指令的单行提示保持原样。
- 指纹计算补上守卫：目标不存在或不是目录时抛错，不再返回空内容哈希。空内容哈希是空文件与空目录的合法指纹，用它表示「目录不存在」等于给调用方一个看似正常的无意义取值。
- 新增开发期依赖 `ajv` 与 `ajv-formats`（仅用于测试中按 JSON Schema 校验样例，内核运行时依赖仍只有 `yaml`）。
- 根脚本调整：`typecheck` 拆成内核与界面两侧分别执行；`build:desktop` 由占位实现改为调用 electron-vite 构建三端产物；新增 `smoke:gui`。
- 静态检查接入 Vue 的正确性规则（模板格式交给 Prettier，避免两套格式化规则互相打架），并禁止渲染层引用 Node 模块与 Electron 运行时。
- 忽略构建输出目录 `gui/out`。
- 界面侧新增依赖：electron、electron-vite、electron-builder、vue、@vitejs/plugin-vue、vue-tsc、eslint-plugin-vue、vue-eslint-parser；内核运行时依赖仍只有 `yaml`。
- `build:kernel` 由占位实现改为真实构建；新增开发期依赖 esbuild（打包内核）与 postject（注入代码块）。
- 内核两个入口的顶层 await 改为等价的 then 链：单文件可执行只支持 CommonJS，而顶层 await 无法打包为 CommonJS；行为与退出码不变。
- `update` 语义扩展：刷新时会重分发受控副本，任一处落位失败则整体失败、索引保持调用前状态；`--target` 由「无可用语义」改为「只重分发指定目标」。为此顺序固定为「先重分发副本，再写索引」，避免出现记录已刷新而副本陈旧的中间态。
- `file_map` 的语义明确化：它从「卸载时的回收清单」变为「落位清单」——回收范围是副本目录本身，与映射内容无关；因此映射只列出 SKILL.md 的元文件，其副本里也只有 SKILL.md。
- 载荷中的位置统一为相对工作区的可移植路径（卸载的副本列表与原件路径由绝对路径改为相对路径）。缺口 `N-02`、`N-03`、`N-06`、`N-09`、`N-11` 一并关闭。
- 打包配置显式指定图标路径：默认只在资源目录下按约定名查找，本项目把图标放在 `packaging/`，因此显式给出以免回落到默认图标。
- 冒烟脚本修两个缺陷：调试端口固定会把探针连到上一次遗留的实例上（那种「连得上但状态不对」的假象比连不上更难排查），改为每次运行取一个空闲端口；结束应用时只杀直接子进程会留下占用端口的实例，改为结束整个进程树。

### 说明

- 已实现 4 条指令，其余 11 条待后续批次。
- 一期指令清单 15 条全部实现，可进入契约规范、JSON Schema 与桌面外壳批次。
- 校验规则 V-01 至 V-18 已全部有实现落点；V-09 由元文件解析阶段承担，V-12、V-13 复用 K-01 的依赖判定。
- 工程约定：端到端测试必须同时核对实际执行的用例数，只断言「无失败」不足以发现用例被静默跳过；改行为时必须回看既有用例的语义，防止用例前提被静默削弱。
- GUI 批次约束（待办）：内核桥接器调用写操作时必须显式给出 `--yes` 或建立真实交互通道，否则 `install` 与 `uninstall` 会被参数校验拦下。
- 已知缺口已逐条登记在指令契约规范第 7.3 节：原 N-01（卸载前备份）本批已实现，其余为 `--target` 与 `--scope` 与 `--mode`、逐文件落位映射与每文件落位计划、确认级别、Git 与归档来源、卸载输出的逐条路径与数量，新增 N-07（内容漂移定位到具体文件）与 N-08（备份载体的恢复），后两项属二期。
- 备份保留策略：一期不自动清理，保留全部备份；恢复能力属二期，见缺口 N-08。
- 遗留限制：中心库原件缺失时，落位路径无从读取，卸载只能移除索引记录而无法回收既有副本；该限制已由生命周期测试固定，回收能力的补全依赖落位路径的存储位置决策。
- 已知缺口更新：N-04（确认级别）本批已实现；新增 N-09（中心库原件缺失时回收受控副本，归逐文件落位批次），解决方向为把受控副本定位改为可推导路径。
- 待回写项：无。上一批登记的两项（非终端拒绝行为、轻确认适用对象）已按裁决回写指令契约第 2.4 节。
- 已知限制：`deps` 不检测外部运行时、也不比较版本约束（已登记为缺口 N-10，归二期）。
- `update` 的一期语义：只按磁盘现状刷新索引记录与派生区字段，不向来源拉取新版本、也不重分发副本；契约第 4.11 节的前置条件（可解析来源）与行为 5（全部目标一并更新）在本地刷新语义下不适用，来源类型非本地的记录一律按来源类问题拒绝。该差异待裁决后回写契约。
- 已知限制：`import` 登记的记录未经磁盘验证，运行期结论取保守值（校验不通过）并提示导入后执行扫描；`--on-conflict` 在一期没有可用语义（冲突一律跳过），传入时按参数类问题拒绝而不静默忽略。
- 界面冒烟检查抓出并修掉两个只在运行时才会暴露的缺陷：主进程以 ES 模块运行却使用了 `__dirname`（窗口创建失败但进程不退出，仅看「进程存活」会误判为通过）；沙箱化的预加载脚本无法加载 ES 模块（渲染层拿不到任何内核接口，界面静默失效）。后者改为输出 CommonJS 预加载以保住沙箱隔离。
- 打包产物：`build/desktop/` 下生成免安装目录、NSIS 安装包与便携单文件（各约 107 MB）。内核可执行文件尚未产出（`build-kernel.mjs` 仍是占位），打包时会跳过该项，运行期找不到内核将报宿主通道异常；打包模式下的界面闭环验证通过环境变量指向内核入口完成。
- 界面侧已知边界：未设置应用图标，使用 Electron 默认图标；备份面板只能按路径导出与导入——一期没有列出既有备份载体的指令，该能力尚未在契约中定义。
- 网络受限时 Electron 运行时二进制需指定镜像后安装，做法记在 `gui/README.md`。
- 内核可执行文件已验证可用范围：版本、初始化、扫描、列表、校验、卸载（写操作带跳过确认）、导出，退出码与源码形态一致。
- 打包产物验证已去掉环境变量：免安装目录与便携单文件都在**不设置任何内核路径变量**的情况下跑通「初始化 → 扫描 → 列表」并渲染真实卡片。
- 打包产物体积：安装包与便携单文件各约 129 MB，其中内核可执行文件约 88 MB——它是 Node 运行时的副本，体积偏大是该分发形态的固有代价。
- 图标验证：ICO 结构含七档尺寸、PNG 为 256×256 RGBA 且签名正确；从可执行文件提取的关联图标中心像素与「标记色以 0.82 不透明度叠加香槟金」的计算值一致，证明图标确已内嵌；打包日志中的「使用默认 Electron 图标」提示消失。图标外观另经外部视觉工具读回确认：圆角方形香槟金底板、三条居中横杠长度与明度递减、无锯齿与偏色，语义读作「条目列表」。
- 三种启动方式（开发产物、免安装目录、便携单文件）的界面冒烟均为 6/6 通过，运行结束后无遗留进程。
- 已知限制：目标落位根约定使副本位置不再由元文件自由指定，偏离约定的声明会被拒绝登记；这是为「原件缺失仍可回收副本」付出的代价，已写入元数据规范 3.5 节。
- 已知限制：契约的问题码 `E-CONFLICT-002`（落位映射冲突）在约定下不再可能由「两个目标指向同一路径」触发，只可能来自 `file_map` 内部冲突；该码的登记含义未变，触发面收窄。
- 缺口登记更新：`N-05` 的本地部分已实现，远端部分（Git 地址与下载链接）登记为下一批次；二期剩余项为远端来源、每文件漂移定位、备份恢复、运行时探测与版本比较。
- 缺口登记更新：`N-05` 全部实现并关闭；二期剩余项为每文件漂移定位、备份恢复与载体枚举、运行时探测与版本比较、内核体积优化。
- 远端来源的测试方式：不依赖真实外网，用本地 HTTP 服务器模拟远端——归档用静态文件服务，Git 仓库用 dumb HTTP（裸仓库加 `update-server-info` 后静态服务）验证真实的克隆路径。

## 0.1.0

### 新增

- 文档基线：需求规格、系统架构、界面设计与四份契约规范。
- 仓库骨架：工作区配置、两个包的清单与编译配置、静态检查与格式化配置、四个构建与校验脚本、目录结构。

### 说明

- 一期功能清单已冻结，详见需求规格附录 D。
- 本版本不含业务逻辑实现。
