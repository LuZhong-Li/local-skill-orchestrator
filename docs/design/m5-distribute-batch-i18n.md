# M6 跨宿主分发与批量治理 + 操作 / 界面 / i18n 设计

| 项目 | 内容 |
|---|---|
| 设计日期 | 2026-10-20 |
| 需求基线 | `docs/requirements.md` 9.3.9（M6；讨论稿称 M5） |
| 调研基线 | [`docs/research/m5-distribute-batch-i18n-2026-10-20.md`](../research/m5-distribute-batch-i18n-2026-10-20.md) |
| 设计状态 | 设计定稿候选，待边界核对后进入计划 |
| 约束 | 不写实现代码；先回写需求，再给模块设计；不新增指令；不新增 `reconcile` 写动作 |
| 代码基线 | `v0.5.2`；17 条指令；732 项常规测试；7 份规范 / 8 份 schema；69 个问题码 |

> **编号说明**：9.3.6 已由 M5 占用，因此 9.3.9 按 M6 登记；本文沿用用户给定的文件名 `m5-distribute-batch-i18n.md`，正文按 M6 描述。

## 0. 设计结论摘要

| 领域 | 最终设计 |
|---|---|
| R1 字段 | `SKILL.md` 按官方六字段识别；`author/version` 从 `metadata` 读取；归一化到 `skill_meta` 时提升为顶层；`compatibility` / `allowed_tools` / `metadata` / `extensions` 各有承载；`install` 只读 `skill_meta` |
| R8 分发 | 新宿主分发走 `reconcile --action repair` 的 `not_distributed`；不使用 `install` / `restore`；不新增指令 |
| 批量 | selection 在 plan 层 flatten；多 `skill_id[]` / root / role；execute 继续逐 item 事务；默认失败继续 |
| 审计 | 期望集合 = `skill_meta.targets[]`；审计是 `scan --inventory` 结果层的只读投影；`host_landings` 继续是账本，不新增审计表 |
| 漂移 | 复用 `reconcileHostCopy`；同 format 比 `content_digest`，跨 format 比 `source_checksum` / `source_version` / `source_ref` |
| i18n | `vue-i18n`（MIT）；`en` / `zh-CN`；跟随系统 + 手动 + `settings.json` 持久化；问题码先保留再本地化 |
| GUI | 保留现有设计令牌与手写组件；不整体引入 Element Plus / Naive UI；复杂组件按需单引 |

**明确不做**：registry / 远程发现安装、私有嵌套 metadata 自动解析、新 `reconcile` 写动作、MCP server 管理、`gray-matter`、CLI / JSON / 错误码本地化、整批 undo。

---

## 1. 修正后的需求映射

### 1.1 R1：官方六字段与 `SKILL.md → skill_meta` 归一化

#### 1.1.1 字段语义

| `SKILL.md` 字段 | 来源类型 | 归一化后的 `skill_meta` | 说明 |
|---|---|---|---|
| `name` | 官方必填 | `name` / `id` | `id` 仍按工作区命名规则；`name` 与目录名按现有契约校验 |
| `description` | 官方必填 | `description` | 直接映射 |
| `license` | 官方可选 | `license` | 直接映射 |
| `compatibility` | 官方可选 | `compatibility` | 官方字符串；不再只藏在运行时依赖文本里 |
| `metadata` | 官方可选 | `metadata` | 原样保留任意映射；`metadata.author` / `metadata.version` 只用于提升 |
| `allowed-tools` | 官方可选 | `allowed_tools` | 保留声明类型；官方语义是空格分隔字符串，设计按字符串承载 |
| `metadata.author` | 官方示例字段 | `author` | 提升为工作区顶层；原 `metadata` 不删除 |
| `metadata.version` | 官方示例字段 | `version` | 提升为工作区顶层；原 `metadata` 不删除 |
| 顶层 `author` / `version` | 旧格式兼容 | `author` / `version` | 仅兼容读取；与 metadata 冲突时以 metadata 为准并警告 |
| `mcp-server` | 非官方 | `extensions['mcp-server']` | 只读保留；不解析、不连接、不管理 |

#### 1.1.2 优先级与冲突

1. **源优先级**：`adopt` / 重新采纳时以 `SKILL.md` 为源；不允许既有 `skill_meta` 覆盖 `SKILL.md` 的显式声明。
2. **同一 SKILL.md 内**：`metadata.author` / `metadata.version` 优先于顶层旧字段；冲突产生字段级 warning，二者都不删除，归一化取 metadata 值。
3. **`metadata` 内部**：`author` / `version` 是唯一被读取并提升的键；`custom`、`dependencies`、`mcp-server` 等不提升、不映射。
4. **`allowed-tools` / `compatibility`**：直接进入同名承载字段；若 `skill_meta` 已有值而 `SKILL.md` 显式声明不同，以 `SKILL.md` 为准。

#### 1.1.3 install / adopt 边界

