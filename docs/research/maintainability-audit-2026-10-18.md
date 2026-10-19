# 可维护性架构审计（第 10 章前置）

| 项目 | 内容 |
|---|---|
| 文档名称 | 可维护性架构审计 |
| 文档路径 | `docs/research/maintainability-audit-2026-10-18.md` |
| 文档状态 | **审计完成，待设计取舍**（2026-10-18） |
| 依据 | 需求第 10 章（MNT-R1 至 MNT-R9）；9.3.7 结构前置约束 |
| 方法 | 逐文件行数、TypeScript / JS import 图、循环检测、ESLint `complexity`、源码检索、测试夹具统计 |
| 边界 | 只读审计；不改代码、不改契约、不改测试、不改 `docs/reviews/`、不改 `docs/requirements.md` |

> 本文只给现状、真实数字、热点与改进候选，不实施拆分。所有改进项都必须回到审计证据；没有证据的「为拆而拆」不进入清单。

---

## 0. 方法与证据等级

### 0.1 采集方法

| 项 | 方法 |
|---|---|
| 文件规模 | 递归统计 `kernel/`、`gui/`、`scripts/`、`tests/` 下 `.ts` / `.tsx` / `.mjs` / `.js` / `.vue`，排除 `node_modules`、`out`、`dist`、`build` |
| 依赖图 | 一次性 Node 脚本解析相对 import / `import()` / `require()`，解析到实际文件；按区域归并；DFS 检测环 |
| 复杂度 | 既有 ESLint 配置 + `complexity` 规则（阈值 10），统计函数级告警 |
| 重复常量 | 源码检索 `E-*` / `W-*`、超时 / 体积常量、结果类型定义 |
| 测试夹具 | 检索 `mkdtemp`、`tempWorkspace`、`tempHostRoot`、`validMeta`、`makeSource` 等 |
| 边界检查 | 复核 `scripts/check-layer.mjs`、`scripts/check-contract.mjs`、`eslint.config.mjs` 的实际覆盖面 |

### 0.2 证据等级

| 等级 | 含义 |
|---|---|
| **[实测]** | 本次在仓库上运行脚本 / 命令得到的数字 |
| **[源码]** | 可直接定位的文件与行号 |
| **[推断]** | 由结构或重复模式推出，需设计阶段复核 |
| **[待补]** | 当前审计未取得足够证据，不能作为拆分依据 |

### 0.3 限制

1. 复杂度使用 ESLint `complexity`，是决策点计数，不等同于认知复杂度；用于排序，不用于单独判决；
2. 跨模块深引用统计包含合法的 `store/contract.ts` 与同层类型契约，不能把 247 条全部当违规；
3. 未做运行时火焰图；性能不是本审计目标；
4. 未做完整的「无用导出」符号级分析；第 5.3 节的 4 个候选只是初筛；
5. 未改任何源码或测试；所有数字为 2026-10-18 快照。

---

## 1. 结论摘要

1. **循环依赖为 0**：110 个 TS/JS/Vue 文件中解析出 315 条相对 import 边，DFS 未发现环。这是好消息，说明当前结构没有硬性循环死结。
2. **存在 2 条 store → core 反向依赖**：`kernel/store/library-fs/index.ts` → `kernel/core/metadata/constants.ts`，`kernel/store/plugin-registry/index.ts` → `kernel/core/plugins/types.ts`。这与「store 是最低层」的目标方向冲突，是 MNT-R2 的直接证据。
3. **存在 1 条 scripts → kernel store 内部引用**：`scripts/gui-smoke.mjs` → `kernel/store/backup-fs/index.ts`。scripts 不应依赖内核内部实现；应走公共 API 或测试辅助。
4. **GUI 没有 kernel 内部深引用**：现有 `check:layer` 的这项检查有效；GUI 通过子进程 bridge 调内核，不直接 import `kernel/dispatch|core|store|entry`。
5. **规模热点集中**：`kernel/dispatch/registry/index.ts` 2621 行、`kernel/core/lifecycle/index.ts` 1738 行、`tests/e2e/cli.test.ts` 1173 行、`gui/renderer/src/App.vue` 858 行；14 个文件超过 500 行，4 个超过 800 行。
6. **复杂度热点集中且可量化**：99 个函数 complexity > 10（43 个文件），47 个 > 15，26 个 > 20，9 个 > 30，4 个 > 40，最大 52（`validatePluginManifest`）。
7. **单一来源缺口明确**：GUI 侧复制了 `E-SRC-005..010`、60s / 128MiB、备份提示；结果类型 `Finding` / `Change` / `KernelResult` 在 kernel、bridge、renderer 三处重复；`E-CHANNEL-001` 在 GUI 内出现 4 次。
8. **测试夹具复用不足**：`tests/fixtures/` 只有 `.gitkeep`；120 处 `mkdtemp` 分布在 38 个测试文件；`validMeta` 重复 3 次、`tempWorkspace` 3 次、`tempHostRoot` 3 次、`makeSource` 2 次。
9. **扩展点仍有散弹**：新增宿主至少触碰注册表、`FORM_BY_HOST`、`defaultRootFor`、测试与文档；M5-R7 的「新增宿主 = 适配器 + 注册表一行」尚未完全成立。新增指令至少触碰注册表、解析器、帮助、bridge、契约、测试。
10. **机械护栏缺口**：现有 `check:layer` 只查三条边界；没有模块级循环检查、store/core 方向检查、文件规模 / 复杂度门禁、单一来源检查、架构文档图核对。ESLint 已有 renderer 的 Node / Electron 禁止导入规则，可复用扩展。

