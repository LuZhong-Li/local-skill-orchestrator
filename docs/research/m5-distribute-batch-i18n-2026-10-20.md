# M6 跨宿主分发与批量治理 + 操作 / 界面 / i18n 技术调研

| 项目 | 内容 |
|---|---|
| 调研日期 | 2026-10-20 |
| 需求基线 | `docs/requirements.md` 9.3.9（讨论稿称 M5；文档中因 9.3.6 已占用 M5，按 M6 登记） |
| 代码基线 | `v0.5.2`；17 条指令；7 份契约规范 / 8 份 JSON Schema；69 个问题码 |
| 测试基线 | 常规套件 732 项（731 通过 + 1 项平台条件跳过）；本次实跑通过 |
| 调研性质 | 只读调研；不实现代码、不定稿 API、不改变契约 |
| 证据标记 | `[代码]` 本项目路径:行；外部仓库用 `repo:path:line`；`[规范]` 本项目契约 / 规范文档；`[研究]` 本项目既有调研；`[官方]` 官方文档 URL；`[实测]` 本次命令或静态测量；`[测试]` 既有测试 |

> **编号说明**：用户提示词中的「9.3.9（M5 …）」在需求文档中按 **M6** 落号，原因是 9.3.6 已经占用 M5，且文档不允许重排既有章节。本文沿用用户给定的文件名 `m5-distribute-batch-i18n-2026-10-20.md`，正文按 M6 描述。

## 0. 先看三个会改变需求前提的结论

1. **R1 的字段表需要修正**：官方 Agent Skills 规范的 frontmatter 只有 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`；`author` / `version` 在官方示例中位于 `metadata` 内，`mcp-server` 不在官方字段表中。`[官方] https://agentskills.io/specification`
2. **R8 的「复用 install / restore」表述不成立**：`install` 对已登记 ID 直接拒绝，`restore` 依赖备份且没有 `--host`；当前最省的新宿主分发路径是既有 `reconcile repair` 的 `not_distributed` 场景。`[代码] kernel/core/lifecycle/install.ts:143-158`；`[代码] kernel/dispatch/reconcile/execute.ts:177-186`
3. **审计的「缺哪个 target」需要一个期望集合定义**：账本只能证明「曾经分发到哪」，不能证明「应该分发到哪」；默认把全部宿主当期望集合会产生大量误报。`[规范] docs/specification/host-landings.spec.md:72-80`

## 0.1 十个问题的结论摘要

| 问题 | 结论 | 主要证据 |
|---|---|---|
| Q1 reconcile 如何接 selection | 当前是单个 `ReconcileSelection`，只有 `path` / `id-host` / `classification` 三种模式；多选需要同时改 contract、options、plan、candidates、execute、CLI 契约与 GUI 状态 | `[代码] contract/src/reconcile.ts:21-45`；`[代码] kernel/dispatch/reconcile/options.ts:258-289`；`[代码] kernel/dispatch/reconcile/plan.ts:80-107` |
| Q2 审计能否直接算 | 账本、索引与盘点结果已经覆盖大部分字段；可直接复用对账分类。缺口是「期望宿主集合」、逐副本观察时间，以及官方 `metadata.version` 的读取 | `[代码] kernel/core/host-landings/index.ts:99-130`；`[代码] kernel/dispatch/scan/reconcile.ts:230-300`；`[代码] kernel/dispatch/scan/aggregate.ts:246-270` |
| Q3 GUI 文案现状 | 没有 i18n 机制；文案分散在 `App.vue`、`host-inventory-presentation.ts`、`inventory-actions.ts`、各盘点组件与设置页；`useKernel.ts` 把时间硬编码为 `zh-CN` | `[代码] gui/renderer/src/App.vue:395-412`；`[代码] gui/renderer/src/host-inventory-presentation.ts:13-42`；`[代码] gui/renderer/src/composables/useKernel.ts:28` |
| Q4 新宿主分发走哪条通道 | `install` 对已登记 ID 直接拒绝；`restore` 依赖备份且没有 `--host`；`enable/disable --host` 只改可见性；最省的是既有 `reconcile repair`，但插件 `x-` 宿主的新目标候选目前不会生成 | `[代码] kernel/core/lifecycle/install.ts:143-158`；`[代码] kernel/core/lifecycle/restore.ts:150-158`；`[代码] kernel/dispatch/reconcile/candidates.ts:202-219`；`[代码] kernel/dispatch/reconcile/execute.ts:177-186` |
| Q5 adopt/install 如何读 frontmatter | `adopt` 读 `SKILL.md`，但只取 `name/description/version/author/license/trigger_keywords`；`install` 根本不读 `SKILL.md`，只接受 `skill_meta.yaml`；`metadata`、`allowed-tools`、`compatibility` 没有进入纳管映射 | `[代码] kernel/dispatch/reconcile/adopt-source.ts:145-192`；`[代码] kernel/core/lifecycle/install.ts:31-45`；`[代码] kernel/dispatch/host/index.ts:35-45` |
| Q6 官方 frontmatter 字段 | 官方字段是 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`；官方示例把 `author` / `version` 放在 `metadata` 内；`mcp-server` 不在官方字段表中 | `[官方] https://agentskills.io/specification`；`[官方] https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx` |
| Q7 i18n 选型 | 直接采用 `vue-i18n` 11.4.16（MIT）：完整构建约 65.7 KB min / 21.4 KB gzip、4 个依赖；可用 runtime-only / 预编译消息压低，最终以 bundle 报告为准。相比自建，迁移成本更低、复数与日期数字能力现成 | `[实测] Bundlephobia / npm`；`[官方] https://vue-i18n.intlify.dev/guide/essentials/started` |
| Q8 批量事务边界 | 现有单副本动作已有备份 / 临时快照 / 账本失败回滚；但 `executeReconcilePlan` 的循环没有对每个 item 做异常隔离，异常逃逸会中断整批；需要执行器级逐项 catch 与取消边界 | `[代码] kernel/dispatch/reconcile/execute.ts:370-404`；`[代码] kernel/dispatch/host/landing-result.ts:226-233`；`[代码] kernel/dispatch/reconcile/clean.ts:343-367` |
| Q9 审计漂移口径 | 应复用 `reconcileHostCopy`；跨格式不能直接比较 `content_digest`，必须按每个宿主的渲染基线比较；跨宿主「同源」应看 `source_checksum` / `source_version` | `[代码] kernel/core/host-landings/reconcile.ts:200-269`；`[代码] kernel/dispatch/scan/reconcile.ts:230-250`；`[规范] docs/specification/host-landings.spec.md:159-179` |
| Q10 i18n 边界 | 指令名、选项名、问题码、JSON 键 / 结构、枚举值、退出码是契约，不翻译；导航、按钮、标签、状态展示、空 / 加载 / 完成态、错误解释与 remedy 是 UI 文案，可翻译。CLI 人类可读提示当前是中文，本次建议保持现状 | `[代码] kernel/dispatch/registry/shared.ts:60-61`；`[代码] gui/renderer/src/components/HostInventoryView.vue:103-130`；`[实测] CLI --help` |

## 0.2 四节结论摘要

1. **现状盘点**：`reconcile` 只有单值 selection，多选要改 contract → options → plan/candidates → execute → CLI/GUI；账本与盘点已能支撑审计，但缺期望宿主集合、观察时间与官方 `metadata.version`；GUI 无 i18n；新宿主分发最省的是 `reconcile repair`；`install` 只读 `skill_meta`，`adopt` 只解析部分 frontmatter。
2. **外部规范**：Agent Skills 官方 6 字段为 `name/description/license/compatibility/metadata/allowed-tools`，`author/version` 在官方示例中位于 `metadata`，`mcp-server` 无官方定义；Vue 3 i18n 直接采用 `vue-i18n`。
3. **现成方案 / 成品代码**：i18n 用 `vue-i18n`；frontmatter 复用已有 `yaml` 2.7.0；批量结果形状借鉴 `agent-skills-manager`，批量 flags / 进度 / 汇总借鉴 `vercel-labs/skills` 与 `agent-skills-cli`，审计维度借鉴 `skill-doctor`；不整体引入 GUI 组件库。
4. **风险与未知**：批量执行器缺逐项异常隔离；审计必须复用 `reconcile` 的漂移口径且不能跨格式直接比 `content_digest`；i18n 只翻译 UI 展示层，CLI / 错误码 / JSON 保持契约不变。

## 1. 调研范围与方法

1. 读取 `kernel/dispatch/reconcile`、`kernel/core/host-landings`、`kernel/dispatch/host`、`kernel/core/lifecycle`、`kernel/core/inventory`、`kernel/core/render`、`gui/renderer/src` 与相关契约 / schema；
2. 运行现有常规测试，确认 732 项基线；本次实际结果为 731 通过 + 1 项平台条件跳过；
3. 查阅 Agent Skills 官方规范、Vue I18n 官方文档、Electron `app.getLocale` 文档与 npm / Bundlephobia 包体积；
4. 只记录事实、候选方案、推荐与风险，不写实现代码，不定稿 CLI / API / schema。

---

## 2. 现状盘点

### 2.1 Q1：reconcile 当前如何接收单个 selection，多选要动哪几层

#### 现状事实

1. **跨层类型只有单选择器**：`ReconcileSelectionMode` 只有 `path` / `id-host` / `classification`；`id`、`host`、`classification` 都是单值，`roots` 是数组，没有 `role` 或 `ids[]`。`[代码] contract/src/reconcile.ts:21-45`
2. **角色信息在计划项上已经存在**：`ReconcilePlanItem.root_roles` 已记录该物理副本被哪些角色消费，GUI 的副本数据也有 `root_role`；缺的是选择器字段与按角色过滤逻辑，不是数据模型。`[代码] contract/src/reconcile.ts:77-98`；`[代码] contract/src/host-inventory.ts:41-59`
3. **参数解析是单值语义**：`selectionOf` 用 `option(args, 'id')`、`option(args, 'host')`、`option(args, 'classification')` 生成选择器；`--path` 不允许与 `--id` / `--host` / `--classification` 混用。`[代码] kernel/dispatch/reconcile/options.ts:258-289`
4. **计划器按模式分支**：`selectCandidates` 调 `selectObservedCandidates`；`path` 按物理键精确匹配，`id-host` 按单个 `id` + host 匹配，`classification` 按分类 + host + roots 匹配。`[代码] kernel/dispatch/reconcile/plan.ts:80-107`
5. **`not_distributed` 只支持 `id-host` 或分类批量**：`notDistributedCandidates` 在 `selection.mode !== 'id-host' && selection.classification !== 'not_distributed'` 时直接返回空；候选根只取内置、非 rules、存在且匹配 host/root 的根。`[代码] kernel/dispatch/reconcile/candidates.ts:202-219, 312-331`
6. **执行器逐项循环但没有批次级异常隔离**：`executeReconcilePlan` 对每个 item 调 `executionOf`，把结果、findings、changes 追加到数组；循环本身没有 `try/catch`。`[代码] kernel/dispatch/reconcile/execute.ts:370-404`
7. **预览与执行共用选择器**：入口先 `buildReconcilePreview`，执行前在锁内重新盘点，使用 `reconcilePlanSignature` 比较 `selection` 和每个 item 的事实；选择器变化会自动进入签名。`[代码] kernel/dispatch/reconcile/index.ts:119-141`；`[代码] kernel/dispatch/reconcile/plan.ts:468-510`
8. **CLI 契约当前只登记单值选择**：语法为 `--path` 或 `--id <标识> --host <宿主|all>` 或 `--classification <分类>` 配合 host/root；没有 `--role`，也没有可重复 `--id`。`[代码] docs/specification/cli-contract.md:697-698`
9. **GUI 只按单个路径预览**：`HostInventoryView.previewAction(nextAction, path)` 只保存一个 `actionPath`；`InventoryActionDialog` 预览和执行都传 `--path <单个路径>`。`[代码] gui/renderer/src/components/HostInventoryView.vue:64-68`；`[代码] gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:91, 114-122`

