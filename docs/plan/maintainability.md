# 可维护性建设实施计划（P0 护栏 → P1 拆分 → P2 收口）

| 项目 | 内容 |
|---|---|
| 文档名称 | 可维护性建设实施计划 |
| 文档路径 | `docs/plan/maintainability.md` |
| 文档状态 | **执行中**（2026-10-18 批准；P0-a ~ P0-d、P1-a/P1-b、M4c-1 ~ M4c-6 已完成，2026-10-19） |
| 依据 | [`docs/design/maintainability.md`](../design/maintainability.md)；需求第 10 章（MNT-R1 ~ R9）；`docs/research/maintainability-audit-2026-10-18.md`；M4c 设计 / 计划 |
| 说明 | 只计划，不实现；每批可独立验证、独立提交；纯重构批不得夹带功能 |
| 基线 | 计划基线 569（P0-d 后）；当前执行基线 658（M4c-6 后：657 通过 + 1 项平台跳过）；0 循环；0 allowlist；94 个 complexity > 10 |

---

## 0. 已裁决输入与全局批次

### 0.1 已裁决

| 编号 | 裁决 | 计划落点 |
|---|---|---|
| D-01 | P0 全量前置：`check:arch`、3 条违例清零、complexity ratchet、单一来源、共享测试夹具 | P0-a ~ P0-d |
| D-02 | P1 只前置与 M4c 相撞的宿主三处合一、dispatch scan 段 | P1-a / P1-b |
| D-03 | lifecycle / plugins manifest 拆分在 M4c 后 | P1-c / P1-d |
| D-04 | P2 收口在 M4c 后 | P2 |
| D-05 | `contract/` 零运行时依赖、不 import kernel/gui、只放类型与常量 | P0-b |
| D-06 | 纯重构不发版；账本 + M4c 合并 v0.4.0 | 第 5 章 |

### 0.2 全局批次表（两份计划共用）

| 批次 | 内容 | 所属计划 | 前置 | 类型 |
|---|---|---|---|---|
| P0-a | `check:arch` 基线 | 本计划 | 无 | 纯重构 / 门禁 |
| P0-b | `contract/` 共享包 + 清 3 条违例 | 本计划 | P0-a | 纯重构 |
| P0-c | complexity / 文件规模 ratchet | 本计划 | P0-b | 门禁 |
| P0-d | 共享测试夹具 | 本计划 | P0-b | 纯重构 / 测试基建 |
| L-1 | `host-landings` 规范 + schema | M4c 计划 | P0-b | 契约 |
| L-2 | `--host` 落账 / 更新 / 回滚 | M4c 计划 | L-1、P0-d | 功能 / 契约 |
| L-3 | `uninstall --host` / `--host all` / 原件卸载孤儿闭环 | M4c 计划 | L-2 | 功能 / 契约 |
| L-4 | 历史副本 inferred / export 决策 | M4c 计划 | L-2 | 功能 / 文档 |
| L-5 | v0.3.0 兼容 / 不破坏迁移 | M4c 计划 | L-4 | 兼容 |
| P1-a | 宿主三处合一 + `inventory_roots` | 本计划 | P0、L | 纯重构 / 契约扩展 |
| P1-b | dispatch scan 段拆分 | 本计划 | P0、P1-a | 纯重构 |
| M4c-1 | `scan --inventory` CLI | M4c 计划 | P1-a、P1-b、L | 功能 |
| M4c-2 | 宿主枚举 / root_role / 深度 / 去重 | M4c 计划 | M4c-1 | 功能 |
| M4c-3 | 双源对账 | M4c 计划 | M4c-2 | 功能 |
| M4c-4 | 结构化输出 | M4c 计划 | M4c-3 | 功能 |
| M4c-5 | 只读断言 | M4c 计划 | M4c-1 | 功能 / 门禁 |
| M4c-6 | GUI 盘点视图 | M4c 计划 | M4c-4 | 功能 |
| M4c-7 | 三平台 CI fixture 探针 | M4c 计划 | M4c-4 | 验证 |
| P1-c | lifecycle 拆分 | 本计划 | M4c-7 | 纯重构 |
| P1-d | plugins/manifest 拆分 | 本计划 | M4c-7 | 纯重构 |
| P2 | App.vue / e2e / 架构图 / 死代码 | 本计划 | M4c-7 | 纯重构 / 收口 |

