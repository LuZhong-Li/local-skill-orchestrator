# M2 跨平台打包实施计划

| 项目 | 内容 |
|---|---|
| 文档名称 | M2 跨平台打包实施计划（T0 ~ T4、依赖、验收映射） |
| 文档路径 | `docs/plan/m2-packaging.md` |
| 文档状态 | 计划稿（待执行；实现按 T0 → T4 顺序推进，逐批给实现提示词） |
| 依据 | [`docs/design/m2-packaging.md`](../design/m2-packaging.md)（含 2026-10-16 评审确认与五项开放项裁决）；[`docs/requirements.md`](../requirements.md) 9.3.2（M2-R1 ~ M2-R5）、9.4.1 / 9.4.2、9.6（M-R-02 / M-R-05 / M-R-08）、9.7；[`docs/plan/m1-ci.md`](m1-ci.md)（M1 已收官口径） |
| 说明 | 本文档只输出任务、依赖与验收映射，不含工作流 YAML、打包命令与脚本内容。 |

---

## 0. 已裁决输入（计划必须体现）

| # | 输入 | 取值 |
|---|---|---|
| 1 | 产物格式 | macOS：`.dmg` ×2（arm64 / x64，**非 universal**）；Linux：`.AppImage`（x64）；Windows：沿用二期的 nsis 安装包 + 便携单文件 |
| 2 | 基座与矩阵标签 | macOS arm64 = `macos-15`；macOS x64 = `macos-15-intel`；Linux x64 = **`ubuntu-24.04`**；Windows = `windows-latest`；固定标签，不使用 `-latest`（Windows 沿用 M1 现状）[设计 3.2；裁决 ④] |
| 3 | 未签名口径 | `CSC_IDENTITY_AUTO_DISCOVERY=false`（环境变量，跨 electron-builder 版本成立）；打包后以 `codesign -dv` 断言**未签名**；设置 `forceCodeSigning` 属禁止项 |
| 4 | 签名预留 | **轻量预留**：文档化官方 secrets 命名（`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）＋签名 job 条件骨架（secrets 存在时才运行）；**不实现、不建证书** [裁决 ③] |
| 5 | 触发与并发 | `push` / `PR` 维持现状（`ci.yml` 行为逐条不变，矩阵不扩）；tag `v*` 与 `workflow_dispatch` 触发全平台矩阵；同 ref 取消旧运行 [裁决 ③（设计）] |
| 6 | 发布 | tag 触发时以预装 `gh` CLI 创建 GitHub Release，附 `SHA256SUMS.txt`；**Windows 两个产物随传**；`gh` 参数细节在 T3 前以官方手册核对并登记 [裁决 ⑤] |
| 7 | 图标 | 构建期生成（iconset → `iconutil` 拼 `.icns`、Linux 512×512 PNG）；**不入库**（唯一来源是脚本）；零图形库 [裁决 ⑦] |
| 8 | `linux.maintainer` | 沿用仓库既有提交身份 `skill-manager <3338004299@qq.com>`；不新造个人信息 [裁决 ⑨] |
| 9 | 冒烟口径 | Linux：`xvfb` GUI 冒烟（`--appimage-extract-and-run`、Electron 沙箱参数属 **CI 环境差异**）；macOS：产物结构校验 + 内核可执行；跑不通按降级口径登记为**结论**（不计为未验证）[裁决 ⑥（设计）] |
| 10 | glibc 下界 | 以 `ubuntu-24.04` 为基座，AppImage 目标的 glibc 下界为 **2.39**；发布说明写明该下界，更老系统走源码构建 [裁决 ④] |

**证据冲突登记（如实记录，不掩盖）**：2026-10-16 浏览器取证时，官方 runner 表中仍列出 `ubuntu-22.04` 标签（设计文档证据表 R-1）；需求侧裁决按其生命周期判断该标签已退役，并要求「T2 首步实测确认」。**本计划以裁决为准**（基座取 `ubuntu-24.04`），`ubuntu-22.04` 不作为任何任务的依赖；T2 首步仅做「矩阵标签可解析」的实测，不依赖 22.04 结论。

---

## 1. 任务序列

### T0 图标管线（实现第一批）

**执行状态**：**已完成（2026-10-16）**。交付：`scripts/icon-render.mjs`（纯函数：同一矢量描述按目标尺寸直接渲染、PNG/ICO 最小编码器、iconset 与 Linux 档位清单、落盘函数返回 14 项写入清单）、`scripts/build-icon.mjs`（命令行入口）、`scripts/icon-icns.mjs`（`iconutil` 封装：参数拼装 + 平台准入 + 执行器可注入）、`scripts/build-icon-icns.mjs`（仅 macOS 的命令行入口）；`.gitignore` 新增三条生成物规则。实测：重跑后 `git status gui/packaging` 为空（既有 `icon.ico` / `icon.png` 逐字节复现，零漂移），`git check-ignore` 判定三条生成路径被忽略。测试：新增 10 项（单元 6 / 契约 4），总数 360 → **370**，全绿；`check` / `typecheck` / `lint` / `format:check` 零告警。**EX-03 保留**：`iconutil` 真机验证登记为 T2 矩阵首跑项，本批未伪造 macOS 结论。

**目标**：在既有程序化图标脚本上扩展出 macOS iconset 与 Linux 图标目录，并在 macOS 上完成 `.icns` 拼装链路，全程不引入图形库。

**依赖**：设计定稿（本文档 + 设计文档第 5 节）。

**交付物**：

1. 图标脚本扩展：`icon.iconset/`（10 个文件，尺寸见设计 5.2）与 `icons/256x256.png`、`icons/512x512.png`；
2. `icns` 拼装脚本（仅 macOS 可运行，调用系统 `iconutil`；非 macOS 以明确错误退出）；
3. 构建期调用点与 `.gitignore` 登记（新产物不入库）；
4. 契约测试：图标产物的存在性与尺寸断言（PNG 头解析，不依赖图形库）。

**验收标准（可验证）**：

1. 在任一平台执行图标命令后，`icons/512x512.png` 与 10 个 iconset 文件存在，且尺寸逐项正确（PNG 头解析断言）；
2. 重复执行结果逐字节一致（幂等）；
3. 在 macOS runner 上 `iconutil` 拼装退出码为 0 且 `icon.icns` 非空；`iconutil` 不可用时任务失败并给出可定位信息（不静默跳过）；
4. 非 macOS 运行 icns 拼装命令时以明确错误退出（非零退出码 + 说明）；
5. 既有 `icon.ico` / `icon.png` 产物与 `win` 打包口径不变（回归断言）；
6. 全量测试与门禁零告警（用例数核对约定沿用）。

**规模估算**：1 个图标脚本扩展 + 1 个 icns 脚本 + 约 4 ~ 6 条契约断言；不新增依赖。

**风险与处置**：`iconutil` 可用性属待确认项（设计证据表 R-10）→ 本任务实测；实测不可用时按设计 5.3 的备选（脚本自行拼装 icns）回到设计对齐后再实现。

### T1 构建配置（实现第二批）

**执行状态**：**已完成（2026-10-16）**。交付：`gui/packaging/electron-builder.yml` 新增 `mac`（dmg / ICNS 图标 / 开发者工具类别 / 产物名含架构 / 不写签名键）与 `linux`（AppImage / 图标目录 / Utility 类别 / synopsis+description / maintainer 沿用仓库提交身份）段，`win` 段与共享骨架未动；打包入口 `scripts/pack.mjs`（执行器）+ `scripts/pack-plan.mjs`（纯函数计划：图标链、平台分支、架构开关、未签名环境变量、只打本平台包）与 `gui/package.json` 的 `pack:mac` / `pack:mac:x64` / `pack:linux`；未签名断言 `scripts/unsigned-check.mjs`（`codesign -dv` 解析可注入，三口径）+ `scripts/assert-unsigned.mjs`（事后复核入口）；`maintainer` 实测 `scripts/maintainer-probe.mjs` + `scripts/check-maintainer.mjs`；README 新增「跨平台分发与安装」（产物清单与 Releases 入口、Gatekeeper 绕行两步、glibc 2.39 与 AppImage 运行前提、自行打包命令）。测试：新增 19 项（单元 12 / 契约 7），总数 370 → **389**，全绿；`check` / `typecheck` / `lint` / `format:check` 零告警。**真机项保留**：`codesign` 未签名断言与 `maintainer` 消费实测登记为 T2 首跑，未伪造结论。

**目标**：让 electron-builder 能按平台产出 dmg 与 AppImage，并把未签名口径与签名预留落到配置与文档层。

**依赖**：T0（图标产物就位，`mac.icon` / `linux.icon` 才有意义）。

**交付物**：

1. `gui/packaging/electron-builder.yml` 增量：`mac` 段（target `dmg` / category / icon / artifactName / 最低系统版本）与 `linux` 段（target `AppImage` / category / synopsis / description / maintainer / icon / artifactName），`win` 段不动；
2. 打包入口脚本：`pack:mac`（按架构参数）、`pack:linux`（与既有 `pack:win` 并列）；
3. 未签名口径落地：打包环境的 `CSC_IDENTITY_AUTO_DISCOVERY=false` 与「产物未签名」断言脚本（`codesign -dv`）及签名预留说明段（secrets 命名 + 条件骨架）；
4. 文档更新：README 的 macOS 首次打开绕行说明与 glibc 下界说明。

**验收标准（可验证）**：

1. 配置通过既有契约/静态检查（无未登记键、字段取值来自官方选项）；
2. `win` 段与 Windows 产物口径逐条未变（回归断言：`pack:win` 配置项与产物名模板一致）；
3. macOS 打包产物中 `codesign -dv` 报未签名；打包日志中不出现「发现证书身份」的动作；
4. Linux 打包产物为 `.AppImage` 且文件名含版本与架构；`.desktop` 条目含 category / synopsis / description；
5. **待核实项登记**：`linux.maintainer` 是否被 AppImage 形态消费（裁决说明称「AppImage 不消费该字段」）——以打包产物元数据实测为准，实测结论写入 T1 执行状态；
6. 全量测试与门禁零告警；CHANGELOG 记录本批（含未签名口径与配置增量）。

**规模估算**：1 份配置文件增量 + 2 个打包入口脚本 + 1 个未签名断言脚本 + README 段落；不新增依赖。

### T2 矩阵 workflow（实现第三批）

**执行状态**：**已完成（2026-10-16）**——四 leg 矩阵、可复用校验工作流与 fail-fast 口径均已落地并实测，**四 leg 全绿**（EX-07 已查明根因、修复并验证关闭）。

| 项 | 实测结果 |
|---|---|
| `verify.yml` 抽取 | ci.yml 改为消费可复用工作流：run 38869061706 **Success 1m 57s**，job 显示为「校验 / 读取版本声明」与「校验 / 验证（…）」；步骤名称与顺序由契约测试逐条钉住（抽取前后一致） |
| 四 leg 首跑（tag `v0.0.1-t2firstrun`） | run 38869913530：Windows ✓ 238 MB、Linux ✗、mac-x64 ✓ 148 MB、mac-arm64 ✗ |
| 修复后重跑（tag `v0.0.1-t2run3`） | run 38871300587：Windows ✓ 238 MB、**Linux ✓ 156 MB AppImage**、mac-x64 ✓ 148 MB、mac-arm64 ✗（517 MB 诊断产物已上传） |
| **四项修复后重跑（tag `v0.0.1-t2run5`）** | run 38887140603：**四 leg 全绿** —— Windows ✓ 238 MB、Linux ✓ 156 MB AppImage、mac-x64 ✓ 149 MB dmg、**mac-arm64 ✓ 145 MB dmg**；真机注解：两端包内内核签名可读（`EX-07 内核 ad-hoc 签名`）、未签名断言分别判定 `adhoc`（arm64）与 `unsigned`（x64）、`iconutil` 产出 79768 字节 icns |
| 三项真机结论 | 均以运行页**注解**公开输出（未登录也可读）：**EX-03 iconutil** 真机产出 `icon.icns`（79768 字节，mac-x64）；**codesign 未签名断言**真机通过（`build/desktop/mac/skill-manager.app` 判定未签名）；**`linux.maintainer`** 单侧实测 **not-consumed**（产物树中未出现该字符串，已回写配置注释） |
| fail-fast 探测 | 探测分支 `probe/pack-failfast`（tag `v0.0.1-t2probe`）run 38869954307：linux leg 按探测步骤**红**，同一次运行中 Windows 与 mac-x64 **仍产出并上传产物**（`fail-fast: false` 的实证）；探测分支与四个临时 tag 已删除，正式 pack.yml 不含探测代码 |

**实测发现的三处缺陷（均已修复并登记）**：

1. **job 级 `if` 不能引用 `matrix`**：GitHub 判为 `Invalid workflow file`（run 38868806071）。改为步骤级过滤，并加契约断言「任何 job 级 `if` 不得出现 `matrix.`」防同类回归。
2. **新契约测试触发 `@typescript-eslint/no-explicit-any`**：本地门禁因「只打印末行」漏看，由 CI 抓到。测试改用具名接口解析工作流 YAML；教训：门禁必须以**退出码**判定，不以输出末行判定。
3. **AppImage 构建失败：`executableName` 含非法字符**：electron-builder 从包名（`@skill-manager/gui`）推导出 `@skill-managergui`；显式给出 `linux.executableName: skill-manager` 后 Linux leg 转绿。

**其它落地项**：Linux leg 增加 FUSE 2 依赖安装（runner 镜像未预装，设计 7.1 / R-2、R-6）；三个打包步骤加「失败原因 → 注解」包装，使失败原因在未登录会话下也能从运行页读到（mac-arm64 那次进程无输出，只落到「见 job 日志」，登记为 EX-07 诊断待办）；`workflow_dispatch` 触发路径因当前会话无已登录浏览器而未实测，登记 EX-08（其输入与守卫位置由契约测试覆盖）。

**遗留（EX-07 / EX-08）**：mac-arm64 leg 的失败原因需读 job 日志或被包装命令的真实输出才能定性（同配置在 mac-x64 全绿，已排除配置与依赖层面的原因）；`workflow_dispatch` 的首跑与输入行为待有已登录会话时补测。

**目标**：把校验步骤抽成唯一实现，并让打包矩阵按 tag / 手动触发运行，`ci.yml` 行为逐条不变。

**依赖**：T1（打包入口就位，矩阵才有可调用的命令）。

**交付物**：

1. `verify.yml`（可复用工作流，`workflow_call`）：内容为现 `ci.yml` 的校验 job（版本守卫 → 依赖安装 → 契约与分层 → 类型检查 → 规范 → 格式 → 测试 → 构建 → 缩减冒烟），矩阵与 Node 取值口径不变；
2. `ci.yml` 改为消费 `verify.yml`：触发、矩阵、并发、产物上传口径**逐条不变**；
3. `pack.yml`：触发（tag `v*`、`workflow_dispatch`）、并发取消、四平台矩阵（`macos-15` / `macos-15-intel` / `ubuntu-24.04` / `windows-latest`）、`needs: verify`、`fail-fast: false`、任务级 60 分钟上限、按「平台-架构」命名上传产物；
4. 首步实测记录：四个矩阵标签可解析（以实际运行结果为准）。

**验收标准（可验证）**：

1. **`ci.yml` 行为不变**：同一提交的推送运行中，job 集合、矩阵取值、步骤顺序、并发取消与产物上传命名与抽取前逐条一致（以运行记录比对，不以「YAML 看起来一样」代替）；
2. `verify.yml` 被 `ci.yml` 与 `pack.yml` 同时消费，仓库中不存在第二份校验步骤序列（检索断言：各步骤命令只在一处出现）；
3. tag 推送触发 `pack.yml` 且四个平台 job 齐备（含 Windows）；`workflow_dispatch` 可指定 ref 预演且**默认不发布**；
4. 任一平台失败不掩盖其他平台结论（`fail-fast: false` 的实证：一次刻意失败探测，其余平台仍出结论）；
5. 矩阵标签实测记录在案（含 `ubuntu-24.04` 可用性结论）；
6. 全量测试与门禁零告警；CHANGELOG 记录本批。

**规模估算**：1 份可复用工作流 + `ci.yml` 改造 + 1 份打包工作流；不新增依赖。

### T3 发布（实现第四批）

**执行状态**：**已完成（2026-10-16）**——机制自测与**真实 `v0.1.0` 发布**均已闭环（tag → run 38908935080 Success；Release 为 latest、非 prerelease、非 draft；下载后哈希复核一致）。

| 项 | 结果 |
|---|---|
| 版本守卫 | `scripts/release-guard.mjs`（纯函数 + CLI）：tag / CHANGELOG 顶部版本段 / 根与 gui 的 `package.json` 三方比对；**严格自测已证**——tag `v0.1.0-t3run1`（run 38889620993）四 leg 全绿后 release job **中止**，运行页注解列出三处不一致，**未创建任何 Release** |
| 资产归位与校验清单 | `scripts/release-publish.mjs`：交付目录必须**恰好**含 5 个产物，缺失或混入非交付物即失败；生成 `SHA256SUMS.txt`（仅交付物，哈希可复算）。**自测即发现真实差异**：Linux 产物实名是 `skill-manager-0.1.0-x86_64.AppImage`（electron-builder 的 `${arch}` 在 Linux 取 `x86_64`），已修正资产清单、README / CHANGELOG / 设计三处表述 |
| 发布与幂等 | `gh` 参数按官方手册核对（EX-04 **关闭**）：`create` 支持 `--title/--notes-file/--verify-tag/--latest`，`edit` 支持 `--title/--notes-file/--latest`，`upload` 支持 `--clobber`；Release 已存在则 edit + 覆盖资产，不产生第二个 Release；不打 prerelease 标记 |
| 权限与触发 | release job `needs: pack`、`if: startsWith(github.ref, 'refs/tags/v')`、job 级 `permissions: contents: write`（工作流级仍只读） |
| Release notes | 由版本守卫把 CHANGELOG 的 `## 0.1.0` 段写成 `RELEASE_NOTES.md`（**放在交付目录之外**——放进去会被归位检查判为非交付物，干跑自测已实测此点并修正） |
| 动作版本 | 汇总产物改用 `actions/download-artifact@v8`（v6 面向 Node 20，会产生废弃告警，与 DP-D 口径冲突） |
| 干跑链路 | 探测分支 + 临时 tag 干跑（守卫降级、`--version` 固定 0.1.0、`--dry-run` 只打印 gh 命令、不创建 Release）：**已取得全绿干跑**（run 38893295554，Success 5m12s，四个打包 leg + release job 全绿），运行页注解公开「发布资产清单（5 个实名）」与「SHA256SUMS（5 行）」；复核无 Release 创建（`/releases` 为空、`/releases/tags/<tag>` 404）。该链路先抓出两处真实差异（Linux 实名 `x86_64`、notes 不得落在交付目录）并修复；此前一次干跑被 **EX-10** 的 dmg 抖动打断，重跑即恢复 |

