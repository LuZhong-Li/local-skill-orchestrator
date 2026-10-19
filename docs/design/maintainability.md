# 可维护性建设设计（P0 护栏、P1 拆分、P2 收口）

| 项目 | 内容 |
|---|---|
| 文档名称 | 可维护性建设设计 |
| 文档路径 | `docs/design/maintainability.md` |
| 文档状态 | **设计稿，待评审**（2026-10-18；已吸收 P0/P1/P2 裁决） |
| 设计依据 | 需求第 10 章（MNT-R1 ~ R9）；`docs/research/maintainability-audit-2026-10-18.md`；M4c 设计 `docs/design/m4c-host-inventory.md` |
| 设计边界 | 只设计，不实现、不改代码 / 契约 / 测试 / `docs/reviews/`；纯重构批次不得夹带功能 |
| 关键约束 | P0 全量前置于 M4c；P1 只前置 M4c 相撞的宿主三处合一与 dispatch scan 段；563 项测试逐批全绿 |

> 本文把审计数字转成可执行的结构规则、批次边界与机械检查。复杂度 / 文件规模阈值采用「基线锁定 + 只减不增」的棘轮，不要求一次消灭 99 个超标函数。

---

## 0. 结论先行

### 0.1 已采纳的裁决

| 编号 | 裁决 | 设计落点 |
|---|---|---|
| D-01 | P0 全量前置：`check:arch`、3 条违例清零、complexity ratchet、单一来源、共享测试夹具 | 第 2 章 |
| D-02 | P1 只前置与 M4c 相撞的 dispatch scan 段、宿主三处合一 | 第 3 章 |
| D-03 | `lifecycle` 1738 行、`plugins/manifest` 636 行拆分可在 M4c 后段做 | 第 3.3、3.4 节 |
| D-04 | P2 收口（App.vue / e2e / 架构依赖图）在 M4c 后 | 第 4 章 |
| D-05 | 所有拆分是纯重构：行为不变、563 项测试逐批全绿、不夹带功能 | 第 5 章 |
| D-06 | 三平台只跑 fixture 探针；真实用户目录登记待真机项 | 第 5.4、6.3 节 |

### 0.2 设计原则

1. **先锁现状，再逐步下降**：不允许「先放宽规则让 CI 绿」；
2. **新增即受约束**：新文件 / 新函数不得进入超标集合；旧集合只减不增；
3. **单一来源优先于机械锁**：能直接复用 / 生成，就不维护第二份；
4. **只拆有证据的热点**：审计数字 + 变更耦合 + 扩展点价值；
5. **每批独立可验**：一个批次只做一类变化，测试与回滚边界清楚；
6. **不改变产品行为**：除 M4c 外，不改 CLI / GUI / 契约语义。

---

## 1. 范围与基线

### 1.1 当前基线（2026-10-18）

| 指标 | 数值 |
|---|---:|
| 常规测试 | 563（P0-a 后；562 通过 + 1 项平台条件跳过） |
| TS/JS 文件（import 图） | 110 |
| import 边 | 315 |
| 循环依赖 | 0 |
| store → core 反向依赖 | 2 |
| scripts → kernel store 内部引用 | 1 |
| complexity > 10 的函数 | 99（43 个文件） |
| complexity > 20 | 26 |
| complexity 最大 | 52（`validatePluginManifest`） |
| 文件 > 500 行 | 14 |
| 文件 > 1000 行 | 3 |
| 最大文件 | `kernel/dispatch/registry/index.ts` 2621 行 |
| 重复测试临时目录 | 120 处 `mkdtemp` / 38 个文件 |

### 1.2 范围

| 本期设计覆盖 | 不在本期 |
|---|---|
| P0 机械护栏与单一来源 | 产品功能（除 M4c 前置依赖） |
| P1 宿主三处合一、dispatch scan 段、lifecycle/plugins 拆分边界 | 性能优化、UI 重做、框架迁移 |
| P2 App.vue / e2e / 架构图收口 | 删除仍被契约使用的 API |
| 批次顺序、验收、回滚、指标 | 具体实现代码 |

---

## 2. P0：结构护栏（M4c 前置，全量）

### 2.1 `check:arch`：依赖方向与循环

