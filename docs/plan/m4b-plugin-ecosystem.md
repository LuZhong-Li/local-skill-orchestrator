# M4b 插件生态实施计划

| 项目 | 内容 |
|---|---|
| 文档名称 | M4b 插件生态实施计划（T0 基础与加载合并 → T1 类型消费面 → T2 GUI → T3 收口） |
| 文档路径 | `docs/plan/m4b-plugin-ecosystem.md` |
| 文档状态 | 计划稿（待确认；确认后按 T0 → T3 顺序推进，逐批给实现提示词） |
| 依据 | [`docs/design/m4b-plugin-ecosystem.md`](../design/m4b-plugin-ecosystem.md)（八项裁决已采纳）；需求 9.3.5（M4b-R1 ~ R5）、9.3.6（M5 边界）、9.5（排除项）；契约 4.4 ~ 4.10；`v0.2.0` 发布现状 |
| 说明 | 本文档只输出任务、依赖、交付物与可验证验收；**不产生代码插件、全局插件、插件更新检查或应用自更新的实现任务**。 |

---

## 0. 已裁决输入（计划必须体现）

| # | 裁决 | 落地位置 |
|---|---|---|
| ① | 本期**仅声明式插件**；不加载第三方代码 | T0 / T1；第 5 节排除项 |
| ② | 插件存放于**工作区级** `<workspace>/plugins/<plugin_id>/plugin.json` | T0 / T1 |
| ③ | 插件使用**独立 `plugin_index.yaml`**，不进入 `skill_index.yaml` 的 `extensions[]` | T0 / T1 |
| ④ | 第三方宿主 canonical 标识为 **`x-<plugin_id>-<host_key>`** | T0 / T1；第 4 节 |
| ⑤ | 生命周期**复用既有指令加类型消费面**，不新增指令；插件操作必须显式给出类型 | T1；0.2 节 |
| ⑥ | 插件更新检查**本期不做**；后续独立 checker，不与 M4a 混用 | T1 / T2；第 5 节 |
| ⑦ | 第三方**不得**声明 `security_control_evidence` 等安全控制字段 | T0；第 4 节 |
| ⑧ | 代码形态维持排除；触发条件为**安全沙箱模型 + 稳定适配器 API + 独立立项**三者齐备 | 第 5 节登记 |

补充约束：

1. **插件 ≠ 技能**：插件是能力扩展载体，不是被管理对象；不得进入 Skill 卡片、Skill 索引记录或 M4a 更新检查结果。
2. **M5 内置机制隔离**：内置 7 个宿主、注册表、`FORM_BY_HOST` 与 `HostAdapter` 接口均为内核资产；插件只追加独立命名空间，不覆盖、不伪装、不共用配置键。
3. **默认不信任**：插件安装/登记后默认 `disabled`；只有显式 `enable` 且校验通过才会提供宿主 profile。
4. **先文档后实现**：T0 先完成新增规范、既有契约修订与 schema，再写代码。
5. **指令数保持 16**：只增加既有指令的 `--kind` 消费面与选项校验，不注册第 17 条指令。

---

## 0.1 计划期事实与口径（先定，避免实现时再猜）

| # | 事实 | 处置 |
|---|---|---|
| F-1 | 现有 `skill_index.yaml` 的单一职责刚经过内核核查批次收紧；把插件记录塞进 `extensions[]` 会让两种对象模型耦合演进 | 插件唯一事实源为 `<workspace>/plugin_index.yaml`；Skill 索引与插件索引各自原子写、各自加锁，不做跨索引事务；「统一入口」由 `list/inspect --kind` 与 GUI 分区承担，不要求单一物理索引 |
| F-2 | 现有 `install` / `enable` / `disable` / `uninstall` 以 `SkillMeta` 和 Skill 目录为中心；不能把 `plugin.json` 塞进 `skill_meta.yaml` | 复用底层原子写、锁、确认与路径解析原语；对象模型走独立插件模块，不伪造 Skill 记录 |
| F-3 | M5 的 `--host` 分发副本**不写入** Skill 索引的 `targets[]`；`targets[]` 只表达工作区内目标 | 插件宿主副本由 `plugin_index.yaml` 的独立 `landings` 账本记录；插件禁用后副本保留、不自动删除，卸载后将对应账本标为 `orphaned`；后续对该宿主的选择/分发明确拒绝 |
| F-4 | 现有 `scan` 只发现并登记 Skill；插件登记必须由 `install` 显式触发 | `scan --kind plugin` 只**核对已登记插件**并报告未登记的插件目录候选；不自动登记、不自动启用 |
| F-5 | 现有工作区布局只有 `skills/` / `backups/` / `locks/` / `logs/` | 新增 `plugins/` 与 `plugin_index.yaml`；`init` 创建它们，旧工作区在首次插件写入时按需创建，读取缺失时视为空插件登记 |
| F-6 | 插件宿主根配置若写入 `skill_index.yaml` 的 `config`，会与 M5 `host.<id>.*` 混在同一事实源 | 插件配置写入 `plugin_index.yaml` 的 `config` 区；`config set` 按 `plugin.` 前缀路由，`host.<id>.*` 继续只认内置注册表；见 0.2 节 K-3 |
| F-7 | 一个插件 profile 若同时声明多形态，`--host` 取值需要额外的 `-rules` 后缀，且与 `host_key` 可能歧义 | 本期每个 profile **只声明一个 `form`**；canonical host id 即 `--host` 取值，不加 `-rules` 后缀 |
| F-8 | 当前常规套件 525 项 + 1 项慢测试 | 计划中的新增用例按 T0~T3 归属登记；实现完成后以实际计数回填，不预估为已通过 |