**EX-04 关闭依据**：官方手册页 `gh_release_create` / `gh_release_edit` / `gh_release_upload` 的 flag 列表（2026-10-16 抓取），脚本参数与之逐项对齐。

**目标**：把三（+1）平台产物与校验清单发布为 GitHub Release，并让版本口径成为可失败检查。

**依赖**：T2（打包矩阵产出齐备）。

**交付物**：

1. 版本守卫：tag 名 ≡ 版本声明 ≡ `CHANGELOG.md` 中该版本段（三者一致才发布；本地可执行、流水线以断言生效）；
2. `release` job：下载四平台产物 → 生成 `SHA256SUMS.txt` → 以预装 `gh` CLI 创建 Release 并上传资产（macOS dmg ×2、Linux AppImage ×1、Windows nsis + portable ×2、校验清单）；
3. `gh` 参数核对记录：以官方手册核对创建与覆盖参数并登记（设计证据表 R-9 的待确认项在 T3 关闭）；
4. 重跑幂等：同 tag 重跑覆盖同名资产，不产生第二个 Release；
5. 发布说明模板与 glibc 下界、未签名绕行说明的固定段落。

**验收标准（可验证）**：

1. 版本守卫三处不一致时失败且不产生 Release（构造反例验证）；
2. 一次真实 tag 运行产出 Release，资产集合与第 0 节清单逐项一致，`SHA256SUMS.txt` 与各资产 sha256 一致；
3. 同 tag 重跑后资产集合与校验值不变（幂等实证）；
4. `gh` 参数已按官方手册核对并登记（关闭 R-9 待确认项）；
5. 权限最小化：仅 `release` job 具备写权限，打包 job 只读；
6. 全量测试与门禁零告警；CHANGELOG 记录本批（含发布口径）。

