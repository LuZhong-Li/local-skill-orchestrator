# M6 批量采纳与审计报告导出设计

| 项目 | 内容 |
|---|---|
| 设计基线 | `docs/requirements.md` 9.3.10 M6（R20–R35） |
| 调研依据 | `docs/research/m6-bulk-adopt-audit-report-2026-10-22.md` |
| 代码基线 | v0.6.0，17 条指令、8 字段结果封装、7 个退出码 |
| 设计状态 | Proposed，等待人工核对后进入实现计划 |
| 实现约束 | 不新增指令；不改 kernel per-item 事务模型；不改变既有 JSON/CLI 契约 |

## 0. 核心设计结论

1. **批量 adopt 不另造事务引擎**：新增模块只负责候选展开、稳定排序、limit/conflict policy 与批量摘要；最终仍生成 `ReconcilePlanItem[]`，由现有 `executeReconcilePlan` 逐 item 执行。
2. **adopt 的正式 CLI 形态是 `reconcile --action adopt --bulk`**，不是 `adopt --bulk`。后者会成为第 18 条指令，违反 R35。
3. **adopt 冲突身份使用 frontmatter `name`**：与现有 `adopt-source` 一致；audit drift 的组键使用 inventory `skill_id`，这样才能检测同名目录内 `name` 字段漂移。这两个“身份”必须在实现里显式分开。
4. **报告渲染是纯函数**：输入 `InventoryAuditData + ReportMeta`，输出 markdown/html/sarif；不读盘、不扫描、不写账本。
5. **SARIF 只输出 sanitized URI**：工作区内优先相对路径；工作区外使用逻辑 URI，不写用户 home 的绝对路径。
6. **GUI 不复制批量执行逻辑**：现有 `HostInventoryView`、`inventory-batch.ts`、`InventoryActionDialog` 继续承担选择、预览、逐项进度与取消；新增组件只做 adopt-specific policy 包装与审计导出。

## 1. 模块划分

### 1.1 Kernel

| 模块 | 职责 | 依赖 / 边界 |
|---|---|---|
| `kernel/dispatch/reconcile/adopt-bulk.ts` | 新增。将 `--bulk` 展开为 adoptable candidates，按 role/limit 过滤并稳定排序，生成 bulk summary；不直接写盘 | 调用现有 candidates/plan；最终执行仍走 `executeReconcilePlan` |
| `kernel/dispatch/reconcile/options.ts` | 扩展 `--bulk/--limit/--rename/--force` 的参数校验与 selection 组装 | 保持 `reconcile` 单一指令 |
| `kernel/dispatch/reconcile/adopt-source.ts` | 在现有单条 adopt 内消费 conflict policy，决定 skip / rename / force | 必须保留备份、临时目录、索引与账本原子回滚 |
| `kernel/dispatch/reconcile/plan.ts` | plan item 记录实际 adopt ID、冲突策略和预期 writes | 不改变 per-item transaction group |
| `kernel/audit/audit-frontmatter.ts` | 新增。读取同一 audit 组的副本 `SKILL.md` frontmatter，比较关键字段与有效 version | 只读；缺字段不伪造值 |
| `kernel/audit/report-render.ts` | 新增。纯函数渲染 markdown/html/sarif | 不访问文件系统；输入已组装好的 audit/report meta |
| `kernel/dispatch/scan/audit-projection.ts` | 在现有 audit row 上补 `drift_subtype` / frontmatter evidence / 分项计数 | 不改变既有 status 语义与 per-target row cardinality |
| `kernel/dispatch/scan/options.ts` | inventory plan 增加 `format/output` | `--format` 仅与 `--inventory --audit` 组合 |
| `kernel/dispatch/scan/inventory.ts` | 产出 audit data，并把 report format 交给 CLI presentation layer | 不把 raw SARIF 塞进 8 字段结果 |
| `kernel/dispatch/parsers/index.ts` | 登记新的重复/取值/布尔选项 | 17 条指令数量不变 |
| `kernel/entry/cli.ts` | 根据 `format` 选择 raw report stdout 或标准 Result output；`--output` 原子写文件 | 错误仍使用既有问题码与非零退出码 |

`adopt-bulk.ts` 只做“选择适配”，不建立 `AdoptBulkExecutor`。现有 `executeReconcilePlan` 已经是逐 item catch、独立状态、汇总与取消边界的事实源。