---

## 0.2 待确认提案：类型消费面与边界

### K-1 `--kind` 参数

提案：七个指令增加取值选项 `--kind <skill|plugin>`。

| 规则 | 提案 |
|---|---|
| 默认值 | 省略 `--kind` = `skill`；既有 Skill 调用方式完全不变 |
| 显式技能 | `--kind skill` 合法，行为与省略一致 |
| 插件操作 | **必须显式** `--kind plugin`；不根据来源内容、`plugin.json` 是否存在或标识前缀自动猜测 |
| 重复给出 | 同一命令重复 `--kind` 返回 `E-INPUT-002`，不静默取最后值 |
| 其他指令 | `init` / `config get` / `config set` / `update` / `validate` / `deps` / `export` / `import` / `restore` 不接受 `--kind`；给出即参数类错误 |
| 输出分区 | 插件分支的 `data` 带 `kind: "plugin"` 与 `plugins` / `plugin` 字段；不得与 Skill 的 `records` 混排 |

逐指令消费面：

| 指令 | 省略 `--kind` | `--kind plugin` 语义 | 插件分支允许 | 插件分支拒绝 |
|---|---|---|---|---|
| `scan` | 现有 Skill 扫描 | 核对已登记插件、刷新插件索引结论、报告未登记候选；**不登记** | `--dry-run` | `--root`（Skill 根专用） |
| `list` | 现有 Skill 列表 | 列出插件记录 | `--state enabled / disabled / invalid`、`--source <类型>` | `--target`（Skill 目标专用） |
| `inspect` | 现有 Skill 详情 | 查看插件记录、manifest、canonical 宿主与校验结论 | 无额外选项 | 无 |
| `install` | 现有 Skill 安装 | 登记插件包；成功登记后默认 `disabled` | `--dry-run`、`--yes` | `--target` / `--host` / `--scope` / `--mode` / `--library-only` |
| `uninstall` | 现有 Skill 卸载 | 删除插件登记与插件包；不触碰 Skill 索引 | `--dry-run`、`--yes` | `--keep-library` / `--hard` |
| `enable` | 现有 Skill 启用 | 校验并启用插件 profile | `--dry-run`、`--yes` | `--target` / `--host` / `--scope` |
| `disable` | 现有 Skill 禁用 | 停用插件 profile；不删除任何文件 | `--dry-run`、`--yes` | `--target` / `--host` / `--scope` |

说明：

1. 插件安装/启停不新增指令；`--kind` 是既有指令的显式类型入口。
2. `update --kind plugin` **不在本期**；插件版本变化通过手动 `uninstall` 后再 `install` 完成，不做自动检查或自动替换。
3. `config set plugin.<plugin_id>.<host_key>.root <路径>` 是本计划唯一不经 `--kind` 的插件相关入口，因为它按配置键前缀路由，不改变 `config` 指令的对象类型语义；见 K-3。
4. `list --kind plugin --json` 同时作为 9.3.5 高层验收目标 6 的「插件列表报告」出口，字段固定、可脚本消费。

### K-2 插件卸载与包保留

提案：`uninstall <plugin_id> --kind plugin` 默认删除插件登记与 `<workspace>/plugins/<plugin_id>/` 整个目录；不做 Skill 式中心库备份。确认文案必须列出完整相对路径与文件数量；`--dry-run` 只展示不删除。插件包可重新从其来源安装，若用户要保留，先自行复制；本期不新增 `--keep-package`。

### K-3 插件宿主根与配置

提案：

1. `scope: project` 的 host root 相对工作区展开；`scope: global` 必须显式配置，不静默落到用户主目录。
2. 插件配置键为 `plugin.<plugin_id>.<host_key>.root` / `.rules_root`，写入 `plugin_index.yaml` 的 `config`；`host.<id>.*` 继续只认内置注册表。
3. `config set plugin.*` 要求插件已登记且 `host_key` 已声明；插件处于 disabled 时仍可预先配置根路径，但不得因此启用插件。
4. 写入工作区之外仍需既有确认机制；未配置全局根时，该插件宿主不可选，返回参数类错误并给出可执行的 `config set` 建议。

### K-4 问题码提案

优先复用现有类别，不新增 `PLUGIN` 类别。建议新增四个编号（名称与文案在 T0 契约中定稿）：