#### 候选方案

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 扩展选择器对象 | 保留 `mode`，增加 `ids[]`、`roles[]`、`hosts[]`，`roots[]` 继续复用；旧字段保持兼容 | 改动集中，旧调用不受影响，最容易做并集与去重 | 需要明确旧字段与新数组的互斥 / 优先级 |
| B. 新增 `batch` 模式 | 新增 `mode: 'batch'`，只接受选择器集合 | 语义清晰，容易限制危险组合 | 模式分支更多，CLI / GUI / 测试需要同时迁移 |
| C. GUI 逐项调用单副本 | 每个副本单独跑一次 `reconcile` | 内核改动最小 | 失去批次汇总、统一取消、共享根整组与预览一致性；不推荐 |

#### 推荐

推荐 **A**：把选择器从「单值模式」升级为「数组 + 角色」的集合，但保留现有 `path` / `id-host` / `classification` 的兼容语义。多选解析后统一做：

1. 物理键去重；
2. `skill_id` 集合、root 集合、role 集合、host 集合的并集；
3. 生成一个稳定的 `selection_summary`；
4. 计划器只消费归一化后的候选集，不在 GUI 或 execute 各自推导。

CLI 层面需要新增可重复 `--id` 与 `--role`（或等价的已登记选项），并在指令契约中明确它们与 `--path` / `--classification` 的互斥规则。GUI 需要把 `actionPath` 改为选择集合，并让预览对话框接受批量计划。

#### 风险

1. **选择器优先级不清**：`ids[]`、`roots[]`、`roles[]` 同时出现时，是并集还是交集必须有唯一规则；否则同一批选择会因实现路径不同而变化。
2. **破坏性动作放大**：`clean` 若允许整角色 / 全选，容易造成大面积删除；应继续禁止仅按分类批量，并对 `clean` 的全选范围做更严格限制。
3. **共享根重复计数**：多选后同一物理路径可能被多个 host 选中，必须在计划层按物理键去重，而不是在执行层补救。
4. **CLI 选项重复语义**：当前解析器对重复取值选项按参数错误处理；新增可重复 `--id` 必须显式登记为可重复，否则会被错误拒绝。`[代码] docs/specification/cli-contract.md:913-914`
5. **执行器异常逃逸**：即使选择器正确，`executeReconcilePlan` 的循环没有逐项 catch，某个未预期异常会中断整批；这属于 Q8 的独立风险。

#### 待设计裁决

- 采用数组扩展还是新增 `batch` 模式；
- `ids[] + roots[] + roles[]` 的并集 / 交集规则；
- `clean` 是否允许整角色选择，是否只允许逐项或明确根范围；
- CLI 选项拼写与契约版本策略。

### 2.2 Q2：host_landings、content_digest 与一致性审计矩阵

#### 现状事实

1. **账本已有足够的主键与摘要字段**：`host_landings.yaml` 的记录包含 `skill_id`、`source_version`、`source_ref`、`host_id`、`target_path`、`format`、`visibility`、`state`、`origin`、`source_checksum`、`content_digest`、`adapter_ref`、`registry_version`、时间戳。`[规范] docs/specification/host-landings.spec.md:115-134`；`[代码] schemas/host_landings.schema.json:37-122`
2. **摘要算法已有单一来源**：`content_digest` 与 `source_checksum` 复用 `collectHashEntries` / `computeChecksum`，SHA-256，按相对路径字节序累加；`content_digest` 覆盖规范化落位视图，不是工作区原件。`[规范] docs/specification/host-landings.spec.md:159-179`
3. **盘点已输出对账分类**：`scan --inventory` 的 copies / corrupt / missing 都带 `reconciliation`；`missing` 由 active 账本反向枚举，只有在账本存在时才产生。`[代码] kernel/dispatch/scan/reconcile.ts:73-96, 230-250, 320-437`
4. **聚合目前按 host / root，不按 skill 矩阵**：`aggregateInventory` 产出 summary、role、classification_groups 与 hosts → roots → copies/corrupt/missing；没有「一个 skill 在多个 host 的横向矩阵」。`[代码] kernel/dispatch/scan/aggregate.ts:246-270`
5. **审计可用的字段**：`InventoryCopyObservation` 已有 `skill_id`、`version`、`content_digest`、`host_id`、`root_role`、`format`、`visibility`、`consumed_by`；`MissingInventoryCopy` 已有 `skill_id`、`host_id`、`target_path`、对账输出。`[代码] contract/src/host-inventory.ts:41-59, 113-124`
6. **缺口一：期望宿主集合**：账本只知道「曾经分发到哪」，不知道「用户希望它出现在哪些宿主」。把所有已配置宿主都当期望集合会把每个 Skill 都标成大量 `not_distributed`；把 `skill_index.yaml` 的 `targets[]` 当宿主账本则是错的。`[规范] docs/specification/host-landings.spec.md:72-80`
7. **缺口二：逐副本观察时间**：盘点数据没有 `observed_at` / `last_seen_at`；最接近的是账本 `updated_at` 与结果生成时间，但前者不是观察时间。`[代码] contract/src/host-inventory.ts:41-59, 193-209`
8. **缺口三：官方 `metadata.version` 不可见**：盘点与 adopt 只读顶层 `version`；官方规范示例把 `version` 放在 `metadata` 内，因此官方形态的副本可能显示无版本，版本漂移也不可见。`[代码] kernel/core/inventory/discover.ts:199-214`；`[代码] kernel/dispatch/reconcile/adopt-source.ts:145-192`；`[官方] https://agentskills.io/specification`

#### 候选方案

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 纯投影 | 新增一个只读 `auditMatrix` 纯函数，输入 `inventorySnapshotOf` + 两份账本，输出按 skill 分组的宿主矩阵 | 不新增写入、不新增摘要算法、与现有分类完全一致 | 需要定义期望宿主集合与观察时间 |
| B. 扩展 `scan --inventory` | 在现有 `InventoryScanData` 上增加 `audit` 字段 | CLI / GUI 共用同一份数据，不新增命令 | JSON 加法字段需要契约登记；可能让 `scan` 载荷变大 |
| C. 新增审计指令 | 新建独立命令 | 语义清晰 | 违背「不新增指令」的边界，且会复制分类逻辑 |

#### 推荐

推荐 **A + B 的加法形态**：用纯投影生成矩阵，再把结果作为 `scan --inventory` 的可选 `audit` 字段（或 GUI 侧纯投影）暴露；不新增指令、不新增哈希算法、不另立 drift 分类。矩阵至少包含：

| 列 | 来源 | 现状 |
|---|---|---|
| `skill_id` | 索引 / 账本 / 副本 | 有 |
| 工作区版本 | `IndexRecord.version` | 有；但官方 `metadata.version` 需补 |
| 宿主 | 账本 `host_id` + 副本 `host_id` | 有 |
| 宿主版本 | 副本 `version` / 账本 `source_version` | 有；官方 metadata 形态需补 |
| 内容摘要 | 副本 `content_digest` / 账本 `content_digest` | 有；跨格式不可直接比较 |
| 期望目标 | 账本 active 记录 | 有；仅代表「曾分发」 |
| 目标是否存在 | copies / missing | 有 |
| 对账分类 | `reconciliation.classification` | 有 |
| 证据等级 | `reconciliation.evidence` / `authority` | 有 |
| 缺失原因 | `drift_reasons` / `reasons` | 有 |
| 最近观察 | 无 | **缺**；建议增加扫描运行时间或 `observed_at` |

**期望宿主集合的推荐口径**：

1. 默认只以 **账本 active 记录** 作为「曾经声明的宿主目标」，用于计算 `missing`；
2. 用户显式选择一个宿主集合（例如「检查 Claude / Codex / Cursor」）时，才对该集合计算 `not_distributed`；
3. 不默认把注册表中的全部宿主当作每个 Skill 的期望集合，避免把「从未分发」误报成「缺失」；
4. 若产品确实需要持久化的「期望宿主集合」，应新增可选声明字段，而不是复用 `targets[]`。

#### 风险

1. **误报 missing**：没有账本证据时不能把未分发报成缺失；现有 `reconcileHostCopy` 已经区分 `undetermined` / `not_distributed`，审计必须沿用。
2. **跨格式摘要误判**：`content_digest` 是宿主渲染后的规范化落位视图；Claude 的 `SKILL.md`、Cursor 的 `.mdc`、AGENTS.md 片段的摘要天然不同，不能拿它们直接互相比较。
3. **共享根重复**：同一物理路径可能有多条 host 记录，矩阵必须按物理键去重，但保留每个消费宿主视图。
4. **时间语义混淆**：`host_landings.updated_at` 是账本写入时间，不是「上次看到」；审计显示「最近观察」前必须补真实观察时间。

### 2.3 Q3：GUI 现状、文案分布与 i18n 机制

#### 现状事实

1. **没有任何 i18n 依赖或机制**：`gui/package.json` 的运行时依赖只有 `vue`；全仓没有 `vue-i18n`、`@intlify/*`、locale 目录或 `t()` 调用。`[代码] gui/package.json:31-33`；`[实测] rg -n -i "vue-i18n|i18n|locale|translat" gui package.json package-lock.json`
2. **文案分布（静态扫描，含注释）**：`App.vue` 864 行 / 67 行命中 CJK；`host-inventory-presentation.ts` 156 行 / 52 行；`HostInventoryView.vue` 286 行 / 38 行；`DetailDialog.vue` 34 行；`InventoryActionDialog.vue` 357 行 / 28 行；`PluginPanel.vue` 270 行 / 28 行；`InventoryHostGroups.vue` 290 行 / 24 行；`InventoryCopyDetails.vue` 271 行 / 22 行；`SettingsPanel.vue` 135 行 / 13 行。`[实测] Get-ChildItem gui/renderer/src -Recurse ... | rg -n "[\u4e00-\u9fff]"`
3. **文案耦合点**：
   - `App.vue` 的导航、状态栏、空态与各类按钮；`[代码] gui/renderer/src/App.vue:395-412, 603`
   - `host-inventory-presentation.ts` 的角色、分类、根状态、可见性、格式、权威等级标签；`[代码] gui/renderer/src/host-inventory-presentation.ts:13-42, 67-81`
   - `inventory-actions.ts` 的六个动作标签；`[代码] gui/renderer/src/inventory-actions.ts:22-29`
   - `HostInventoryView.vue` 的标题、说明、加载 / 空 / 错误、未纳管清单；`[代码] gui/renderer/src/components/HostInventoryView.vue:99-130, 172-211`
   - `InventoryCopyDetails.vue` 的表头、空态、未解析占位；`[代码] gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue:49-58, 166-168`
   - `InventoryActionDialog.vue` 的预览标题、破坏性提示、写入 / 账本 / 执行结果、按钮；`[代码] gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:146-267`
   - `SettingsPanel.vue` 的配置与更新检查文案；`[代码] gui/renderer/src/components/SettingsPanel.vue:43-93`
   - `DialogShell.vue` 的 `aria-label="关闭"`；`[代码] gui/renderer/src/components/DialogShell.vue:15`