| 入口 | 输入 | 行为 |
|---|---|---|
| `adopt` | 宿主副本的实际 `SKILL.md` | 解析官方六字段 + metadata author/version；生成/更新 `skill_meta`；复制宿主内容到中心库 |
| `install` | 已归一化的 `skill_meta.yaml` + 内容 | 只消费 `skill_meta`；不直接读裸 `SKILL.md`；重复 ID 继续拒绝 |
| `update` / `restore` / 渲染 | 中心库 `skill_meta` + `SKILL.md` 正文 | 读取新增承载字段，渲染到目标宿主；不得重新从宿主猜 source |

#### 1.1.4 未知字段与 `mcp-server`

- `mcp-server` 不是官方六字段，不进入 `compatibility` / `metadata` / `dependencies` 的正式语义；存放在可选 `extensions` 映射中，键为原始字段路径，值为原始 YAML 值。
- `extensions` 只读保留；渲染层只有在宿主注册表明确允许该扩展时才可能输出，否则不输出，并在渲染台账中记录 `dropped` / `read_only`。
- 非标准嵌套字段按 R3 产生 warning；不得静默丢弃。

### 1.2 R8：`reconcile repair` 的 `not_distributed` 场景

| 事项 | 设计 |
|---|---|
| 入口 | `reconcile --action repair --id <id> --host <host>`；批量时按 R4 生成多个 `not_distributed` item |
| `install` | 继续拒绝已登记 ID；不作为新宿主分发入口 |
| `restore` | 继续无 `--host`；不作为新宿主分发入口 |
| 内置宿主 | `notDistributedRoots` 从已存在的内置技能根生成候选 |
| 插件 `x-` 宿主 | 计划层为已启用插件根生成 `not_distributed` 候选；不能生成时显式 `skipped` / 拒绝并给 remedy |
| 落位 | `repairItem` 复用 `runHostLanding`、注册表、适配器、`landPlan`、备份与账本回滚 |
| 共享根 | 只写一次，同步全部消费宿主记录 |
| 幂等 | 目标已一致返回 no-op；失败回滚目标、索引与账本 |

### 1.3 其他已回写的需求

| 需求 | 设计口径 |
|---|---|
| R4 | selection 在 plan 层 flatten；execute 不改 per-item 事务模型；默认失败继续 |
| R5 | GUI 多选 / 全选；`clean` 允许整角色 / 全选，但共享根整组保护 |
| R7 | 期望集合 = `skill_meta.targets[]`；审计矩阵只读投影；观察时刻 = 盘点时刻 |
| R11 | `clean` 整角色 / 全选必须整组；取消在 item 边界停止；不提供整批 undo |
| R16 | GUI 使用 `vue-i18n`，不自建 i18n 框架 |

---

## 2. 总体架构与数据流

### 2.1 模块关系

| 层 | 模块 | 本设计的职责 |
|---|---|---|
| 契约 | `contract/src/reconcile.ts` | 批量选择器、动作结果、summary 的跨层形状 |
| 契约 | `contract/src/host-inventory.ts` | 审计矩阵的只读数据形状 |
| 调度 | `kernel/dispatch/reconcile/options.ts` | 解析 repeatable `--id` / `--root` / `--role` |
| 调度 | `kernel/dispatch/reconcile/plan.ts` | selection flatten、物理键去重、transaction group、预览 |
| 调度 | `kernel/dispatch/reconcile/execute.ts` | 逐 item 执行、逐项 try/catch、默认继续 |
| 核心 | `kernel/core/host-landings/*` | 账本、摘要、回滚、缺失反向枚举 |
| 扫描 | `kernel/dispatch/scan/*` | 盘点快照、审计投影、只读观察时刻 |
| GUI | `gui/renderer/src/components/*` | 多选、批量栏、预览三区块、进度 / 汇总 |
| GUI | `gui/renderer/src/i18n/*` | `vue-i18n` 资源与 locale 状态 |

### 2.2 批量执行数据流

```text
CLI / GUI selection
  → ReconcileSelection（legacy 或 batch）
  → plan.flattenSelection()（纯函数：并集、物理键去重、角色过滤）
  → ReconcilePlanItem[]（扁平 items）
  → transaction_group（按 physical_key 分组；共享根为一组）
  → preview（零写入）
  → execute 逐 item（每项 try/catch；共享组原子）
  → ReconcileResultItem[] + summary
```

**关键边界**：`execute` 不接收嵌套批次，只接收扁平 `items`；`transaction_group` 只描述原子组，不是第二层循环。

### 2.3 审计数据流

```text
skill_meta.targets[]（期望集合）
  + skill_index（工作区基线）
  + host_landings / plugin landings（分发账本）
  + inventory snapshot（物理观察）
  → audit projection（只读）
  → rows[]（skill × target × scope）
  → summary + GUI 矩阵 / CLI JSON
```

**关键边界**：`targets[]` 只提供期望集合；账本仍只由 `host_landings` / plugin landings 提供。