#### 2.1.1 分层与允许边

| 层 / 区域 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `contract/`（新增共享契约） | 无运行时 | Node / kernel / GUI |
| `kernel/store/` | `contract/`、Node 内置 | `kernel/core`、`dispatch`、`entry`、GUI |
| `kernel/core/` | `store`、`contract`、同层公共入口 | `dispatch`、`entry`、GUI |
| `kernel/dispatch/` | `core`、`store`、`contract` | `entry`、GUI；被 `core` / `store` 反向引用 |
| `kernel/entry/` | `dispatch`、`store`、`contract` | 被下层反向引用 |
| `gui/main/` | `gui/bridge`、`contract` | kernel 内部深引用、renderer 内部 |
| `gui/preload/` | `contract` | 领域逻辑、renderer 内部 |
| `gui/renderer/` | `contract`、preload 暴露 API | Node / Electron / kernel 内部 / main 内部 |
| `scripts/` | 公共 CLI / 公共 API / `contract` / 测试辅助 | 内核内部实现、被 kernel / GUI 反向引用 |
| `tests/` | 任意测试辅助 / 必要的内部模块 | 被生产代码引用 |

#### 2.1.2 当前必清的三条违例

| 源 | 目标 | 处理 |
|---|---|---|
| `kernel/store/library-fs/index.ts` | `kernel/core/metadata/constants.ts` | 把 `SKILL_MD_NAME` / `DISABLED_SUFFIX` 等共享常量下移到 `contract/` 或 `store/contract` |
| `kernel/store/plugin-registry/index.ts` | `kernel/core/plugins/types.ts` | 把 `PluginIndex` / `PluginLanding` / `PluginRecord` 的纯结构类型下移到 `contract/` |
| `scripts/gui-smoke.mjs` | `kernel/store/backup-fs/index.ts` | 改用公共 CLI / 公共 API / 测试辅助；不把 store 内部暴露给 smoke |

#### 2.1.3 检查规则

扩展现有 `scripts/check-layer.mjs`（不另起检查器），使用 Node 静态解析 + 仓库已有 `typescript` 能力：

1. 解析 `kernel/`、`gui/`、`scripts/` 的 import / `import()` / `require()`；
2. 解析相对路径到实际文件；识别区域；
3. 检查：
   - 禁止边（表 2.1.1）；
   - 循环依赖（DFS / Tarjan）；
   - 跨层深引用（除非目标在 `contract/` 或显式 public API allowlist）；
   - `kernel/store` → `kernel/core` 零容忍；
   - `scripts` → `kernel/{core,store,dispatch,entry}` 内部零容忍；
   - GUI → kernel 内部零容忍（复用现有 `check:layer` 规则）；
   - 生产代码 → `tests/` 零容忍；
4. 输出人类可读统计（文件数 / 边数 / 循环 / allowlist）与失败列表；
5. 失败退出 1；`npm run check` 纳入；CI 必跑。

#### 2.1.4 例外与 allowlist

1. `contract/` 是唯一跨层共享包，允许所有层依赖；
2. `store/contract.ts` 若保留为兼容 re-export，必须标记 `public-contract`，不得成为新的内部实现入口；
3. P0-a 的 3 条基线 allowlist 内嵌在 `scripts/check-layer.mjs` 的 `BASELINE_ALLOWLIST`，不单独维护 JSON；条目含精确文件对、方向、原因、owner、expires、clearedBy；

条目形态示例（当前内嵌在脚本中）：

```json
{
  "id": "ARCH-001",
  "from": "path",
  "to": "path",
  "rule": "kernel-store -> kernel-core",
  "reason": "why",
  "owner": "name",
  "expires": "2026-12-31",
  "clearedBy": "P0-b"
}
```

4. P0 完成后三条违例清空，allowlist 为空（或仅保留经评审的临时项）；
5. 到期未清 → `check:arch` 失败；
6. 未来的外部化 allowlist JSON 仅作为可选演进，不作为 P0-a 前置。

#### 2.1.5 验收

1. `check:arch` 可失败，且至少一个反例测试证明它会对循环 / 反向边 / 深引用报红；
2. 当前 3 条违例清零；
3. 0 循环；
4. GUI 无 kernel 内部 import；
5. `scripts` 无 kernel 内部 import；
6. 563 项测试全绿。