4. **唯一的 locale 硬编码**：`useKernel.record()` 使用 `toLocaleTimeString('zh-CN', { hour12: false })`。`[代码] gui/renderer/src/composables/useKernel.ts:28`
5. **持久化存储只有两个更新开关**：`UpdateSettingsStore` 的 `UpdateSettings` 只有 `periodic_check_enabled` / `instant_check_enabled`，`normalizeSettings` 只保留这两个字段，`set()` 直接重写整份 JSON。直接加 `language` 字段会在下一次写入时被丢弃。`[代码] gui/main/updates/settings.ts:4-12, 19-28, 61-65`
6. **打包语言包已预留中英**：`electron-builder.yml` 只保留 `zh-CN` 与 `en-US`，并注明 Chromium 对不在此列表的系统语言回退到 `en-US`。`[代码] gui/packaging/electron-builder.yml:20-24`
7. **窗口尺寸**：默认 `1180 × 760`，最小 `900 × 600`。`[代码] gui/main/index.ts:60-64`
8. **组件拆分基础可用**：盘点已经拆成 `HostInventoryView`、`InventorySummary`、`InventoryHostGroups`、`InventoryCopyDetails`、`InventoryActionDialog`、`InventoryActionMenu`，适合逐组件替换文案。`[代码] gui/renderer/src/components/HostInventoryView.vue:13-16`
9. **状态呈现不完整**：`HostInventoryView` 有 `loading` / `error` / `data`，但没有单独的「部分结果 / 全部完成」状态；`InventoryActionDialog` 有 `loading` / `executing` / `result`，但没有批次进度、成功 / 失败汇总或执行中取消按钮。`[代码] gui/renderer/src/components/HostInventoryView.vue:23-62, 128-130`；`[代码] gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:29-35, 83-135, 225-241`
10. **现有布局有基础约束**：`DialogShell` 的 `.body` 可滚动、对话框最大高度 84vh；盘点表格容器最大高度 420px；但尚未验证 `900 × 600` 与 125% 缩放下英文长文案是否溢出。`[代码] gui/renderer/src/components/DialogShell.vue:39-74`；`[代码] gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue:179-185`
11. **盘点层次已有部分实现，但没有批量选择**：已有内置 / 第三方宿主分区、角色标签、根状态标签、共享根消费宿主；没有角色折叠、复选框、多选动作栏或三区块预览。`[代码] gui/renderer/src/components/host-inventory/InventoryHostGroups.vue:22-116, 135-165`；`[代码] gui/renderer/src/components/HostInventoryView.vue:98-211`

#### 候选方案

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 轻量自建 | 一个 `i18n` 目录 + `zh-CN.ts` / `en.ts` + 类型化 `t()` + `Intl` | 零新增运行时依赖；键类型可控 | 需要自己实现插值、复数 / 选择规则、缺键检查；与“优先成熟库”原则冲突 |
| B. vue-i18n（推荐） | 使用 `createI18n` / `useI18n`，消息资源集中，内置插值 / 复数 / 日期数字 API | 生态成熟，后续多语言扩展方便；迁移是机械工作 | 11.4.16 完整构建约 21.4 KB gzip、4 个依赖；可用 runtime-only / 预编译压低 |
| C. 混合 | 自建 `t()`，仅在复杂复数 / 格式化时引入 vue-i18n | 兼顾体积与能力 | 两套机制并存，边界不清 |

#### 推荐

推荐 **B：`vue-i18n`**，不自建 i18n 框架；详细选型、体积与迁移成本见 3.2。理由：

1. 插值、复数、缺键回退、日期 / 数字格式化都是现成的，避免在英文复数、占位符、回退上重复踩坑；
2. 当前只有两种语言，但文案分布在 `App.vue`、展示映射、盘点组件与设置页，使用统一资源结构比散落的 `t()` 更容易做键集合检查；
3. 现有设置存储仍是自定义 JSON，`language` 字段的迁移与 i18n 库选择互不冲突；
4. 可以用 `vue-i18n` 的资源结构 + 项目契约测试同时保证「键集合一致」「无硬编码中文」。

建议的模块边界（仅选型，不定稿 API）：

- `gui/renderer/src/i18n/index.ts` 创建 `createI18n` 实例；
- `gui/renderer/src/i18n/messages/zh-CN.ts` 与 `en.ts`；
- 组件用 `useI18n().t`；日期 / 数字用 `i18n-d` / `i18n-n` 或原生 `Intl`；
- `error-text.ts` 以问题码为键映射 `message` / `remedy`；
- 主进程用 `app.getLocale()` 提供系统语言，`settings.json` 持久化 `language`。

#### 风险

1. **内核 message 直接进 GUI**：当前 GUI 多处直接显示 `finding.message` / `item.message`（如 `HostInventoryView.vue:47`、`InventoryActionDialog.vue:237`）。如果只翻译静态模板，英文界面仍会出现中文错误文案；必须按问题码做本地化，原始文案放诊断详情。
2. **设置存储覆盖**：`UpdateSettingsStore.normalizeSettings` 只保留两个字段，新增 `language` 必须同步迁移，否则用户切换更新开关时语言设置会被抹掉。
3. **迁移遗漏**：`aria-label`、`title`、错误拼接、状态标签与空态容易漏翻；需要硬编码中文扫描 + 页面遍历。
4. **中英长度差异**：英文按钮 / 标签更长，现有 900 × 600 最小窗口与表格列宽需要重新做布局验证。
5. **包体积**：完整 `vue-i18n` 约 21.4 KB gzip；预编译插件增加构建配置，最终以 bundle 报告为准。

### 2.4 Q4：install / restore / toggle 与新宿主分发

#### 现状事实

1. **`install` 拒绝重复 ID**：`installFromSource` 在索引中已有同 `id` 时直接返回 `E-CONFLICT-001`，并提示「如需升级用 update，如需替换先卸载」；因此不能用 `install` 对已纳管 Skill 再分发。`[代码] kernel/core/lifecycle/install.ts:143-158`
2. **`install` 还需要来源目录**：`locateMetaFile` 要求来源里存在 `skill_meta.yaml`；它不接受只有 `SKILL.md` 的目录。`[代码] kernel/core/lifecycle/install.ts:31-45`
3. **`install --host` 只在首次安装时追加宿主分发**：安装主体成功后，若给出 `--host` 才调用 `runHostLanding`；它不能绕过重复 ID 拒绝。`[代码] kernel/dispatch/registry/commands/lifecycle.ts:119-150`
4. **`restore` 没有 `--host`**：契约语法只有 `<标识> [--timestamp] [--dry-run] [--yes]`；恢复目标来自 `record.targets`（工作区目标），不是宿主真实根。`[代码] docs/specification/cli-contract.md:656`；`[代码] kernel/core/lifecycle/restore.ts:150-158`
5. **`restore` 会先覆盖中心库，再重分发 `record.targets`**：它依赖备份载体，且失败路径是整体返回，不针对新宿主目标。`[代码] kernel/core/lifecycle/restore.ts:227-276`
6. **`enable/disable --host` 只改可见性**：`runHostToggle` 只改 `SKILL.md` / `SKILL.md.disabled` 或规则文件后缀，不新建副本；`disable` 还明确不改索引状态。`[代码] kernel/dispatch/registry/host-toggle.ts:204-227`；`[代码] docs/specification/cli-contract.md:439, 468`
7. **`update --host` 要求副本已存在**：`runHostLanding` 的 `requireExisting` 会在缺失时返回 `PATH_INVALID`，并提示先走 `reconcile repair`。`[代码] kernel/dispatch/host/index.ts:83-112`；`[代码] kernel/dispatch/registry/commands/mutate.ts:158-169`
8. **`reconcile repair` 已能为内置宿主创建新副本**：`notDistributedRoots` 选择已存在的内置技能根；`notDistributedCandidate` 在目标不存在时生成候选；`repairItem` 调 `runHostLanding`，使用工作区中心库渲染并落位。`[代码] kernel/dispatch/reconcile/candidates.ts:202-219, 238-309`；`[代码] kernel/dispatch/reconcile/execute.ts:177-186`
9. **插件 `x-` 新目标目前缺候选**：`notDistributedRoots` 过滤 `host_group === 'builtin'`，所以没有副本的 `x-` 插件根不会生成 `not_distributed` 候选；`runHostLanding` 本身支持插件 host，但计划器不会把新插件目标送进来。`[代码] kernel/dispatch/reconcile/candidates.ts:206-219`；`[代码] kernel/dispatch/host/channel.ts:91-118`
10. **现有批量分类测试已证明功能失败隔离**：同一次 `reconcile --action adopt --classification untracked --host doubao` 中，1 个成功、1 个失败，成功项不回滚。`[测试] tests/e2e/reconcile-shared-plugin.test.ts:460-492`

#### 候选方案

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 复用 `reconcile repair` | 把「给已纳管 Skill 补新宿主」定义为 `repair` 的一个 `not_distributed` 场景；内置宿主已支持 | **最省**；不新增指令、不重复导入、复用渲染 / 备份 / 账本 |
| B. 给 `install` 增加“只分发已登记 Skill”选项 | 在 `install` 上增加已登记 ID 的分支，跳过中心库复制，直接 `runHostLanding` | 语义容易和「安装」混淆；需要处理重复 ID 拒绝与来源参数 |
| C. 给 `restore` 增加 `--host` | 从备份恢复并分发到宿主 | 需要备份；会覆盖中心库；不是「新目标分发」的最小路径 |
| D. 新增 `distribute` 指令 | 独立分发命令 | 违背 M6 不新增指令的边界 |

#### 推荐

推荐 **A**，并把 R8 的「复用 install / restore」修正为更准确的表述：

> 已纳管 Skill 分发到新宿主目标，优先复用 `reconcile repair` 的 `not_distributed` 场景与 `runHostLanding` 落位通道；不新增指令，不重新导入中心库。

具体边界：

- **内置宿主**：`reconcile repair --id <id> --host <host>` 已能创建缺失副本并写账本；这是当前最省、最一致的路径。
- **插件 `x-` 宿主**：需要把 `notDistributedRoots` 的候选范围扩展到已启用插件根，或在既有指令上增加一个已登记的“分发到 x- 宿主”选项；这属于设计裁决，不是新增 reconcile 写动作。
- **与 `install` 的边界**：`install` 负责「首次把来源纳入中心库」；已纳管 Skill 的新宿主分发不应再走 `install`。
- **与 `restore` 的边界**：`restore` 负责「从备份恢复内容并重分发工作区目标」；它不是新宿主目标分发的主通道。
- **与 `enable/disable` 的边界**：它们只切换已有副本的可见性，不负责创建副本。

#### 风险

1. **语义风险**：`repair` 的名字表达「修复」，用户可能不理解它也能做首次新宿主分发；GUI 文案应显示「分发到新宿主」而不是只显示「修复」。
2. **插件 `x-` 缺口**：如果 R8 要求覆盖插件宿主，必须扩展候选生成；否则只能覆盖内置宿主。
3. **共享根**：新宿主与既有宿主共享物理根时，必须只写一次并同步全部消费宿主账本，不能按 host 重复写。
4. **可见性**：新分发副本的可见性应取工作区记录状态；`repairItem` 已按 `record.status` 推导，需保持。
5. **失败回滚**：`runHostLanding` 已有物理写入 + 账本提交 + rollback；但批量执行器仍需逐项隔离。
6. **测试证据缺口**：现有测试明确覆盖 install/update/enable/disable 的 `--host` 与分类批量，但没有找到专门针对「内置宿主 `not_distributed` repair 首次创建副本」的 e2e；设计阶段应补这条证据，不能只凭代码路径推断。`[测试] tests/e2e/reconcile-*.test.ts`（本次检索未命中 `not_distributed` 专项）

### 2.5 Q5：adopt / install 当前如何读 SKILL.md frontmatter

#### 现状事实