---

## 3. 批量 reconcile 设计

### 3.1 选择器模型

保留现有单选择器，新增 batch 选择器：

| 字段 | 语义 |
|---|---|
| `mode` | `path` / `id-host` / `classification` 保持；新增 `batch` |
| `ids[]` | 多个 `skill_id`；CLI 可重复 `--id` |
| `roles[]` | `user` / `system` / `platform` / `project`；CLI 可重复 `--role` |
| `roots[]` | 现有可重复 `--root` |
| `host` | 现有单值 / `all`；不改成重复值 |
| `classification` | 现有分类批量；与 batch 选择器并集 |
| `path` | 继续精确单副本，且与 batch 选择器互斥 |

**不做**：CLI 裸 `--all`。GUI 的“全选”展开为当前可见的 `ids[]` 或 `--role user`；`clean` 的整角色 / 全选仍走明确范围。

### 3.2 plan 层 flatten

`plan.flattenSelection(snapshot, selection)` 是纯函数，按下列顺序产生候选：

1. 解析 legacy `path` / `id-host` / `classification`；
2. 展开 `ids[]` 对应的 observed copies；
3. 展开 `roots[]` 覆盖的副本；
4. 展开 `roles[]` 覆盖的宿主根；
5. 合并 `notDistributedCandidates`（`repair` 场景）；
6. 用 `physical_key` 去重；同一 shared root 只保留一个 item；
7. 按 `physical_key` 生成 `transaction_group`；
8. 对 `system` / `platform` / `project` 与混合角色组标 `skipped`。

**选择器组合规则**：

- 多个条件取并集；
- 同一物理键去重；
- 不隐式扩大到未选中的 root / host / role；
- `clean` 不做 classification-only 批量；允许 role / root / 显式 ids；
- `role=all` 仅表示选择全部角色，写动作仍只执行 `user`，其他角色 `skipped`。

批量 `repair` 与 `adopt` / `track` / `accept` / `clean` 共用同一 flatten、item 执行与 summary 骨架；不另建 repair 批量实现。

### 3.3 事务与共享根保护

| 对象 | 事务边界 | 失败行为 |
|---|---|---|
| 普通副本 | 单 item | 当前 item 回滚，其他 item 继续 |
| 共享根 | 一个 `transaction_group` / 一个 item | 组内失败整组回滚；组外继续 |
| `clean` 共享根 | 整组选择 | 组内混入非 `user` 或仍有活跃消费宿主时整组 skipped / 拒绝 |

`transaction_group` 的现有 `shared` 标记继续使用；GUI 预览必须展示组内 `consumed_by` 与影响宿主。

### 3.4 执行器逐项隔离

`executeReconcilePlan` 保持扁平循环，但每项包裹 `try/catch`：

1. `skipped` item 不执行，直接产出 skipped result；
2. `planned` item 执行；异常转 `failed`，带 `item_id`、`target_path`、`findings` / `reason`；
3. 当前 item 失败不改变已完成 item；
4. 共享组异常由组内动作回滚；组外继续；
5. 取消信号在每个 item 开始前检查；当前原子组允许完成或回滚；
6. 不因单项异常丢失已成功项的 result。

### 3.5 结果与 summary

**预览**：

| 字段 | 语义 |
|---|---|
| `selected` | flatten 后的 item 总数 |
| `planned` | 可执行 item 数 |
| `skipped` | 跳过 item 数 |
| `destructive` | `clean` item 数 |
| `shared_groups` | 共享根组数 |
| `selection_summary` | 按 skill / root / role / host / classification 的分布（加法字段） |

**执行后**：

| 字段 | 语义 |
|---|---|
| `succeeded` | 成功 item 数 |
| `failed` | 失败 item 数 |
| `skipped` | 跳过 item 数 |
| `cancelled` | 取消未执行 item 数 |
| `duration_ms` | 本批耗时 |
| `results[]` | 每项 `item_id` / `status` / `target_path` / `findings` / `message` / `after` |

计数规则：`succeeded + failed + skipped + cancelled = selected`；预览与执行后的 `selected` 必须一致；不一致视为计划过期。

### 3.6 GUI 批量执行与进度

设计选择：

1. **一次预览**：GUI 用 batch selection 调一次 `reconcile` 预览，得到扁平 items 与 summary；
2. **一次确认**：用户确认整批计划；
3. **逐 item apply**：GUI 按 plan item 的稳定 `target_path` / `physical_key` 顺序调用既有 `reconcile --apply --path ... --yes`；每次调用重新读取状态，过期 item 标 failed；
4. **进度**：每完成一个 item 更新 `已完成 / 总数`；不做伪造百分比；共享组完成后计 1 个 item；
5. **取消**：设置本地停止标志，不再发起后续 item；当前 item 完成 / 回滚；汇总显示 cancelled；
6. **重试失败项**：只对失败 item 重新预览 + apply；成功项不重复执行。