### 1.2 GUI

| 模块 | 职责 |
|---|---|
| `gui/renderer/src/components/unmanaged/UnmanagedBulkAdoptDialog.vue` | adopt-specific wrapper：补充冲突策略说明、候选摘要和批量结果；复用 `InventoryActionDialog` 的预览/进度/汇总/取消 |
| `gui/renderer/src/components/audit/AuditMatrixView.vue` | **补充遗漏**：展示 skill × host 矩阵、drift subtype、summary 与空/加载/错误态 |
| `gui/renderer/src/components/audit/AuditExportMenu.vue` | markdown/html/sarif 下拉菜单；不自行序列化报告 |
| `gui/main/inventory-export.ts` | 扩展现有保存对话框 IPC：支持报告格式和 kernel `--output` 调用 |
| `gui/renderer/src/components/HostInventoryView.vue` | 增加“副本 / 审计”视图切换；批量 adopt 成功后刷新并切到审计视图 |

现有 `HostInventoryView.load()` 只调用 `scan --inventory`，不会产生 `audit`；M6 必须显式调用 `scan --inventory --audit` 才能渲染矩阵。

## 2. 数据结构变更

### 2.1 Audit row：保留旧 status，增加可选 drift 细节

`InventoryAuditStatus` 已包含 `distributed/missing/drift/visibility_mismatch/undeclared/unmapped/workspace_only/insufficient`，不能替换成只含五项的新枚举；否则旧消费者与 M5 audit 测试会破坏。`contract/src/host-inventory.ts:145-176`

建议加法：

```ts
type DriftSubtype = 'checksum' | 'frontmatter' | 'version';

interface FrontmatterFieldDiff {
  field: 'name' | 'description' | 'license' | 'compatibility' | 'allowed-tools';
  values: {
    host: string;
    role: string;
    value: string | null;
  }[];
}

interface VersionDiff {
  values: {
    host: string;
    role: string;
    version: string | null;
  }[];
}

interface InventoryAuditRow {
  // 现有字段不变
  drift_subtype?: DriftSubtype;
  frontmatter_diffs?: FrontmatterFieldDiff[];
  version_diff?: VersionDiff;
}
```

`status` 仍为 `'drift'`；`drift_subtype` 只在该 status 下出现。`AuditRowType` 若需要用于 GUI，应作为 view-level 派生类型，不进入 8 字段 Result 封装。

### 2.2 Audit summary

现有 `InventoryAuditSummary.drift` 保留，并加法增加：

```ts
interface InventoryAuditSummary {
  // 现有字段不变
  drift_by_subtype?: {
    checksum: number;
    frontmatter: number;
    version: number;
  };
}
```

计数单位是 audit row，不是字段差异条数；一个 row 多个 frontmatter 字段不一致仍只计一次 `frontmatter`。

### 2.3 Report document

```ts
type AuditReportFormat = 'json' | 'markdown' | 'html' | 'sarif';

interface AuditReportMeta {
  generated_at: string;
  tool_version: string;
  workspace: string;       // home 路径已脱敏
  hosts: string[];
  observed_at: string;
  audit_file?: string;     // GUI 文件定位；不参与 SARIF artifactUri
}

interface AuditReportDocument {
  format: AuditReportFormat;
  media_type: 'application/json' | 'text/markdown' | 'text/html' | 'application/sarif+json';
  extension: 'json' | 'md' | 'html' | 'sarif';
  content: string;
}
```

### 2.4 Batch adopt policy

```ts
type AdoptConflictPolicy = 'skip' | 'rename' | 'force';

interface BulkAdoptPolicy {
  enabled: boolean;
  roles?: HostRootRole[];
  limit?: number;
  conflict: AdoptConflictPolicy;
  dry_run: boolean;
}

interface BulkAdoptItem {
  skill_id: string;
  source_path: string;
  host: string;
  role: HostRootRole;
  target_path: string;
  conflict: AdoptPreview['conflict'];
}

type BulkAdoptSelection = BulkAdoptItem[];
```

现有 `ReconcilePlanItem` 只有 `before/writes/ledger_changes`，不足以满足 R21 的“frontmatter 摘要 + 潜在冲突”；T0 增加可选预览字段，T4 填充：