1. **`install` 不读 `SKILL.md`**：`installSkill` 先 `acquireFromPath`，再 `locateMetaFile`；`locateMetaFile` 只找 `skill_meta.yaml`，找不到就报 `PATH_INVALID`。`[代码] kernel/core/lifecycle/install.ts:31-45, 55-124`
2. **`adopt` 读 `SKILL.md`**：`frontmatterIdentity` 调 `readSkillFrontmatter`，要求 `name` 合法、`description` 非空；读取 `version`、`author`、`license`、`trigger_keywords`。`[代码] kernel/dispatch/reconcile/adopt-source.ts:145-192`
3. **`adopt` 合成的元文件只包含上述字段**：`metaOf` 写入 `id`、`name`、`version`、`description`、`author`、`license`、`trigger_keywords`、`status`、`path`、`source: unknown`、`targets`、时间与校验和；没有 `metadata`、`allowed-tools`、`compatibility`、`mcp-server`。`[代码] kernel/dispatch/reconcile/adopt-source.ts:323-353`
4. **`adopt` 保留原 `SKILL.md` 文件但不改写 frontmatter**：`normalizeStaging` 只删除 `skill_meta.yaml`、`.git`、`node_modules`，处理 `.disabled` 重命名；没有重写 `SKILL.md`。`[代码] kernel/dispatch/reconcile/adopt-source.ts:300-321`
5. **盘点只读顶层 `name/description/version`**：`skillFieldsOf` 不读 `metadata`，也不读 `allowed-tools` / `compatibility`；因此官方 `metadata.version` 在盘点视图中不可见。`[代码] kernel/core/inventory/discover.ts:199-214`
6. **渲染层的内部模型已预留更多字段**：`RenderSource` 已有 `compatibility`、`allowed_tools`、`homepage`、`tags`、`extensions`，`metadataMap` 会把 `version/author/homepage/tags` 写入标准 `metadata`，`mapStandardFields` 会输出 `compatibility` 与 `allowed-tools`。`[代码] kernel/core/render/types.ts:14-36`；`[代码] kernel/core/render/fields.ts:64-79, 135-167`
7. **但宿主落位的 `renderSourceOf` 没有填这些字段**：它只从 `skill_meta` 读 `description`、`license`、`version`、`author`，再读 `trigger_keywords` 与 `dependencies`；没有读 `metadata`、`compatibility`、`allowed_tools`、`extensions`。`[代码] kernel/dispatch/host/index.ts:35-45`
8. **官方字段与当前实现不一致**：官方规范见 Q6；当前 `adopt` 把 `author` / `version` 当顶层字段，而官方示例把它们放在 `metadata`；当前完全没有 `compatibility` / `allowed-tools` 的纳管路径。

#### 候选方案

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 单一 frontmatter normalizer | `adopt`、盘点、渲染共用一套「官方字段 + 兼容旧顶层字段」的归一化逻辑 | 一次修正所有入口，避免三套解析 | 需要定义 `metadata` / 旧顶层字段的优先级与冲突提示 |
| B. 只改 `adopt` | 只让 `adopt` 读取官方字段 | 改动最小 | 盘点与后续渲染仍丢字段；install 仍不读 SKILL.md |
| C. 保持现状 | 只做 UI，不碰元数据 | 风险最低 | R1 / R2 / R3 无法验收 |

#### 推荐

推荐 **A**，但分两步：

1. **先定义字段语义**：官方 `name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools`；`author` / `version` 作为 `metadata` 内的官方示例字段；`mcp-server` 作为未确认的宿主扩展，按 R3 只读保留，不声明为官方字段。
2. **再定义承载与优先级**：`skill_meta.yaml` 增加可选承载字段（名称待设计）；`metadata` 原样保留；`allowed-tools` / `compatibility` 直接映射；旧顶层 `author` / `version` 作为兼容输入，若与 `metadata.author` / `metadata.version` 冲突，给出字段级警告并采用明确优先级。

`install` 的边界需要在设计阶段裁决：

- 若 R1 要覆盖 `install`，必须在 `install` 前增加「从 SKILL.md 归一化」的入口，或让 `install` 接受只有 `SKILL.md` 的来源；
- 若 `install` 继续只消费 `skill_meta.yaml`，则 R1 的「install/adopt 正确映射」应改写成「adopt 负责从 SKILL.md 归一化，install 负责消费归一化后的 skill_meta」。

#### 风险

1. **官方 `metadata` 是字符串映射**：官方规范要求 `map<string, string>`；用户要求的 `metadata.custom` 私有嵌套可能是嵌套映射，超出官方 schema。管理端可以原样保存，但渲染到宿主 `SKILL.md` 时必须选择「省略、字符串化或仅保留字符串键」，否则可能被宿主校验拒绝。
2. **顶层与嵌套冲突**：同时存在 `author` 顶层与 `metadata.author` 时，必须有唯一优先级与警告，不能静默覆盖。
3. **`mcp-server` 无官方依据**：当前没有官方 frontmatter 定义；不能把它当标准字段校验，更不能启动 / 连接 MCP 服务。
4. **渲染链路丢失**：即使 `skill_meta` 保存了字段，`renderSourceOf` 不读取就仍会在分发时丢失；这是比 `adopt` 更隐蔽的缺口。
5. **`install` 语义扩张**：让 `install` 直接读 `SKILL.md` 会改变「来源必须是 skill_meta」的既有契约，可能影响已有用户与测试。

---

## 3. 外部规范核实

### 3.1 Q6：Agent Skills 官方 frontmatter 字段表

#### 现状事实

截至 2026-10-20，Agent Skills 官方规范页给出的 frontmatter 字段表为：

| 字段 | 必需 | 约束 / 语义 |
|---|---|---|
| `name` | 是 | 最多 64 字符；小写字母、数字、连字符；不得首尾连字符或连续连字符；必须与父目录名一致 |
| `description` | 是 | 1–1024 字符；非空；描述做什么、何时使用 |
| `license` | 否 | 许可证名称或随包许可证文件引用 |
| `compatibility` | 否 | 最多 500 字符；环境要求（目标产品、系统包、网络等） |
| `metadata` | 否 | 任意字符串键值映射，用于规范外的附加属性 |
| `allowed-tools` | 否 | 空格分隔的预批准工具字符串；实验性 |

来源：`[官方] https://agentskills.io/specification`；`[官方] https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx`（第 25-32 行）；`[官方] https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py`（第 14-22 行）

官方示例把 `author` / `version` 放在 `metadata` 内：

```yaml
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
```

来源：`[官方] https://agentskills.io/specification`（「Example with optional fields」段）；`[官方] https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx`（第 44-55、147-160 行）

**结论**：

1. `author` / `version` **不是**官方顶层字段；官方示例把它们放在 `metadata` 内。
2. `mcp-server` **不在**官方字段表中；官方仓库与官方 validator 的允许字段集合也没有它。`[官方] https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py`（第 14-22 行）
3. `compatibility` 是官方字段，但当前 R1 的字段清单没有列它，需要补入。
4. `allowed-tools` 是官方字段，但类型是空格分隔字符串，且明确标注实验性；不能按数组或任意对象校验。
5. `metadata` 是官方字段，但官方要求字符串键值映射；私有嵌套是管理器扩展，不是官方格式。

本项目既有调研也已经记录「标准 6 字段」与 `metadata.version/author` 的映射关系：`[研究] docs/research/host-mechanisms.md:88, 245-247`。

#### 候选方案

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 按官方字段修正 R1 | 官方字段：`name/description/license/compatibility/metadata/allowed-tools`；`author/version` 读 `metadata`，同时兼容旧顶层；`mcp-server` 作为未确认扩展 | **推荐**；与官方规范一致，也保留对旧夹具的兼容 |
| B. 坚持当前 R1 清单 | 把 `author/version/allowed-tools/mcp-server` 都当官方顶层 | 与官方规范冲突；会把官方 `metadata.author/version` 漏掉，也会把非标准字段误当标准 |
| C. 只支持官方 6 字段 | 拒绝所有顶层 `author/version/mcp-server` | 规范最纯，但会破坏既有兼容与用户已写的 Skill |

#### 推荐

推荐 **A**，并在需求文档中把 R1 改写为：

1. 官方字段按官方规范识别；
2. `author` / `version` 从 `metadata` 读取，同时兼容旧顶层写法；
3. `compatibility` 与 `allowed-tools` 纳入纳管与渲染；
4. `mcp-server` 不属于官方字段，按 R3 的未知非标准字段只读保留，除非后续拿到具体宿主官方依据。

#### 风险

1. **需求与实现同时改**：R1 是需求前提，若不在设计前修正，后续 schema、夹具、契约测试都会围绕错误字段表构建。
2. **兼容性**：现有用户可能已经写顶层 `author` / `version`；不能直接拒绝，应给兼容读取与警告。
3. **嵌套 metadata 的渲染**：官方只接受字符串映射；私有嵌套不能原样写入宿主 `SKILL.md`。

### 3.2 Q7：Vue3 / Electron 桌面 i18n 选型

#### 现状事实

1. `vue-i18n` 最新版本 11.4.16；npm 解包体积约 1.68 MB，Bundlephobia 估算 65.7 KB min / **21.4 KB gzip**，4 个依赖（`@intlify/core-base`、`@intlify/shared`、`@intlify/message-compiler`、`@vue/devtools-api`）。`[实测] npm view vue-i18n version dist.unpackedSize dependencies`；`[实测] https://bundlephobia.com/package/vue-i18n@11.4.16`
2. 官方文档提供 `createI18n`、`useI18n`、`fallbackLocale`、`$t` / `i18n-t` / `i18n-d` / `i18n-n`，并说明 locale 使用 BCP 47 标签，格式化会传给 `Intl` API。`[官方] https://vue-i18n.intlify.dev/guide/essentials/started`
3. Electron 提供 `app.getLocale()` 获取当前应用 locale（Chromium `l10n_util`）；打包时需要携带 `locales` 文件夹。`[官方] https://www.electronjs.org/docs/latest/api/app#appgetlocale`
4. 当前 GUI 只有 Vue 一个运行时依赖，没有 i18n；`electron-builder.yml` 已经只保留 `zh-CN` / `en-US`。`[代码] gui/package.json:31-33`；`[代码] gui/packaging/electron-builder.yml:20-24`
5. 项目已有自定义 `settings.json` 存储，但只保留两个布尔开关；增加语言需要迁移。`[代码] gui/main/updates/settings.ts:4-12, 19-28, 61-65`
6. 同类工具 `xigua-wang/skill-doctor` 也做中英双语，但采用的是 React 侧的 in-repo dictionary，而非 i18n 库；这证明双语界面可行，但其代码是 React/TS，不能直接搬到 Vue，也不符合本轮“优先成熟库、不自建”的方向。`[代码] xigua-wang/skill-doctor:src/App.tsx:71-100, 277-300`；`[代码] xigua-wang/skill-doctor:docs/tech-plan-i18n-language-switch-20260419-session-001.md:27`

#### 候选方案

| 维度 | vue-i18n 11.4.16（推荐） | 轻量自建（不推荐） |
|---|---|---|
| 运行时体积 | 约 21.4 KB gzip | 预计 1–3 KB（仅资源和 `t()`） |
| 依赖 | 4 个包 | 0 |
| 插值 / 复数 | 内置，支持 `$t` / `i18n-t` | 需自己实现；容易在英文复数与占位符上出错 |
| 日期 / 数字 | 内置 `i18n-d` / `i18n-n`，最终走 `Intl` | 直接用 `Intl`，更少抽象 |
| 语言切换 | 成熟 | 一个响应式 `ref` 即可 |
| 键类型 / 缺键检查 | 资源结构 + 项目契约测试 | 需要自建类型、插值、缺键与回退逻辑 |
| 构建优化 | 可用 runtime-only / 预编译消息压低体积 | 无现成优化路径 |
| 迁移成本 | 一次性接入 `createI18n` / `useI18n`，后续新增文案机械 | 初期少，但每加一种语言都要维护框架 |
| 未来扩展 | 多语言 / 复杂消息更合适 | 语言数增长后仍需迁移 |

#### 推荐

推荐 **直接采用 `vue-i18n`**，不自建 i18n 框架：

1. **成熟度**：`createI18n` / `useI18n`、`fallbackLocale`、插值、复数、日期 / 数字组件都是现成的；`xigua-wang/skill-doctor` 的 in-repo dictionary 证明双语可行，但它是 React 实现且需要自己维护消息框架，不能直接复用；
2. **体积可控**：完整构建约 21.4 KB gzip；实际采用 runtime-only / 预编译消息后可按构建结果复核。相比引入 `element-plus` 这类 UI 库，i18n 的体积小一个数量级；
3. **迁移成本低**：把 `App.vue`、`host-inventory-presentation.ts`、`inventory-actions.ts`、`HostInventoryView.vue`、`InventoryActionDialog.vue`、`SettingsPanel.vue` 等处的文案抽到 `zh-CN` / `en` 资源，组件改用 `useI18n().t`；一次性迁移后新增文案是机械工作；
4. **边界清晰**：问题码到 `message` / `remedy` 的业务映射仍由项目维护（这是业务字典，不是 i18n 框架）；`vue-i18n` 只负责键、插值、回退与格式化；
5. **系统语言**：主进程用 `app.getLocale()` 提供系统 locale；手动选择持久化到 `settings.json`；`fallbackLocale: 'en'`。