该方案不新增 IPC 流式协议；批量计划仍是唯一事实源。若后续需要真正的内核级流式进度，再作为独立契约演进。

CLI 仍保持一次 batch invocation，返回最终逐项结果与 summary；只有 GUI 为了进度把同一计划拆成逐 item 的既有 apply 调用。

### 3.7 `W-DRIFT-001` 修正

1. `update` 成功完成内容、索引与副本写入后，重新计算校验结论；不沿用更新前快照；
2. 成功结果不输出由旧快照导致的 `W-DRIFT-001`；
3. 若写入后仍存在真实漂移，保留 `W-DRIFT-001`，文案描述「更新后仍不一致」与具体文件 / 原因；
4. 问题码、JSON 字段、退出码不变；
5. GUI 使用最新 result，不复用旧缓存告警。

---

## 4. 跨宿主一致性审计矩阵

### 4.1 期望集合：`skill_meta.targets[]`

审计读取每条 `targets[]` 的 `target`、`scope`、`enabled`、`path`：

| 解析结果 | 条件 | 处理 |
|---|---|---|
| `host` | `target` 命中内置宿主注册表 | 进入宿主矩阵 |
| `plugin_host` | `target` 命中已启用 `x-` 插件宿主 | 进入宿主矩阵 |
| `workspace_only` | `target` 不是宿主，只是工作区目标 | 单列 `workspace_only`，不计入 missing |
| `unmapped` | `target` 无法解析 | 标 `unmapped`，不计入 missing |
| `ambiguous` | 同 target/scope 对应多个宿主根 | 标 `insufficient`，要求显式根，不猜 |

所有 `targets[]` 条目都视为期望目标，`enabled` 只决定期望可见性，不决定是否存在。

> 这是本设计的明确取舍：若产品把 `enabled: false` 理解为“不要求存在”，必须在需求层改写，不能由实现层自行猜测。

### 4.2 状态推导

| 状态 | 条件 | 是否计入 missing |
|---|---|---|
| `distributed` | 期望 target 有 active 账本记录，物理副本存在，摘要 / 来源 / 可见性一致 | 否 |
| `missing` | 期望 target 无 active 账本记录；或账本 active 但物理副本不存在 | 是 |
| `drift` | 账本 active、副本存在，但内容 / 来源 / 版本不一致 | 否（drift 单列） |
| `visibility_mismatch` | 账本 active、副本存在，但可见性与 targets / 账本不一致 | 否 |
| `undeclared` | 观察到副本或账本记录，但 targets[] 没声明 | 否；只提示 |
| `unmapped` | targets 条目无法映射到宿主 | 否；证据不足 |
| `insufficient` | 账本损坏、副本不可读、基线不可计算、根歧义 | 否；不伪造权威结论 |

**优先级**：`unmapped` / `insufficient` > `missing` > `visibility_mismatch` > `drift` > `distributed`。`undeclared` 只用于非期望目标的行。

**关键口径**：

- `targets` 有、账本无 → `missing`，即使磁盘上存在复制品；原因标 `ledger_missing`；
- `targets` 有、账本 active、副本无 → `missing`，原因标 `copy_missing`；
- 账本 active、副本存在但 targets 未声明 → 不并入 missing；以 `undeclared` 提示；
- `enabled: false` 只影响期望可见性；期望目标仍参与矩阵；副本不存在仍是 `missing`。

`targets[]` 本身就是期望证据；账本缺失是 `missing` 的原因，不是降级为 `undetermined` 的理由。`undetermined` / `insufficient` 只用于账本或副本证据本身不可读 / 不可判定的情况。

### 4.3 漂移比较

| 比较对象 | 规则 |
|---|---|
| 工作区基线 | 按目标宿主 format 重新渲染后的 `expected_content_digest`，不是中心库原始 checksum |
| 同 format | 可比较 `content_digest`；不一致 → `drift` |
| 跨 format | 不比较 `content_digest`；比较 `source_checksum`、`source_version`、`source_ref` |
| 可见性 | targets `enabled` / 账本 `visibility` / 副本实际 visibility 三者比对 |
| 证据 | 复用 `reconciliation.classification` / `evidence` / `drift_reasons`；不另立分类 |

### 4.4 观察时刻与存储

- `observed_at` = 本次 `scan --inventory` 运行时刻；每个 audit row 使用同一时刻；
- 不新增历史观察字段；不使用 `host_landings.updated_at` 冒充观察时间；
- `host_landings.yaml` / plugin landings 继续是唯一账本；
- 审计矩阵是 `scan --inventory` 结果层的只读投影；不新增独立持久化审计表。

### 4.5 输出形状

设计为 `scan --inventory --audit` 的可选加法字段 `data.audit`：