```ts
interface AdoptPreview {
  source_path: string;
  requested_skill_id: string;
  target_skill_id: string;
  description: string;
  version: string | null;
  conflict: 'none' | 'same_content' | 'different_content' | 'target_occupied';
  conflict_policy: AdoptConflictPolicy;
}

interface ReconcilePlanItem {
  // 现有字段不变
  adopt_preview?: AdoptPreview;
}
```

稳定顺序固定为：

1. `skill_id`（display ID，缺失时用 target path）；
2. `host_id`；
3. `root_role`；
4. `physical_key`。

`limit` 在物理 copy 去重后、生成 plan 前生效；输出应包含 `candidates`、`limited`、`planned`、`skipped`、`renamed`。

### 2.5 Frontmatter compare

```ts
interface FrontmatterCompare {
  skill_id: string;
  group_key: string;       // audit: inventory skill_id；adopt: normalized frontmatter name
  field: 'name' | 'description' | 'license' | 'compatibility' | 'allowed-tools';
  values: {
    host: string;
    role: string;
    value: string | null;
  }[];
}
```

同一 host/role 若出现多个副本，具体路径包含在对应 audit row 与冲突上下文中；本比较结构按已确认的 `host/role/value` 形状保持稳定。

## 3. CLI 契约变更

### 3.1 批量 adopt

正式形式：

```text
skill-manager reconcile --action adopt --bulk
  [--role <role>]...
  [--limit <N>]
  [--dry-run]
  [--rename | --force]
  [--apply]
```

规则：

- 仍是既有 `reconcile` 指令；不新增 `adopt` 指令；
- `--bulk` 默认只选 user 角色中的 adoptable candidates；显式传 `--role system|platform|project` 时，这些项进入计划后按 M5 写保护标记 skipped，而不是绕过保护；
- `--role` 保留重复取值能力，角色集合必须包含 `platform`（现有 `HostRootRole` 四值）；
- `--limit` 必须是正整数，且只限制过滤、去重后的候选；
- `--rename` 与 `--force` 互斥；
- 默认预览；`--apply` 才执行；`--dry-run` 与 `--apply` 互斥；
- 批量结果继续使用既有 `ReconcilePlanSummary`，加法字段：

```ts
interface ReconcilePlanSummary {
  // 现有 selected/planned/skipped/destructive/shared_groups 保持
  bulk?: {
    candidates: number;
    limited: number;
    conflict_skipped: number;
    renamed: number;
    forced: number;
  };
}
```

### 3.2 冲突策略

| 条件 | 默认 `skip` | `--rename` | `--force` |
|---|---|---|---|
| workspace 已有同 ID、内容一致 | skipped，提示使用 track | skipped，不复制同内容副本 | skipped；force 只处理内容差异 |
| workspace 已有同 ID、内容不同 | skipped + warning | 选择下一个合法 `-2/-3/...` ID，保留原中心库 | 通过备份与原子替换覆盖同 ID；不得覆盖其他 ID |
| 同 batch 内重复 ID | 第一个按稳定顺序保留，其余 skipped | 后续项按稳定顺序重命名 | 后续项视为内容差异；按 force 规则覆盖或 failed |
| 目标路径被其他 Skill 占用 | skipped/failed | 不得自动改名目标 Skill，标 failed | 不得越权覆盖其他 Skill，标 failed |
| 非 user 角色 | skipped | skipped | skipped；force 不放宽角色写保护 |

`--force` 是破坏性动作，必须触发常规确认；非交互执行还需 `--yes`。共享根受影响时整组使用同一事务。

### 3.3 报告输出

```text
skill-manager scan --inventory --audit --format markdown|html|sarif
  [--output <path>]
```

输出规则：

1. 不传 `--format`：保持现状，输出既有 8 字段 Result；
2. 传 `--format` 且不传 `--output`：stdout 直接输出对应格式的原始报告；
3. 传 `--format --output`：报告原子写入目标文件；stdout 输出既有 Result（`data.report` 为格式、路径、字节数）；
4. `--format` 与 `--json` 互斥，避免 raw SARIF 与 Result 双信封；
5. `--format` 必须与 `--inventory --audit` 同用；`--output` 必须与 `--format` 同用；
6. 错误仍使用既有问题码与非零退出码；报告写文件失败不得留下半文件；
7. CLI 报告文案保持英文，GUI 菜单标签走 i18n；报告不因 GUI locale 改变语义或 schema。

