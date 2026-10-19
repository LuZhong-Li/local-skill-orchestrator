# M4c 二期盘点动作实施计划（确认后纳管、修复与清理）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 二期盘点动作实施计划 |
| 文档路径 | `docs/plan/m4c-inventory-actions.md` |
| 文档状态 | **评审通过，T0 / T1 已完成；T2 待启动**（2026-10-19） |
| 依据 | [`docs/design/m4c-inventory-actions.md`](../design/m4c-inventory-actions.md)；需求 9.3.8、9.3.7；[`docs/research/m4c-inventory-actions-2026-10-19.md`](../research/m4c-inventory-actions-2026-10-19.md) |
| 基线 | T0 后常规测试 **676 项**（675 通过 + 1 项平台跳过）；`check:arch` 218 文件 / 778 边 / 0 循环；complexity 94；超阈值文件 0 |
| 边界 | 本文不修改代码、契约或 schema；评审批准后才进入 T0 实现 |

---

## 0. 前置裁决

### 0.1 必须拍板

| 编号 | 议题 | 推荐 |
|---|---|---|
| R-01 | 是否新增第 17 条 `reconcile` 指令 | 新增；保持 `scan --inventory` 只读 |
| R-02 | untracked 默认方向 | `adopt` 导入中心库；`track` 只处理已有工作区且内容一致的副本 |
| R-03 | drift 默认方向 | 默认 `repair`（工作区）；`accept` 只接受内容 / 可见性 |
| R-04 | missing 清理 | 默认 `repair`；`forget` 只把确认不存在的记录转 orphaned |
| R-05 | `adopt` 的 workspace target | 显式 `--target` 优先；省略时使用工作区 `default_target`，路径按 `skill_id` 推导；不使用源 host id |
| R-06 | `clean` 的回滚快照 | 已定：操作级临时快照，不新增用户可见 backup 类型；成功后清理 |
| R-07 | 插件宿主动作范围 | 已定：先支持 `track / repair / clean / forget`；`adopt / accept` 后置 |

### 0.2 全局原则

1. 先文档、后契约、再实现；
2. 读路径与写路径严格分离；
3. 默认预览，`--apply` 才写；
4. 不猜来源、不覆盖未选中的内容；
5. 复用现有渲染、checksum、账本、备份、原子写、锁与确认；
6. 每批只做一类动作，失败矩阵与回归门禁一起交付。

---

## 1. 分期总览

| 批次 | 内容 | 写入面 | 前置 | 交付价值 |
|---|---|---|---|---|
| T0 | 契约 / action plan 类型 / 只读预览骨架 | 无 | 评审通过 | 让所有动作共享同一份计划，先不写盘 |
| T1 | `repair`（missing / not_distributed / orphaned-with-workspace）+ `forget` | 宿主副本 + 账本 | T0 | 修复缺失 / 未分发，清理无副本账本 |
| T2 | `adopt` + `track` | 中心库 + 索引 + 账本 | T1、adopt 元数据裁决 | 把未纳管 / 推断副本接入管理 |
| T3 | `accept` + `clean` | 中心库 / 宿主 + 索引 / 账本 | T2 | 支持磁盘→工作区与显式清理 |
| T4 | 共享根整组、插件 x- 宿主、批量选择 | 同 T1~T3 | T1~T3 | 多宿主与第三方宿主一致化 |
| T5 | GUI 动作预览 / 执行 / 刷新 | GUI + 内核动作 | T1~T4 | 从盘点视图进入可确认动作 |
| T6 | 三平台 e2e、失败注入、发布前门禁 | 无新增产品写面 | T1~T5 | 验收与回归收口 |

> 顺序说明：虽然用户最直观的需求是“先 adopt + missing repair”，但 `adopt` 需要先决定元数据、targets、ID 冲突和来源未知规则；T1 先交付复用现有写原语的 `repair / forget`，能把风险最低的闭环跑通，再进入 T2 的 adopt。R-05 已定，T2 不再等待该项裁决。

---

## 2. T0：契约与只读计划（已完成 2026-10-19）

**目标**：把动作变成稳定、可测试、零写入的计划结构。

任务：

1. 评审并定稿命令形态、动作枚举、选择器、默认预览与确认级别；
2. 若采用 `reconcile`，更新 CLI 指令总表（16 → 17）与帮助；
3. 在 `contract/` 定义 `ReconcileAction`、`ReconcilePlan`、`ReconcileItem`、前后分类与写入项；
4. 在 `contract/` 或结果规范登记 `E-RECONCILE-001/002/003`；
5. 实现只读计划生成：从盘点观察、索引与两本账本生成预览，不 import 写 API；
6. 为动作码、互斥、选择器、过期计划、共享根分组写契约测试；
7. 建立动作矩阵测试夹具，覆盖 9.3.8 的全部分类。