| 字段 | 内容 |
|---|---|
| `observed_at` | 盘点时刻 |
| `summary` | `declared` / `distributed` / `missing` / `drift` / `visibility_mismatch` / `undeclared` / `unmapped` / `insufficient` |
| `rows[]` | `skill_id`、`target`、`scope`、`host_id`、`expected_enabled`、`ledger_state`、`copy_path`、`copy_version`、`source_checksum`、`source_version`、`content_digest`、`status`、`classification`、`evidence`、`reasons[]`、`observed_at` |
| `groups[]` | 可选：按角色 / 宿主 / 状态的聚合 |

不传 `--audit` 时既有 `scan --inventory` JSON 不变；传 `--audit` 时只增加字段，不改变既有字段语义。

### 4.6 GUI 审计视图

- 默认按角色分组：`user` 展开，其他折叠；
- 行筛选：skill、host、status、declared / observed；
- 状态标签同时使用文字与颜色；
- `missing` / `drift` / `visibility_mismatch` 可下钻到账本、副本与 reconcile 预览；
- `undeclared` / `unmapped` / `insufficient` 单独分区，不与 missing 混排；
- 共享根显示 `consumed_by`，只计一次。

---

## 5. 字段分层与元数据

### 5.1 `SKILL.md`（源头）

官方字段：

| 字段 | 类型 | 归一化 |
|---|---|---|
| `name` | 字符串 | `id` / `name` |
| `description` | 字符串 | `description` |
| `license` | 字符串 | `license` |
| `compatibility` | 字符串 | `compatibility` |
| `metadata` | 映射 | `metadata` 原样保留；仅读取 `author/version` 提升 |
| `allowed-tools` | 空格分隔字符串 | `allowed_tools` |

兼容字段：

- 顶层 `author` / `version`：可读，但 metadata 同名键优先；冲突 warning；
- `mcp-server`：非官方，`extensions` 只读承载；
- 其他非标准嵌套：R3 warning，保留。

### 5.2 `skill_meta.yaml`（工作区归一化契约）

新增/明确的声明区字段：

| 字段 | 类型 | 必填 | 来源 |
|---|---|---|---|
| `compatibility` | 字符串 | 否 | SKILL.md `compatibility` |
| `allowed_tools` | 字符串 | 否 | SKILL.md `allowed-tools` |
| `metadata` | 映射 | 否 | SKILL.md `metadata` 原样 |
| `extensions` | 映射 | 否 | 未识别非标准字段（含 `mcp-server`） |
| `author` / `version` | 字符串 | 否 | metadata 提升或旧顶层兼容 |

`id/name/description/license/status/path/trigger_keywords/dependencies/source/targets` 保持现有语义。

### 5.3 归一化流程

1. `adopt` 读取宿主副本 `SKILL.md`；
2. 识别官方六字段，读取 `metadata.author/version`；
3. 顶层旧 `author/version` 作为兼容输入；与 metadata 冲突时 warning + metadata 胜出；
4. `compatibility` / `allowed_tools` 直接映射；
5. `metadata` 原样保留；
6. `mcp-server` 与其他未识别非标准字段进入 `extensions`，只读；
7. 生成 `skill_meta.yaml`，校验 schema；
8. `install` 只消费该归一化文件；
9. `renderSourceOf` 读取新增字段，交给适配器渲染；不再丢字段。

### 5.4 `metadata` 与 `extensions` 的边界

| 内容 | 位置 | 是否解析 |
|---|---|---|
| 官方 `metadata` 块 | `skill_meta.metadata` | 只读 `author/version` 提升；其余不解析 |
| `metadata.custom` | `skill_meta.metadata.custom` | 原样保留，不展平、不映射 |
| `mcp-server` | `skill_meta.extensions['mcp-server']` | 不解析、不连接、不管理 |
| 其他非标准顶层 / 嵌套 | `skill_meta.extensions[原始路径]` | 只读保留 + warning |

**渲染限制**：宿主 `SKILL.md` 的 `metadata` 只输出官方允许的字符串映射；嵌套值 / 非字符串值保留在管理端，不直接写入宿主；渲染台账记录 `dropped` 与原因。

### 5.5 冲突矩阵

| 冲突 | 处理 |
|---|---|
| `metadata.author` vs 顶层 `author` | metadata 胜出，warning |
| `metadata.version` vs 顶层 `version` | metadata 胜出，warning |
| `SKILL.md` vs 既有 `skill_meta` | `SKILL.md` 显式声明胜出（adopt 重新归一化） |
| `allowed-tools` vs 既有 `allowed_tools` | `SKILL.md` 胜出，warning |
| `compatibility` vs 既有 `compatibility` | `SKILL.md` 胜出，warning |

---

## 6. i18n 架构

### 6.1 库与模块

| 项 | 设计 |
|---|---|
| 库 | `vue-i18n` 11.x（MIT），直接依赖 |
| 实例 | `gui/renderer/src/i18n/index.ts` 创建 `createI18n` |
| 资源 | `messages/zh-CN.ts`、`messages/en.ts` |
| 组件接入 | `useI18n().t`；日期 / 数字可用 `i18n-d` / `i18n-n` 或原生 `Intl` |
| 回退 | `fallbackLocale: 'en'` |
| 体积 | 完整构建约 21.4 KB gzip；可用 runtime-only / 预编译消息，最终以 bundle 报告为准 |