---

## 2. 规模基线

### 2.1 分区总量

| 区域 | 文件数 | 总行数 |
|---|---:|---:|
| `kernel/` | 55 | 15,347 |
| `gui/` | 35 | 4,121 |
| `scripts/` | 31 | 4,541 |
| `tests/` | 76 | 15,109 |
| **合计** | **197** | **39,118** |

说明：文件数包含 `.vue`；不含 `node_modules`、`out`、`dist`、`build`。

### 2.2 Top 热点

| 文件 | 行数 |
|---|---:|
| `kernel/dispatch/registry/index.ts` | 2,621 |
| `kernel/core/lifecycle/index.ts` | 1,738 |
| `tests/e2e/cli.test.ts` | 1,173 |
| `gui/renderer/src/App.vue` | 858 |
| `kernel/core/hosts/validate.ts` | 758 |
| `scripts/gui-smoke.mjs` | 743 |
| `kernel/core/lifecycle/source.ts` | 720 |
| `kernel/core/validation/index.ts` | 670 |
| `kernel/core/backup/index.ts` | 654 |
| `kernel/core/plugins/manifest.ts` | 636 |
| `tests/contract/schema.test.ts` | 611 |
| `kernel/core/metadata/validate.ts` | 579 |
| `scripts/bench/runner.mjs` | 534 |
| `tests/unit/lifecycle.test.ts` | 524 |
| `tests/unit/restore.test.ts` | 457 |
| `scripts/bench/fixture.mjs` | 457 |
| `tests/e2e/plugin-cli.test.ts` | 454 |
| `tests/unit/plugin-t0.test.ts` | 442 |
| `kernel/core/discovery/index.ts` | 423 |
| `kernel/core/hosts/registry-data.ts` | 420 |
| `kernel/store/backup-fs/index.ts` | 418 |
| `tests/contract/ci-workflows.test.ts` | 399 |
| `tests/contract/host-registry.test.ts` | 385 |
| `kernel/core/plugins/host.ts` | 385 |
| `kernel/core/plugins/discovery.ts` | 361 |

### 2.3 行数阈值分布

| 阈值 | 文件数 |
|---|---:|
| > 300 行 | 33 |
| > 500 行 | 14 |
| > 800 行 | 4 |
| > 1000 行 | 3 |
| > 1500 行 | 2 |
| > 2000 行 | 1 |

**结论**：不能立即把 500 行设为硬门禁，否则 14 个既有文件立刻失败；应先建立基线 + 例外清单，再逐步收紧。

### 2.4 复杂度阈值分布

使用 ESLint `complexity`（阈值 10）扫描 `kernel/`、`gui/`、`scripts/`、`tests/`：

| 复杂度 | 函数数 |
|---|---:|
| > 10 | 99（43 个文件） |
| > 15 | 47 |
| > 20 | 26 |
| > 30 | 9 |
| > 40 | 4 |
| > 50 | 1 |
| 最大 | 52 |

Top 复杂度函数：

| 文件 | 函数 | 复杂度 |
|---|---|---:|
| `kernel/core/plugins/manifest.ts` | `validatePluginManifest` | 52 |
| `kernel/core/discovery/index.ts` | `buildRecord` | 47 |
| `scripts/bench/fixture.mjs` | `planFixture` | 46 |
| `scripts/gui-smoke.mjs` | `main` | 45 |
| `kernel/core/plugins/manifest.ts` | `validateHost` | 39 |
| `kernel/core/lifecycle/index.ts` | `restoreSkill` | 37 |
| `kernel/core/lifecycle/index.ts` | `installFromSource` | 34 |
| `gui/main/plugins/hosts.ts` | `partitionPluginHosts` | 33 |
| `kernel/dispatch/registry/index.ts` | `runHostToggle` | 31 |
| `kernel/core/plugins/manifest.ts` | `validateRoot` | 30 |
| `kernel/core/lifecycle/index.ts` | `enableSkill` | 27 |
| `kernel/core/hosts/validate.ts` | `checkPolicy` | 27 |
| `kernel/core/hosts/validate.ts` | `checkClassificationAndRoots` | 26 |
| `kernel/core/discovery/index.ts` | `scanWorkspace` | 25 |
| `kernel/core/index/index.ts` | `setConfig` | 24 |
| `kernel/core/plugins/host.ts` | `buildPluginHostPlan` | 24 |
| `scripts/bench/runner.mjs` | `measureScenario` | 24 |
| `kernel/core/plugins/discovery.ts` | `discoverPluginPackages` | 24 |
| `kernel/core/adapters/roots.ts` | `resolveHostRoot` | 24 |