> 本计划只展开 P0 / P1 / P2；L / M4c 批次的任务、契约与验收见 [`docs/plan/m4c-host-inventory.md`](m4c-host-inventory.md)。两份计划使用同一批次号与同一顺序。

---

## 1. P0：结构护栏（M4c 前置）

### P0-a `check:arch` 基线

**执行状态**：**已完成（2026-10-18）**。落点：扩展现有 `scripts/check-layer.mjs`（未另起检查器）；规则常量与纯函数（`classifyRegion` / `evaluateArchitecture` / `findCycles`）内嵌并导出；`package.json` 增加 `check:arch` 别名并随 `npm run check` 执行；`tests/contract/architecture.test.ts` 5 项反例测试。结果：**121 文件 / 330 条相对 import 边 / 0 循环 / 3 条 P0-a 基线 allowlist**；临时新增 store→core 边得到 `[layer]` 失败，临时环得到 `[cycle]` 失败，均已恢复。全门禁：`check` / `test`（563，562 通过 + 1 跳过）/ `typecheck` / `lint` / `format:check` / `build` 全绿。未改业务代码；`docs/reviews/` 未动。

**目标**：在不改变行为的前提下，把依赖方向、循环、深引用、3 条现有违例变成可失败的机械检查。

**依赖**：无。

**任务清单**：

1. 在 `scripts/check-layer.mjs` 内固化区域、允许边、禁止边与 public API allowlist，并导出纯函数供测试；
2. 扩展 `scripts/check-layer.mjs`：Node + 仓库已有 `typescript` 编译 API，解析 import / 动态 import / require；
3. 基线 allowlist 登记 3 条违例：
   - `kernel/store/library-fs/index.ts` → `kernel/core/metadata/constants.ts`；
   - `kernel/store/plugin-registry/index.ts` → `kernel/core/plugins/types.ts`；
   - `scripts/gui-smoke.mjs` → `kernel/store/backup-fs/index.ts`；
4. 规则覆盖：禁止边、循环、跨层深引用、GUI → kernel 内部、scripts → kernel 内部、生产代码 → tests；
5. 输出人类可读统计与失败清单（文件数 / 边数 / 循环 / allowlist）；
6. 增加 `check:arch` 别名并纳入 `npm run check` 与 CI；
7. 加反例测试：构造循环 / 反向边 / 深引用，断言脚本失败。

**契约 / 规范变更**：无；不新增 schema / 规范。

**测试**：

1. 反例测试 ≥ 3（循环、反向边、深引用）；
2. 既有 558 项全绿，本批实际 **+5** → 563（562 通过 + 1 跳过）；
3. 反例测试 5 项（区域归类 / 新跨层边 / 精确 allowlist / 循环 / GUI+scripts 内部引用）。

**验收**：

1. `check:arch` 可失败；
2. 3 条违例在 allowlist 中可见，带 owner / expires；
3. 0 个未登记违规；
4. 不改任何产品行为；
5. 纯重构 / 门禁批，不新增功能。

**门禁**：`npm run check` + `npm test` 全绿；allowlist 不得无期限。

### P0-b `contract/` 共享包与 3 条违例清零

**执行状态**：**已完成（2026-10-18）**。新增 `contract/` workspace 包（`@skill-manager/contract`，零运行时依赖，`exports` 指向 `src/index.ts`，由 esbuild / electron-vite 直接编译 TS 源码）；迁入结果类型、`CODES`（含 `CHANNEL_FAILED`）、`SOURCE_TIMEOUT_MS` / `SOURCE_MAX_OUTPUT_BYTES` / `BACKUP_NOTICE`、`SKILL_MD_NAME` / `DISABLED_SUFFIX`、插件纯结构类型。GUI 的 `update-check/constants.ts`、bridge/renderer 重复结果类型已删除；`E-CHANNEL-001` 与 `E-SRC-*` 改为 `CODES`；`gui-smoke` 改经 `kernel/index.ts` 公共导出 `createBackup`。结果：P0-a 的 3 条 allowlist 清零，`check:arch` 为 **126 文件 / 331 边 / 0 循环 / 0 例外**；`build:kernel` + `smoke:kernel`、`build:desktop` + `smoke:gui`（28/28）通过。全门禁：563 项测试、typecheck / lint / format:check / build 全绿。未改业务行为；`docs/reviews/` 未动。