### 2.2 ESLint complexity ratchet（棘轮）

#### 2.2.1 基线文件

`scripts/architecture/complexity-baseline.json`：

```json
{
  "generated_at": "2026-10-18T00:00:00Z",
  "threshold": 10,
  "entries": [
    {
      "file": "kernel/core/plugins/manifest.ts",
      "function": "validatePluginManifest",
      "line": 415,
      "complexity": 52
    }
  ],
  "file_lines": {
    "kernel/dispatch/registry/index.ts": 2621
  }
}
```

#### 2.2.2 规则

1. **新函数**：complexity ≤ 10；> 10 直接失败；
2. **已有函数**：不得高于基线；下降时更新基线（只在明确的重构批次）；
3. **文件行数**：新文件 ≤ 1000 行；已有文件不得高于基线；下降时更新；
4. **函数行数**：新函数 ≤ 200 行；已有函数不得高于基线；下降时更新；
5. 基线更新必须由 `npm run arch:baseline` 生成并在 PR 中可见；不得手写放宽；
6. 匿名函数 / 箭头函数用 `file + start line + ordinal` 稳定标识；重排导致基线失配时，人工确认后重建；
7. `complexity` 规则数据来源：ESLint JSON（`--rule '{"complexity":["warn",10]}'`）或 TypeScript AST；优先复用 ESLint，避免新依赖。

#### 2.2.3 初始基线

不要求 P0 消灭 99 个超标函数；P0 只锁定：

1. 99 个 >10（43 个文件）；
2. 47 个 >15；
3. 26 个 >20；
4. 9 个 >30；
5. 4 个 >40；
6. 1 个 >50；
7. 14 个文件 >500 行；3 个 >1000 行。

#### 2.2.4 验收

1. 新增代码不得新增超标项；
2. 既有超标项数量不增加；
3. 基线文件与当前扫描一致；
4. 至少一个反例测试证明新超标函数会失败；
5. 563 项测试全绿。

### 2.3 单一来源架构

#### 2.3.1 方案比较

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 共享 `contract/` workspace 包 | 新增纯 TS 包，kernel / gui 共同依赖 | 直接复用；GUI 不 import kernel 内部；无生成步骤 | 新增 workspace / 构建接线 | **推荐** |
| B 只导出内核公共类型 | GUI main 从 `kernel/index.ts` type-import；renderer 仍不能 | 改动小 | renderer 无法用；跨进程类型仍可能复制 | 不推荐 |
| C 构建期生成 contract | 从 schema / 常量生成 GUI 侧文件 | 适合外部契约 | 生成链复杂；常量源仍在 kernel | 备选 |

#### 2.3.2 推荐方案 A：`contract/` 包

包内容（纯 TS，无 Node / Electron）：

1. `Finding`、`Change`、`Result` / `KernelResult` 形状；
2. `ProblemCode` 与 `CODES`（含 `E-CHANNEL-001`）；
3. `E-SRC-005..010`、`SOURCE_TIMEOUT_MS`、`SOURCE_MAX_BYTES`、`BACKUP_NOTICE` 等跨层常量；
4. 共享路径 / 根角色 / 盘点分类 / 账本状态的纯类型（不包含 kernel 实现）。

**硬约束**：

1. `contract/` 零运行时依赖；**不得 import `kernel/` 或 `gui/`**；
2. 只放类型与常量：错误码表、`E-SRC-005..010`、`E-CHANNEL-001`、60s / 128MiB、8 字段结果类型、契约枚举；**不放运行时逻辑**；
3. `check:arch` 把 `contract/` 锁为最底层：所有层可依赖它，它不能反向依赖任何层；
4. kernel（含 SEA 构建链路）与 GUI 都 import `contract/`，彼此不直接引用；
5. 迁移一处由类型系统逼出全部双写点；**禁止保留「人工同步」补丁**（包括旧的逐项比对测试作为长期方案）。

依赖关系：

```text
contract/ (pure)
  ↑ kernel/store
  ↑ kernel/core
  ↑ kernel/dispatch
  ↑ kernel/entry
  ↑ gui/main, gui/preload, gui/renderer
  ↑ scripts (public constants only)
```