**结论**：拆分优先级应按「复杂度 × 变更耦合 × 是否扩展点」排序，而不是单看行数。`validatePluginManifest`、`buildRecord`、`installFromSource` / `restoreSkill`、`runHostToggle` 同时命中复杂度与核心路径。

---

## 3. 依赖图与分层

### 3.1 图规模

| 指标 | 值 |
|---|---:|
| 扫描文件 | 110（TS/JS，不含 `.vue`） |
| 解析出的相对 import 边 | 315 |
| 跨区域边 | 143 |
| 循环依赖 | **0** |
| 未解析的相对 import | 1（`gui/renderer/src/main.ts` → `./App.vue`，Vue 文件不在 TS 图内，属正常） |

跨区域边的主要方向：

| 方向 | 边数 |
|---|---:|
| core → store | 79 |
| dispatch → core | 28 |
| dispatch → store | 14 |
| entry → dispatch | 5 |
| store → core | **2** |
| scripts → store | **1** |

### 3.2 两条 store → core 反向依赖

| 源 | 目标 | 用途 | 判定 |
|---|---|---|---|
| `kernel/store/library-fs/index.ts:15` | `kernel/core/metadata/constants.ts` | `SKILL_MD_NAME`、`DISABLED_SUFFIX` | **反向依赖**：store 是基础层，却依赖 core 的元数据常量 |
| `kernel/store/plugin-registry/index.ts:11` | `kernel/core/plugins/types.ts` | `PluginIndex`、`PluginLanding`、`PluginRecord` 类型 | **反向依赖**（type-only）：store 的插件索引持久化依赖 core 的领域类型 |

影响：

1. 违反 MNT-R2 的「store 不得依赖 core」；
2. 类型反向依赖会迫使 store 了解插件领域模型，后续拆分插件会牵连存储层；
3. 解决方式必须在设计阶段选：把共享常量 / 类型下移到更低的契约模块，或把这些类型改为 store 自有结构 + core 做映射。不能简单复制。

### 3.3 scripts → kernel store 内部引用

| 源 | 目标 | 用途 | 判定 |
|---|---|---|---|
| `scripts/gui-smoke.mjs:19` | `kernel/store/backup-fs/index.ts` | 生成备份夹具 | **跨层内部引用**：scripts 不应直接依赖内核实现；应走公共 API 或测试辅助 |

### 3.4 GUI 与内核边界

1. `gui/main` 通过 `gui/bridge/commands.ts` 的 `KernelBridge` 以子进程调用内核；
2. `gui/bridge/kernel.ts` 只依赖 `node:child_process`，不 import kernel；
3. `gui/renderer` 的 ESLint 规则已禁止 `node:*`、`fs`、`path`、`os`、`child_process`、`electron`；
4. `check:layer` 已禁止 GUI 引用 `kernel/(dispatch|core|store|entry)/`；
5. `kernel/index.ts` 是内核公共 barrel，显式 re-export dispatch/result/parsers/render 与少量类型；它没有被 GUI 直接使用（GUI 走子进程），但仍应作为内核公共 API 维护。

**结论**：GUI 的 Node / Electron 边界目前是干净的；主要问题是 store → core 与 scripts → store，以及缺少模块级循环 / 深度检查。

### 3.5 barrel 与深引用

按「跨模块且目标不是 `index.ts`」统计，共 **247 条深引用**。这个数字不能直接当违规：

1. `kernel/store/contract.ts` 是设计上的跨层契约词汇，允许被 core / dispatch / entry 直接引用；
2. 同层 `types.ts` 的 type-only 引用是合理的内部契约；
3. 大量 `core/adapters -> core/hosts`、`core/lifecycle -> core/metadata` 是领域内协作，不等于越层。

真正需要处理的信号：

| 信号 | 证据 |
|---|---|
| 缺少 barrel 的目录 | `kernel/core/metadata/`、`kernel/core/plugins/`、`gui/main/plugins/`、`gui/renderer/src/composables/` 没有 `index.ts` |
| 公共 API 未定义 | `kernel/core/metadata` 被 8 处外部模块直接引用；插件类型被 store 直接引用 |
| 深引用无法区分「公共类型」与「内部实现」 | 247 条中没有统一的 allowlist / public API 表 |

**建议**：MNT-R5 的机械检查不能简单禁止所有深引用；应先定义「公共入口 / 允许的跨层契约 / 内部实现」三类，再禁止第三类跨模块引用。

---

## 4. 扩展点散弹成本

### 4.1 矩阵总览