| 提案编号 | 级别 | 含义 | 用途 |
|---|---|---|---|
| `E-ID-004` | 错误 | 插件标识不符合命名规范或与目录名不一致 | manifest / 发现 |
| `E-ID-005` | 错误 | 插件标识在插件登记中重复 | install / scan |
| `E-VER-002` | 错误 | 插件 manifest 或插件 API 兼容声明不受当前工具支持 | 兼容性 |
| `E-CONFLICT-004` | 错误 | 插件 canonical 宿主命名空间冲突 | 合并 |

其余沿用：manifest 字段缺失/类型/取值用 `E-FIELD-001/002/005`；路径越界用 `E-PATH-001`；来源获取用 `E-SRC-*`；插件索引损坏用 `E-YAML-001` / `E-ENV-002`；插件索引 `schema_version` 不受支持按索引版本问题 `E-VER-001`；禁用宿主被选择用 `E-INPUT-002`。

---

## 1. 任务序列

### T0 规范、schema、插件索引与加载合并纯函数

**执行状态**：**已完成（2026-10-18）**。交付：`docs/specification/plugin-format.md`、`schemas/plugin_manifest.schema.json`、`schemas/plugin_index.schema.json`、`kernel/core/plugins/`（manifest/discovery/catalog/record/types）、`kernel/store/plugin-registry/`；`init` 建立 `plugins/` 与空 `plugin_index.yaml`。常规套件 525 → **541 项**（单元 361、契约 107、端到端 73；540 通过 + 1 项符号链接平台条件跳过），慢测试 1 项通过；九项保证/审计逐条有用例。

**目标**：先把声明式插件的数据契约、独立登记事实源与“内置不可被覆盖”的合并边界固定下来；本批不接线 CLI 业务分支。

**依赖**：设计定稿（八项裁决）。

**交付物**：

1. **规范先行**：新增 `docs/specification/plugin-format.md`（第六份契约规范），定义：
   - `plugin.json` manifest 字段、取值域、禁用字段与文件限制；
   - `plugin_index.yaml` 结构、状态机、运行时结论与唯一事实源；
   - `x-<plugin_id>-<host_key>` 命名空间与内置隔离；
   - 插件 profile 的 `skill` / `rules` / `entry` 三种形态与受控路径模板；
   - 插件生命周期、配置前缀、错误码与失败口径。
2. **既有契约修订**：`docs/specification/cli-contract.md` 的 `scan` / `list` / `inspect` / `install` / `uninstall` / `enable` / `disable` 语法与选项表加入 `--kind`；第 2.2 节登记 `--kind` 的取值与重复给出规则；第 3 节仍为 16 条指令。
3. **结果契约修订**：`docs/specification/result-and-exit-codes.md` 登记 K-4 的新编号与对象限定；不改变既有退出码语义。`docs/specification/index-format.md` 增加边界说明：`skill_index.yaml` 结构不变，`plugin_index.yaml` 由第六份规范定义，不属于 Skill 索引。
4. **schema**：`schemas/plugin_manifest.schema.json` 与 `schemas/plugin_index.schema.json`，逐字段对齐新规范；两者均为独立 schema，**不 `$ref` 内置 `host_registry.schema.json`**，避免把 M5 资产变成第三方契约。
5. **工作区布局**：`layoutOf()` 增加 `pluginIndexFile` 与 `pluginsDir`；`init` 创建 `plugins/` 与空 `plugin_index.yaml`；旧工作区读取缺失时按空登记处理。
6. **插件存储层**：独立读/写/锁/原子写模块；保留未知字段；插件索引损坏时报告可读错误，不自动重建、不静默清空。
7. **发现与校验**：只扫描 `<workspace>/plugins/<plugin_id>/plugin.json`；拒绝符号链接、绝对路径、`..`、目录名与 `plugin_id` 不一致；计算 manifest SHA-256；拒绝代码文件扩展名与禁用字段。
8. **加载合并纯函数**：输入为内置注册表快照 + 插件索引记录 + manifest 原始数据，输出只读 `HostCatalogView`；纯函数不读盘、不写盘、不修改内置对象。
9. **六条机械隔离断言**（见第 4 节）及配套单元/契约测试。

**manifest 硬边界**：

| 项目 | 规则 |
|---|---|
| 顶层字段 | `manifest_version` / `plugin_id` / `name` / `version` / `compatibility` / `capabilities` / `hosts`；可选 `description` / `author` / `license` / `source` |
| 版本 | `manifest_version` 仅 `"1"`；`version` 仅 semver 正式版；`compatibility.plugin_api` 仅 `"1"`；`compatibility.skill_manager` 为合法 semver 范围 |
| 能力 | `capabilities` 本期仅 `host_profile` |
| 宿主 | 1 ~ 8 个 profile；每个 profile 仅一个 `form`（`skill` / `rules` / `entry`） |
| 渲染 | `field_mode` 本期仅 `standard6`；安全控制字段一律拒绝；不承认第三方 `security_control_evidence` |
| 路径 | `path_template` 只接受相对模板与 `<skill_id>` 占位符；禁止绝对路径、盘符、反斜杠、`..` 和未知占位符 |
| 文件 | 插件目录不得出现 `.js` / `.mjs` / `.cjs` / `.node` / `.exe` / `.dll` / `.dylib` / `.so`；不得有 `main` / `exports` / `scripts` 字段 |
| 资源上限 | manifest 256 KiB、profile 8 个、每 profile 4 个 root、字段长度上限在 schema 固定；超限整插件拒绝 |
| 来源 | manifest 内 `source` 仅作审计展示；安装来源以 CLI 位置参数为准，禁止用 manifest 内地址隐式发起网络请求 |