**目标**：建立零运行时依赖的 `contract/` workspace 包，作为类型 / 常量唯一来源；清除 3 条违例，删除 GUI 双写。

**依赖**：P0-a。

**任务清单**：

1. 新增 `contract/package.json`、`contract/tsconfig.json`、`contract/src/index.ts`；
2. 迁入：
   - `Finding` / `Change` / `Result` / `KernelResult` 8 字段结果类型；
   - `CODES` / `ProblemCode`（含 `E-CHANNEL-001`）；
   - `E-SRC-005..010`；
   - 60s / 128MiB / 备份提示等跨层常量；
   - 契约枚举（宿主 / 根角色 / 分类 / 账本状态等纯类型）；
3. kernel（含 SEA 构建链路）、gui/main、gui/preload、gui/renderer 增加 `@skill-manager/contract` 依赖；
4. 删除 `gui/bridge/kernel.ts` / `gui/renderer/src/types.ts` 重复结果类型；
5. 删除 `gui/main/update-check/constants.ts` 重复常量；
6. `kernel/store/library-fs` 的共享常量改从 contract 导入；
7. `kernel/store/plugin-registry` 的纯结构类型改从 contract 导入；
8. `scripts/gui-smoke.mjs` 改用公共 CLI / 测试辅助，不再 import kernel store；
9. `update-check-constants.test.ts` 改为 contract 单源断言，删除“两份源码逐项比对”的长期补丁；
10. `check:arch` 锁 `contract/` 为最底层：不得 import kernel/gui，零运行时依赖；
11. 清空 P0-a 的 3 条 allowlist。

**契约 / 规范变更**：

1. 不新增规范 / schema；规范份数保持 **6**、schema 份数保持 **7**；
2. `schemas/result.schema.json` 不变；contract 类型与其一致性由测试锁定；
3. 不改变 8 字段结果封装与问题码语义。

**测试**：

1. contract 类型 / 常量单源测试；
2. GUI 无重复 `Finding` / `Change` / `KernelResult`；
3. `E-SRC-005..010`、超时 / 体积 / 备份提示只在一处；
4. `E-CHANNEL-001` 只从 contract 取；
5. 563 项全绿；本批改造现有 `update-check` 常量守卫，不新增测试数。

**验收**：

1. 3 条违例清零，allowlist 为空；
2. GUI 不 import kernel 内部；
3. `contract/` 不 import kernel/gui；
4. 修改一个常量不需要改 GUI 副本；
5. SEA 构建链路可正常 typecheck / build；
6. 纯重构，行为不变。

**门禁**：`check:arch` 0 违规；`npm run check` + `npm test` 全绿；不允许保留人工同步补丁。

### P0-c complexity / 文件规模 ratchet

**执行状态**：**已完成（2026-10-18）**。新增 `scripts/check-complexity.mjs` 与 `scripts/architecture/complexity-baseline.json`；`check:complexity` 已纳入 `npm run check`，`arch:baseline` 负责显式更新。实跑复现 **99 个 complexity > 10 函数 / 43 个文件 / 最大 52**，与审计一致；文件规模基线 **12 个**，四档阈值按非基线最大值反推：core 500（非基线最大 423）、vue 800（248）、tests 1000（611）、scripts 500（457）。三类临时自检均被捕获：新复杂函数 `[complexity-new]`、基线函数 52→53 `[complexity-up]`、基线大文件 2621→2622 `[size-up]`；恢复后绿色。全门禁：563 项测试、typecheck / lint / format:check / build 全绿。

**后续变化（L-2，2026-10-18）**：宿主通道从 `dispatch/registry` 拆到 `dispatch/host/` 后，complexity 基线由 **99 降至 96**，`dispatch/registry` 由 **2621 降至 2419** 行（非空行口径）；未放宽任何阈值，三份新文件均低于 core 500 行。