| 扩展类型 | 当前必须触碰的主要位置 | 估算文件数 | 散弹点 | 对应需求 |
|---|---|---:|---|---|
| 新增一条指令 | `kernel/dispatch/registry/index.ts`（命令表 + handler + register）、`kernel/dispatch/parsers/index.ts`（选项）、`kernel/entry/cli.ts`（帮助）、`gui/bridge/commands.ts`（GUI 门面，若界面使用）、`docs/specification/cli-contract.md`、`tests/contract/registry.test.ts`、`tests/e2e/cli.test.ts`、`scripts/gui-smoke.mjs`（若界面入口） | 8–10 | 命令名、选项、确认级别、帮助文本、bridge 方法、契约、测试各自维护 | MNT-R1 / R6 |
| 新增一个宿主 | `kernel/core/hosts/registry-data.ts`、`kernel/core/adapters/index.ts` 的 `FORM_BY_HOST`、`kernel/core/adapters/roots.ts` 的 `defaultRootFor`、`tests/contract/host-registry.test.ts`、`tests/contract/adapters.test.ts`、`tests/contract/land.test.ts`、`docs/specification/host-registry.spec.md`、`docs/one-summary.md` | 8–10 | 宿主标识在注册表、适配器映射、默认路径三处硬编码；`adapter_ref` 已存在但未用于映射 | MNT-R1 / R2 / R6 |
| 新增来源类型 | `kernel/core/lifecycle/source.ts` 的类型分支与获取实现、`kernel/core/metadata/constants.ts` 的 `SOURCE_TYPE_VALUES`、`kernel/core/metadata/validate.ts` 的 `validateSource`、`schemas/skill_meta.schema.json`、`docs/specification/skill-meta-spec.md`、`kernel/dispatch/registry/index.ts` 的 install/update、GUI 安装表单（若暴露来源类型）、测试 | 8–10 | 来源类型枚举、获取、校验、UI、契约四处分散 | MNT-R1 / R4 |
| 新增渲染形态 | `kernel/core/adapters/types.ts` 的 `AdapterForm`、`kernel/core/adapters/index.ts` 的 `FORM_BY_HOST` / `FormImplementation`、`kernel/core/adapters/plan.ts`、`kernel/core/adapters/land.ts`、`kernel/core/render/types.ts`、`kernel/core/render/index.ts`、`kernel/core/hosts/registry-data.ts` 的 `render_policy`、`schemas/host_registry.schema.json`、`tests/contract/adapters.test.ts`、`tests/contract/render.test.ts`、`docs/specification/host-registry.spec.md` | 10–12 | 形态枚举、渲染、落位、验证、注册表、schema 多处同步 | MNT-R1 / R2 / R6 |
| 新增插件校验规则 | `kernel/core/plugins/manifest.ts`、`schemas/plugin_manifest.schema.json`、`docs/specification/plugin-format.md`、`tests/contract/plugin-schema.test.ts`、`tests/e2e/plugin-matrix.test.ts`、`kernel/core/plugins/types.ts`（若涉及结构） | 5–6 | 规则实现集中在 636 行 / complexity 52 的文件；schema 与手写校验双维护 | MNT-R1 / R3 / R4 |
| 新增盘点分类 | `kernel/core/discovery/index.ts`、`schemas/skill_index.schema.json`、`kernel/core/index/index.ts`（若摘要）、`kernel/dispatch/registry/index.ts`（scan 输出）、`gui/renderer/src/types.ts`、`gui/renderer/src/App.vue`、`tests/unit/discovery.test.ts`、`tests/contract/schema.test.ts`、`docs/specification/index-format.md` | 7–9 | 分类枚举、索引 schema、scan 输出、GUI 展示、测试分散 | MNT-R1 / R3 / R6 |

### 4.2 新增指令的具体散弹

当前命令集合是 `REGISTERED_COMMANDS` 数组 + `handlers` Map + 每个 handler 的 `register()` 调用（`kernel/dispatch/registry/index.ts:107-129`），没有单一的命令描述对象。新增一条指令至少要改：

1. `REGISTERED_COMMANDS`（未知指令提示、审计、契约测试）；
2. handler 实现 + `register({ name, handler })`；
3. 若有选项，`BOOLEAN_OPTIONS` / `VALUE_OPTIONS` / `REPEATABLE_OPTIONS`（`kernel/dispatch/parsers/index.ts`）；
4. `kernel/entry/cli.ts` 的帮助文本；
5. `gui/bridge/commands.ts` 的具名门面（若 GUI 需要）；
6. `gui/preload` / `gui/main` 的 IPC 白名单（若 GUI 需要）；
7. `docs/specification/cli-contract.md` 的语法、行为、输出、退出码；
8. 契约测试 / e2e / GUI 冒烟；
9. 若新增问题码，还要改结果规范与 `kernel/store/contract.ts`。

**根因**：命令的元数据（名称、选项、确认级别、帮助、bridge 名、契约引用）没有集中登记。建议在设计中引入 CommandSpec 的扩展字段或独立命令表，由 registry / help / bridge / tests 共同消费；这是 MNT-R1 的高价值项，但成本中等、回归面大。