**规模估算**：1 个守卫脚本 + `pack.yml` 的 `release` job + 发布说明模板；不新增依赖。

**前置外部条件**：需要一次真实 tag 的发布授权（见第 5 节）。

### T4 冒烟与验收（收口批次）

**目标**：把各平台断言、降级口径与 M2 验收映射收口为可复核的交付物。

**依赖**：T0 ~ T3 + 一次真实 tag 运行记录。

**交付物**：

1. 各平台断言集合的执行记录（产物结构、架构、未签名、内核最小闭环；Linux 含 GUI 冒烟或降级登记）；
2. 产物验证报告生成（设计 8.5 的固定字段）并随 artifact 上传；
3. 平台差异登记表与兼容性问题列表（9.4.2 / M2-R4 口径）；
4. M2 验收映射表（需求 9.3.2 七条 + M2-R1 ~ R5 逐条承载与验证方式）；
5. 文档同步：设计第 8 章执行状态、README（绕行说明、glibc 下界、Release 入口）、one-summary 7.4 与遗留项、CHANGELOG 收官条目、需求回写批次与计数校验。

**验收标准（可验证）**：

1. 三平台（macOS arm64 / macOS x64 / Linux x64）各有一份产物验证报告与启动结论；Windows 以二期结论作对照基线并逐条说明一致或差异；
2. 内核三平台行为一致：同一最小闭环的退出码与结果封装结构一致（含含空格与非 ASCII 路径用例）；
3. 未签名断言、架构断言、可执行权限断言全部通过；
4. Linux GUI 冒烟结论明确：通过，或以降级口径登记（含原因与后续动作）；
5. 未验证项为零；不适用项与降级项均有登记条目与原因；
6. 全量测试与门禁零告警（用例数核对约定）；CHANGELOG 与 one-summary 同步完成。