验收：

- `scan --inventory` 的静态守卫与动态快照完全不变；
- 预览 JSON 具备 action / selector / before / after / writes / ledger_changes / backups / hosts / warnings；
- 不带 `--apply` 的调用零字节变化；
- 既有 668 项测试与全门禁不回归；T0 新增后为 676 项。

**落地记录**：

| 项 | 结果 |
|---|---|
| 指令与选择器 | 第 17 条 `reconcile` 注册；action / path / id+host / classification / root / target / apply / dry-run 校验完成 |
| 计划类型 | `contract/src/reconcile.ts`：六动作、前后分类、三轴证据、写入、账本变化、共享根事务组与汇总 |
| 只读预览 | 复用 `inventorySnapshotOf` 与 L-4 对账；预览前后工作区与宿主字节不变；`--apply` 返回 `E-RECONCILE-001` |
| update 对齐 | `update --host` 缺失副本返回 `E-PATH-001` 并引导 `reconcile repair`，不再隐式创建 |
| 契约与门槛 | CLI 17 条；问题码 `E-RECONCILE-001/002/003`；`check:arch` 218 文件 / 778 边 / 0 循环；测试 676 项 |

---

## 3. T1：repair 与 forget（已完成 2026-10-19）

**目标**：先交付工作区 → 宿主的安全修复闭环，以及缺失副本的账本清理。

任务：

1. `repair` 支持：
   - `missing`：按工作区记录创建宿主副本；
   - `not_distributed`：首次分发到选中宿主；
   - `orphaned_with_workspace`：重渲染并把记录恢复 active；
   - 工作区可解释的 `drift` / `inferred_drift`；
2. 复用 `adapterFor` / `buildHostChannel` / `renderSourceOf` / `landPlan`；
3. `repair` 不访问网络，不调用 `update` 的来源刷新；
4. 内置账本写入复用 `commitHostLandings`；插件 `x-` 留 T4；
5. `forget` 将确认不存在的 active 记录转为 `orphaned`；
6. 失败注入：备份失败、宿主写失败、账本失败、共享根部分失败、回滚失败；
7. 覆盖未选中路径字节不变与 preview stale 拒绝。

验收：

- missing / not_distributed 修复后为 `managed_consistent`；
- `repair` 前后 `skill_index.yaml`、中心库与未选中宿主字节不变；
- `forget` 不改变磁盘，只改账本；
- 既有 16 指令行为与退出码不变。

**落地记录**：

| 项 | 结果 |
|---|---|
| repair | missing / not_distributed 创建、content / visibility drift 恢复、orphaned 再激活、有基线的 corrupt 路径修复 |
| 重渲染 | 直接读取中心库元文件与内容，经现有 adapter / `runHostLanding` / `landPlan`，不访问网络、不新增渲染实现 |
| 执行 | `--apply` 通过工作区锁、计划签名复查、标准确认；逐项返回 succeeded / failed / skipped |
| stale | 预览后摘要、路径、分类或账本状态变化返回 `E-RECONCILE-002` |
| forget | 仅把 active 账本转 orphaned；验证 `skill_index.yaml` 字节不变、无物理副本写入 |
| 边界 | 共享根 `shared_root_t4`、插件 `plugin_host_t4` 跳过；占用路径失败保持原账本与文件 |
| 测试 | 新增 8 项 T1 e2e；常规 676 → **684 项**（683 通过 + 1 平台跳过） |
| 结构 | 新增 landing visibility / result builder / reconcile candidate 模块均低于 500 行；`check:arch` 222 文件 / 807 边 / 0 循环；complexity 94 |

---

## 4. T2：adopt 与 track

**目标**：让 `untracked` 与 `inferred_consistent` 从“看见”进入真正管理。

任务：

1. `adopt` 从宿主副本读内容，生成 `skill_meta.yaml`；
2. 落实 ID 规则、frontmatter 最小字段、`source: unknown`、target 选择与冲突拒绝；
3. 写中心库、索引、内置账本；插件 x- 的 adopt 暂不开放（见 T4）；
4. `track` 只补账本，不复制内容；
5. 共享根只导入一次；
6. 失败注入：ID 冲突、target 冲突、元数据不合格、索引写失败、账本写失败、回滚失败；
7. 覆盖“adopt 后再次 inventory 不再是 untracked”、“track 不改变工作区与宿主字节”。

验收：