### 4.3 新增宿主的具体散弹

当前新增宿主不是「适配器 + 注册表一行」：

1. `kernel/core/hosts/registry-data.ts` 增加条目；
2. `kernel/core/adapters/index.ts` 的 `FORM_BY_HOST` 增加宿主 → 形态实现映射；
3. `kernel/core/adapters/roots.ts` 的 `defaultRootFor()` 增加默认路径分支（否则新宿主没有默认根，必须配置）；
4. 若新宿主有新的路径类（如 rules），还要改 `path_template` / `rootKindOf` / 计划器；
5. 测试、注册表规范、one-summary。

证据：

1. `FORM_BY_HOST` 在 `kernel/core/adapters/index.ts:117-128`，是硬编码 map；
2. `defaultRootFor()` 在 `kernel/core/adapters/roots.ts:26-62`，直接按 `hostId` 分支；
3. 注册表条目已有 `adapter_ref` 字段（`kernel/core/hosts/registry-data.ts`），但 `FORM_BY_HOST` 没有使用它；这意味着注册表与适配器绑定是两套事实源。

**建议**：

1. 用 `adapter_ref` + 形态注册表推导 `FORM_BY_HOST`，删除按宿主标识的硬编码；
2. 把默认根表（平台 + 路径模板）移入注册表数据或独立数据文件，`defaultRootFor()` 只做展开；
3. 新增宿主只改「注册表条目 + 适配器实现（若新形态）+ 测试/文档」，不再改 `roots.ts` 的 if 分支。

### 4.4 新增来源类型的散弹

当前来源类型在以下位置重复：

1. `SOURCE_TYPE_VALUES`（`kernel/core/metadata/constants.ts`）；
2. `validateSource()` 的 `local` / `unknown` 特判（`kernel/core/metadata/validate.ts:237-280`）；
3. `source.ts` 的 `git` / `archive` / `local` 获取分支（`kernel/core/lifecycle/source.ts:518-545`）；
4. JSON Schema 的枚举与条件必填；
5. 元数据规范的字段表；
6. GUI 安装表单 / 来源展示（若新增来源需要用户输入）。

**建议**：来源类型注册表（`acquire`、`validate` 元数据、`display`、能力）作为唯一扩展点；schema 与文档由注册表生成或逐项核对。该项与 MNT-R1 / R4 直接相关。

### 4.5 新增渲染形态的散弹

渲染形态同时出现在：

1. `AdapterForm`（`kernel/core/adapters/types.ts`）；
2. `FormImplementation.forms`（`kernel/core/adapters/index.ts`）；
3. `FORM_BY_HOST` 绑定；
4. `plan.ts` 的 `rootKindOf` / 计划生成；
5. `land.ts` 的目录类 / 文件类落位分支；
6. `render/types.ts` 的 `FieldMode` / `DegradeForm`；
7. `render/index.ts` 的渲染策略；
8. 注册表 `render_policy` / `degrade_form`；
9. schema、测试、文档。

**根因**：形态是横跨渲染、计划、落位、注册表、schema 的横切概念，但没有一个形态注册表。建议把形态实现与注册表绑定统一到一个 `FormRegistry`，宿主只引用形态键。

### 4.6 新增插件校验规则的散弹

`kernel/core/plugins/manifest.ts` 636 行，`validatePluginManifest` complexity 52、`validateHost` 39、`validateRoot` 30。新增规则通常要改：

1. 手写校验函数；
2. JSON Schema；
3. 规范文档字段表；
4. 契约测试 / e2e 失败矩阵；
5. 若涉及类型，`plugins/types.ts`。

**根因**：schema 与手写校验双维护，规则没有表驱动。建议把规则拆成「字段规则函数 + 规则表」，并用 schema 生成 / 逐项一致性测试锁住。该项是 MNT-R3 / R4 的高价值拆分。

### 4.7 新增盘点分类的散弹

盘点分类（M4c）会同时影响：

1. `kernel/core/discovery/index.ts` 的扫描分类与摘要；
2. `skill_index` schema 的 summary / validation 字段（若分类进入索引）；
3. `scan` 输出载荷；
4. GUI 类型、列表/详情/筛选；
5. 测试与文档。

**建议**：先定义「分类注册表」（category id、label、判定函数、输出字段、GUI 展示策略），避免把新分类硬编码进 discovery 与 GUI。

---

## 5. 重复与单一来源

### 5.1 常量 / 错误码双写