**规模估算**：断言集合执行记录 + 1 份报告生成步骤 + 3 份登记表/映射表；不新增依赖。

---

## 2. 依赖关系与关键路径

| 任务 | 依赖 | 说明 |
|---|---|---|
| T0 图标管线 | 设计定稿 | 先文档后实现：设计已产出并评审确认 |
| T1 构建配置 | T0 | `mac.icon` / `linux.icon` 依赖 T0 产物 |
| T2 矩阵 workflow | T1 | 矩阵调用 T1 的打包入口 |
| T3 发布 | T2 + 一次真实 tag 授权 | 无产物即无发布对象 |
| T4 冒烟与验收 | T0 ~ T3 + 真实运行记录 | 收口批次；无运行记录无法完成验收 |

关键路径：**T0 → T1 → T2 → T3 → T4**（T3 另需发布授权，T4 另需真实 tag 运行记录）。

---

## 3. 里程碑验收映射（需求 9.3.2）

### 3.1 需求条目映射

| 需求条目 | 承载任务 | 验证方式 | 口径说明 |
|---|---|---|---|
| M2-R1 目标平台（macOS arm64 / x64、Linux x64；Windows 沿用） | T2 / T4 | 四平台 job 齐备 + 三平台产物清单与启动结论；Windows 以二期结论对照 | 三平台各自一次完整运行记录（可复核） |
| M2-R2 三启动方式验证（不适用须登记） | T1 / T4 | 归属表（CI / 本地 / 人工）＋本地复验记录 | 完整 GUI 交互留本地属**已登记的归属**，不计为未验证（M-R-08） |
| M2-R3 内核独立可执行形态行为验证 | T1 / T4 | 从产物内取内核执行 `--version` 与最小闭环；退出码与结果封装比对；含空格与非 ASCII 路径用例 | 与 Windows 基线逐条对照 |
| M2-R4 打包配置差异验证 | T1 / T4 | 差异登记表（Windows 专属资源、路径分隔符、大小写、换行符、权限位、启动脚本形态） | 未登记的差异按不一致缺陷处理（9.4.2 第 3 条） |
| M2-R5 验证方式与 M1 的关系 | T2 | `verify.yml` 单一实现 + `ci.yml` 行为逐条不变的比对记录 | 不得为单平台维护独立步骤序列 |