`--output` 是用户显式请求的报告文件写入；审计本身仍不得修改工作区索引、账本或宿主副本。测试必须区分“报告目标文件变化”和“被审计状态零变化”。

## 4. 漂移判定流程

### 4.1 组键与前置条件

audit 阶段以 `InventoryAuditRow.skill_id` 聚合。该值来自工作区 Skill ID / 目录派生 ID，便于发现同目录副本的 `name` 漂移。adopt 阶段另行使用 normalized frontmatter `name` 作为目标 ID；两者不得混用。

只有同一 audit group 有 ≥2 个可读副本时才比较字段。单副本直接返回 `frontmatter_status=not_compared`，不产生 drift。

### 4.2 优先级

沿用 M5 的五态判定，再对 `status=drift` 细分：

1. `checksum_drift`：先按现有 reconcile 内容证据判断。同 format 比较 `content_digest`；跨 format 比较宿主渲染基线 `source_checksum/source_version/source_ref`。
2. `frontmatter_drift`：checksum 一致时，比较 `name/description/license/compatibility/allowed-tools`。出现至少两个不同有效值，或有值/缺失并存时命中。
3. `version_drift`：checksum/frontmatter 一致后，按 `顶层 version → metadata.version → null` 比较。两个以上有效值不同，或有值/缺失并存时命中。
4. 全部 version 均缺失：不设 `drift_subtype`，在 `reasons` 中加 `metadata_incomplete`，报告按 note 展示。
5. 任何副本不可读、frontmatter 损坏或无法形成 ≥2 个可读副本：保留 `insufficient`，不伪造 drift。

一个 row 只记录一个 `drift_subtype`，按上述优先级选择；`frontmatter_diffs` 可保留多个字段证据。

## 5. GUI 组件

### 5.1 未纳管批量采纳

现有 `HostInventoryView` 已维护 checkbox、根级全选与 `availableBatchActions`；只对 user、可执行 adopt 的副本展示选择。`gui/renderer/src/inventory-batch.ts`

复用链路：

1. 未纳管列表选择多个副本 → 批量动作栏显示 Adopt；
2. `UnmanagedBulkAdoptDialog` 包装现有 `InventoryActionDialog`，调用 `reconcile --action adopt`；
3. 预览分三区块展示：写入项（中心库 / skill_meta / target）、账本变更（host_landings / plugin_index）、警告（同名、内容冲突、共享根）；
4. 执行后保留现有逐 item 进度、item 边界取消、失败 stage/reason 与 summary；
5. 若有 succeeded，刷新 inventory 并调用 `scan --inventory --audit`，切到审计矩阵；failed/skipped 结果仍保留在对话框。

### 5.2 审计视图

当前仓库没有独立 audit matrix 组件，且 `HostInventoryView.load()` 只请求 `scan --inventory`。新增 `AuditMatrixView.vue` 作为盘点页内的“副本 / 审计”子视图，不新增顶层导航。

展示层次：

1. 总览卡：declared / distributed / missing / checksum drift / frontmatter drift / version drift / visibility / undeclared / insufficient；
2. skill × host 矩阵：每个 skill 一行，列按 host；空值显示“缺失”而非留白；
3. 按 host 缺失清单与按 skill 的明细；
4. 严重度顺序：`error → warning → note`，同级按 skill_id、host_id、target 稳定排序；
5. 空态、加载态、审计失败态分别可区分。

### 5.3 导出

`AuditExportMenu.vue` 的菜单项：

```text
Markdown  (.md)
HTML      (.html)
SARIF     (.sarif)
```

选择后由渲染层调用主进程保存对话框，主进程再调用现有 KernelBridge：

```text
scan --inventory --audit --format <format> --output <path> --json
```

主进程返回 `{ canceled, path?, error? }`；渲染层显示成功、取消或错误状态。保存文件的序列化与临时文件替换复用并扩展现有 `gui/main/inventory-export.ts`，禁止 renderer 直接拼接文件路径。