- untracked → `managed_consistent`（content evidence 可为 inferred）；
- inferred_consistent → `managed_consistent`，宿主与工作区字节不变；
- ID / target 冲突不覆盖；
- `adopt` 不猜来源、不修改源宿主副本。

---

## 5. T3：accept 与 clean

**目标**：完成 drift 的双向可解释动作与显式清理。

任务：

1. `accept` 支持 content / visibility；拒绝 source/ref 猜测；
2. 备份工作区 → 复制宿主内容到中心库（保留工作区元文件）→ 更新索引与账本；
3. `clean` 按物理副本组删除宿主副本；有账本转 orphaned，无账本 legacy；
4. 共享根其他活跃消费方存在时拒绝单宿主 clean；
5. `clean` 的临时快照与删除提交顺序；
6. 失败注入每一阶段，验证工作区 / 宿主 / 两本账本回到一致状态。

验收：

- `accept` 后 source/ref 不因宿主内容改变；
- `clean` 不触碰中心库与索引；
- 共享根整组操作只删除一次；
- 不允许裸 `--all` 或 classification + clean 的危险批量。

---

## 6. T4：插件宿主与批量

任务：

1. 将 `track / repair / clean / forget` 接到 `plugin_index.landings`；
2. 插件副本的 content / visibility 证据最多标 `inferred`；
3. 共享根事务组、`--host all`、`--classification + --root/--host` 批量结果逐项返回；
4. 插件包本身不被动作删除；
5. 未启用 / manifest 无效插件宿主的动作返回排除原因；
6. `adopt / accept` 的 x- 支持只有在 R-05 / R-07 评审通过后实现。

---

## 7. T5：GUI 动作入口

任务：

1. 在盘点明细中为可动作分类显示动作入口；
2. 接入统一 `reconcile --json` 预览，不自行推导分类；
3. 预览展示写入路径、宿主、账本、备份、影响面与不可逆提示；
4. 确认后调用 `--apply --yes`；取消零写入；
5. 单条失败保留其余结果并刷新；
6. 空工作区、无动作根状态、undetermined 不显示可执行按钮；
7. GUI 冒烟覆盖共享根、adopt、repair、accept、clean、取消场景。

---

## 8. T6：跨平台与收口

任务：

1. Windows / macOS / Linux fixture：路径、rules、共享根、大小写、symlink；
2. 真实发布物内核闭环：inventory → preview → apply → inventory；
3. slow test / smoke kernel / smoke GUI / check / typecheck / lint / format / build；
4. 生产 GUI 仍只读盘点；动作只在显式预览与确认后发生；
5. 文档同步：需求 9.3.8、CLI 契约、host landings 规范 / schema 变更记录、README、one-summary、CHANGELOG；
6. 不计入版本号决策；发版需另行授权。

---

## 9. 测试矩阵

| 分类 | preview | apply 成功 | apply 拒绝 | 回滚 |
|---|---|---|---|---|
| untracked | adopt 计划 | 工作区 + 账本 | 无效 ID / target 冲突 | 中心库 / 索引 / 账本 |
| inferred_consistent | track 计划 | 仅账本 | 内容不一致 | 账本字节 |
| missing | repair / forget 计划 | 宿主 + 账本 / orphaned | 根不可读 / 计划过期 | landPlan + 账本 |
| drift content | repair / accept 计划 | 双向结果 | source 不明 | 两侧备份 |
| drift visibility | repair / accept 计划 | 账本 / 宿主 | rules 不可切换 | 账本 / 宿主 |
| drift source/version | repair 计划 | 工作区为准 | 宿主方向拒绝 | landPlan + 账本 |
| orphaned 副本在 | repair / clean | active / 删除 | 共享根冲突 | 物理 + 账本 |
| orphaned 副本无 | forget | orphaned | 副本仍存在 | 账本 |
| corrupt / unreadable | repair / clean | 修复 / 删除 | 无可重渲染基线 | 物理 + 账本 |
| not_distributed | repair | 首次创建 | 来源不可用 | landPlan |

---

## 10. 发布前门禁

每个实现批次：

1. 不回归 676 项基线；新增动作测试与快照测试计入回填；
2. `check:arch` 0 违例、0 循环、0 allowlist；
3. complexity / 文件规模 ratchet 不新增超标；
4. `npm test`、`test:slow`、`typecheck`、`lint`、`format:check`、`build`、`smoke:kernel`、`smoke:gui` 全绿；
5. `scan --inventory` 的 M4c-5 只读断言仍全绿；
6. `docs/reviews/` 不动；
7. 动作预览 / apply / 回滚矩阵有真实 CLI e2e，不以单元测试替代全部系统行为。