不引入第二套 i18n 框架；不引入 `gray-matter`。

### 6.2 语言解析与持久化

| 模式 | 行为 |
|---|---|
| `system` | `app.getLocale()`；`zh` / `zh-CN` / `zh-Hans*` → `zh-CN`；`en*` → `en`；其他 → `en` |
| `manual` | 用户在设置页选择 `zh-CN` / `en`，立即生效 |
| 持久化 | `userData/settings.json` 的 app 配置；不写工作区、索引、导出物 |
| 迁移 | 既有 `periodic_check_enabled` / `instant_check_enabled` 保持；新增字段为加法，读取时保留未知字段 |
| 系统变化 | 跟随模式至少下次启动生效；手动模式不被系统覆盖 |

### 6.3 错误文案

1. 内核结果保留 `code`、`message`、`remedy`、`target` 原样；
2. GUI 主文案按 `code` 查本地字典，显示本地化的「原因 / 下一步」；
3. 原始 `message` / `remedy` 放入可展开的诊断详情，可复制；
4. 未知 code 回退原始 message，并保留 code；
5. 同一 code 在不同命令下的上下文差异，由字典提供通用说明，必要时附加 `target` / `source` 上下文。

### 6.4 契约与 UI 边界

| 类别 | 是否翻译 | 说明 |
|---|---|---|
| 指令名 / 选项名 | 否 | CLI 契约 |
| 问题码 | 否 | 机器契约 |
| JSON 键 / 结构 / 枚举值 | 否 | 机器契约 |
| 退出码 | 否 | 机器契约 |
| CLI 人类可读 message / remedy | 否 | 当前中文，保持现状 |
| GUI 导航 / 按钮 / 标签 / 状态 | 是 | `vue-i18n` 资源 |
| GUI 空 / 加载 / 完成态 | 是 | 资源键 |
| GUI 错误解释 / remedy | 是 | 按 code 字典；原始详情保留 |
| 日期 / 数字 | 本地化 | `Intl` |
| 路径 | 不改写 | 原值复制；等宽 + 方向隔离 + 换行 |

---

## 7. GUI 界面与操作设计

### 7.1 盘点视图

| 区域 | 设计 |
|---|---|
| 顶部摘要 | 唯一 Skill、有效副本、missing / drift / untracked 计数 |
| 角色分组 | `user` 默认展开；`system` / `platform` / `project` 折叠并标注由对应工具管理 |
| 状态标签 | 对账分类、根状态、可见性、角色、证据等级；文字 + 颜色 / 图标 |
| 空根 | 保留在分组中，显示 `ok/empty/missing/unconfigured/unreadable/not_applicable` 与 remedy |
| 共享根 | 显示 `consumed_by`，只计一次 |
| 多选 | 行 checkbox；选择状态对应物理副本 / 事务组；全选只覆盖当前筛选可见的 user 可执行项 |
| 批量栏 | 动作、已选数量、可执行 / 跳过、影响宿主；`clean` 显示整组警告 |

### 7.2 动作预览对话框

三个区块：

| 区块 | 内容 |
|---|---|
| 写入项 | 路径、动作、备份、目标宿主 |
| 账本变更 | 记录键、来源、from → to |
| 警告 | 共享根、非 user、覆盖、不可逆、过期计划 |

摘要区显示动作、总数、分布、影响角色、可逆性；确认按钮带具体动作名；取消零写入。

### 7.3 状态与反馈

| 状态 | 显示 |
|---|---|
| 首次加载 | skeleton / 进度，不显示空态 |
| 就绪 | 正常数据与操作入口 |
| 未初始化 | 引导 `init` |
| 无根 | 提示配置宿主根 |
| 空根 | 根存在但无有效副本，显示根状态 |
| 筛选空 | 提示清除筛选 |
| 预览中 | 计划加载 |
| 执行中 | `已完成 / 总数`、成功 / 失败 / 跳过 / 取消计数、当前项 |
| 全部成功 | 汇总 + 关闭 / 导出 |
| 部分成功 | 成功 / 失败 / 跳过 + 重试失败 |
| 全部失败 | 失败清单 + remedy |
| 已取消 | 已完成 + 取消计数；不宣告成功或失败 |

### 7.4 组件库策略

- 保留现有设计令牌与手写组件；
- 不整体引入 `element-plus` / `naive-ui`；
- 只在复杂表格 / 对话框出现明显自研成本时，按需引入 **Element Plus 单组件**，使用自动导入与主题变量；不引入 Naive UI 全量；
- 布局继续在 `900 × 600` / `1180 × 760` 与 125% 缩放下验证。

---

## 8. 契约 / Schema 需改动点