接入形态建议（不定稿 API）：

- `gui/renderer/src/i18n/index.ts` 创建 i18n 实例；
- `gui/renderer/src/i18n/messages/zh-CN.ts` / `en.ts` 放资源；
- 构建时可用 `@intlify/unplugin-vue-i18n` 预编译消息（MIT，构建期依赖，需评估 Vite 配置复杂度）；
- GUI 错误按问题码查本地字典；未知码回退原始 message；
- 语言选择扩展 `UpdateSettingsStore`，不要另起一套 localStorage。

迁移量基线：`App.vue` 约 67 行 CJK、`host-inventory-presentation.ts` 约 52 行、`HostInventoryView.vue` 约 38 行、`InventoryActionDialog.vue` 约 28 行（均含注释，实际文案键需人工归类），属于可控的一次性迁移。

#### 风险

1. **包体积**：完整构建 21.4 KB gzip；若引入预编译插件，需把构建期与运行期依赖分开核算，最终以 bundle 报告为准。
2. **迁移遗漏**：GUI 当前大量文案在模板与纯展示映射中，容易漏掉 `aria-label`、`title`、错误拼接与状态标签；需要硬编码中文扫描与页面遍历。
3. **内核 message 混合**：`vue-i18n` 不能自动翻译内核返回的中文 message；必须保留按问题码映射的业务字典，原始 message 只进诊断详情。
4. **系统语言回退**：Electron `app.getLocale()` 在打包环境需要正确携带 locale；当前只保留 `zh-CN` / `en-US`，与目标一致，但需要测试。
5. **持久化迁移**：`UpdateSettingsStore` 当前会丢弃未知字段；新增 `language` 时必须同时改 schema 与测试。

---

### 3.3 现成方案 / 成品代码复用（i18n、frontmatter、同类工具、GUI 组件库）

#### A. i18n：直接采用 `vue-i18n`

**现状事实**

- 当前没有 i18n 依赖或机制，文案散落在模板、纯展示映射和错误拼接中。`[代码] gui/renderer/src/App.vue:395-412`；`[代码] gui/renderer/src/host-inventory-presentation.ts:13-42`
- `vue-i18n` 11.4.16（MIT）提供 `createI18n` / `useI18n`、`fallbackLocale`、插值、复数、`i18n-t` / `i18n-d` / `i18n-n`；完整构建约 65.7 KB min / 21.4 KB gzip、4 个依赖。`[官方] https://vue-i18n.intlify.dev/guide/essentials/started`；`[实测] https://bundlephobia.com/package/vue-i18n@11.4.16`
- `@intlify/unplugin-vue-i18n` 11.2.7（MIT）可在构建期预编译消息，用于压低运行期体积；它是构建期工具，不是运行时框架。`[实测] npm view @intlify/unplugin-vue-i18n version license dependencies`
- 同类工具 `xigua-wang/skill-doctor` 采用 in-repo dictionary 做中英双语，但它是 React/TS 实现，不能直接搬到 Vue；这证明双语可行，不代表应在本项目自建框架。`[代码] xigua-wang/skill-doctor:src/App.tsx:71-100, 277-300`

**候选 / 现成方案**

| 方案 | 类型 | 评价 |
|---|---|---|
| `vue-i18n` 11.4.16 | 直接依赖（推荐） | 成熟、MIT、Vue 3 原生集成；插值 / 复数 / 日期数字 / 回退齐全；运行时体积可控 |
| `vue-i18n` + `@intlify/unplugin-vue-i18n` | 直接依赖 + 构建期预编译 | 进一步压低运行期体积；增加 Vite 配置复杂度 |
| 自建字典 + `t()` | 自研（不推荐） | 初期看似轻，但插值、复数、缺键、回退、类型与测试都要自己维护 |

**推荐**

直接采用 **`vue-i18n`**，不自建 i18n 框架。迁移路径：`createI18n` 放在渲染层入口；资源放 `zh-CN` / `en` 两个模块；组件用 `useI18n().t`；日期 / 数字用 `i18n-d` / `i18n-n` 或原生 `Intl`；系统语言来自 `app.getLocale()`；手动选择写入 `settings.json`。若构建体积需要进一步压缩，再启用预编译消息。

**风险**

- 完整构建 21.4 KB gzip；预编译插件会增加构建配置与依赖，需要以实际 bundle 报告复核。
- 迁移量粗估 200+ 行含中文的代码（含注释），具体文案键数需设计阶段盘点；`App.vue`、盘点视图、动作预览、设置页是主要工作面。
- 内核 message 是中文，`vue-i18n` 不会自动翻译；必须保留问题码到 `message` / `remedy` 的业务字典。
- `UpdateSettingsStore` 当前只保留两个字段，新增 `language` 需要迁移，否则切换更新开关会丢失语言。

#### B. SKILL.md frontmatter：复用 `yaml`，不引入 `gray-matter`

**现状事实**

- 当前仓库已经依赖 `yaml` ^2.7.0（**ISC**，宽松许可，已是项目依赖），并通过 `parseYaml` 使用 `uniqueKeys: true`、`merge: false` 严格解析。`[代码] kernel/store/yaml/index.ts:8-21`；`[代码] kernel/package.json:10-14`
- frontmatter 提取目前是「分隔符正则 + `yaml` 解析」；`adopt` 与盘点共用 `readSkillFrontmatter`。`[代码] kernel/core/inventory/discover.ts:143-160`
- `gray-matter` 4.0.3 是 MIT，解包 38,621 bytes，Bundlephobia 约 6.8 KB min / 2.6 KB gzip，但依赖 `js-yaml`、`kind-of`、`section-matter`、`strip-bom-string`；它默认支持 YAML / JSON / JavaScript frontmatter。`[实测] npm view gray-matter version license dist.unpackedSize dependencies`；`[实测] https://bundlephobia.com/package/gray-matter@4.0.3`
- `vercel-labs/skills` 明确没有使用 `gray-matter`，而是用 `yaml` + 极薄的分隔符解析，并在源码注释中说明避开 `gray-matter` 的 `---js` / `---javascript` eval 面。`[代码] vercel-labs/skills:src/frontmatter.ts:1-16`
- 同类工具 `umutbozdag/agent-skills-manager` 确实使用了 `gray-matter`；这说明它在普通 UI 场景可用，但该仓库是 Next.js 应用，不承担本项目内核的严格重复键 / merge / 安全解析约束。`[代码] umutbozdag/agent-skills-manager:package.json`（dependencies 含 `gray-matter`）
- `tcarac/skill-doctor` 使用 `strictyaml` 做官方规范校验，说明「严格 YAML + 字段校验」是同类项目的共同方向。`[代码] tcarac/skill-doctor:src/skill_doctor/validator.py:44-79`

**候选 / 现成方案**

| 方案 | 类型 | 评价 |
|---|---|---|
| 继续使用 `yaml` 2.7.0 + 现有薄提取 | 复用现有成熟库（推荐） | 已是项目依赖；严格键、无 merge；无新增包；只需补字段归一化 |
| `gray-matter` 4.0.3 | 直接依赖（不推荐默认采用） | 生态成熟、MIT、体积小，但多 4 个依赖，默认 JS engine 是额外攻击面；需要显式关闭 |
| 手写 YAML 解析器 | 自研（不推荐） | 重复造轮子，缩进 / 重复键 / 引号 / 锚点边界成本高 |

**推荐**

复用 **`yaml` 2.7.0**（已有成熟库），保留现有分隔符提取与严格解析；把工作放在「frontmatter 归一化 + 官方字段校验 + `skill_meta` 映射」上。这不是自研 YAML 解析器：YAML 解析交给 `yaml`，项目只维护分隔符提取与字段语义。不要为了 frontmatter 引入 `gray-matter`。如果设计阶段确实需要完整的 front-matter 生态（例如 TOML / 多格式），再评估 `gray-matter`，并必须禁用 JavaScript engine。

**风险**

- 官方 `metadata` 是字符串映射；私有嵌套是管理器扩展，不能原样渲染到宿主。
- 顶层 `author/version` 与 `metadata.author/version` 冲突时需要明确优先级。
- `install` 当前只接受 `skill_meta.yaml`；若要让 `install` 直接消费裸 `SKILL.md`，需要改变既有契约。

#### C. 开源同类工具：批量、多 host、漂移检测

**现状事实**

以下仓库均为本次实际访问/浅克隆核实的公开仓库；许可证来自仓库 `LICENSE` 文件。`tools-manager` 没有找到稳定、可核实的同名目标（同名候选 `pipihua666/tools-manager` 的 README 无法访问，返回 404），故不纳入可二开清单；`skill-cli` 同名项目较多，本表以 `Karanjot786/agent-skills-cli` 作为代表。

`vibe-package-manager (vpm)` 的公开可核实候选是 `cheatcodezky/vibe_package_manager`（npm 包 `vibe-pm`，0 star，2026-03 更新）；如果你指的是另一个 vpm 仓库，请提供 URL，本表不猜测同名项目。

许可筛选：下表只纳入 MIT / Apache-2.0；搜索中出现的 AGPL-3.0 项目（如 `nocodevit/hive`）已排除，未进入候选清单。

| 项目 / 仓库 | 许可证 | 批量操作模型 | 多 host / 多 agent | 漂移 / 一致性 | 可借鉴 / 可二开 |
|---|---|---|---|---|---|
| `vercel-labs/skills` | MIT | `--all` = `--skill '*' --agent '*' -y`；`--skill` / `--agent` 多值；`update --all`；批量安装 / 更新有成功 / 失败汇总 | 80+ agent 注册表；项目 / 全局路径；符号链接或复制；共享 `.agents/skills` | lock 文件记录 `source`、`ref`、`skillPath`、`skillFolderHash`、`wellKnownDigest`；更新时比较来源树 / 摘要；不做本地多宿主副本审计 | **借鉴**：agent 注册表、lock schema、批量 flags、逐项结果 / 汇总语义；MIT 可 fork，但它是独立 CLI，不建议整体嵌入 |
| `cheatcodezky/vibe_package_manager`（`vibe-pm`） | MIT | `vibe_package.json` 声明全部依赖；按依赖顺序安装；`target_agents` 逐 agent 同步 | `claude` / `iflow` 两个目标；按目录复制；无共享根 | 无内容摘要 / 漂移；只有 `version` 与 `support_agent` 版本提示；`TODO` 未实现真实 agent 版本比较 | **借鉴**：desired-state 配置与 `target_agents` 数组；**不建议二开**：规模小（0 star、2026-03 更新）、无测试 / 无事务 |
| `umutbozdag/agent-skills-manager` | MIT | `/api/skills/bulk` 对 `skillIds` 逐项 `try/catch`，返回 `{id, success, error}[]`；UI 有批量动作栏 | 11 个工具 / 全局 / 项目 / 插件 / 单文件配置；copy / move / toggle / delete | 无 checksum / drift；以扫描到的路径与来源为事实 | **借鉴**：逐项结果形状、批量动作栏、多来源扫描；**不能直接复用**：Next.js/React，不是 Vue |
| `xigua-wang/skill-doctor` | MIT | 检查 / 审计为主，未发现批量写操作 | 多 agent root 发现、优先级链、冲突 / 重复名 / trigger overlap | 以“优先级赢家 + 冲突链”为核心，不是 content digest 漂移 | **借鉴**：审计维度、优先级 / 冲突展示、双语 UI；**不能直接复用**：React/TS，定位是 inspector 而非管理器 |
| `tcarac/skill-doctor` | Apache-2.0 | GitHub Action 批量校验目录；无安装 / 分发 | 无多 host 写入 | 按官方规范校验 frontmatter、字段、名称 / 目录一致性；无漂移账本 | **借鉴**：官方字段校验规则、错误 / 修复建议、夹具；**不能直接复用**：Python，且不是管理器 |
| `Karanjot786/agent-skills-cli` | MIT | `--all`、`--skill` 多选、批量 install / update；`(3/20)` 进度与 `20 installed, 0 failed` 汇总；并行下载 | 45+ agent adapter 注册表；项目 / 全局目录；lock `~/.skills/skills.lock` | 有 `frozen --verify` / lock 校验与冲突检测；没有本项目式 host ledger / content digest | **借鉴**：批量进度 / 汇总、adapter 注册表、lock 校验；**部分二开**：TS CLI 的 adapter / 结果形状可参考，不建议整库嵌入 |
| `lasoons/AgentSkillsManager` | MIT | 单条安装 / 仓库管理为主，未见批量结果协议 | VS Code 扩展，多 IDE 技能目录 | 无 checksum / drift | **借鉴**：IDE 目标路径映射；不纳入批量/审计核心 |
| `Soul-Brews-Studio/arra-oracle-skills-cli` | MIT | 多 agent 安装 CLI | 12+ agent 安装 | 未发现独立 drift 审计 | **借鉴**：多 agent 安装入口；优先级低于前两项 |