### 3.2 里程碑验收七条映射

| # | 验收标准 | 承载任务 | 验证方式 | 口径 |
|---|---|---|---|---|
| 1 | 三个目标平台各有产物清单与启动结论 | T2 / T3 / T4 | Release 资产清单 + 三份产物验证报告 | — |
| 2 | 三启动方式结论逐平台可见，不适用项已登记 | T4 | 归属表 + 本地复验记录 | 不适用项有登记条目与原因 |
| 3 | 内核启动、指令、退出码与输出结构一致 | T4 | 三平台最小闭环比对（含路径与换行语义用例） | 以 Windows 为对照基线 |
| 4 | 平台差异逐条登记且不影响构建成功 | T1 / T4 | 差异登记表 + 四平台构建均成功 | 允许差异清单与 9.4.2 第 2 条一致 |
| 5 | 未验证项为零 | T4 | 登记表逐条对应；降级项写明原因 | **降级 = 已登记结论，不是未验证** |
| 6 | 三启动方式最小冒烟 ≥ 95% 断言通过，失败归类并登记 | T4 | 断言通过/失败计数 + 兼容性问题列表 | 失败项归类为兼容性问题 |
| 7 | 每平台产物验证报告（体积、启动成功率、启停日志） | T4 | 自动部分随 artifact；启停日志按 9.7 属人工记录 | 报告字段固定（设计 8.5） |