**后续变化（L-3，2026-10-18）**：卸载闭环拆为 `uninstall-options / types / plan / execute` 四文件后，complexity 基线由 **96 降至 95**；`dispatch/registry` 保持 **2419** 行，四份新文件均低于 core 500 行。

**目标**：锁定当前 99 个 complexity > 10 函数与 2621 / 1738 / 1173 / 858 等大文件基线；新代码不得超标，旧项只减不增。

**依赖**：P0-b。

**任务清单**：

1. 新增 `scripts/architecture/complexity-baseline.json`；
2. 新增 `scripts/check-complexity.mjs`（ESLint JSON 或 TypeScript AST；不新增依赖）；
3. 规则：
   - 新函数 complexity > 10 失败；
   - 旧函数不得高于基线；
   - 新文件超过所属档阈值失败：core 500 / vue 800 / tests 1000 / scripts 500；
   - 旧文件行数不得增加；下降时同步更新基线；
   - 基线函数/文件被拆分或改名后，残留条目必须报错；
4. `npm run arch:baseline` 显式生成基线；PR 可见；
5. 纳入 `npm run check` / CI；
6. 自检临时改动（新复杂函数、基线函数升高、基线文件加行）不入库。

**契约 / 规范变更**：无。

**测试**：

1. 三类临时自检均被捕获；
2. 基线文件与当前扫描一致；
3. 563 项全绿；本批不新增永久测试文件。

**验收**：

1. 新增代码不进入超标集合；
2. 旧超标数量不增加；
3. 基线可复核、可更新、不得手写放宽；
4. 纯门禁批，不改行为。

**门禁**：`check:complexity` 通过；`npm run check` + `npm test` 全绿。

### P0-d 共享测试夹具

**执行状态**：**已完成（2026-10-18）**。建立 `tests/helpers/`（temp / skill / host / plugin / backup / git-daemon），38 个测试文件的 **82 个直接 `mkdtemp` 调用点**全部改为 `makeTempDir`（grep 的 120 处匹配含 38 处 import 声明），直接调用数为 **0**；`validMeta` 3 处、`tempHostRoot` 3 处、插件 manifest、备份构造与回环 git daemon（含 Windows 进程树收尾）已复用 helper。特殊归档 / zip 安全样本与 bench N=5000 大夹具保留专门构造，但临时目录统一走 helper。新增 helpers 单测 6 项，常规套件 563 → **569**（568 通过 + 1 平台跳过）；慢测试 1 项通过；完整套件与慢测试前后 `sm-*` / `bench-fixture-*` 新目录均为 0。`check:test-fixtures` 已入 `npm run check`，直接 mkdtemp 基线 0。全门禁：569 项测试、typecheck / lint / format:check / build 全绿。

**目标**：建立 `tests/helpers/`，收编高频重复；锁定 120 处 `mkdtemp`，只减不增。

**依赖**：P0-b。

**任务清单**：

1. 新增 helpers：temp / skill / host / plugin / backup / git-daemon；
2. 迁移高频重复：
   - `validMeta` 3 处；
   - `tempWorkspace` 2 处（host-wiring / m5-closure）；land 的 `ensureWorkspaceDirs` 特殊构造保留；
   - `tempHostRoot` 3 处；
   - host-wiring 的 `makeSource` 迁移；m5-closure 的无 `location` 特殊 meta 保留；
3. 新测试必须使用 helpers；
4. 既有 82 个直接调用点（grep 120 含 import 行）清零，基线锁定为 0；
5. 夹具自身单元测试；
6. 不触碰真实宿主根；使用临时目录 + config 覆盖。

**契约 / 规范变更**：无。

**测试**：

1. helpers 自身测试；
2. 迁移前后断言语义不变；
3. 569 项全绿；helpers 新增 6 项。

**验收**：

1. `tests/fixtures/` 增加夹具说明，helpers 位于 `tests/helpers/`；
2. 高频重复辅助清零；
3. `mkdtemp` 数量不增加；
4. 隔离 / 清理 / 确定性可复核；
5. 纯测试基建，不改产品行为。

**门禁**：`npm test`、慢测试、GUI 冒烟全绿；无真实宿主写入。

---

## 2. P1：拆分与扩展点