| 重复项 | 位置 | 现状 | 风险 |
|---|---|---|---|
| `E-SRC-005` ~ `E-SRC-010` | `gui/main/update-check/constants.ts:12-19` 与 `kernel/store/contract.ts:87-96` | GUI 保留一份副本，靠 `tests/contract/update-check-constants.test.ts` 逐项比对 | 机械锁能防漂移，但不能消除双写；新增 / 重命名码要改两处 |
| 远端超时 / 体积 | `gui/main/update-check/constants.ts:7-8` 与 `kernel/core/lifecycle/source.ts:71-73` | 60_000 / 128 MiB 双写，测试比对源码 | 同左 |
| 备份提示 | `gui/main/update-check/constants.ts:9` 与内核 / 文案 | GUI 复制提示文本 | 文案变更需同步 |
| `E-CHANNEL-001` | `gui/bridge/kernel.ts:58`、`gui/main/updates/coordinator.ts:32`、`gui/main/update-check/check.ts:46,77` | GUI 内 4 处字面量 | 结果契约里的码没有单一来源 |

### 5.2 结果类型三处定义

| 类型 | 位置 |
|---|---|
| `Finding` / `Change` / `Result` | `kernel/store/contract.ts`（权威） |
| `Finding` / `Change` / `KernelResult` | `gui/bridge/kernel.ts:17-42` |
| `Finding` / `Change` / `KernelResult` | `gui/renderer/src/types.ts:1-34` |

三处结构目前一致，但没有生成 / 复用关系；字段变化需要手工同步。GUI 走子进程，不能直接 import kernel 内部，因此需要「公共契约生成物 / 独立 contract 包 / 运行时契约端点」三者之一，不能继续手写三份。

### 5.3 无用导出初筛

用「导出名在 kernel/gui/scripts/tests（含 .vue）中出现一次」做初筛，得到 4 个候选：

| 位置 | 导出 | 备注 |
|---|---|---|
| `kernel/core/hosts/types.ts:172` | `SecurityControlField` | 类型导出未被引用；同类 `isSecurityControlField` 有使用 |
| `kernel/core/integrity/index.ts:85` | `isDigestMap` | 未被引用 |
| `scripts/bench/thresholds.mjs:37` | `THRESHOLD_METRICS` | 未被引用 |
| `scripts/bench/thresholds.mjs:49` | `exceedsThreshold` | 未被引用 |

这是**初筛**，不是最终死代码判定；需在设计中用 TypeScript 符号级分析复核（尤其动态导出、测试辅助、Vue 模板引用）。

### 5.4 测试夹具重复

| 夹具 / 辅助 | 重复次数 | 位置示例 |
|---|---:|---|
| `mkdtemp` / `mkdtempSync` | 120 处，38 个文件 | 各 unit / e2e / contract 测试 |
| `validMeta` | 3 | `tests/e2e/cli.test.ts`、`tests/unit/discovery.test.ts`、`tests/unit/validation.test.ts` |
| `tempWorkspace` | 3 | `tests/contract/host-wiring.test.ts`、`land.test.ts`、`m5-closure.test.ts` |
| `tempHostRoot` | 3 | 同上 |
| `makeSource` | 2 | `host-wiring.test.ts`、`m5-closure.test.ts` |

`tests/fixtures/` 目前只有 `.gitkeep`，没有共享 fixture 库。建议新增：

1. `tests/helpers/workspace.ts`：临时工作区 + 清理；
2. `tests/helpers/host.ts`：宿主根、注册表配置、共享根；
3. `tests/helpers/skill.ts`：`validMeta`、最小技能目录、`SKILL.md` / `skill_meta.yaml`；
4. `tests/helpers/plugin.ts`：manifest、plugin index、landings；
5. `tests/helpers/readonly.ts`：内容 / 目录项快照与比较。

---

## 6. 改进清单与机械护栏

### 6.1 改进项排序（影响 × 成本）