**测试**：

1. schema 正反例：必填缺失、类型错误、取值越界、未知字段、代码字段、安全字段、超限。
2. manifest 文件：坏 JSON、坏 YAML 不适用（manifest 固定 JSON）、哈希、目录名不一致、符号链接、路径越界。
3. 插件索引：读写往返、未知字段保留、原子写、锁、缺失/损坏/版本不兼容。
4. 工作区：`init` 创建插件目录与索引；旧工作区缺目录时可读为空；不触碰 Skill 索引。
5. 合并纯函数：输入不被修改、输出只读、确定性排序、重复加载幂等。
6. 六条机械断言逐条独立测试（不合并成一条“大断言”）。
7. 契约测试：规范字段与 schema 一致、`--kind` 只出现在七个指令、指令数仍 16。

**验收标准（可验证）**：

1. 新规范与两个 schema 逐字段一致；既有五份规范与五个 schema 未被改写（只做增量修订的契约除外，逐条可查）。
2. `plugin_index.yaml` 与 `skill_index.yaml` 物理分离；插件 T0 操作前后 Skill 索引字节一致。
3. 六条机械隔离断言全部通过（第 4 节逐条对应）。
4. 声明式 manifest 不含代码入口；含代码扩展名/代码字段/安全字段的插件整包拒绝。
5. 插件索引损坏、manifest 损坏、路径越界均有可读问题码与修复建议；单条失败不阻断其他插件校验。
6. 既有 525 项 + 1 项慢测试不回归；新增用例归属与计数核对；`check` / `typecheck` / `eslint` / `prettier` 零告警。

**规模估算**：1 份新规范 + 2 份 schema + 1 个存储模块 + 1 个发现/校验模块 + 1 个纯合并模块 + 约 20~30 条用例；不新增运行时依赖。

**风险与处置**：schema 过严会挡住合理声明 → 只允许设计已列字段；如需扩展，先改规范与 schema，不在实现中放宽。符号链接在 Windows/macOS 行为不同 → 用 realpath/平台测试覆盖。

---

### T1 类型消费面、插件生命周期与插件宿主落位

**执行状态**：**已完成（2026-10-18）**。七个既有指令的 `--kind plugin` 分支、插件安装/启停/卸载、`x-` 宿主落位、`plugin.*` 配置路由与独立 `landings` 账本已落地；新增真实 CLI 生命周期、global/local、`--kind` 门禁与 enable 重校验用例。常规套件 541 → **547 项**（单元 361、契约 107、端到端 79；546 通过 + 1 项符号链接平台条件跳过）。

**目标**：让七个既有指令通过显式 `--kind plugin` 管理插件，并让启用插件的 host profile 可参与既有 `--host` 分发；不改动无 `--kind` 的 Skill 路径。

**依赖**：T0。

**交付物**：

1. **类型路由**：按 K-1 接入 `scan` / `list` / `inspect` / `install` / `uninstall` / `enable` / `disable`；集中解析 `--kind`，避免七个 handler 各写一套；未给 `--kind` 时走原路径。
2. **插件生命周期**：
   - `install --kind plugin`：读取来源（本地目录/归档或复用 `acquireSource` 的远端获取），校验 manifest，复制到 `<workspace>/plugins/<plugin_id>/`；成功登记为 `disabled`；
   - 同 id 同 manifest 哈希幂等；同 id 不同哈希返回冲突且不覆盖；
   - 可读出 `plugin_id` 但 manifest 不合格时，登记为 `invalid` 供查看；无法确定标识时不写记录，但返回可读错误（不静默丢弃）；
   - `enable` 重新校验 schema、兼容性、命名空间、路径与 profile；失败保持 `invalid`/`disabled`；
   - `disable` 只改状态并从加载视图移除；不删除宿主根中的既有副本；
   - `uninstall` 按 K-2 删除登记与包；不触碰 Skill 索引；
   - `scan --kind plugin` 只核对已登记记录并报告未登记目录候选；不自动登记、不自动启用。
