# M4c 二期盘点动作实施计划（确认后纳管、修复与清理）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 二期盘点动作实施计划 |
| 文档路径 | `docs/plan/m4c-inventory-actions.md` |
| 文档状态 | **评审通过，T0 / T1 / T2 / T3 / T4 / T5 / T6 已完成**（2026-10-19） |
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

**落地记录**：

| 项 | 结果 |
|---|---|
| adopt | 从宿主实际内容建立 `skills/<skill_id>`，合成 `source.type: unknown` 元文件；未生成 URL / ref / 本地来源 |
| 元数据 | 元文件通过现有 `validateMetaRecord`；`--target` 只写工作区目标声明，中心库路径按 `skill_id`；目录名与 frontmatter `name` 不一致时以 `name` 为 ID |
| 冲突 | 中心库同 ID 一致引导 `track`、不一致引导 `accept` / `repair`；未登记同名目录拒绝覆盖；工作区目标被其他 Skill 占用时要求显式 `--target` |
| track | 仅接受 `inferred_consistent`，只写内置账本（`origin: adopted`）；索引、中心库与宿主字节不变；drift / untracked 拒绝 |
| 事务 | 中心库使用同卷暂存目录与原子改名；索引或账本失败时恢复索引、移除中心库；来源宿主副本全程只读 |
| 边界 | 共享根 `shared_root_t4`、插件 `plugin_host_t4` 跳过；`accept` / `clean` 仍返回 `E-RECONCILE-001` |
| 测试 | 新增 12 项 T2 e2e；常规 684 → **696 项**（695 通过 + 1 平台跳过） |
| 结构 | `check:arch` 225 文件 / 839 边 / 0 循环；complexity 94；超阈值文件 0 |

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

**落地记录**：

| 项 | 结果 |
|---|---|
| accept content | 宿主内容覆盖中心库，保留工作区 `skill_meta.yaml`；重算 checksum / digests，更新索引与账本，覆盖前写标准备份 |
| accept visibility | 只同步索引 `status` 与账本 `visibility`，不改中心库或宿主内容 |
| source 边界 | `source_changed` / `version_mismatch` / `source_ref_mismatch` 拒绝 accept，引导 repair；不改 source 声明 |
| clean | 无工作区 orphaned 残留、无基线 corrupt/unreadable；同卷临时快照移走 → 账本提交 → 删除；成功无快照，失败恢复物理副本与账本 |
| 安全 | clean 禁止仅按 `--classification` 批量，必须精确 path 或 id+host；未纳管副本不被 clean |
| 边界 | 共享根 `shared_root_t4`、插件 `plugin_host_t4` 跳过 |
| 测试 | 新增 7 项 T3 e2e（含备份失败、账本失败、删除失败注入）；常规 696 → **703 项**（702 通过 + 1 平台跳过） |
| 结构 | `check:arch` 228 文件 / 864 边 / 0 循环；complexity 94；超阈值文件 0 |

---

## 6. T4：插件宿主与批量

任务：

1. 将 `track / repair / clean / forget` 接到 `plugin_index.landings`；
2. 插件副本的 content / visibility 证据最多标 `inferred`；
3. 共享根事务组、`--host all`、`--classification + --root/--host` 批量结果逐项返回；
4. 插件包本身不被动作删除；
5. 未启用 / manifest 无效插件宿主的动作返回排除原因；
6. `adopt / accept` 的 x- 支持只有在 R-05 / R-07 评审通过后实现。

**落地记录**：

| 项 | 结果 |
|---|---|
| 共享根 | realpath + casefold 事务组；repair/accept 一次物理写、全部 active 账本同步；adopt 一份中心库；track 全部消费宿主补账 |
| 引用计数 | forget 单宿主只转选中记录；clean 有 active 消费时只清选中 orphaned 账本，全部 orphaned 才删物理 |
| 冲突 | 同路径不同 form / 内置与插件账本冲突分别以 `shared_root_form_conflict` / `shared_root_ledger_conflict` 跳过，不任选 |
| 插件 x- | track/repair/clean/forget 写 `plugin_index.landings`；repair 复用插件 profile/adapter；禁用后的 orphaned 副本可从插件账本发现并 clean；插件包保留 |
| 隔离 | 内置动作不写 plugin_index，插件动作不写 host_landings；adopt/accept 对 x- 明确拒绝 |
| 批量 | classification 必须 host/root；逐项结果，单副本失败不回滚成功项；共享组内原子 |
| 测试 | 新增 8 项 T4（7 e2e + 1 单元）；常规 703 → **711 项**（710 通过 + 1 平台跳过） |
| 结构 | `check:arch` 232 文件 / 896 边 / 0 循环；complexity 94；超阈值文件 0 |

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

**落地记录**：

| 项 | 结果 |
|---|---|
| 入口 | 普通 / 损坏 / 缺失明细按副本显示动作；未纳管、缺失、漂移、孤儿、损坏与 not_distributed 可进入；managed 与 undetermined 无按钮 |
| 预览 | 对话框挂载即只读生成计划；自持预览 / 执行状态，展示写入、账本变化、备份、共享根全部消费宿主与执行后分类 |
| 确认 | 仅显式确认发 `--apply --yes`；accept / clean 二次确认；取消零写入；无批量写入口 |
| 插件 | x- 宿主禁用 adopt / accept；repair 只写 plugin_index |
| 刷新 | 执行后重新盘点；逐项 succeeded / failed / skipped 与问题码保留可读 |
| 测试 | 新增 3 项动作映射单元与 21 项界面冒烟；常规 711 → **714 项**（713 通过 + 1 平台跳过）；`smoke:gui` **61/61** |
| 结构 | 依赖图 236 源文件 / 905 边 / 0 循环；complexity 94；超阈值文件 0；App.vue 785 行 |