迁移：

1. 新增 `contract/package.json`、`contract/tsconfig.json`、`contract/src/index.ts`；
2. root `workspaces` 增加 `contract`；kernel / gui package 增加依赖；
3. `kernel/store/contract.ts` 改为 re-export 或删除；所有 import 改到 `@skill-manager/contract`；
4. `gui/bridge/kernel.ts`、`gui/renderer/src/types.ts` 删除重复定义，import contract；
5. `gui/main/update-check/constants.ts` 删除重复常量；
6. `schemas/result.schema.json` 保持外部契约；contract 类型与 schema 一致性由契约测试锁定；
7. `update-check-constants.test.ts` 改为“contract 常量 == schema / 规范”而不是 GUI 与 kernel 两份源码比对；
8. `check:arch` 允许所有层依赖 `contract/`；禁止 contract 依赖任何运行时层。

#### 2.3.3 验收

1. GUI 不再定义 `Finding` / `Change` / `KernelResult` 第二份；
2. `E-SRC-*`、超时 / 体积 / 备份提示只在一处；
3. `E-CHANNEL-001` 只从 contract 取；
4. 修改常量不需要改 GUI 副本；
5. 契约测试证明 contract 与 `schemas/result.schema.json` / 规范一致；
6. GUI 仍不 import kernel 内部；563 项测试全绿。

### 2.4 共享测试夹具

#### 2.4.1 目录与 API

```text
tests/helpers/
  workspace.ts   createTempWorkspace / cleanup / initWorkspace
  host.ts        createHostRoot / writeHostSkill / sharedRoot
  skill.ts       validMeta / writeSkill / writeSkillMeta
  plugin.ts      writePluginManifest / writePluginIndex / writeLanding
  snapshot.ts    snapshotTree / assertTreeUnchanged
  cli.ts         runCli / runJson
```

设计约束：

1. 所有临时目录用 OS temp；测试后清理；
2. 不触碰真实 `~/.claude` / `~/.codex` / 豆包目录；
3. 夹具固定输入、无网络、无时间依赖；
4. 结果断言统一走 `assertResult` / `assertFinding`；
5. 只读快照统一走 `snapshotTree`（相对路径、类型、大小、SHA-256、mtime）。

#### 2.4.2 迁移

1. P0 先迁移高频重复：`validMeta`（3）、`tempWorkspace`（3）、`tempHostRoot`（3）、`makeSource`（2）；
2. 新增测试必须使用 helpers；
3. 既有 120 处 `mkdtemp` 分批迁移；P0 锁定数量，只减不增；
4. 迁移批次不改测试语义；断言保持 / 增强，不删除。

#### 2.4.3 验收

1. `tests/fixtures/` 不再只有 `.gitkeep`；
2. 高频重复辅助清零（除必要的测试本地特例）；
3. `mkdtemp` 数量不增加，P0 后开始下降；
4. 563 项测试、慢测试、GUI 冒烟全绿；
5. 新增夹具自身有单元测试。

---

## 3. P1：拆分与扩展点

### 3.1 宿主三处合一（M4c 前）

#### 3.1.1 目标模型

```text
HostDescriptor:
  host_id, display_name, adapter_ref
  adapter_forms: skill | rules | entry
  landing_roots[]                # 既有默认分发根，行为保持不变
  inventory_roots[]              # 只读盘点候选根（root_id / role / kind / base / depth / origin / consumed_by）
  support_state, evidence
  render_policy
```

`adapter_forms` 绑定通用形态实现；`inventory_roots` 提供 M4c 根枚举；`landing_roots` 保持现有分发行为。

#### 3.1.2 消除三处硬编码

| 现状 | 目标 |
|---|---|
| `FORM_BY_HOST` 按 hostId 硬编码 | 由 `adapter_forms` + 形态实现派生，不再维护宿主→形态第二表 |
| `defaultRootFor()` 按 hostId if 分支 | 由 `landing_roots` 数据展开 |
| 注册表条目 | 保持唯一事实源；新增宿主只改条目 + 新形态实现 |

#### 3.1.3 新增宿主验收