**未签名与 CI 差异的口径**：未签名是**主动选择**且被 `codesign -dv` 断言检查（T1）；`--appimage-extract-and-run` 与 Electron 沙箱参数属 **CI 环境差异**，与交付物给用户的行为分开登记（T4），不写进「产物缺陷」。

---

## 4. 硬性约束与执行纪律

1. **先文档后实现**：设计已定稿；各批次实现前如需偏离设计，先回写设计再实现；
2. **不修改 `docs/reviews/` 快照与既有定稿**；需求侧如需变更走变更记录批次；
3. **指令数与选项不变**（16 条）；**不新增内核依赖**、零图形库；
4. **步骤集合唯一**：校验步骤只存在于 `verify.yml`，`ci.yml` 与 `pack.yml` 消费同一份定义；
5. **四条工程约定继续适用**：用例数核对、改行为回看用例语义、选项登记一致性、含子进程的断言走独立进程；
6. **不在真实 tag 之外发布**：`workflow_dispatch` 预演默认不发布；发布需显式开关与 tag；
7. **免费额度内运行**：打包矩阵只在 tag / 手动触发时运行；不使用容器构建（M2 轻量原则，裁决 ④）；
8. **未签名禁止项**：不设置 `forceCodeSigning`，不引入签名配置键（签名预留仅文档化 secrets 与条件骨架）。