> 以下全部是设计层变更点；按「先契约后实现」执行，未登记的字段 / 选项不得进入实现。

| 文件 | 变更 | 类型 |
|---|---|---|
| `contract/src/reconcile.ts` | `ReconcileSelectionMode` 增加 `batch`；增加 `ids[]` / `roles[]`；结果增加 `succeeded/failed/cancelled/duration_ms`；保留旧字段 | 加法 |
| `docs/specification/cli-contract.md` | `reconcile` 增加可重复 `--id`、可重复 `--role`；明确与 `--path` / `--classification` / `--root` 的互斥 / 并集；`scan --inventory` 增加只读 `--audit`；不新增指令；`clean` 允许 role / 全选 | 契约 |
| `contract/src/host-inventory.ts` | 新增 audit row / summary / `observed_at` 类型；`targets[]` 期望集合投影 | 加法 |
| `schemas/skill_meta.schema.json` | 新增可选 `compatibility`、`allowed_tools`、`metadata`、`extensions`；保持既有字段 | 加法 |
| `docs/specification/skill-meta-spec.md` | 增加字段语义、类型、冲突优先级、`metadata` / `extensions` 边界 | 规范 |
| `docs/specification/index-format.md` | 明确新增字段是否进入索引；默认只进 `skill_meta`，索引不扩字段 | 规范 |
| `schemas/backup.schema.json` | 新增可选 `compatibility`、`allowed_tools`、`metadata`、`extensions`；旧消费者忽略，不改变既有结构 | 加法 |
| `kernel/core/backup/export.ts` / `import.ts` | 导出时读取中心库 `skill_meta` 的可选字段并做加法写出；导入时保留；不进入索引记录 | 行为 |
| `schemas/host_landings.schema.json` | 不改；审计使用现有账本字段 | 无 |
| `docs/specification/host-landings.spec.md` | 不改账本结构；补审计「期望集合来自 targets[]」的说明 | 规范 |
| `docs/specification/result-and-exit-codes.md` | 不新增问题码；`W-DRIFT-001` 文案 / 时机修正；批量结果字段加法 | 规范 |
| `gui/main/updates/settings.ts` | app 配置增加 `language.mode` / `language.value`；迁移保留更新开关 | 加法 |
| `gui/package.json` | 增加 `vue-i18n`；不增加组件库全量依赖 | 依赖 |
| `gui/renderer/src/i18n/*` | 新增 `en` / `zh-CN` 资源与 `createI18n` | 资源 |
| `gui/renderer/src/components/*` | 盘点多选、批量栏、预览三区块、进度 / 汇总 | 组件 |
| `docs/ui-design.md` | 补充批量 / 双语 / 状态 / 组件库策略 | 设计 |

**明确不改**：`host_landings.yaml` schema 版本、17 条指令数量、八字段结果封装、69 个问题码、退出码、JSON 键名语义。

---

## 9. 验收映射（R1~R19）

| 需求 | 设计落点 | 可失败断言点 |
|---|---|---|
| R1 | 5.1~5.5；adopt normalizer | 官方六字段、metadata author/version、冲突优先级、install 裸 SKILL 拒绝、mcp-server 只读 |
| R2 | 5.3~5.4 | `metadata` 深比较相等；嵌套 custom 不提升；重渲染不丢失 |
| R3 | 5.4 | 未知路径 warning 含完整路径；重复扫描不重复；无法保留时拒绝 |
| R4 | 3.1~3.5 | 多 id / root / role 并集去重；plan 层 flatten；单项异常不中断；共享组回滚 |
| R5 | 7.1~7.2 | 复选框 / 全选范围；clean 整组警告；一次预览一次确认 |
| R6 | 3.7 | 成功 update 无旧 W-DRIFT；后续篡改仍告警；CLI/GUI 一致 |
| R7 | 4.1~4.6 | targets 有 / 账本缺 → missing；undeclared / unmapped / insufficient 不混 missing；跨格式比较 |
| R8 | 1.2 | repair not_distributed 落位；install 重复拒绝；restore 无 host；x- 正例或 skipped |
| R9 | 3.2~3.5 | repair 复用同一 flatten / 执行 / summary；失败继续 |
| R10 | 3.5~3.6；7.3 | 计数守恒；每项原因；GUI 进度与汇总一致 |
| R11 | 3.3~3.6；7.2 | 取消边界；clean 不可回退；共享组整组；重试失败项 |
| R12 | 7.3 | 12 状态互斥；加载不显示空态；部分成功不显示全成功 |
| R13 | 7.1 | 角色分组、状态标签、空根、共享根、1000 条可交互 |
| R14 | 7.2 | 写入 / 账本 / 警告三区块；计数与逐项一致；确认文案 |
| R15 | 7.4 | 900×600 / 1180×760 / 125%；无横向溢出；超阈值文件数 0 |
| R16 | 6.1~6.4 | vue-i18n 资源键一致；无硬编码中文；错误按 code 本地化 |
| R17 | 6.2 | 系统默认 / 手动 / 持久化 / 迁移 / 不写工作区 |
| R18 | 6.4；8 | CLI 输出 / 问题码 / JSON / 退出码不变；GUI 切换不影响内核 |
| R19 | 6.4 | 日期 / 数字按 locale；路径原值；切换不触发写 / 扫描 |