1. 在测试注册表加一个宿主条目 + 复用 `skill` 形态；
2. 未来的新增宿主不改 selector 代码、不重建 `FORM_BY_HOST`、不改 dispatch；
3. 渲染、落位、库存根枚举均通过夹具；
4. 既有 7 宿主行为不变；P1-a 收口时 627 项测试全绿。

#### 3.1.4 与 M4c 的关系

M4c 的 `role` / `depth` / 根枚举依赖 `inventory_roots`；因此该批次必须在 M4c CLI 之前。它同时是 M5-R7 的兑现。

### 3.2 dispatch scan 段拆分（P1-b 已完成）

#### 3.2.1 目标边界

从 `kernel/dispatch/registry/index.ts` 抽出：

```text
kernel/dispatch/scan/
  index.ts          # 插件 / workspace 入口与 M4c-1 inventory 分流点
  types.ts          # scan 计划与结果类型
  options.ts        # 现有 --root / --dry-run 参数计划
  workspace.ts      # 现有 scan skill 写路径（加锁）
  plugin.ts         # 现有 scan --kind plugin
  result.ts         # scan 结果组装 / 排除项
```

`scanHandler` 只保留：

1. `--kind plugin` 分支；
2. 形成 workspace 扫描计划；
3. 在索引检查前调用 workspace 执行；M4c-1 的 inventory 分支从同一位置接入。

#### 3.2.2 约束

1. 纯重构：现有 `scan` / `scan --kind plugin` 行为、输出、退出码不变；
2. `scan` 的写路径仍由 lifecycle / discovery 负责；不把写逻辑搬进 inventory；
3. M4c 的 `inventory.ts` 是只读分支，不得复用 `withLock` / `saveIndex`；
4. 拆分后 registry 文件行数下降，但不在本批次追求最终阈值；
5. 629 项测试全绿；新增 2 项 scan 结构测试。

#### 3.2.3 验收

1. `scan` 既有 e2e 全部通过；
2. `scan --kind plugin` 既有测试通过；
3. `--inventory` 尚未实现时，路由位置已为后续留出；
4. 拆分前后输出逐字段一致。

### 3.3 lifecycle 拆分（M4c 后）

#### 3.3.1 目标边界

`kernel/core/lifecycle/index.ts` 拆为：

```text
lifecycle/
  index.ts          # 公共 barrel
  install.ts        # installFromSource / install flow
  update.ts         # updateFromSource / check
  toggle.ts         # enableSkill / disableSkill
  restore.ts        # restoreSkill
  project.ts        # projectRecord / toIndexRecord / targets projection
  types.ts          # LifecycleOutcome / inputs
```

#### 3.3.2 顺序与约束

1. 先抽 `project.ts`（纯投影 / 记录构造），再抽 `toggle.ts`，再 `install.ts` / `update.ts`，最后 `restore.ts`；
2. 保持「先备份 → 再替换 → 重分发 → 最后写索引」顺序不变；
3. 保持失败原子性 / 回滚语义不变；
4. 公共 `lifecycle/index.ts` 仍导出既有函数，调用方不改；
5. 每抽一个模块，相关单测 + e2e 全绿；
6. 不在 M4c 前做；M4c 后段执行。

#### 3.3.3 验收

1. 文件行数下降，复杂度热点减少；
2. 安装 / 更新 / 启停 / 恢复行为不变；
3. 563 项测试全绿；
4. `check:arch` 无新增违规。

### 3.4 plugins/manifest 拆分（M4c 后）

#### 3.4.1 目标边界

`kernel/core/plugins/manifest.ts` 636 行、complexity 52，拆为规则表 + 小函数：

```text
plugins/manifest/
  index.ts          # validatePluginManifest
  schema-rules.ts   # 字段白名单 / 必填 / 类型
  host.ts           # validateHost
  root.ts           # validateRoot
  policy.ts         # render_policy / security
  errors.ts         # 问题码映射
```

#### 3.4.2 约束

1. 先建立规则表与问题码映射，再拆函数；
2. JSON Schema 与手写校验保持同源/逐项测试；
3. 失败矩阵（`tests/e2e/plugin-matrix.test.ts`）全部保留；
4. 不改变插件 manifest 语义与错误码；
5. 不在 M4c 前做，M4c 后段执行。

#### 3.4.3 验收