| 优先级 | 改进项 | 审计证据 | 对应 MNT | 预期收益 | 成本 / 风险 |
|---|---|---|---|---|---|
| P0 | 新增 `check:arch`：循环、store→core、scripts→store、GUI 深引用、barrel 白名单 | 0 循环；2 条 store→core；1 条 scripts→store；247 条深引用需分类 | R2 / R5 | 把「方向」变成可失败门禁；阻止新增反向边 | 中；需维护 allowlist |
| P0 | 结果契约单一来源（生成物 / 独立包） | 3 处 `Finding/Change/Result`；`E-SRC` 双写；`E-CHANNEL` 4 处 | R4 | 消除 GUI / kernel 双写；契约变化一处改 | 中；需决定生成位置与构建接线 |
| P0 | 共享常量 / 类型下移 | store→core 两条反向依赖 | R2 / R4 | 解除 store 对 core 的依赖 | 中；类型迁移要避免新环 |
| P0 | 共享测试夹具 | 120 处 mkdtemp；3× validMeta / tempWorkspace / tempHostRoot | R8 | 降低测试重复与隔离风险 | 低–中；需批量改测试 |
| P1 | 拆分 `plugins/manifest.ts` | 636 行；complexity 52 / 39 / 30 | R3 | 插件校验可读、可测、可扩展 | 中；规则回归面大 |
| P1 | 拆分 `dispatch/registry/index.ts` 的插件 / 生命周期 handler | 2621 行；多个 handler complexity 19–20；`runHostToggle` 31 | R3 | 降低路由文件耦合；M4c 新分支不再加剧 | 高；需 e2e 全回归 |
| P1 | 拆分 `lifecycle/index.ts` 的 install / update / toggle / restore | 1738 行；install 34、restore 37、enable 27、disable 20 | R3 | 生命周期职责清晰；测试更易定位 | 高；顺序与原子性不能变 |
| P1 | 宿主扩展点：`adapter_ref` 驱动 `FORM_BY_HOST`，默认根移入数据 | `FORM_BY_HOST` 硬编码；`defaultRootFor` 按 hostId 分支 | R1 / R2 | 新增宿主不再改两处 if/map；M4c 根枚举复用 | 中；需兼容现有 7 宿主 |
| P1 | 命令扩展点：命令描述表统一 help / bridge / contract / tests | `REGISTERED_COMMANDS` + handler + help + bridge 多处 | R1 / R6 | 新增指令改动集中 | 中–高；回归面大 |
| P2 | 拆分 `gui/renderer/src/App.vue` | 858 行；视图状态与模板集中 | R3 | 视图可维护；M4c 盘点视图可增量接入 | 中；GUI 冒烟 |
| P2 | 拆分 `tests/e2e/cli.test.ts` | 1173 行 | R3 / R8 | 测试可读、可并行维护 | 低–中；测试语义不能变 |
| P2 | 架构文档图机械化核对 | 当前无 import 图 / 文档一致性测试 | R6 | 防止文档与代码漂移 | 低–中；需生成 JSON |
| P2 | 清理无用导出 / 重复辅助 | 4 个初筛候选；重复夹具已列 | R7 / R8 | 降低维护噪音 | 低；需符号级复核 |

### 6.2 机制建议

1. **依赖图 / 循环 / 反向边**：新增 `scripts/check-arch.mjs`，用仓库已有 `typescript` 编译 API 构建 import 图；输出 JSON + 人类可读失败列表；CI 运行。不要引入新运行时依赖。
2. **文件规模 / 复杂度**：扩展 `eslint.config.mjs`：
   - `max-lines`（初始阈值建议 1000，先允许现有 3 个 >1000 文件进入例外清单，再逐步下调）；
   - `max-lines-per-function`（初始按审计数据设 200，或先 warning）；
   - `complexity`（初始 20 为 error，10 为 warn；99 个 >10 不能一次清零，采用 ratchet）；
   - 对例外使用文件 / 函数指纹 + 负责人 + 到期时间，不允许无限期。
3. **深引用 / 公共 API**：在 `no-restricted-imports` 中增加跨层模式；维护 `public-api.json`（模块 → 允许入口）并由脚本核对；`store/contract.ts` 作为显式 allowlist。
4. **单一来源**：由 `kernel/store/contract.ts` 或独立 `contract/` 包生成 GUI 侧契约（类型 + 问题码 + 时间 / 体积常量）；生成物入库或构建期生成，测试检查「生成物 == 源」。删除 `update-check-constants.test.ts` 的逐项比对，改为直接消费生成物。
5. **架构文档图**：生成 `docs/architecture/dependency-graph.json`（模块 / 边 / 层），测试解析代码 import 图并比较；文档中的 Mermaid / 表格由该 JSON 生成或核对。
6. **测试夹具**：`tests/helpers/` 放共享构造器；新测试禁止重复 `mkdtemp` 大段 setup；保留必要的进程级隔离。

### 6.3 最小步骤序列

1. **A 审计（本报告）**：基线数字、热点、反向边、重复点；
2. **B 设计**：确定公共 contract 位置、层规则、allowlist 格式、阈值与例外策略；
3. **C 计划**：把护栏、单一来源、拆分、测试夹具拆成可独立验证的批次；
4. **D 护栏批次**：`check:arch` + ESLint ratchet + 文档图检查，先只记录基线、不改变行为；
5. **E 单一来源批次**：共享 contract / 常量下移；删掉 GUI 双写；
6. **F 拆分批次**：先 `plugins/manifest.ts` 与 `lifecycle`，再 `dispatch/registry`；每批 558 项测试全绿；
7. **G 宿主扩展点批次**：`adapter_ref` 驱动、默认根数据化；为 M4c 根枚举提供稳定入口；
8. **H M4c 实现**：在 D–G 之后开始；M4c 新代码必须通过 `check:arch`、ESLint 阈值与公共 API 检查。

**顺序理由**：M4c 需要宿主根枚举与只读扫描；如果先生命周期 / registry 拆分，M4c 会在旧结构上再增分支，之后迁移成本更高。因此 `F` / `G` 中与 M4c 直接相关的宿主扩展点必须先于 `H`。

---

## 7. 对照 MNT-R1 至 R9 的差距