3. **输出分区**：`list` 的 Skill 分支形状不变；插件分支用 `data.kind = "plugin"` 与 `data.plugins`；`inspect --kind plugin` 用 `data.plugin`；不得把插件放进 `records` 或把 Skill 放进 `plugins`。
4. **插件宿主目录**：
   - canonical id 为 `x-<plugin_id>-<host_key>`；与内置 id、其他插件 canonical id 冲突时整插件拒绝；
   - 每个 profile 单形态；`skill` 写到目录内 `SKILL.md`，`rules` 写单文件，`entry` 只产出片段不落盘；
   - 复用 `renderWithPolicy()`、落位计划与原子写；不修改 `FORM_BY_HOST`，不改内置 `adapterFor()` 的返回集合；
   - 新增独立的插件 profile 适配器解析（仅对 `x-` 命名空间生效），内置路径不经过它。
5. **宿主根与配置**：按 K-3 实现 `plugin.<plugin_id>.<host_key>.root` / `.rules_root`；`config set` 按前缀路由到插件索引；`config get` 保留既有 `config` 字段并附加可选 `plugin_config` 区（不改变旧字段）；`host.*` 仍只认内置注册表；工作区外写入沿用确认。
6. **宿主可选性**：`--host` 的可用值 = 内置可落位宿主 + 已启用且校验通过的插件 canonical host；disabled/invalid/不兼容插件不出现；选中时返回 `E-INPUT-002` 并引导 `enable <plugin_id> --kind plugin`。
7. **不改动的路径**：`update` / `validate` / `deps` / `export` / `import` / `restore` / `config` 的 Skill 语义不变；插件不进入 M4a 的 `list` 数据源或更新检查。

**测试**：

1. 七个指令的 `--kind` 矩阵：省略、`skill`、`plugin`、重复、非法值、错误指令携带 `--kind`。
2. 插件安装：本地目录、归档、远端来源（回环或注入）、成功默认 disabled、重复幂等、同 id 不同哈希冲突、失败无半截目录。
3. 不合格项可见：坏 manifest 记录为 invalid；无法定标识时报错；单条失败不阻断其他插件。
4. 启停：enable 校验、disable 卸载视图、状态不因禁用而删除文件；重新启用恢复宿主可用。
5. 扫描：只核对已登记项；未登记目录只作为候选报告；插件索引写、Skill 索引字节不变。
6. 宿主落位：三种 form 各一条；plugin root 项目/全局作用域；未配置全局根拒绝；工作区外确认；路径/CRLF/平台差异。
7. 隔离：插件 host 不出现在内置 `host.*` 配置校验；内置 `--host` 值集合加载前后不变。
8. 输出：技能/插件不混排；`list --kind plugin --json` 作为报告固定字段。

**验收标准（可验证）**：

1. 插件操作必须显式 `--kind plugin`；省略时既有 Skill 行为逐字/逐字节不变（以回归用例证明）。
2. 安装成功默认 `disabled`；未显式 enable 前不提供任何插件 host。
3. 插件索引是插件状态唯一事实源；任何插件操作不写 Skill 索引（宿主落位只写目标文件）。
4. 三种 form 均可通过既有渲染/落位核心工作；无宿主专有代码、无第三方代码加载。
5. `--host x-...` 在启用/禁用/不兼容三态下行为正确；禁用后既有副本保留且不自动删除。
6. 既有 525 项 + 1 项慢测试不回归；新增用例归属与计数核对；门禁零告警。

**规模估算**：1 个类型路由模块 + 1 个插件生命周期模块 + 1 个插件宿主适配器 + 配置路由 + 约 25~35 条用例；不新增指令、不新增运行时依赖。

**风险与处置**：`--kind` 可能与未来对象类型冲突 → 本期封闭为 `skill|plugin`，其他值拒绝；插件 host 的 rules 形态若需要宿主专有逻辑 → 只允许共享渲染核心可表达的规则，不能为某个插件写代码分支。

---

### T2 GUI：插件列表、详情、安装与启停

**执行状态**：**已完成（2026-10-18）**。插件视图、主进程 `plugins:hosts` 分区、安装/启停/卸载交互与详情账本已落地；`smoke:gui` **28/28 通过**（安装默认 disabled → enable → `x-` 宿主分发 → landings → disable → uninstall），并修复 `update --host` 被 M4a 专用通道截走的问题。常规套件 **552 项**（单元 365、契约 107、端到端 80；551 通过 + 1 项符号链接平台条件跳过）。

**目标**：在既有界面页面族内提供扩展清单视图，展示第三方插件与内置宿主的分区；不做插件更新检查、不执行插件代码。

**依赖**：T1。

**交付物**：

1. 侧栏新增「插件（扩展）」入口；沿用既有页面/卡片/表格样式，不新建导航体系或视觉规范。
2. 插件列表：名称、版本、作者/来源、状态（enabled/disabled/invalid）、manifest 哈希、贡献的 canonical host、校验摘要；内置 7 宿主单独只读展示，标注「内置，不可被第三方覆盖」。
3. 插件详情：manifest 字段、兼容性、host profile、root 模板、失败原因与修复建议；不展示/不执行任何代码。
4. 安装入口：复用安装对话框的交互模式，增加显式「Skill / 插件」类型选择；插件安装调用 `install <source> --kind plugin`，成功提示默认 disabled。
5. 启停/卸载：`enable <id> --kind plugin`、`disable <id> --kind plugin`、`uninstall <id> --kind plugin`；卸载沿用强制确认并展示将删除的插件目录与文件数。
6. 失败呈现：invalid/不兼容/命名空间冲突/未配置全局根均有可读文案与可执行修复建议；插件错误不影响 Skill 列表、M4a 更新检查或内置宿主展示。
7. 不使用新 IPC：通过既有 `kernel:invoke` / `kernel:execute` 通道消费内核结果；界面不直读工作区或插件目录。