1. `validatePluginManifest` 复杂度显著下降；
2. 规则表覆盖所有现有规则；
3. 失败矩阵全绿；
4. 563 项测试全绿。

### 3.5 P1 批次映射

| 批次 | 内容 | 前置 | 时间点 |
|---|---|---|---|
| P1-a | 宿主三处合一 + `inventory_roots` | P0 | M4c 前 |
| P1-b | dispatch scan 段拆分 | P0 | M4c 前 |
| P1-c | lifecycle 拆分 | M4c | M4c 后 |
| P1-d | plugins/manifest 拆分 | M4c | M4c 后 |

---

## 4. P2：收口（M4c 后）

### 4.1 App.vue 拆分

`gui/renderer/src/App.vue` 858 行，按视图与状态拆分：

1. `views/DashboardView.vue`、`views/ValidationView.vue`、`views/BackupView.vue`、`views/PluginsView.vue`、`views/HostInventoryView.vue`（M4c）、`views/SettingsView.vue`；
2. `composables/useSkills.ts`、`usePlugins.ts`、`useBackups.ts`、`useHostInventory.ts`；
3. `App.vue` 只保留导航 / 装配 / 全局状态；
4. GUI 冒烟覆盖所有视图；不改变交互语义。

### 4.2 e2e `cli.test.ts` 拆分

`tests/e2e/cli.test.ts` 1173 行，按命令族拆分：

```text
tests/e2e/cli/
  init-config.test.ts
  scan-list-inspect.test.ts
  install-uninstall.test.ts
  enable-disable.test.ts
  update-restore.test.ts
  errors.test.ts
```

共享 `tests/helpers/cli.ts`；测试总数与语义不变。

### 4.3 架构依赖图文档

1. 新增 `docs/architecture/dependency-graph.json`（module / layer / edges / allowed）；
2. `docs/architecture.md` 中的图由该 JSON 生成或核对；
3. `scripts/check-layer.mjs`（check:arch）生成实际图并比较文档图；
4. 新增 / 删除模块或改变层间边时，文档漂移测试失败。

### 4.4 死代码 / 重复清理

1. 用 TypeScript 符号级分析复核 4 个初筛无用导出；
2. 清理重复实现 / 无用辅助；
3. 不删除测试契约或公共 API；
4. 无用导出数 / 零导入文件数不增加。

### 4.5 P2 验收

1. App.vue / e2e 行数下降，职责清晰；
2. GUI 冒烟、563 项测试全绿；
3. 文档图与代码图一致；
4. 无新增违规 / 超标函数；
5. 不改产品行为。

---

## 5. 批次序列与版本

### 5.1 总序列

```text
P0-a  check:arch 基线（允许 3 条临时例外）
P0-b  contract 共享包 + 清除 3 条违例（allowlist 清空）
P0-c  complexity / 文件规模 ratchet
P0-d  共享测试夹具 + 高频重复迁移
账本    host_landings + uninstall --host + 契约
P1-a   宿主三处合一 + inventory_roots
P1-b   dispatch scan 段拆分
M4c CLI scan --inventory
M4c GUI hosts 视图
P1-c   lifecycle 拆分
P1-d   plugins/manifest 拆分
P2     App.vue / e2e / 架构图 / 死代码
```

### 5.2 每批约束

1. 独立分支 / 独立批次；每批可回滚；
2. 每批 563 项测试全绿；慢测试与 GUI 冒烟按既有口径；
3. 每批不夹带功能；除 M4c / 账本外不改用户可见行为；
4. `check:arch` / ratchet 从 P0-a 起持续运行；
5. 账本批次的契约变更先登记再实现；
6. 版本建议：账本 + M4c 契约变更合并为 **v0.4.0**；最终在计划中定。

### 5.3 依赖关系

1. P0-b 依赖 contract 包，P0-a 可先用 allowlist 锁住 3 条违例；
2. 账本依赖 P0-b（共享常量 / 类型）与 P0-d（测试夹具）；
3. 宿主三处合一依赖 P0 与账本（账本需要 `root_role`）；
4. dispatch scan 段依赖 P0 与宿主三处合一；
5. M4c CLI 依赖账本 + 宿主三处合一 + dispatch scan 段；
6. M4c GUI 依赖 CLI 输出；
7. lifecycle / plugins 拆分在 M4c 后，避免与功能批次相撞。