## 6. 开放问题取舍表

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | 批量 adopt 账本复用？ | 复用现有 reconcile/host_landings/plugin_index 账本，per-item 事务；不新增批量账本 |
| Q2 | 报告输出？ | CLI stdout 为主；`--output` 原子写文件；GUI 经主进程保存对话框调用 kernel |
| Q3 | 多副本组定义？ | adopt 冲突组按 normalized frontmatter `name`；audit drift 组按 inventory `skill_id`，两者显式分离；R32 的 name 比较因此仍可成立 |
| Q4 | SARIF artifactUri？ | 工作区内用相对 workspace root 的 URI；工作区外使用 `SKILL_MANAGER_AUDIT` 逻辑 URI，不写用户绝对路径 |
| Q5 | HTML 报告交互？ | 纯静态、内联 CSS、无外部 JS/CDN/字体；所有文本做 HTML escape |
| Q6 | 冲突 skip 后批量继续？ | 是；per-item 隔离，继续执行，summary 计入 skipped/failed |

## 7. 设计自审：遗漏与需人工确认

### 7.1 必须在计划前确认

1. **伪指令纠正**：需求里的 `adopt --bulk` 应理解为 `reconcile --action adopt --bulk`，否则会新增第 18 条指令。
2. **Q3 身份冲突**：若 adopt 和 audit 都完全按 frontmatter name 分组，R32 的 `name` 字段永远不可能漂移。本设计采用“adopt 冲突按 name，audit drift 按 inventory skill_id”的双键模型。
3. **role 枚举遗漏**：M6 框架写 `user/system/project`，漏了现有 `platform`。本设计保留四角色，非 user 一律写保护 skipped。
4. **audit 视图缺失**：现有 GUI 没有审计矩阵组件，且未请求 `--audit`；必须增加 `AuditMatrixView.vue` 和 inventory audit 数据加载。
5. **summary 计数缺口**：仅给 row 加 subtype 不能直接满足 R34 的分项计数；`InventoryAuditSummary` 必须增加 `drift_by_subtype`。
6. **报告输出信封**：raw Markdown/HTML/SARIF 不能塞进现有 Result JSON，否则 GitHub 不能直接消费 SARIF；本设计固定 stdout/file 两种 presentation mode。
7. **输出写入边界**：`--output` 是显式文件写入，必须排除“报告目标文件”后仍证明工作区、账本和宿主零变化。

### 7.2 设计阶段已固化

- 单副本不产生 drift；
- version 使用顶层 → metadata → missing 的回退；
- 全部 version 缺失只产生 note 级元数据不完整；
- 默认冲突策略 skip，rename/force 互斥；
- bulk adopt 使用稳定排序和显式 limit；
- GUI 批量操作继续使用 per-item preview/apply 与 item 边界取消；
- HTML 无外部资源；SARIF schema 校验通过。

## 8. 验收映射

| 需求 | 设计落点 | 可失败断言 |
|---|---|---|
| R20 | `HostInventoryView` + 现有 batch selection | user untracked 可多选；非 user checkbox disabled |
| R21 | adopt preview 三区块 | 每项显示 source/target/frontmatter/conflict |
| R22 | `adopt-bulk` + `adopt-source` policy | 默认 skip；rename 稳定；force 受确认/角色/共享根保护 |
| R23 | 现有 `executeReconcilePlan` | 单 item 失败不中止；summary 与逐项 reason 可复核 |
| R24 | `adopt-source` 现有归一化 | 六字段、metadata 提升、extensions 保留 |
| R25 | `HostInventoryView`/`AuditMatrixView` | 有成功项后切 audit；新 row 可见 |
| R26 | `reconcile --action adopt --bulk` | 17 指令不变；role/limit/dry-run 可组合校验 |
| R27–R30 | `report-render.ts` | markdown 分区、HTML 自包含、SARIF schema、元信息脱敏 |
| R31 | `AuditExportMenu` + IPC | 三种格式、保存/取消/失败态 |
| R32 | `audit-frontmatter` | 多副本字段漂移；单副本不报 |
| R33 | 同上 + version fallback | 有值不同/有值-缺失报 drift；全缺失 note |
| R34 | row subtype + summary | 三 subtype 独立计数，报告/GUI 一致 |
| R35 | contract guards | 无 registry、无中央库/symlink、无新宿主/新指令 |

## 9. 边界

- 不修改 M5 的 per-item transaction group 和共享根整组保护；
- 不新增历史审计表；审计数据仍是盘点时刻投影；
- 不新增 registry/远程安装、MCP server、中央库/symlink 或宿主；
- 不让报告渲染器读取文件系统；
- 不让 GUI renderer 直接写用户选择的文件；
- 不把报告格式变化视为 8 字段结果封装变化。