**测试**：

1. 组件测试：空状态、插件列表、内置/第三方分区、invalid 详情、启用/禁用按钮、卸载确认。
2. 主进程/桥接断言：所有写动作走既有内核指令；未确认不调用 `uninstall`；不出现插件更新检查入口。
3. `smoke:gui` 真机窗口：打开插件视图、展示空/已登记插件、默认 disabled、内置宿主分区、安装/启停入口可见；不要求真实网络。
4. 无新页面族/无代码加载：源码检索断言不存在插件 `import()` / `require()` / `eval()` 路径；插件视图无更新检查 API。

**验收标准（可验证）**：

1. 插件视图与 Skill 视图明确分区；插件不会出现在 Skill 卡片或更新检查结果中。
2. 安装、启用、禁用、卸载均有入口且走既有指令；默认 disabled 可见。
3. 内置 7 宿主在插件视图中只读，第三方 canonical host 带 `x-` 标识。
4. invalid/失败有可读原因与修复建议；单插件失败不阻断其他条目。
5. `smoke:gui` 通过；既有 GUI 冒烟不回归；门禁零告警。

**规模估算**：1 个插件视图 + 1 个详情/安装交互扩展 + 约 8~12 条组件/主进程用例；不新增 IPC、不新增依赖。

**风险与处置**：插件视图可能扩大界面范围 → 只复用既有页面族与组件，不新增导航/视觉体系；真机 CI 无窗口 → 组件测试 + 本机 `smoke:gui` 登记。

---

### T3 收口：端到端、失败隔离、验收映射、三平台与发版准备

**目标**：用真实内核与 CLI 证明插件从安装到宿主落位、停用、卸载的完整链路；完成 9.3.5 验收映射、文档同步与发版准备，不实际发版。

**依赖**：T0 ~ T2。

**交付物**：

1. **端到端主链路**（本地目录来源，独立进程）：
   - 安装插件 → 默认为 disabled、宿主不可选；
   - `enable` → canonical host 出现在 `--host` 可选值；
   - 安装/落位一个 Skill 到插件宿主 → 文件内容/路径正确；
   - `disable` → 后续 `--host` 选择被拒绝、既有副本保留；
   - 重新 `enable` → 可继续操作；
   - `uninstall` → 插件记录与包移除，Skill 索引与 Skill 原件不变。
2. **失败矩阵**：坏 manifest、代码文件、安全字段、canonical 冲突、重复 id、不兼容 API、未配置全局根、符号链接/路径越界、插件索引损坏；逐项断言问题码、退出码、无半截写入，且其他插件/内置宿主不受影响。本期无第三方代码执行，“插件崩溃”等价于 manifest 解析/校验/合并异常，不得拖垮内核。
3. **六条机械隔离断言全链路复核**：T0 单元断言 + T1 加载/卸载路径 + T3 真实 CLI 前后快照。
4. **9.3.5 验收映射**：M4b-R1 ~ R5、后续高层目标 6/7 逐条回填测试/运行证据。
5. **插件列表报告**：`list --kind plugin --json` 固定字段与稳定排序；作为「导出插件列表报告」的可复核出口。
6. **三平台验证**：Windows/Linux CI 全量；macOS arm64/x64 复用既有 pack/probe leg 跑插件相关单元/端到端或最小冒烟；不做平台专有插件代码。
7. **文档同步**：README 用户可见段（安装、默认 disabled、`--kind plugin`、内置/第三方分区、无插件代码）；one-summary（M4b 状态、规模/计数、遗留）；CHANGELOG（T0~T3 开发记录）；需求回写批次与计数校验；设计/计划状态回写；文档计数从「五份规范 / 五份 schema」更新为 T0 完成后的实际数量。
8. **发版准备**：建议 `v0.3.0`（新增 GUI 插件视图 + 七个既有指令的 `--kind` 消费面）；准备 CHANGELOG 版本段要点与版本守卫预检；**不实际发版**，由维护者授权。

**测试**：

1. 端到端主链路逐段证据：命令、退出码、插件索引变化、Skill 索引字节、宿主文件内容、停用/卸载后的文件状态。
2. 失败矩阵逐项有码、有可读修复建议、无部分写入；单条失败不阻断其他插件。
3. 兼容性矩阵：当前版本范围通过、未来 API 拒绝、非法范围拒绝、prerelease 拒绝。
4. 隔离复核：内置 registry/`FORM_BY_HOST`/`host.*` 配置前后快照；插件 host 不进入内置集合。
5. 三平台：Windows/Linux CI 全量；macOS arm64/x64 既有 leg 的最小插件路径冒烟；路径分隔符/CRLF 断言。
6. 文档与计数：16 指令、实际规范/schema 数量、测试总数、遗留项逐项可核对；`docs/reviews/` 未改。