---

## 10. 调研 22 个开放问题的最终取舍

| ID | 开放问题 | 最终取舍 | 设计落点 |
|---|---|---|---|
| D-01 | R1 官方字段表 | 官方六字段；`author/version` 读 metadata；`compatibility` / `allowed-tools` / `metadata` 独立承载 | 1.1 / 5 |
| D-02 | install 是否读裸 SKILL | 不读；install 只消费 `skill_meta`；adopt 归一化 | 1.1.3 |
| D-03 | 新字段承载 | `compatibility`、`allowed_tools`、`metadata`、`extensions` 可选加法 | 5.2 |
| D-04 | 顶层 vs metadata 冲突 | metadata 胜出 + warning；SKILL.md 胜过既有 skill_meta | 1.1.2 / 5.5 |
| D-05 | 未知字段提示级别 | warning 只读保留；不升级为错误；无法保留才拒绝 | 5.4 |
| D-06 | R4 选择器形态 | 新增 batch 模式 + `ids[]` / `roles[]`；plan 层 flatten | 3.1 |
| D-07 | 多选择器组合 | 并集 + physical_key 去重；不隐式扩大 | 3.2 |
| D-08 | clean 整角色 / 全选 | 允许在当前筛选内全选 / 整角色；共享根整组；非 user skipped | 3.3 / 7.1 |
| D-09 | 批量失败策略 | 默认继续；逐项 try/catch；共享组回滚 | 3.4 |
| D-10 | 进度传输 | GUI 一次预览 + 逐 item apply；不新增流式 IPC | 3.6 |
| D-11 | R8 分发通道 | `reconcile repair` 的 `not_distributed`；install/restore 不作为入口 | 1.2 |
| D-12 | 审计期望集合 | `skill_meta.targets[]`；不假定全部宿主 | 4.1 |
| D-13 | 最近观察时间 | 盘点时刻；不新增历史字段；不用 ledger updated_at 冒充 | 4.4 |
| D-14 | 跨格式摘要 | 同 format 比 content_digest；跨 format 比 source_checksum/version/ref | 4.3 |
| D-15 | i18n 方案 | `vue-i18n`；不自建 | 6.1 |
| D-16 | 语言存储 | app `settings.json`；跟随系统 + 手动 + 迁移 | 6.2 |
| D-17 | GUI 错误本地化 | 问题码为键；原始 message 进诊断详情 | 6.3 |
| D-18 | W-DRIFT 处理 | 成功更新后重算；旧快照告警抑制；真实漂移保留 | 3.7 |
| D-19 | frontmatter 解析库 | 复用 `yaml`；不引入 `gray-matter`；如必须用则禁用 JS engine | 5.1 / 8 |
| D-20 | GUI 组件库 | 保持自建；复杂组件再按需 Element Plus 单组件；不引入 Naive UI 全量 | 7.4 |
| D-21 | 外部代码复用 | 借鉴结构；仅小段 MIT 代码二开；不整体 fork CLI | 0 / 8 |
| D-22 | vpm / tools-manager / skill-cli 命名 | 采用可核实代表；`tools-manager` 无法核实则排除；vpm 采用 `cheatcodezky/vibe_package_manager` 作为候选 | 0 / 8 |

---

## 11. 风险、未知与设计前置

1. **审计 target 解析**：`targets[].target` 可能包含工作区目标而非宿主；设计用 `workspace_only` / `unmapped` / `insufficient` 隔离，绝不把无法映射的 target 计入 missing。
2. **批量 GUI 进度**：逐 item apply 会产生多次计划校验；过期项必须标 failed，不得用旧预览直接写。若未来要求内核级流式进度，另立契约。
3. **字段承载名**：`allowed_tools` / `compatibility` / `metadata` / `extensions` 需先进入元数据规范与 schema；未登记前不得写入。
4. **export / import**：新增字段以可选加法进入导出 / 导入，旧消费者忽略；不进入索引记录，不能静默丢失。
5. **i18n 迁移**：`vue-i18n` 只解决框架；约 200+ 行含中文的代码仍需逐项抽键；内核中文 message 需要 code 字典。
6. **组件库**：全量 Element Plus / Naive UI 与现有视觉令牌不兼容，且包体积显著；仅在复杂组件出现时按需引入。
7. **测试预算**：现有 732 项测试是回归基线；新增批量失败、审计状态、i18n 双语的断言应分批加入，不得以删除 / 跳过旧测试换取通过。

**设计前置**：进入计划前需确认 5.2 的字段承载名、8 的契约 / schema 变更顺序，以及 4.1 的 target→host 映射规则。