| 需求 | 现状差距 | 本审计证据 | 建议优先级 |
|---|---|---|---|
| MNT-R1 扩展点稳定 | 命令、宿主、来源、形态、插件规则、盘点分类均无统一变更影响矩阵；宿主 `FORM_BY_HOST` / `defaultRootFor` 硬编码 | 第 4 节矩阵；`FORM_BY_HOST` / `roots.ts` | P0/P1 |
| MNT-R2 分层与依赖 | 2 条 store→core；1 条 scripts→store；`check:layer` 只覆盖 3 条边界 | 第 3.2 / 3.3 节 | P0 |
| MNT-R3 模块规模 / 复杂度 | 2621 / 1738 / 1173 / 858 行；99 个函数 >10；无规模门禁 | 第 2.2–2.4 节 | P0/P1 |
| MNT-R4 单一来源 | E-SRC / 超时 / 体积 / 备份提示 / E-CHANNEL 双写；结果类型三处 | 第 5.1 / 5.2 节 | P0 |
| MNT-R5 公共 API / 内部边界 | 4 个目录缺 barrel；247 条深引用无分类；store 直接引 core 类型 | 第 3.5 节 | P0/P1 |
| MNT-R6 架构文档 | 无 import 图机械核对；扩展步骤未统一 | 第 6.2 节 | P2 |
| MNT-R7 死代码 / 重复 | 4 个无用导出初筛；重复夹具 120 处 mkdtemp | 第 5.3 / 5.4 节 | P2 |
| MNT-R8 测试基建 | `tests/fixtures` 为空；validMeta / tempWorkspace / tempHostRoot 重复 | 第 5.4 节 | P0/P2 |
| MNT-R9 审计与治理 | 无批次影响声明 / 例外到期机制；现有 allowlist 仅零星存在 | 第 6.2 节 | P0 |

---

## 8. 未决问题

| 编号 | 问题 | 影响 | 建议 |
|---|---|---|---|
| Q-MNT-01 | 公共 contract 放哪：`kernel/store/contract.ts`、独立 workspace 包，还是构建期生成到 GUI？ | 决定单一来源方案与构建接线 | 设计阶段评审；建议独立生成物，避免 GUI 深引用内核 |
| Q-MNT-02 | `max-lines` / `complexity` 初始阈值 | 决定门禁是否会立刻红 | 先基线 + allowlist，再 ratchet；不要一次清零 |
| Q-MNT-03 | `FORM_BY_HOST` 是否完全由 `adapter_ref` 推导 | 决定宿主扩展点成本 | 建议是；新增宿主只改注册表 + 形态实现 |
| Q-MNT-04 | 命令描述表是否值得一次性引入 | 影响新增指令成本与回归面 | 先做一个只读查询指令试点，再推广 |
| Q-MNT-05 | 死代码是否包含测试专用导出 | 影响清理范围 | 用 TypeScript 符号级分析复核；不删测试契约 |
| Q-MNT-06 | 架构文档图格式（JSON / Mermaid / 表格） | 影响机械核对 | 建议 JSON 为源，Mermaid 为展示 |
| Q-MNT-07 | 复杂度工具是否只用 ESLint | 影响阈值与例外管理 | 先用 ESLint 内置规则；不引入新依赖 |
| Q-MNT-08 | M4c 根枚举与 M5 注册表的关系 | 决定是否要新增根模型 | 建议在宿主扩展点批次中先落只读根枚举，M4c 复用 |

---

## 附录 A：复现命令

### A.1 文件行数

```powershell
$files = Get-ChildItem -Path @('kernel','gui','scripts','tests') -Recurse -File `
  -Include *.ts,*.tsx,*.mjs,*.js,*.vue |
  Where-Object { $_.FullName -notmatch 'node_modules|\\out\\|\\dist\\|\\build\\' }
$rows = $files | ForEach-Object {
  [pscustomobject]@{
    Lines = (Get-Content -LiteralPath $_.FullName | Measure-Object -Line).Lines
    Path  = $_.FullName.Replace((Get-Location).Path + '\','')
  }
}
$rows | Sort-Object Lines -Descending | Select-Object -First 25
```

### A.2 复杂度

```powershell
npx eslint kernel gui scripts tests --rule '{"complexity":["warn",10]}' --format json
```

### A.3 import 图 / 循环

本次使用一次性 Node 脚本：递归收集 `kernel/`、`gui/`、`scripts/` 的 `.ts/.tsx/.mjs/.js`，解析 `from` / `import()` / `require()`，解析相对路径到实际文件，DFS 检测环。结果：110 文件、315 边、0 环。

### A.4 重复夹具

```powershell
rg -n "mkdtempSync|mkdtemp\(" tests -g "*.ts"
rg -n "function tempWorkspace|function tempHostRoot|function makeSource|const validMeta" tests -g "*.ts"
```

---

## 附录 B：本审计未做的事

1. 未做运行时火焰图 / 性能剖析；
2. 未做完整的 TypeScript 符号级无用导出分析；
3. 未修改任何源码、测试、契约或 `docs/reviews/`；
4. 未决定阈值、contract 位置、拆分批次；这些留给设计与需求侧取舍。