**验收标准（可验证）**：

1. 端到端主链路与失败矩阵全部有运行证据；插件失效不使内核或内置宿主不可用。
2. 9.3.5 的 R1~R5 与高层目标 6/7 逐条映射，无悬空项。
3. 六条机械隔离断言在单元、加载路径与真实 CLI 三层均成立。
4. 三平台结论明确；不适用项写明边界，不以「未验证」留白。
5. README/one-summary/CHANGELOG/需求/设计/计划同步；计数一致；reviews 快照不动。
6. 全量测试与门禁全绿；给出 `v0.3.0` 发版建议但不发布。

**规模估算**：1 组端到端 + 1 组失败矩阵 + 三平台冒烟 + 文档批次；不新增指令、不新增运行时依赖。

**风险与处置**：插件宿主落位涉及工作区外路径 → 复用既有确认与备份/原子写；macOS 无本地窗口 → 复用 pack/probe leg 的最小冒烟；插件索引与 Skill 索引无跨事务 → 明确各自唯一事实源，测试分别断言。

---

## 2. 依赖关系与关键路径

| 任务 | 依赖 | 说明 |
|---|---|---|
| T0 规范/schema/索引/合并纯函数 | 设计定稿 | 先文档后实现；schema 与纯函数优先 |
| T1 类型消费面/生命周期/宿主落位 | T0 | 依赖 manifest、插件索引与合并视图 |
| T2 GUI | T1 | 依赖插件列表/详情/启停结果形状 |
| T3 收口 | T0 ~ T2 | 端到端、失败矩阵、三平台、文档 |

关键路径：**T0 → T1 → T2 → T3**。T0 内部顺序为：规范与 schema → 工作区/存储 → 发现校验 → 纯合并函数 → 六条断言。

---

## 3. 验收映射（需求 9.3.5 与本期约束）

| 验收项 | 承载 | 证据 |
|---|---|---|
| M4b-R1 扩展清单 | T0 / T1 / T3 | `plugin_index.yaml` 字段与 schema；`list --kind plugin --json` 报告；与 Skill 索引物理分离 |
| M4b-R2 注册/注销/列出 | T1 / T3 | `install/uninstall/list --kind plugin`；重复登记幂等；不合格项可见；单条失败不阻断 |
| M4b-R3 能力扩展方式 | T0 / T1 | 声明式 host profile；三种 form；不新增指令；`REGISTERED_COMMANDS` 仍 16 |
| M4b-R4 版本与兼容 | T0 / T1 / T3 | manifest/plugin_api 版本；semver 范围；不兼容拒绝且不加载 |
| M4b-R5 失败隔离 | T0 / T3 | 六条机械断言；失败矩阵；单插件 invalid 不影响内置/其他插件 |
| 高层目标 6：登记/查询/列出/导出报告 | T1 / T3 | `list --kind plugin --json` 固定字段；`inspect --kind plugin` |
| 高层目标 7：schema 与兼容格式校验 | T0 / T1 | manifest schema 正反例；兼容性格式/范围校验 |
| 插件 ≠ 技能 | T0 / T1 / T2 | 独立索引、独立输出分区、Skill 卡片/更新检查不含插件 |
| M5 内置不可覆盖 | T0 / T1 / T3 | 内置 registry 深比较、`FORM_BY_HOST` 键集合、`host.*` 配置拒绝插件 id |
| 默认 disabled | T1 / T2 / T3 | 安装后状态、宿主不可选、显式 enable 才加载 |
| 安全字段禁止 | T0 / T1 / T3 | schema + 原始 manifest 双重拒绝；安全字段反例 |
| 不新增指令 | 全部 | 契约测试：16 条指令；`--kind` 仅七个既有指令 |
| 无代码插件/全局插件/更新检查 | 全部 | 第 5 节排除项；源码检索与 GUI 断言 |

---

## 4. 六条机械隔离断言与测试方法

| # | 断言 | 测试方法 |
|---|---|---|
| 1 | 加载插件前后，内置 `loadHostRegistry()` 深比较完全一致 | 加载前 `structuredClone`/JSON 快照，加载后逐字段比较；注册表保持冻结 |
| 2 | `FORM_BY_HOST` 键集合加载前后不变 | 通过 `allAdapters()` 的 `host_id` 集合或内部只读测试钩子比较；插件 profile 不写入该表 |
| 3 | canonical host 冲突时整插件拒绝，不部分加载 | 构造两个 canonical id 相同的插件；后加载者零 profile 进入目录，先加载者与内置保持 |
| 4 | manifest schema 非法时插件不加载 | 一个非法 + 一个合法插件；非法记录 invalid、合法正常；非法项无 host |
| 5 | disabled 插件不加载 | 安装后默认 disabled，目录中无其 host；enable 后出现，disable 后消失 |
| 6 | manifest 出现安全控制字段即整插件拒绝 | 在任意层级放 `security_control_evidence` / `disable-model-invocation` 等禁用键；返回错误、零 profile |