---

## 8. T6：跨平台与收口

任务：

1. Windows / macOS / Linux fixture：路径、rules、共享根、大小写、symlink；
2. 真实发布物内核闭环：inventory → preview → apply → inventory；
3. slow test / smoke kernel / smoke GUI / check / typecheck / lint / format / build；
4. 生产 GUI 仍只读盘点；动作只在显式预览与确认后发生；
5. 文档同步：需求 9.3.8、CLI 契约、host landings 规范 / schema 变更记录、README、one-summary、CHANGELOG；
6. 不计入版本号决策；发版需另行授权。

**落地记录**：

| 项 | 结果 |
|---|---|
| 三平台写探针 | `scripts/probe-reconcile-actions.mjs` + `probe-reconcile-plugin.mjs`；verify `reconcile-probe` job 在 `ubuntu-24.04 / windows-latest / macos-15` 运行；87 项断言；CI [39264446848](https://github.com/LuZhong-Li/skill-manager/actions/runs/39264446848) 三平台全 Success |
| 覆盖 | 六动作预览零写入 → apply → 分类更新；共享根整组；插件 x- repair/track/forget/clean 与 adopt/accept 拒绝；分类批量；POSIX symlink；目标占用失败隔离 |
| 失败矩阵 | 新增 track / forget 账本损坏、accept 计划过期、accept 账本失败回滚 4 项 e2e；既有 repair 占用、clean 删除/账本失败、共享组账本失败保留 |
| EPERM | T5 一次观察到 Windows 临时目录 `renameSync` 瞬时 EPERM，未能稳定复现；触发条件为安全软件 / 索引服务短暂持有目录。按稳定风险处理：目录级换名统一走 `renameWithRetry`（5 次，10/20/30/40ms 线性退避，识别 EPERM/EACCES/EBUSY）；静态守卫确保 kernel 只有 `store/atomic` 直接调用 `renameSync` |
| 版本 | 0.5.0 发版候选；三处 package.json、`TOOL_VERSION`、CHANGELOG 顶部段一致；未打 tag / 未发布 |
| 测试 | 常规 714 → **726 项**（725 通过 + 1 平台跳过）；`smoke:gui` 61/61；写探针 87 项 |
| 结构 | 依赖图 238 源文件 + 1 资产节点 / 913 边 / 0 循环；complexity 94；超阈值文件 0 |

**9.3.8 验收映射**：

| 需求 | 结论 | 主要证据 |
|---|---|---|
| M4c2-R1 只读盘点与动作入口分离 | 通过 | `scan --inventory` 只读守卫（M4c-5 4 项快照/静态审计）；动作仅经 `reconcile` |
| M4c2-R2 分类到动作确定性映射 | 通过 | `gui/renderer/src/inventory-actions.ts`、`kernel/dispatch/reconcile/plan.ts` ACTION_RULES、`tests/unit/inventory-actions.test.ts` |
| M4c2-R3 预览、显式执行与确认 | 通过 | `tests/e2e/reconcile-preview.test.ts`、`reconcile-failure-matrix.test.ts`、GUI 61/61 冒烟 |
| M4c2-R4 工作区 → 宿主修复 | 通过 | `tests/e2e/reconcile-repair.test.ts`、写探针 repair 段 |
| M4c2-R5 宿主 → 工作区采纳与接回 | 通过 | `tests/e2e/reconcile-adopt-track.test.ts`、`reconcile-accept-clean.test.ts`、写探针 adopt/track/accept 段 |
| M4c2-R6 账本孤儿与缺失记录清理 | 通过 | forget/clean e2e、共享根引用计数、`reconcile-failure-matrix.test.ts` |
| M4c2-R7 共享根、多宿主与未选中对象隔离 | 通过 | `tests/e2e/reconcile-shared-plugin.test.ts`、写探针 shared root 段 |
| M4c2-R8 CLI、结果封装与契约 | 通过 | `tests/unit/reconcile-options.test.ts`、CLI 契约 4.17、八字段结果、写探针 JSON 断言 |
| M4c2-R9 GUI 动作入口 | 通过 | `InventoryActionDialog.vue`、`tests/contract/inventory-ui.test.ts`、`smoke:gui` 61/61 |
| M4c2-R10 兼容、错误与范围边界 | 通过 | 错误码矩阵、`rename-single-source.test.ts`、无自动删除/全修测试、版本守卫 |

**发布后修复（v0.5.1 已发布）**：

- v0.5.0 Release Verify 的 macOS C 组在六动作全部通过后，发现 `scan --inventory --json` 约 64KB 处截断；根因是 SEA 入口 `kernel/entry/exe.ts` 仍用 `process.exit(code)`。
- v0.5.1 改为 `process.exitCode`，与 `cli.ts` 一致；新增三平台 `sea-pipe-probe`（SEA 内核六动作 + 只读盘点 + 300 副本大 JSON 管道）与 `kernel/`/`gui/` 无 `process.exit(` 静态守卫。GUI 动作冒烟增加按钮就绪等待。
- 发布：tag `v0.5.1` → `433b3e4`；Pack [39272915140](https://github.com/LuZhong-Li/skill-manager/actions/runs/39272915140) 与 Release Verify [39275887751](https://github.com/LuZhong-Li/skill-manager/actions/runs/39275887751) 全 Success；Windows GUI 61/61，三平台发布物内核 `actions=6 / pipe_copies=302 / ~1.03MB`。
- 常规测试 727 项（726 通过 + 1 平台跳过）。

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