---

## 5. 阻塞项与需要外部条件的事项

| 编号 | 事项 | 影响 | 处置 |
|---|---|---|---|
| EX-01 | 首次发布需 `CHANGELOG.md` 存在 `<version>` 段（现状只有「未发布」） | T3 发布会失败（版本守卫按设计拦截） | 发布前把「未发布」定版；属发布前置动作，不阻塞 T0 ~ T2 |
| EX-02 | 一次真实 tag 推送与发布授权 | T3 / T4 无法在本地完成 | 由维护者执行或授权执行（沿用 M1 的 DP-C 口径） |
| EX-03 | `iconutil` 在 `macos-15` 上的可用性（设计 R-10 待确认） | T0 的 icns 拼装 | T0 实测；不可用则回设计对齐（脚本自行拼装 icns）后再实现 |
| EX-04 | `gh release create` 的参数细节（设计 R-9 待确认） | T3 发布步骤写法 | T3 前以官方手册核对并登记 |
| EX-05 | macOS runner 排队与镜像标签可用性 | T2 / T3 时长 | 固定标签 + 按需触发 + 同 ref 取消旧运行；标签变更按开放项 ⑥ 显式决策 |
| EX-06 | AppImage FUSE 与 Electron 沙箱的 CI 环境差异 | T2 / T4 的 Linux 断言 | 以 `--appimage-extract-and-run` 与沙箱参数处理，并在 T4 登记为 CI 差异 |
| EX-07 | **mac-arm64 leg 打包失败**（T2 实测）：Windows / Linux / mac-x64 三 leg 全绿，仅 macos-15（arm64）失败，且被包装命令无任何输出（疑似 runner 侧中断或 OOM），517 MB 诊断产物已上传 | T2 的四 leg 首跑未全绿；M2 验收第 1 条缺 mac-arm64 产物 | 需读 job 日志（或被包装命令的真实输出）定性；诊断通道已备（失败原因注解），下一步在包装里补 exit code 与末行回落后重跑 |
| EX-07（**已关闭**） | **根因**：Node 官方 SEA 流程要求 macOS 上在 `postject` 注入前后处理签名（注入前 `codesign --remove-signature`、注入后 `codesign --sign -` ad-hoc），`build-kernel.mjs` 此前缺这两步——x64 宽容通过、arm64 在打包期签名校验失败。**修复过程中另发现第二处问题**：未签名断言口径过严（arm64 产物按平台要求带 ad-hoc 签名，被判为 `signed`） | 修复：① `scripts/sea-signing.mjs` + `build-kernel.mjs` 按序接入；② `unsigned-check.mjs` 判定扩为三态、**接受 `unsigned` 与 `adhoc`**、仍拒绝 `signed`/`unknown`；③ mac leg 增加「包内内核有效签名」可失败断言；④ pack 增加阶段文件与打包器日志自证 | **已验证关闭**：run 38887140603 四 leg 全绿（arm64 dmg 145 MB、x64 dmg 149 MB），真机注解显示两端内核签名可读、判定分别为 `adhoc` / `unsigned` |
| EX-09 | 内核产物在三平台同名 `skill-manager.exe`（扩展名与平台习惯不符） | 仅命名规范；无功能影响 | 核查结论：codesign 按 Mach-O 内容判定、与扩展名无关；GUI 按 `resources/kernel/skill-manager.exe` 固定解析。本批**不改名**（改名属额外变更，牵动 GUI/CI/文档），登记待评估 |
| EX-10 | **macOS dmg 构建抖动**：`dmgbuild`/`hdiutil` 偶发 `couldn't eject "disk2" - Resource busy`（T3 干跑自测 run 38891909354 命中，此前多次运行未出现） | 单 leg 变红；重跑可恢复，非确定性失败影响发布节奏 | 处置顺序：先重跑证据（确认是抖动而非回归）；若复现频繁，按「在 packing 步骤加重试」处理并登记（不改交付物口径） |
| EX-11 | Release notes 与交付目录的关系（干跑自测实测） | 若把 notes 写进交付目录，归位检查会判其为非交付物 | 已修：notes 写在交付目录之外（`RELEASE_NOTES.md`），并有契约断言钉住「不得落在 release/ 内」 |
| EX-12 | **新建的 Release 处于 draft**（真实发布首跑实测）：此时 `gh release edit --latest` 被 GitHub 以 422「Latest release cannot be draft or prerelease」拒绝 | 首跑留下一个 0 资产的 Release 与红色发布 job | 已修（收敛流程）：发布动作固定为 `create → publish(--draft=false --prerelease=false) → edit(--title/--notes-file/--latest) → upload(--clobber)`，复跑同 tag 复用该 Release 并补齐全部资产；**根因未完全定位**（疑与 gh 2.102.0 的 create 行为有关），如需追根用已登录会话复核 |
| EX-08 | `workflow_dispatch` 触发路径未实测（当前会话无已登录浏览器，无法点 Run workflow） | 「手工触发」这条入口缺真实运行证据 | 有已登录会话时补一次 dispatch 首跑（含 platforms / arch 输入）；触发定义与步骤级守卫已由契约测试覆盖 |

---

## 6. 与既有里程碑的衔接

1. **与 M1**：打包工作流的前置门禁直接调用 M1 的可复用校验工作流；并发取消、`fail-fast: false`、60 分钟硬上限、产物命名与保留期、失败诊断产物全部沿用 M1 口径；
2. **与 M4a（自动更新）**：M2 的 Release 资产是后续更新检查的输入，但本阶段不设计更新通道、不引入网络检查逻辑；
3. **与 M3（压测）**：无直接依赖；M3 的结论不影响打包矩阵（若 M3 发现平台相关的性能差异，按缺陷流程处理）。