### P1-a 宿主三处合一 + inventory_roots（已完成 2026-10-19）

**目标**：让 `FORM_BY_HOST` / `defaultRootFor` / 注册表三处合一；新增 `inventory_roots`，兑现 M5-R7。

**依赖**：P0-b、P0-d、L-1~L-5。

**执行状态**：**已完成（2026-10-19）**。注册表条目统一承载 `adapter_forms` / `landing_roots` / `inventory_roots`；`FORM_BY_HOST` 删除，`formImplementationOf` 从注册表派生；`defaultRootFor` 只展开 `landing_roots`；新增内置盘点根 selector 与插件 catalog selector，输出同一 `InventoryRootView`。分发默认根保持等价（Codex 仍为 `~/.agents/skills`）。新增 6 项契约测试；常规套件 621 → **627 项**（单元 400、契约 123、端到端 104；626 通过 + 1 项平台跳过）；`check:arch` 146 文件 / 416 边 / 0 循环 / 0 allowlist，complexity 基线 95 → **94**。

**任务清单**：

1. 注册表条目增加 `adapter_forms`、`landing_roots[]` 与 `inventory_roots[]`（root_id / role / kind / base / path_template / env_var / platform / depth / origin / consumed_by / notes / pending_verification）；
2. `adapter_forms` 驱动形态实现；删除 `FORM_BY_HOST`；
3. `defaultRootFor` 改为展开 `landing_roots`，删除 hostId if 分支；
4. 跨层纯类型置于 `contract/src/host-roots.ts`，内核 selector 与插件 selector 输出同一视图；
5. 7 个内置宿主行为不变；
6. 新增宿主 fixture：只改注册表 + 复用 `skill` 形态，不改 roots.ts / FORM_BY_HOST / dispatch；
7. 契约：`host-registry.spec.md` / `host_registry.schema.json` 扩展三组字段与 HR-14 / HR-15（规范 7 份、schema 8 份；本批不新增份数）。

**契约 / 规范变更**：更新宿主注册表规范 / schema；规范份数不变（7），schema 份数不变（8）；新增可选字段向后兼容。

**测试**：

1. 新增宿主 fixture：注册表校验 / 形态绑定 / 盘点根枚举；
2. 既有 7 宿主契约 / 落位测试全绿；
3. 627 项全绿；本批新增 6 项。

**验收**：

1. 新增宿主 = 注册表条目 + 适配器（若新形态），不改三处硬编码；
2. `inventory_roots` 可供 M4c 枚举；
3. 既有行为不变；
4. 纯重构 + 注册表扩展。

**门禁**：`check:arch` 0 违规；`npm test` 全绿。

### P1-b dispatch scan 段拆分（已完成 2026-10-19）

**目标**：把 `scan` 从 2621 行 registry 中抽成 `kernel/dispatch/scan/`，为 M4c `--inventory` 分流留出位置。

**依赖**：P0、P1-a。

**执行状态**：**已完成（2026-10-19）**。Skill 与插件扫描分别进入 `dispatch/scan/workspace.ts` / `plugin.ts`；计划、类型与结果组装独立；共享的工作区/插件索引读取辅助抽到 `dispatch/shared` 与 `dispatch/plugins`。`dispatch/registry/index.ts` 从 2419 降至 **2172** 行，只保留 `scanHandler` 注册。现有 scan 输出、退出码、索引与 `last_scan_at` 写入、workspace 加锁、插件扫描无锁行为不变。新增 2 项结构测试；常规套件 627 → **629 项**（628 通过 + 1 平台跳过）；`check:arch` 154 文件 / 462 边 / 0 循环。

**任务清单**：

1. 新建 `kernel/dispatch/scan/`：`index.ts` / `types.ts` / `options.ts` / `workspace.ts` / `plugin.ts` / `result.ts`；
2. `scanHandler` 只保留插件分支、扫描计划与 workspace 执行入口；
3. 现有 `scan` / `scan --kind plugin` 行为、输出、退出码不变；
4. 新增 registry 无 scan 实现与分流点的结构测试；
5. 不实现 `--inventory` 功能（M4c-1 才实现）。

**契约 / 规范变更**：无。

**测试**：