### 5.4 三平台与真机

1. `check:arch` / ratchet / 测试在 Windows / Linux / macOS CI 跑；
2. M4c fixture 探针在三平台跑（见 M4c 设计第 8 章）；
3. 真实用户宿主目录（`~/.claude/skills` 等）登记为待真机项，不伪造；
4. 真实目录验证不阻塞设计 / 计划，但阻塞「三平台真实目录已实测」的验收声明。

### 5.5 跨文档阶段建议

1. **P0 四批**：check:arch 基线 → contract 单一来源并清除 3 条违例 → complexity / 文件规模 ratchet → 共享测试夹具；
2. **账本批次**：`host_landings` + `uninstall --host` + 契约 / schema / 需求增量；
3. **P1 前两批**：宿主三处合一（`inventory_roots` / `adapter_ref` / 默认根数据化）→ dispatch scan 段拆分；
4. **M4c**：CLI `scan --inventory` → GUI `hosts` 视图；
5. **P1 后两批**：lifecycle 拆分 → plugins/manifest 拆分；
6. **P2**：App.vue / e2e / 架构依赖图 / 死代码收口。

该序列的硬边界：账本与宿主三处合一是 M4c CLI 的前置；dispatch scan 段必须先把 `--inventory` 分支位置留出；lifecycle / plugins 拆分不得插到 M4c CLI 前，避免功能与结构同时变更。版本建议把账本 + M4c 合并为 **v0.4.0**，最终以计划为准。

---

## 6. 机械检查实现方式

### 6.1 `check:arch`

| 项 | 设计 |
|---|---|
| 语言 / 工具 | Node + 仓库已有 `typescript` 编译 API；不引入 madge / depcruise |
| 输入 | `scripts/check-layer.mjs` 内嵌规则、`BASELINE_ALLOWLIST`、`tsconfig` 项目 |
| 输出 | 人类可读统计（文件数 / 边数 / 循环 / allowlist）+ 失败列表 |
| 规则 | 允许边、禁止边、循环、深引用、public API allowlist |
| 集成 | `npm run check`（check:layer 内含架构检查）+ `check:arch` 别名；CI verify 工作流 |
| 反例测试 | `tests/contract/architecture.test.ts` 5 项；另做临时跨层 / 环自检并恢复 |

### 6.2 complexity / file-size ratchet

| 项 | 设计 |
|---|---|
| 工具 | ESLint `complexity` JSON（已有）或 TypeScript AST；不新增依赖 |
| 基线 | `scripts/architecture/complexity-baseline.json` |
| 规则 | 新函数 >10 失败；旧函数不得高于基线；新文件 >1000 行失败；旧文件不得增加 |
| 更新 | `npm run arch:baseline` 显式生成；PR 可见 |
| 集成 | `npm run check` / CI |
| 反例 | 新增一个 >10 的函数，断言失败 |

### 6.3 单一来源检查

1. `contract/` 包是唯一类型 / 常量来源；
2. `check:arch` 禁止 kernel 内部导入 / GUI 复制；
3. 契约测试验证 contract 与 `schemas/result.schema.json` / 规范一致；
4. 删除 `update-check-constants.test.ts` 的双写比对，改为 contract 单源断言；
5. `E-CHANNEL-001` 从 contract 取，GUI 无字面量。

### 6.4 测试夹具检查

1. 新测试必须从 `tests/helpers/` 导入；
2. `mkdtemp` 数量基线锁定；
3. 共享夹具自身有单元测试；
4. 不触碰真实宿主根（CI 环境变量 / 配置覆盖）。

### 6.5 架构文档图

1. `architecture-report.json` 作为源；
2. `docs/architecture/dependency-graph.json` 与报告比较；
3. `docs/architecture.md` 的 Mermaid / 表格由该 JSON 生成或核对；
4. 新增模块 / 边时检查失败，提示更新文档。

---

## 7. MNT-R1 ~ R9 对照