**推荐**

1. **批量执行内核：必自研**。没有现成项目同时满足本项目的「共享根整组原子 + 每副本独立事务 + 账本双源 + `root_role` 隔离 + 可取消」；这些约束来自现有内核，不能直接套用外部 CLI。
2. **批量结果形状：借鉴 `agent-skills-manager`**：`{id, success, error}[]` 的逐项结果 + 批量动作栏，是最接近 R4/R10 的成熟成品形态；其 bulk route 是 MIT，逻辑很短，可作为设计参照。`[代码] agent-skills-manager/app/api/skills/bulk/route.ts:7-54`
3. **批量 flags / 进度 / 汇总：借鉴 `vercel-labs/skills` 与 `agent-skills-cli`**：`--all` / `--skill` / `--agent` 的多值语义、进度计数、成功 / 失败汇总、lock 追踪，可直接映射到 R5/R10。`[代码] vercel-labs/skills:docs/commands.md:69-101`；`[代码] Karanjot786/agent-skills-cli:src/cli/index.ts:228-249`；`[代码] Karanjot786/agent-skills-cli:CHANGELOG.md:103-108`
4. **多 host 注册表：借鉴 `vercel-labs/skills` 的 agent 配置形状**：一个数据驱动的 agent 表 + `detectInstalled` + project/global 路径；本项目已有更强的主机注册表，不建议替换，取其「单条数据 + 路径 + 检测函数」的组织方式即可。`[代码] vercel-labs/skills:src/agents.ts:80-100`
5. **审计维度：借鉴 `xigua-wang/skill-doctor`**：root、precedence、conflict chain、duplicate name、trigger overlap 这些维度可以作为审计 UI 的信息架构参考；本项目已有的 `reconciliation` 分类应作为唯一漂移语义，不另造一套。`[代码] xigua-wang/skill-doctor/src-core/types.ts:76-180`
6. **官方字段校验：借鉴 `tcarac/skill-doctor`**：字段表、名称 / 目录一致性、错误建议与夹具可迁移到本项目测试，但不要引入 Python 运行时。`[代码] tcarac/skill-doctor/src/skill_doctor/validator.py:11-79`

**风险**

- 外部 CLI 的“批量”多是“顺序处理 + 汇总”，不等于本项目要求的「逐副本事务 + 共享根原子 + 账本回滚」；不能把它们的实现当作事务保证。
- `vibe_package_manager` 规模很小且没有摘要 / 漂移，只能借鉴配置模型，不能作为生产依赖。
- `vercel-labs/skills` 的 lock 以来源树 hash 为主，不覆盖本地多宿主副本的 content digest；其 lock schema 只能借鉴字段，不能直接替代 `host_landings`。
- 直接复制外部代码会引入其目录约定、错误模型和依赖树；除非是小段 MIT 代码，否则优先「借鉴结构」而不是 fork。

#### D. GUI 组件库：保持轻量自建，按需借鉴

**现状事实**

- 当前 GUI 是 Vue 3 + 手写 CSS，已有设计令牌、`DialogShell`、盘点分区、表格滚动容器；没有组件库。`[代码] gui/renderer/src/components/DialogShell.vue:1-74`；`[代码] gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue:172-185`
- `App.vue` 已 864 行（含空行），契约测试要求非空行不超过 858；引入组件库并迁移现有样式会进一步扩大改动面。`[实测] Get-Content gui/renderer/src/App.vue`
- `element-plus` 2.14.7（MIT）完整构建约 1.07 MB min / **298 KB gzip**、15 个依赖；`naive-ui` 2.45.3（MIT）完整构建约 2.2 MB min / **521 KB gzip**、18 个依赖。`[实测] npm view element-plus version license dist.unpackedSize dependencies`；`[实测] npm view naive-ui version license dist.unpackedSize dependencies`；`[实测] Bundlephobia`
- 同类工具 `agent-skills-manager` 用 Tailwind 自定义 UI，`xigua-wang/skill-doctor` 用自定义 React UI；它们都没有为了表格 / 对话框引入完整组件库。`[代码] agent-skills-manager/components/BulkActions.tsx`；`[代码] xigua-wang/skill-doctor/src/App.tsx`

**候选 / 现成方案**

| 方案 | 包体积 / 依赖 | 优点 | 代价 |
|---|---|---|---|
| 保持现有轻量自建 | 0 新增 | 视觉一致、无主题迁移、现有 App.vue 规模可控 | 表格 / 弹窗 / 可访问性需要继续手工打磨 |
| `element-plus` 按需引入 | 完整 298 KB gzip；按需更小 | 表格、对话框、复选、进度、表单组件成熟；中文生态好 | 需要主题变量、样式隔离、组件替换与视觉回归 |
| `naive-ui` 按需引入 | 完整 521 KB gzip | 组件完整、TypeScript 体验好 | 体积更大；主题 / 字体 / 交互迁移成本高 |

**推荐**

**不整体引入组件库**，保持现有设计令牌与手写组件；优先借鉴 `agent-skills-manager` 的批量动作栏 / 逐项结果展示，以及 `skill-doctor` 的信息层级。若设计阶段确认某个复杂组件（例如大数据表格、虚拟滚动）自研成本过高，再按需引入 **Element Plus 单组件**，并用 `unplugin-vue-components` / 自动导入避免整库打包；不建议 Naive UI 全量接入。

明确分类：

- **直接用现成**：`vue-i18n`（MIT）、`yaml` ^2.7.0（ISC，已存在）；
- **借鉴结构 / UX**：`vercel-labs/skills` 的 agent registry / batch flags、`agent-skills-manager` 的 bulk result shape、`xigua-wang/skill-doctor` 的审计维度、`tcarac/skill-doctor` 的校验规则；
- **必须自研**：本项目的事务边界、共享根整组、账本双源、`root_role` 隔离、审计矩阵聚合、批量选择器与执行器；
- **不引入**：`gray-matter`（默认 JS engine 风险）、`naive-ui` 全量、`vibe_package_manager` 作为依赖、无法定位的 `tools-manager`。

**风险**

- 组件库会带来视觉重置与 CSS 冲突，破坏现有 900 × 600 / 1180 × 760 的布局基线。
- 全量引入 `element-plus` / `naive-ui` 的 gzip 体积分别约为 `vue-i18n` 的 14× / 24×，与「包体积可控」冲突。
- 外部 UI 的批量栏通常假设“每项独立、失败继续”，不覆盖共享根整组事务；照搬会掩盖本项目的安全边界。

**可二开 / 借鉴清单（含许可）**

| 方案 | 许可 | 建议用法 | 不做什么 |
|---|---|---|---|
| `vue-i18n` | MIT | 直接依赖；中英文资源 + `useI18n` | 不自建 i18n 框架 |
| `yaml` ^2.7.0 | ISC | 复用现有严格解析；补 frontmatter 归一化 | 不引入 `gray-matter` 的 JS engine；若许可证策略只允许 MIT/Apache/BSD，需单独裁决（ISC 为宽松许可） |
| `vercel-labs/skills` | MIT | 借鉴 agent 注册表、`--all` / `--skill` / `--agent` 语义、lock 字段与批量汇总；必要时 fork 小段代码 | 不整体替换本项目内核 |
| `umutbozdag/agent-skills-manager` | MIT | 借鉴 `/api/skills/bulk` 的逐项 `{id, success, error}` 与批量动作栏；可复制小段 MIT 代码 | 不直接搬 Next.js/React UI |
| `xigua-wang/skill-doctor` | MIT | 借鉴 root / precedence / conflict 审计维度与双语信息层级 | 不把只读 inspector 当作执行内核 |
| `tcarac/skill-doctor` | Apache-2.0 | 借鉴官方字段校验规则、错误建议与测试夹具 | 不引入 Python 运行时 |
| `Karanjot786/agent-skills-cli` | MIT | 借鉴批量进度 `(3/20)`、成功 / 失败汇总、adapter 注册表与 lock 校验 | 不整体 fork 其 50+ 命令 CLI |
| `lasoons/AgentSkillsManager` | MIT | 借鉴 IDE 目标路径映射 | 不作为批量 / 审计核心 |
| `Soul-Brews-Studio/arra-oracle-skills-cli` | MIT | 借鉴多 agent 安装入口 | 不引入其运行时 |
| `element-plus` | MIT | 仅在复杂表格 / 对话框时按需引入单组件 | 不全量接入、不替换现有视觉规范 |
| `naive-ui` | MIT | 不推荐；仅作对照 | 不全量接入 |
| `gray-matter` | MIT | 不默认引入；若必须用则禁用 JavaScript engine | 不引入默认多格式解析面 |
| `vibe_package_manager` | MIT | 只借鉴 `vibe_package.json` 的 desired-state 与 `target_agents` 模型 | 不作为依赖或执行引擎 |
| `tools-manager` | 未确认 | 不纳入 | 未找到稳定可核实目标，禁止猜测 |

---

## 4. 风险与未知

### 4.1 Q8：批量操作的事务边界

#### 现状事实

1. **单副本动作有回滚**：
   - `runHostLanding` 在账本提交失败时调用 `rollbackLandWrites`；`commitHostLandings` 把「物理写 + 账本写」视为一个可回滚操作。`[代码] kernel/dispatch/host/landing-result.ts:226-233`；`[代码] kernel/core/host-landings/index.ts:47-71`
   - `clean` 先把物理副本移到同卷临时快照，提交账本后再删除；失败时恢复物理副本与账本。`[代码] kernel/dispatch/reconcile/clean.ts:343-367`
   - `adopt` 有 `rollbackAdopt`，`accept` 在覆盖中心库前创建备份。`[代码] kernel/dispatch/reconcile/adopt.ts:58-150`；`[代码] kernel/dispatch/reconcile/accept.ts:315`
2. **批量执行器逐项循环**：`executeReconcilePlan` 对每个 `planned` item 调 `executionOf`，把结果追加；`skipped` 直接生成 skipped 结果。`[代码] kernel/dispatch/reconcile/execute.ts:370-404`
3. **循环没有逐项 catch**：如果 `executionOf` 抛出未捕获异常，整个 `executeReconcilePlan` 调用会中断，已成功的 items 结果不会返回，后续 items 不会执行。单副本函数大多自己 catch 并返回 failed，但不能假设所有未来动作都如此。
4. **现有测试证明了功能失败隔离**：分类批量中 1 个失败、1 个成功，成功项保留；但这不是任意异常逃逸的证明。`[测试] tests/e2e/reconcile-shared-plugin.test.ts:460-492`
5. **原子写是文件级**：`atomicWriteFile` 保证单文件替换，不是跨文件事务；物理副本与账本之间靠补偿回滚，不是数据库式两阶段提交。`[代码] kernel/store/atomic/index.ts:76`
6. **共享根组是单个计划 item**：`itemOf` 的 `transaction_group` 按 `physical_key` 生成，共享根的多个 host 记录汇入一个 item；因此组内原子性可以通过单 item 的回滚实现。`[代码] kernel/dispatch/reconcile/plan.ts:413-441`