1. 现有 scan e2e 全绿；
2. 路由测试：skill / plugin 分支；
3. 629 项全绿；本批新增 2 项。

**验收**：

1. 拆分前后输出逐字段一致；
2. registry 行数下降；
3. `--inventory` 分支位置已留出且未注册占位参数；
4. 纯重构。

**门禁**：`npm test` 全绿；`check:arch` 0 违规。

### P1-c lifecycle 拆分（M4c 后）

**目标**：拆分 1738 行 `kernel/core/lifecycle/index.ts`，降低复杂度热点。

**依赖**：M4c-7、v0.4.0 范围确认（可随主干）。

**任务清单**：

1. 先抽 `project.ts`（投影 / 记录构造）；
2. 再抽 `toggle.ts`；
3. 再抽 `install.ts` / `update.ts`；
4. 最后 `restore.ts`；
5. 公共 `lifecycle/index.ts` 保留 barrel；
6. 保持「先备份 → 替换 → 重分发 → 写索引」顺序与失败原子性。

**契约 / 规范变更**：无。

**测试**：既有 lifecycle / e2e 测试全绿；不新增功能测试；每抽一个模块跑全套。

**验收**：行为不变；复杂度 / 行数下降；658 项基线全绿；纯重构。

**门禁**：`check:arch` / ratchet 通过。

### P1-d plugins/manifest 拆分（M4c 后）

**目标**：拆分 636 行、complexity 52 的 `manifest.ts`，建立规则表。

**依赖**：M4c-7、P1-c（可并行/顺序执行）。

**任务清单**：

1. 规则表 + 问题码映射；
2. 拆 `schema-rules` / `host` / `root` / `policy` / `errors`；
3. 保留 `validatePluginManifest` 公共入口；
4. 保持 schema / 手写校验一致；
5. 失败矩阵全保留。

**契约 / 规范变更**：无。

**测试**：插件失败矩阵 / schema 测试全绿；不新增功能测试。

**验收**：复杂度下降；行为不变；658 项基线全绿；纯重构。

**门禁**：`check:arch` / ratchet 通过。

---

## 3. P2：收口（M4c 后）

### P2-1 App.vue 拆分

- `App.vue` 858 行 → 视图 / composables；
- 保留导航与交互语义；
- GUI 冒烟全绿。

### P2-2 e2e `cli.test.ts` 拆分

- 1173 行按命令族拆；
- 共享 `tests/helpers/cli.ts`；
- 测试语义 / 数量不变。

### P2-3 架构依赖图

- 新增 `docs/architecture/dependency-graph.json`；
- `docs/architecture.md` 图由 JSON 生成 / 核对；
- `check:arch` 比较代码图与文档图。

### P2-4 死代码 / 重复收口

- 复核 4 个无用导出候选；
- 清理不改变公共 API；
- 无用导出 / 零导入文件不增加。

### P2-5 P0-c 剩余基线热点

- P1-a / P1-b / P1-c / P1-d 已覆盖 host、dispatch、lifecycle、plugins/manifest 的基线热点；
- `kernel/core/discovery`、`validation`、`backup`、`metadata`、`index`、`gui`、`scripts`、`tests` 等未归入 P1 的基线项，由 P2 按职责拆分或登记保留理由；
- 只减不增；拆分完成后用 `npm run arch:baseline` 更新基线并审阅 diff。

**契约 / 规范变更**：无。

**测试**：658 项 + GUI 冒烟；不新增功能测试。

**验收**：文件行数下降；文档图一致；无新增违规；纯重构。

---

## 4. 依赖关系与关键路径

```text
P0-a → P0-b → P0-c → P0-d
                         ↓
                    L-1 → L-2 → L-3 → L-4 → L-5
                         ↓
                    P1-a → P1-b
                         ↓
                    M4c-1 → M4c-2 → M4c-3 → M4c-4 → M4c-5 → M4c-6 → M4c-7
                         ↓
                    P1-c / P1-d / P2
```

**关键路径**：P0-b（contract）→ L-1（账本契约）→ L-2/L-3（账本生命周期）→ P1-a（宿主统一）→ P1-b（scan 段）→ M4c CLI/GUI。