| 需求 | 设计落点 | 机械检查 |
|---|---|---|
| MNT-R1 扩展点稳定 | 3.1 宿主三处合一、3.2 scan 段、3.3/3.4 拆分 | 新增宿主 / 指令 fixture；变更影响矩阵 |
| MNT-R2 分层与依赖 | 2.1 | `check:arch` 禁止边 / 环 / 深引用 |
| MNT-R3 模块规模 / 复杂度 | 2.2、3.3、3.4、4.1、4.2 | complexity / max-lines ratchet |
| MNT-R4 单一来源 | 2.3 | contract 唯一来源；重复定义检查 |
| MNT-R5 公共 API / 内部边界 | 2.1、2.3 | barrel / deep import 检查 |
| MNT-R6 架构文档 | 4.3 | 文档图与 import 图比较 |
| MNT-R7 死代码 / 重复 | 4.4 | 符号级初筛 + 无用导出基线 |
| MNT-R8 测试基建 | 2.4 | 夹具复用 / mkdtemp 基线 |
| MNT-R9 审计与治理 | 5、6 | 批次影响声明、基线更新、例外到期 |

---

## 8. 风险与回滚

| 编号 | 风险 | 应对 |
|---|---|---|
| R-MNT-01 | check:arch 过严，导致大量历史代码无法通过 | P0-a allowlist 仅 3 条；P0-b 清零；不把历史内部类型全部当违规 |
| R-MNT-02 | ratchet 基线被手动放宽 | 基线由脚本生成；PR 审查；只减不增 |
| R-MNT-03 | contract 包引入循环 / 构建问题 | contract 纯 TS、无 Node；`check:arch` 禁止反向依赖 |
| R-MNT-04 | 拆 lifecycle / plugins 改变行为 | 纯重构、逐模块、563 项测试 / 失败矩阵 |
| R-MNT-05 | 拆分批次与 M4c 相撞 | 只前置 host 三处合一 + scan 段；其余后置 |
| R-MNT-06 | 测试夹具迁移改变语义 | 断言保持 / 增强；不删测试；逐批迁移 |
| R-MNT-07 | 文档图与代码漂移 | JSON 源 + 机械比较 |
| R-MNT-08 | 版本发布节奏 | 账本 + M4c 合并 v0.4.0；计划确认 |

**回滚**：每批独立提交 / 分支；回滚该批不带走其他批；契约批次按版本回滚；测试夹具迁移可逆。

---

## 9. 验收与交付

### 9.1 P0 验收

1. `check:arch` 通过且可失败；3 条违例清零；0 循环；
2. complexity / 文件规模基线锁定，新代码不得超标；
3. contract 单一来源；GUI 无重复类型 / 常量；
4. `tests/helpers/` 建立，高频重复迁移；
5. 563 项测试全绿。

### 9.2 P1 验收

1. 宿主三处合一：新增宿主只改注册表 + 适配器；
2. dispatch scan 段拆分：既有 scan 行为不变；
3. lifecycle / plugins 拆分：复杂度下降、行为不变；
4. 563 项测试 / 慢测试 / GUI 冒烟全绿。

### 9.3 P2 验收

1. App.vue / e2e 文件行数下降；
2. 架构图与代码图一致；
3. 无新增超标 / 违规；
4. 563 项测试全绿。

### 9.4 交付物

1. `scripts/check-layer.mjs`（check:arch）+ rules / allowlist / baseline；
2. `contract/` 包与迁移清单；
3. `tests/helpers/` 与迁移记录；
4. 拆分后的模块 / 公共 barrel；
5. 架构图 JSON + 文档；
6. 前后指标表（文件行数、复杂度、违规数、重复夹具数、测试结果）。

---

## 10. 附录：批次检查清单

每个批次提交前核对：

1. 本批只做一类变化；
2. 563 项测试全绿（562 通过 + 1 项平台跳过）；
3. `check:arch` 无新增违规；
4. complexity / max-lines 基线未放宽；
5. 无新增 GUI / kernel 双写；
6. 无新增真实宿主根写入；
7. 文档图 / 契约引用同步；
8. 回滚路径明确；
9. 不夹带 M4c 功能（除 M4c 批次）；
10. `docs/reviews/` 未改。

---

**设计结束**。本文档只定义设计，不包含实现代码；所有拆分批次必须保持行为不变并逐批验证。