补充断言（不替代六条）：

1. 插件加载不调用 `import()` / `require()` / `eval()` / `new Function()`；以源码检索与测试双重审计。
2. 插件 canonical host 全部以 `x-` 开头，且与内置 7 个 id 不相交。
3. `host.<id>.*` 配置校验拒绝插件 id；插件配置只写 `plugin_index.yaml`。
4. 同一插件重复加载幂等，不产生重复 host 或重复记录。

---

## 5. 明确不做（本期边界）

| 项 | 处置 |
|---|---|
| 代码插件（ESM/原生/外部可执行） | 不实现；触发条件为安全沙箱模型 + 稳定适配器 API + 独立立项 |
| 全局插件目录 | 不实现；仅工作区级 |
| 插件更新检查 | 不实现；不与 M4a 四态混用；后续独立 checker |
| 第三方安全控制字段 | 一律禁止；不承认自报 evidence |
| 新渲染算法/新来源协议/新校验语义 | 不实现；需代码或独立安全模型 |
| 新指令 | 不实现；保持 16 条 |
| 插件市场/在线检索/自动分发 | 不实现 |
| 插件进入 Skill 导出/导入/备份恢复 | 不在本期；插件列表报告走 `list --kind plugin --json` |
| 应用自更新（M4a-2） | 不在本期；沿用 M4a-2 登记 |

---

## 6. 风险、阻塞与登记

| 编号 | 事项 | 处置 |
|---|---|---|
| B-1 | `--kind` 的默认值与插件必填规则需要契约确认 | 按 0.2 节 K-1；确认后先改契约再实现 |
| B-2 | 插件卸载是否删除包、是否做 Skill 式备份 | 按 K-2；默认删除插件包，不做 Skill 备份，确认文案列全路径 |
| B-3 | 全局宿主根配置位置 | 按 K-3；写 `plugin_index.yaml`，必须显式配置，不默认落到用户主目录 |
| B-4 | 新问题码是否获批 | 按 K-4；优先复用类别，新增编号在 T0 登记，不改变既有退出码语义 |
| B-5 | 插件宿主既有副本不进入 `targets[]` | 按 F-3；`landings` 账本保留可追溯性，禁用只影响后续选择/分发，卸载标记孤儿并提示人工清理 |
| B-6 | rules 形态与共享渲染核心的边界 | 只实现共享核心可表达的规则；需要宿主专有逻辑的 profile 视为超出声明式能力，不写代码分支 |
| B-7 | 三平台路径/符号链接差异 | 用项目根与相对路径断言；Windows/macOS 各自跑最小路径用例 |
| B-8 | 插件索引与 Skill 索引无跨索引事务 | 两者各自唯一事实源；插件操作只写插件索引，宿主落位只写目标文件；失败回滚各自范围 |

---

## 7. 测试与文档计数

| 项目 | 计划口径 |
|---|---|
| 既有基线 | 常规 525 项 + 慢测试 1 项 |
| T0 新增 | schema/索引/发现/合并/六断言，按单元与契约归属登记 |
| T1 新增 | `--kind` 矩阵、生命周期、宿主落位、配置路由，按单元/契约/端到端归属登记 |
| T2 新增 | 插件视图、详情、安装/启停、确认与无更新入口，按组件/主进程归属登记 |
| T3 新增 | 端到端主链路、失败矩阵、三平台最小冒烟、文档契约断言 |
| 指令数 | 16（不变） |
| 规范数 | T0 完成后为 6 份（新增 `plugin-format.md`） |
| schema 数 | T0 完成后为 7 份（新增 manifest 与 plugin_index 两份） |
| `docs/reviews/` | 不修改快照 |

实现完成后按实际用例数回填本表；不以预计数替代测试输出。

---

## 8. 发版准备（不实际发版）

1. 建议版本：`v0.3.0`。理由：新增用户可见的插件管理视图，并为七个既有指令增加 `--kind` 消费面；不是补丁语义。
2. CHANGELOG 版本段要点：声明式插件、默认 disabled、独立 `plugin_index.yaml`、`x-` 命名空间、内置不可覆盖、三种受限 form、无代码插件/无插件更新检查/无新指令。
3. 版本守卫预检：三处 `package.json`、`TOOL_VERSION`、CHANGELOG 顶部一致；发布动作留给维护者授权。
4. 发布后建议验证（届时另给提示词）：生产形态 GUI 插件视图、发布物内核 `--kind plugin` 最小闭环、内置宿主前后快照、mac C 组、SHA 复核。

---

**计划结束**。本文档只输出任务、依赖、交付物与验收；T0 ~ T3 的实现、测试计数与运行证据在执行后回填。