**禁止**：P1-c/P1-d/P2 插到 M4c CLI 之前；账本 / 宿主三处合并没有完成就开 M4c CLI。

---

## 5. 测试、契约计数与版本

### 5.1 计数

| 项 | 计划值 |
|---|---:|
| 当前常规测试（M4c-6 后） | 658 |
| 纯重构批 | 不新增功能测试；新增门禁 / 反例测试 |
| 契约规范 | 保持 6，直到 L-1 增至 7 |
| JSON Schema | 保持 7，直到 L-1 增至 8 |
| 指令数 | 16 |
| P0 预计新增测试 | 10–12 |
| P1 预计新增测试 | 7–9 |

实际新增数在实现后回填；每个纯重构批必须至少保持当前基线全绿（658 项：657 通过 + 1 项平台跳过）。

### 5.2 版本

1. P0 / P1 / P2 纯重构**不发版**，随主干；
2. 账本 + M4c 合并 **v0.4.0**；P1-a/b 作为其内部前置随该版本；
3. P1-c/P1-d/P2 在 v0.4.0 后随主干，不单独发版；
4. 三平台、发版前守卫与发布资产沿用 v0.3.0 机制；
5. 最终版本范围在计划确认后锁定。

---

## 6. 遗留项登记

| 编号 | 遗留项 | 类型 | 处理 |
|---|---|---|---|
| TD-01 | 双源账本 → 单账本统一 | 技术债 | 计划 / CHANGELOG 登记；触发 plugin_index v2 或下一次分发契约变更 |
| TD-02 | macOS / Linux 真实用户宿主目录 | 待真机 | EX-08 模式；fixture 探针不替代真实布局 |
| TD-03 | `W-DRIFT-001` 措辞批次 | 既有遗留 | 按 one-summary 既有登记处理 |
| TD-04 | `--host all` 对历史无账本副本覆盖有限 | 已知边界 | M4c 标 inferred / untracked；二期处理 |
| TD-05 | 工作区 + 宿主 + 账本单一事务 | 未闭环 | 当前保证宿主副本 + 账本；更大编排重构另立 |
| TD-06 | 兼容 re-export barrel：`core/metadata/constants.ts`、`core/plugins/types.ts` | 技术债 | P1/P2 收口时删除，所有引用直接指向 contract |

---

## 7. 验收映射

| 需求 | 批次 | 验收 |
|---|---|---|
| MNT-R1 扩展点稳定 | P1-a / P1-b / P1-c / P1-d | 新增宿主 / scan 段 fixture；变更影响矩阵 |
| MNT-R2 分层与依赖 | P0-a / P0-b | check:arch 0 违规、0 循环、3 条违例清零 |
| MNT-R3 规模 / 复杂度 | P0-c / P1-c / P1-d / P2 | baseline 只减不增；热点下降 |
| MNT-R4 单一来源 | P0-b | contract 唯一来源；GUI 无重复类型 / 常量 |
| MNT-R5 公共 API / 内部边界 | P0-a / P0-b | barrel / deep import 检查 |
| MNT-R6 架构文档 | P2-3 | 代码图与文档图一致 |
| MNT-R7 死代码 / 重复 | P2-4 | 无用导出初筛复核；清理 |
| MNT-R8 测试基建 | P0-d | 120 处 mkdtemp 锁定 / 复用 |
| MNT-R9 审计与治理 | 全部 | 每批影响声明、基线、例外到期 |
| M-R-21 结构改造回归 | 全部 | 658 项起逐批全绿、纯重构 |

---

## 8. 门禁与检查清单

每批提交前：

1. 本批只做一类变化；纯重构与功能严格分离；
2. `npm test` 658 项全绿（657 + 1 跳过）；慢测试 / GUI 冒烟按口径；
3. `check:arch` 0 未登记违规；
4. complexity / max-lines 基线未放宽；
5. `contract/` 无 kernel/gui import、零运行时依赖；
6. 无新增 GUI / kernel 双写；
7. 不触碰真实宿主根；
8. 文档 / 计划 / 计数同步；
9. 回滚路径明确；
10. `docs/reviews/` 未改。

---

**计划结束**。本计划只定义批次、任务、验收与门禁，不含实现代码。