#### 候选方案

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 执行器逐项 catch | 每个 item 包 `try/catch`，异常转 failed result，继续下一个 | **必须**；最小改动即可满足「单副本失败不污染整批」 |
| B. 每项独立进程 | 每个副本启动一个子进程 | 隔离强，但成本高、进度与锁复杂，不适合本产品 |
| C. 引入事务日志 | 写前日志 + 恢复 | 可处理崩溃一致性，但超出本阶段范围 |

#### 推荐

推荐 **A**，并把「事务」明确为：

1. 单副本 / 共享根组是事务边界；
2. 每个边界独立备份、独立提交、独立回滚；
3. 执行器逐项捕获异常并记录 failed result；
4. 取消只阻止后续 item，不试图回滚已成功 item；
5. 崩溃一致性继续依赖现有备份 / 临时快照，不承诺跨进程崩溃恢复。

#### 风险

1. **异常逃逸**：未捕获异常会中断整批并丢失已成功项的结果汇总；这是当前最直接的缺口。
2. **账本锁竞争**：批量逐项写账本会多次加锁；如果锁实现不支持重入或长事务，可能出现等待 / 失败；需要在设计阶段确认锁粒度。
3. **部分写入**：物理副本写成功、账本写失败时，现有 rollback 能恢复；但进程在两者之间崩溃时仍可能留下不一致，需要接受为已知边界或引入日志。
4. **取消语义**：同步执行中没有取消点；要在 item 边界检查取消信号，不能在中途硬杀进程。

### 4.2 Q9：跨宿主一致性审计的漂移判定

#### 现状事实

1. `reconcileHostCopy` 的漂移由五类组成：
   - `visibility_mismatch`：账本 visibility 与观察 visibility 不同；
   - `content_drift`：账本 `content_digest` 与观察 `content_digest` 不同，且不是「工作区渲染基线已变化」；
   - `source_changed`：账本 `source_checksum` 与工作区 `checksum` 不同；
   - `version_mismatch`：账本 `source_version` 与工作区 `version` 不同；
   - `source_ref_mismatch`：账本 `source_ref` 与工作区 `source_ref` 不同。`[代码] kernel/core/host-landings/reconcile.ts:200-269`
2. `render_baseline_changed` 是「内容摘要不同，但工作区重新渲染后的期望摘要正好等于观察摘要」的解释，不作为漂移。`[代码] kernel/core/host-landings/reconcile.ts:227-233`
3. 审计需要的「工作区 vs 宿主」基线不是中心库原始校验和，而是**按目标宿主形态重新渲染后的期望摘要**：`workspaceEvidenceFor` 会调用 `expectedDigestForCopy`。`[代码] kernel/dispatch/scan/reconcile.ts:230-250`
4. `content_digest` 是宿主渲染产物的规范化摘要；不同 format（skill / rules）与不同适配器天然不同，不能直接跨格式比较。`[规范] docs/specification/host-landings.spec.md:171-179`
5. 跨宿主「同源」的稳定依据是 `source_checksum`（中心库内容）与 `source_version` / `source_ref`，不是各宿主渲染后的 `content_digest`。

#### 候选方案

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 复用 reconcile | 审计直接使用 `reconciliation.classification`、`drift_reasons`、`evidence` | **推荐**；一套口径，避免审计与修复结论不一致 |
| B. 另立审计 drift | 审计自己比较中心库 checksum 与宿主 content_digest | 会把渲染差异误判为漂移；不推荐 |
| C. 只比较版本 | 只看 `source_version` | 会漏掉内容改动与可见性漂移 |

#### 推荐

推荐 **A**，并按以下口径输出：

1. **单宿主漂移**：复用 `reconcileHostCopy` 的分类与原因；
2. **工作区基线**：使用按宿主 format 重新渲染后的 `expected_content_digest`，不是中心库原始 checksum；
3. **跨宿主一致性**：
   - 同 format / 同适配器：可以比较 `content_digest`；
   - 不同 format：比较 `source_checksum`、`source_version`、`source_ref`，`content_digest` 只作为各自宿主的内部一致性证据；
4. **缺失**：只对账本 active 记录报 `missing`；无账本证据报 `undetermined` / `not_distributed`；
5. **不新增 drift 分类**，审计只做聚合与展示。

#### 风险

1. **跨格式误判**：把 Claude `SKILL.md` 与 Cursor `.mdc` 的 `content_digest` 直接比较，会把正常格式差异报成漂移。
2. **工作区基线不可计算**：如果中心库原件缺失、适配器失败或插件不可用，`expected_content_digest` 可能缺失；审计必须标 `insufficient`，不能猜。
3. **版本不可比**：官方 `metadata.version` 当前未读取；修复前审计的版本列可能为空或误判。
4. **共享根**：同一物理副本的多个 host 记录共享同一 `content_digest`；审计应按物理键去重，不能按 host 重复计算漂移。

### 4.3 Q10：i18n 范围边界

#### 现状事实

1. **CLI 人类可读提示当前是中文**：`--help`、错误 message、remedy 与确认文案大量中文；问题码、JSON 键、枚举值、退出码是英文契约。`[实测] node kernel/entry/cli.ts --help`；`[代码] kernel/dispatch/registry/shared.ts:60-61`
2. **GUI 直接显示内核 message**：`HostInventoryView` 用 `${item.code}：${item.message}` 拼接错误；`InventoryActionDialog` 直接显示 `finding.message` / `item.message`。`[代码] gui/renderer/src/components/HostInventoryView.vue:45-49`；`[代码] gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:79-81, 237`
3. **GUI 已有中文标签映射**：角色、分类、根状态、可见性、格式、动作标签集中在两个纯展示模块，适合迁移到 locale 资源。`[代码] gui/renderer/src/host-inventory-presentation.ts:13-42, 67-81`；`[代码] gui/renderer/src/inventory-actions.ts:22-29`
4. **日期唯一的 locale 硬编码**：`useKernel` 的 `zh-CN` 时间。`[代码] gui/renderer/src/composables/useKernel.ts:28`

#### 候选方案

| 类别 | 是否翻译 | 说明 |
|---|---|---|
| 指令名 / 选项名 | 否 | CLI 契约，脚本依赖 |
| 问题码（`E-*` / `W-*`） | 否 | 机器契约，不能翻译 |
| JSON 键 / 结构 / 枚举值 | 否 | 机器可解析契约 |
| 退出码 | 否 | 机器契约 |
| 路径 / 哈希 / 宿主 ID | 否 | 事实值，不翻译、不改写 |
| CLI 人类可读 message / remedy | 本次不翻译 | 当前为中文；保持现状，不随 GUI 切换 |
| GUI 导航 / 按钮 / 标签 / 空态 / 加载 / 完成态 | 是 | 面向用户文案 |
| GUI 状态标签 / 角色 / 分类 / 动作名 | 是 | 展示层映射 |
| GUI 错误主文案 / remedy | 是 | 以问题码为键做本地化；原始 message 放诊断详情 |
| 日期 / 数字 / 路径展示 | 本地化格式 | 日期数字用 `Intl`；路径不改写，只做方向 / 换行 / 省略 |

#### 推荐

推荐：

1. **内核 / CLI / JSON 完全不动**：问题码、键名、枚举值、退出码、message / remedy 原样保留；
2. **GUI 以问题码为键**：`E-RECONCILE-001` → 本地化标题 / 说明 / remedy；未知码回退原始 message；
3. **CLI 人类可读输出不纳入本次切换**：保持现状，避免把一次 GUI i18n 扩成 CLI 文案改写；
4. **原始 message 只进诊断详情**：可复制、可展开，不作为主文案；
5. **日期 / 数字用 `Intl`，路径不改写**：路径复制时输出内核原值。

#### 风险

1. **只翻译模板不够**：GUI 目前直接显示内核 message；若不做问题码映射，英文界面仍会出现中文错误。
2. **问题码覆盖不完整**：69 个问题码需要逐个建立文案键；未知码必须有回退，不能空白。
3. **文案漂移**：同一问题码在不同命令下 message 可能不同；GUI 以码为键时，说明要足够通用，不能假设单一上下文。
4. **CLI 与 GUI 语言不一致**：用户可能看到英文 GUI + 中文 CLI 输出；这是本次范围裁决的已知结果，需要在帮助 / 诊断详情中可接受。

---

## 5. 待设计阶段裁决的开放问题清单

| # | 开放问题 | 可选方案 | 推荐 | 影响 |
|---|---|---|---|---|
| D-01 | R1 的官方字段表是否修正 | 按官方 6 字段 + 兼容顶层 author/version；或坚持当前 R1 的 `author/version/allowed-tools/mcp-server` 清单 | 按官方修正，补 `compatibility`，`author/version` 读 `metadata`，`mcp-server` 作未确认扩展 | 决定 schema、夹具、契约测试与渲染 |
| D-02 | `install` 是否直接读 `SKILL.md` | 让 install 读；或保持 install 只消费 `skill_meta`，由 adopt 归一化 | 保持 install 只消费归一化后的 `skill_meta`，除非产品明确要求「从裸 SKILL.md 安装」 | 影响已有安装契约与测试 |
| D-03 | `metadata` / `allowed-tools` / `compatibility` / `mcp-server` 在 `skill_meta` 的承载字段名与类型 | 新增可选字段；或统一放入扩展映射 | 用可选、加法字段；名称与 schema 在设计阶段登记 | 影响 schema 版本与导出兼容 |
| D-04 | 顶层 `author/version` 与 `metadata.author/version` 冲突时的优先级 | 顶层优先；metadata 优先；报错拒绝 | metadata 优先并给字段级警告；顶层作为兼容输入 | 影响纳管结果与用户迁移 |
| D-05 | 非标准嵌套字段的提示级别 | warning 不阻断；strict 下升级为 error；静默保留 | warning 不阻断，strict 可升级；禁止静默丢弃 | 影响 R3 验收与严格模式 |
| D-06 | R4 选择器形态 | 扩展数组；新增 `batch` 模式；GUI 逐项调用 | 扩展数组，保留旧模式兼容 | 影响 CLI 契约、GUI 状态、批量去重 |
| D-07 | 多选择器组合语义 | 并集；交集；显式分组 | 并集 + 物理键去重；危险动作要求更窄范围 | 影响批量范围与安全 |
| D-08 | `clean` 是否允许整角色 / 全选 | 允许；仅逐项；仅明确 root/host | 仅逐项或明确 root/host；不提供跨筛选全选 | 影响破坏性操作安全 |
| D-09 | 批量执行失败策略 | 默认继续；默认停止；可配置 | 默认继续逐项，单项异常转 failed；取消在 item 边界停止 | 影响 R4 / R10 / R11 |
| D-10 | 进度传输方式 | 单次同步返回；GUI 逐项调用；内核事件 / 流式 | 设计阶段在「单计划 + 进度事件」与「GUI 顺序调用」之间裁决；不得伪造进度 | 影响 IPC、取消与汇总一致性 |
| D-11 | R8 新宿主分发通道 | reconcile repair；install 新选项；restore 新选项；新指令 | reconcile repair 优先；x- 插件候选需扩展；不新增指令 | 影响 R8 文案与实现范围 |
| D-12 | 审计的期望宿主集合 | 账本 active；全部配置宿主；显式选择宿主集合；持久化 desired set | 默认账本 active；按用户选择的宿主集合计算 not_distributed | 决定「缺哪个 target」是否可信 |
| D-13 | 审计的最近观察时间 | 增加 scan 运行时间；使用 ledger updated_at；不显示 | 增加扫描运行时间 / 每副本 observed_at；不要拿 updated_at 冒充 | 影响审计矩阵与排序 |
| D-14 | 跨格式摘要比较 | 直接比 content_digest；按 format 分组；用 source_checksum | 同 format 才比 content_digest；跨格式用 source_checksum/version/ref | 决定漂移判定正确性 |
| D-15 | i18n 方案 | vue-i18n；自建；混合 | 直接采用 `vue-i18n`，runtime-only / 预编译消息控制体积 | 影响包体积、测试与维护成本 |
| D-16 | 语言设置存储 | 扩展 `settings.json`；单独 locale 文件；localStorage | 扩展 `settings.json` 并做迁移；不写工作区 | 影响持久化与升级 |
| D-17 | GUI 错误本地化 | 以问题码为键；直接翻译 message；内核返回 message key | 以问题码为键，原始 message 进诊断详情 | 影响双语完整性与契约稳定性 |
| D-18 | `W-DRIFT-001` 处理方式 | 成功更新后抑制；改写文案；两者结合 | 成功更新后基于新状态重算，抑制旧快照告警；真实漂移保留并改写 | 影响 R6 与现有漂移测试 |
| D-19 | frontmatter 解析库 | 现有 `yaml` 2.7.0；`gray-matter`；手写解析 | 复用 `yaml` + 薄提取；不引入 `gray-matter`；如必须用则禁用 JS engine | 影响供应链安全、依赖体积与解析边界 |
| D-20 | GUI 组件库 | 保持自建；Element Plus 按需；Naive UI 全量 | 保持自建；复杂组件再按需引入 Element Plus；不引入 Naive UI 全量 | 影响包体积、视觉一致性与迁移成本 |
| D-21 | 外部代码复用方式 | 直接 fork；复制小段代码；只借鉴结构 | 优先借鉴结构；仅对 MIT 小段代码（如 bulk result shape）做二开；不整体 fork CLI | 影响许可、维护与架构一致性 |
| D-22 | `vpm` / `tools-manager` / `skill-cli` 命名 | 继续寻找同名仓库；用代表项目替代；排除 | 确认 vpm 是否为 `cheatcodezky/vibe_package_manager`；排除无法核实稳定目标的 `tools-manager`；以 `Karanjot786/agent-skills-cli` 代表 `skill-cli` | 影响调研证据与可二开清单 |

---

## 6. 建议的下一步

1. **先修正需求前提**：R1 的官方字段表、R8 的「install / restore」表述、审计的期望宿主集合，建议在进入设计前完成需求回写或明确保留为待裁决。
2. **再做设计**：批量选择器形态、执行器逐项隔离、审计投影、i18n 模块边界、settings 迁移。
3. **最后做计划**：按「契约 / schema → 内核批量骨架 → 审计 → 分发 → GUI 批量与反馈 → i18n → UI 层次与布局 → 三平台验证」拆分，避免把 i18n 与批量写入混在一个批次。

---

## 附录 A：代码证据索引

| 主题 | 路径:行 |
|---|---|
| reconcile 选择器类型 | `contract/src/reconcile.ts:21-45` |
| reconcile 参数解析 | `kernel/dispatch/reconcile/options.ts:258-289` |
| reconcile 计划选择 | `kernel/dispatch/reconcile/plan.ts:80-107, 373-441, 468-510` |
| reconcile 执行循环 | `kernel/dispatch/reconcile/execute.ts:370-404` |
| reconcile 入口与锁 | `kernel/dispatch/reconcile/index.ts:119-141` |
| `not_distributed` 候选 | `kernel/dispatch/reconcile/candidates.ts:202-219, 238-331` |
| 共享根事务组 | `kernel/dispatch/reconcile/plan.ts:413-465` |
| 账本字段 | `docs/specification/host-landings.spec.md:115-134` |
| 摘要算法 | `docs/specification/host-landings.spec.md:159-179` |
| 账本 schema | `schemas/host_landings.schema.json:37-161` |
| 盘点对账 | `kernel/dispatch/scan/reconcile.ts:73-96, 230-300, 320-437` |
| 盘点聚合 | `kernel/dispatch/scan/aggregate.ts:246-270` |
| GUI 导航 | `gui/renderer/src/App.vue:395-412` |
| GUI 时间 locale | `gui/renderer/src/composables/useKernel.ts:28` |
| GUI 盘点视图 | `gui/renderer/src/components/HostInventoryView.vue:64-68, 99-130, 172-220` |
| GUI 动作预览 | `gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:91, 114-122, 146-267` |
| GUI 动作菜单 | `gui/renderer/src/components/host-inventory/InventoryActionMenu.vue:20-35` |
| GUI 标签映射 | `gui/renderer/src/host-inventory-presentation.ts:13-42, 67-81` |
| GUI 动作文案 | `gui/renderer/src/inventory-actions.ts:22-29` |
| GUI 设置存储 | `gui/main/updates/settings.ts:4-12, 19-28, 61-65` |
| 窗口尺寸 | `gui/main/index.ts:60-64` |
| 打包语言包 | `gui/packaging/electron-builder.yml:20-24` |
| install 只读 meta | `kernel/core/lifecycle/install.ts:31-45, 143-158` |
| restore 目标 | `kernel/core/lifecycle/restore.ts:150-158, 227-276` |
| toggle 只改可见性 | `kernel/dispatch/registry/host-toggle.ts:204-227` |
| update --host 要求已有副本 | `kernel/dispatch/host/index.ts:83-112`；`kernel/dispatch/registry/commands/mutate.ts:158-169, 230-253` |
| adopt frontmatter | `kernel/dispatch/reconcile/adopt-source.ts:145-192, 300-353` |
| 盘点 frontmatter | `kernel/core/inventory/discover.ts:143-160, 199-214` |
| 渲染源模型 | `kernel/core/render/types.ts:14-36` |
| 渲染字段映射 | `kernel/core/render/fields.ts:64-79, 135-167` |
| 宿主渲染源 | `kernel/dispatch/host/index.ts:35-45` |
| 账本回滚 | `kernel/dispatch/host/landing-result.ts:226-233`；`kernel/core/host-landings/index.ts:47-71` |
| clean 快照 | `kernel/dispatch/reconcile/clean.ts:343-367` |
| 批量隔离测试 | `tests/e2e/reconcile-shared-plugin.test.ts:460-492` |
| Vercel lock schema | `vercel-labs/skills:src/skill-lock.ts:13-60` |
| Vercel frontmatter | `vercel-labs/skills:src/frontmatter.ts:1-16` |
| Vercel agents | `vercel-labs/skills:src/agents.ts:80-100` |
| Vercel batch docs | `vercel-labs/skills:docs/commands.md:69-101` |
| ASM bulk result | `umutbozdag/agent-skills-manager:app/api/skills/bulk/route.ts:7-54` |
| ASM bulk UI | `umutbozdag/agent-skills-manager:README.md:128-134` |
| xigua audit dimensions | `xigua-wang/skill-doctor:src-core/types.ts:76-180` |
| xigua bilingual UI | `xigua-wang/skill-doctor:src/App.tsx:71-100, 277-300` |
| tcarac validator | `tcarac/skill-doctor:src/skill_doctor/validator.py:11-79` |
| Karanjot batch UX | `Karanjot786/agent-skills-cli:src/cli/index.ts:228-249` |
| vpm target_agents | `cheatcodezky/vibe_package_manager:src/install.js:23-45, 83-87` |

## 附录 B：官方来源

1. Agent Skills 规范：`https://agentskills.io/specification`
2. Agent Skills 规范 Markdown：`https://agentskills.io/specification.md`
3. Agent Skills 官方仓库规范文件：`https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx`
4. Agent Skills 官方 validator 允许字段：`https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py`
5. Agent Skills 官方仓库 README（说明由 Anthropic 最初开发并作为开放标准发布）：`https://github.com/agentskills/agentskills`
6. Vue I18n 官方快速开始：`https://vue-i18n.intlify.dev/guide/essentials/started`
7. Vue I18n 优化（runtime-only / 预编译）：`https://vue-i18n.intlify.dev/guide/advanced/optimization`
8. Vue I18n npm：`https://www.npmjs.com/package/vue-i18n`
9. Vue I18n 包体积：`https://bundlephobia.com/package/vue-i18n@11.4.16`
10. Electron `app.getLocale()`：`https://www.electronjs.org/docs/latest/api/app#appgetlocale`
11. MDN `Intl.DateTimeFormat`：`https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat`
12. `vercel-labs/skills`：`https://github.com/vercel-labs/skills`（MIT）
13. `cheatcodezky/vibe_package_manager`：`https://github.com/cheatcodezky/vibe_package_manager`（MIT）
14. `umutbozdag/agent-skills-manager`：`https://github.com/umutbozdag/agent-skills-manager`（MIT）
15. `xigua-wang/skill-doctor`：`https://github.com/xigua-wang/skill-doctor`（MIT）
16. `tcarac/skill-doctor`：`https://github.com/tcarac/skill-doctor`（Apache-2.0）
17. `Karanjot786/agent-skills-cli`：`https://github.com/Karanjot786/agent-skills-cli`（MIT）
18. `lasoons/AgentSkillsManager`：`https://github.com/lasoons/AgentSkillsManager`（MIT）
19. `Soul-Brews-Studio/arra-oracle-skills-cli`：`https://github.com/Soul-Brews-Studio/arra-oracle-skills-cli`（MIT）
20. `gray-matter`：`https://github.com/jonschlinkert/gray-matter`（MIT）
21. Element Plus：`https://element-plus.org/`；仓库 `https://github.com/element-plus/element-plus`（MIT）
22. Naive UI：`https://www.naiveui.com/`；仓库 `https://github.com/tusen-ai/naive-ui`（MIT）
23. `yaml`（YAML 1.2 解析器，ISC）：`https://eemeli.org/yaml/`

## 附录 C：本次实测命令与结果

| 测量 | 命令 | 结果 |
|---|---|---|
| 常规测试基线 | `npm test` | 732 项；731 通过 + 1 项平台条件跳过；0 失败 |
| GUI 文案命中 | `Get-ChildItem gui/renderer/src -Recurse -Include *.vue,*.ts` + `rg -n "[\u4e00-\u9fff]"` | `App.vue` 67 行、`host-inventory-presentation.ts` 52 行、`HostInventoryView.vue` 38 行（含注释） |
| i18n 依赖 | `rg -n -i "vue-i18n|i18n|locale|translat" gui package.json package-lock.json` | 仅 `useKernel.ts` 的 `zh-CN`、`electron-builder.yml` 的 locale 注释；无 i18n 依赖 |
| vue-i18n 体积 | `npm view vue-i18n version dist.unpackedSize dependencies`；Bundlephobia | 11.4.16；1,680,333 bytes unpacked；65,723 bytes min / 21,395 bytes gzip；4 个依赖 |
| gray-matter 体积 | `npm view gray-matter version license dist.unpackedSize dependencies`；Bundlephobia | 4.0.3；38,621 bytes unpacked；6,770 bytes min / 2,587 bytes gzip；4 个依赖 |
| Element Plus 体积 | `npm view element-plus version license dist.unpackedSize dependencies`；Bundlephobia | 2.14.7；43,966,005 bytes unpacked；1,066,110 bytes min / 298,422 bytes gzip；15 个依赖 |
| Naive UI 体积 | `npm view naive-ui version license dist.unpackedSize dependencies`；Bundlephobia | 2.45.3；51,874,410 bytes unpacked；2,199,719 bytes min / 521,478 bytes gzip；18 个依赖 |
| 仓库许可 | 浅克隆后读取各仓库 `LICENSE` | `vercel-labs/skills` MIT；`vibe_package_manager` MIT；`agent-skills-manager` MIT；`xigua-wang/skill-doctor` MIT；`tcarac/skill-doctor` Apache-2.0；`agent-skills-cli` MIT |
| 官方字段 | `https://agentskills.io/specification` | `name/description/license/compatibility/metadata/allowed-tools`；`author/version` 示例位于 `metadata`；无 `mcp-server` |

