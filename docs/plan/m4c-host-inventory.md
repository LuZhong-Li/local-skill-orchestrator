# M4c 宿主盘点实施计划（账本前置 → 宿主扩展点 → CLI/GUI）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 宿主盘点实施计划 |
| 文档路径 | `docs/plan/m4c-host-inventory.md` |
| 文档状态 | **执行中**（2026-10-18 批准；L-1 ~ L-5、P1-a/P1-b、M4c-1 ~ M4c-6 已完成，2026-10-19） |
| 依据 | [`docs/design/m4c-host-inventory.md`](../design/m4c-host-inventory.md)；需求 9.3.7（M4c-R1 ~ R9）、9.4.7、9.5、9.6；第 10 章；两份调研报告 |
| 说明 | 只计划，不实现；账本批次先于 M4c；纯重构与功能批严格分离；每批独立可验 |
| 基线 | 常规测试 658（M4c-6 后；657 通过 + 1 项平台跳过）；16 条指令；7 份规范 / 8 份 schema |

---

## 0. 裁决与全局批次

### 0.1 已裁决

| 编号 | 裁决 | 计划落点 |
|---|---|---|
| D-01 | 内置 `host_landings.yaml`，作为 M4c 前置独立批次 | L-1 ~ L-5 |
| D-02 | 与 M4b `plugin_index.landings` 双源并存、读取合并；显式权威等级 | L-1 / L-2 / M4c-3 / M4c-4 |
| D-03 | `uninstall --host`；`--host all` 显式清理全部宿主；`--hard` / `--kind plugin` 互斥 | L-3 |
| D-04 | 原件卸载时若仍有宿主账本，默认阻断并列出未清理宿主 | L-3 |
| D-05 | `root_role` 分 user/system/platform/project；主计数只算 user | M4c-2 / M4c-4 / M4c-6 |
| D-06 | `scan --inventory`；互斥集合；未初始化可用 | M4c-1 |
| D-07 | 双源统一登记为技术债；不把过渡态写成终态 | L-1 / L-5、第 8 章 |
| D-08 | 三平台 fixture 探针；真实用户目录待真机 | M4c-7 |

### 0.2 全局批次表（两份计划共用）

| 批次 | 内容 | 所属计划 | 前置 | 类型 |
|---|---|---|---|---|
| P0-a | `check:arch` 基线 | 可维护性计划 | 无 | 纯重构 / 门禁 |
| P0-b | `contract/` 共享包 + 3 条违例清零 | 可维护性计划 | P0-a | 纯重构 |
| P0-c | complexity / 文件规模 ratchet | 可维护性计划 | P0-b | 门禁 |
| P0-d | 共享测试夹具 | 可维护性计划 | P0-b | 纯重构 / 测试基建 |
| L-1 | `host-landings` 规范 + schema | 本计划 | P0-b | 契约 |
| L-2 | `--host` 落账 / 更新 / 回滚 | 本计划 | L-1、P0-d | 功能 / 契约 |
| L-3 | `uninstall --host` / `--host all` / 原件卸载孤儿闭环 | 本计划 | L-2 | 功能 / 契约 |
| L-4 | 历史副本 inferred / export 决策 | 本计划 | L-2 | 功能 / 文档 |
| L-5 | v0.3.0 兼容 / 不做破坏性迁移 | 本计划 | L-4 | 兼容 |
| P1-a | 宿主三处合一 + `inventory_roots` | 可维护性计划 | P0、L | 纯重构 / 契约扩展 |
| P1-b | dispatch scan 段拆分 | 可维护性计划 | P0、P1-a | 纯重构 |
| M4c-1 | `scan --inventory` CLI | 本计划 | P1-a、P1-b、L | 功能 |
| M4c-2 | 宿主枚举 / root_role / 深度 / 去重 | 本计划 | M4c-1 | 功能 |
| M4c-3 | 双源对账 | 本计划 | M4c-2 | 功能 |
| M4c-4 | 结构化输出 | 本计划 | M4c-3 | 功能 |
| M4c-5 | 只读断言 | 本计划 | M4c-1 | 功能 / 门禁 |
| M4c-6 | GUI 盘点视图 | 本计划 | M4c-4 | 功能 |
| M4c-7 | 三平台 CI fixture 探针 | 本计划 | M4c-4 | 验证 |
| P1-c | lifecycle 拆分 | 可维护性计划 | M4c-7 | 纯重构 |
| P1-d | plugins/manifest 拆分 | 可维护性计划 | M4c-7 | 纯重构 |
| P2 | App.vue / e2e / 架构图 / 死代码 | 可维护性计划 | M4c-7 | 纯重构 / 收口 |

> 任务展开：P0 / P1 / P2 见 [`docs/plan/maintainability.md`](maintainability.md)；本文件展开 L / M4c。

**执行状态（2026-10-19）**：P0-a ~ P0-d、L-1 ~ L-5、P1-a/P1-b、M4c-1 ~ M4c-6 已完成；下一批为 M4c-7（三平台 CI fixture 探针 + 真机登记）。M4c-6 已交付只读 GUI 盘点视图，空工作区可直接进入。逐批证据见 [`maintainability.md`](maintainability.md) 与 `docs/one-summary.md` 6.4 ~ 6.19。

---

## 1. 账本批次（v0.4.0 契约第一批）

### L-1 `host-landings` 规范与 schema（已完成 2026-10-18）

**目标**：把内置宿主账本固定为第七份规范 / 第八份 schema，并明确双源读取边界与权威等级。

**依赖**：P0-b（contract 共享常量 / 类型）。

**任务清单**：

1. 新增 `docs/specification/host-landings.spec.md`：
   - 文件位置、顶层结构、字段语义、唯一键；
   - `content_digest` 算法与 `.disabled` 规范化；
   - `state: active|orphaned`、`origin: distributed|adopted`、`visibility: visible|disabled`；
   - `root_role` / `root_id` 不固化进账本，由注册表与配置在读取时判定；
   - 写入 / 更新 / 孤儿 / 删除时机；
   - 与 `plugin_index.landings` 的双源读取边界 / 权威等级；
2. 新增 `schemas/host_landings.schema.json`（第八份 schema）；
3. `cli-contract.md` 预留 `uninstall --host` / `--host all`、`scan --inventory` 的契约位置（L-3 / M4c-1 落语法）；
4. `result-and-exit-codes.md` 登记 `E-LANDING-001` / `E-LANDING-002`（L-3 完成语义），并同步 `contract/` 的同名常量；
5. `docs/requirements.md` 9.3.7 增补账本前置 / `uninstall --host` 需求增量（按变更记录）；
6. `CHANGELOG` 登记「双源 → 单账本统一」技术债（TD-01）。

**契约 / 规范变更**：

| 项 | 变化 |
|---|---|
| 契约规范 | **6 → 7**（新增 `host-landings.spec.md`） |
| JSON Schema | **7 → 8**（新增 `host_landings.schema.json`） |
| 指令数 | 16，不变 |
| 新问题码 | `E-LANDING-001` / `E-LANDING-002` 登记 |
| 既有契约 | `plugin_index` 不改；`targets[]` 不改 |

**测试**：

1. schema 正反例（缺字段、状态、路径、摘要格式）；
2. 规范字段与 schema 逐字段一致；
3. `content_digest` 规范化（`.disabled` 不改变摘要）；
4. 573 项全绿（569 基线 + 4 项新增）；actual 572 通过 + 1 项平台跳过。

**验收**：

1. 第七份规范 / 第八份 schema 可校验；
2. 双源权威等级写明：内置完整、插件 managed/缺失权威但内容需重渲染、无账本推断；
3. 既有 6 份规范 / 7 份 schema 不被改写语义；
4. 技术债已登记。

**门禁**：文档先行；`npm run check` / schema 测试通过；不改实现。

**落地记录（2026-10-18）**：

| 项 | 结果 |
|---|---|
| 规范 / schema | `docs/specification/host-landings.spec.md`（第 7 份规范）；`schemas/host_landings.schema.json`（第 8 份 schema） |
| 字段口径 | `skill_id / source_version? / source_ref? / host_id / target_path / format / visibility / state / origin / source_checksum / content_digest / adapter_ref / registry_version / created_at / updated_at` |
| 摘要 | 复用 `collectHashEntries` / `computeChecksum`：「相对路径 UTF-8 + NUL + 文件字节」单次 SHA-256；禁用标记规范化；不造第二套哈希 |
| 共享根 | 同一物理路径按宿主各记一条；账本不去重；单宿主卸载遇其他活跃消费方拒绝 `E-LANDING-001` |
| 状态机 | `uninstall --host` 与 `--host all` 保留 `orphaned` 审计；原件卸载成功后物理清除该 Skill 的 `orphaned` 记录；002 同时检查两源 |
| 问题码 | `E-LANDING-001/002` 已入 `result-and-exit-codes.md` 与 `contract/src/codes.ts`；`check:contract` 锁定规范 7 / schema 8 |
| 测试 | 新增 4 项：schema 正反例、主键与共享根、规范字段一致、两码边界；常规 569 → 573（572 通过 + 1 跳过） |
| 验证 | `npm run check`、`npm test`、typecheck、lint、format:check、build 全绿；`smoke:kernel` 通过，`smoke:gui` 28/28，慢测试 1 项通过 |

### L-2 `--host` 落账 / 更新 / 回滚（已完成 2026-10-18）

**目标**：让 `install/update/enable/disable --host` 写入 / 更新内置账本，并保证宿主副本 + 账本原子可回滚。

**依赖**：L-1、P0-d（测试夹具）。

**任务清单**：

1. 账本 store：加载、原子写、独立锁、损坏拒绝写；
2. `install --host`：成功落位后 upsert `active` / `origin: distributed`；
3. `update --host`：更新 `content_digest` / `source_checksum` / `source_version` / `updated_at`，保留 `created_at`；
4. `enable/disable --host`：更新 `visibility`；无账本时 `origin: adopted`；
5. 计算 `content_digest`（目录 / 规则文件；`.disabled` 规范化）；
6. 账本写失败：恢复宿主副本备份 / 删除新副本；命令失败；
7. `dry-run` 不写；
8. 账本损坏：写前拒绝；不覆盖可恢复数据。

**契约 / 规范变更**：无新增规范 / schema；按 L-1 字段落地。

**测试**：

1. install/update/enable/disable 写入 / 更新字段；
2. 失败回滚（账本写失败、备份失败、副本写失败）；
3. `dry-run` 零写入；
4. 账本损坏写前拒绝；
5. 591 项全绿（573 基线 + 18 项新增）；actual 590 通过 + 1 项平台跳过。

**验收**：

1. 四种命令成功时账本字段正确；
2. 失败时宿主副本 / 账本不留半截；
3. 账本与 `skill_index` 分离；
4. 既有指令输出 / 行为除新增账本数据外不变；
5. 纯功能批，不改 M4c 扫描。

**门禁**：L-1 规范先行；账本测试 + 现有 host 契约测试全绿。

**落地记录（2026-10-18）**：

| 项 | 结果 |
|---|---|
| Store | `kernel/store/host-landings/index.ts`：原子读写、主键 CRUD、共享路径同步、损坏 / 重复主键 / 坏枚举返回 `E-LANDING-001` |
| Core | `kernel/core/host-landings/index.ts`：记录构造、adopted 入账、按路径同步活跃记录、账本提交与回滚编排 |
| Dispatch | `kernel/dispatch/host/channel.ts`、`landing-result.ts`、`index.ts`：从 `dispatch/registry` 抽出宿主通道，registry 只保留路由与确认 |
| init | `init` 幂等创建空 `host_landings.yaml`，与 `skill_index.yaml` / `plugin_index.yaml` 同级；已有账本不覆盖 |
| 四命令 | install/update 落位成功后写账本；enable/disable 改名后更新 visibility；账本不在物理写盘前写入 |
| Digest | 新增 `computeLandingChecksum`，复用 `collectHashEntries` / `computeChecksum` 的单次 SHA-256；`.disabled` 规范化；单测断言可见副本摘要与 `computeChecksum` 完全相同 |
| 共享根 | codex/cursor 同路径 e2e：只写一份副本、按宿主各记一条；disable/enable/update 同步全部活跃记录 |
| adopted | 历史副本 enable 时 `origin: adopted`，结果数据 `adopted: true`；不误记为 distributed |
| 形态 | entry 不产生账本记录；rules 只允许 visible，`enable/disable --host cursor-rules` 返回参数类错误 |
| 回滚 | 单测覆盖已有副本恢复、首次副本删除、规则文件恢复/删除、既有账本字节不变、共享根两记录整体回滚；e2e 覆盖损坏账本前置中止与目标路径冲突 |
| 测试 | 新增 18 项（11 unit + 7 e2e）；常规 573 → **591 项**（590 通过 + 1 平台跳过） |
| 结构 | 99 → **96** 个复杂函数；`dispatch/registry` 2621 → **2419** 行；新增 `dispatch/host` 三文件均低于 500 行；`check:arch` 134 文件 / 377 边 / 0 循环 |
| 验证 | `npm run check`、`npm test`、typecheck、lint、format:check、build 全绿；`smoke:kernel` 通过，`smoke:gui` 28/28，慢测试 1 项通过 |

### L-3 `uninstall --host` / `--host all` / 原件卸载孤儿闭环（已完成 2026-10-18）

**目标**：补全分发生命周期——单宿主清理、全宿主清理、原件卸载阻断与显式闭环。

**依赖**：L-2。

**任务清单**：

1. `uninstall <id> --host <host>`：
   - 只清理指定宿主副本 + 账本；
   - 备份先行；副本 / 账本删除失败回滚；
   - 工作区原件 / 索引 `status` / `targets[]` 不变；
2. `uninstall <id> --host all`：
   - 显式清理该 Skill 的全部宿主副本 + 两源账本条目；
   - 不删工作区原件；
   - 需要确认；非交互 `--yes`；
3. `uninstall <id>`（无 `--host`）：
   - 检查 `host_landings` + `plugin_index.landings` 的 active 条目；
   - 有记录 → 默认拒绝 `E-LANDING-002`，列出 `host_id` / `target_path` / `ledger_source`；
   - remedy 给出逐宿主与 `--host all` 两条路径；
4. `uninstall <id> --hard`：
   - 有 active 宿主账本时同样拒绝；先 `--host all` 再 `--hard`；
5. 互斥：
   - `--host` 与 `--hard` 互斥；
   - `--host` 与 `--kind plugin` 互斥；
   - `agents-md` 等不可落盘宿主返回参数类错误；
6. 插件宿主：`--host all` / 单宿主清理删除 `plugin_index.landings` 对应条目；不改插件包；
7. 历史无账本副本：允许 `--host` 清理并标 `legacy: true`；原件卸载无法阻断无账本副本，M4c 标 inferred / untracked。

**契约 / 规范变更**：

| 项 | 变化 |
|---|---|
| `cli-contract.md` | `uninstall` 新增 `--host <宿主或 all>`；互斥条文；指令数 16 |
| `result-and-exit-codes.md` | `E-LANDING-002` 语义：原件卸载被宿主账本阻断 |
| 规范 / schema 份数 | 7 / 8，不变 |
| 指令数 | 16，不变 |

**测试**：

1. 单宿主清理：副本 + 账本；其他宿主 / 工作区不变；
2. `--host all`：全部宿主副本 + 两源账本；工作区原件保留；
3. 原件卸载有 active 账本 → `E-LANDING-002`，列出条数与路径；
4. `--hard` 有 active 账本 → 拒绝；
5. `--host` + `--hard` / `--kind plugin` → 参数错误；
6. 备份失败 / 删除失败 / 账本删除失败回滚；
7. 插件 landings 阻断 / 清理；
8. 历史无账本副本；
9. 603 项全绿（591 基线 + 12 项新增）；actual 602 通过 + 1 项平台跳过。

**验收**：

1. 三种操作面单一意图：单宿主清理 / 原件卸载 / 插件包卸载；
2. 原件卸载不再静默留下新孤儿；
3. `--host all` 显式、可预览、可回滚；
4. 工作区原件与宿主副本清理不互相隐式牵连；
5. 旧副本边界写明。

**门禁**：L-2 全绿；契约登记完成；失败矩阵覆盖。

**落地记录（2026-10-18）**：

| 项 | 结果 |
|---|---|
| 路由 | 内置 host-id / `cursor-rules` → `host_landings`；`x-` 前缀 → `plugin_index.landings`；`all` 同时读取两账本 |
| 单宿主 | 物理副本临时改名 → 两账本写 orphaned → 删除；共享根仍被其他 active 宿主消费时拒绝 `E-LANDING-001`；路径不存在按幂等成功 |
| `--host all` | 按物理副本分组，共享副本只删一次；逐组提交，单组失败不影响其他组，结果逐宿主列出 `removed` / `missing` / `unchanged` / `failed` |
| 账本一致性 | 每组先临时移走副本，再写两账本，再删除；账本失败恢复副本与两账本，删除失败恢复副本并保留 orphaned 记录 |
| 原件阻断 | `uninstall` 与 `--hard` 前检查两账本 active；命中 `E-LANDING-002`，消息含 host / path / ledger_source 与逐宿主 / `--host all` 引导 |
| 孤儿清理 | 原件卸载成功后物理清除 `host_landings` 中该 Skill 的 orphaned 记录；`plugin_index.landings` 孤儿按 M4b 保留 |
| 互斥 | `--host` 与 `--hard` / `--kind plugin` 互斥，返回 `E-INPUT-002`；非法宿主 / 无记录不误删 |
| 再激活 | orphaned 后 `update --host` 复用同主键回到 active，不新增重复记录 |
| 备份 | `--host` 不创建 Skill 备份；结果 `backup: null`、`workspace_unchanged: true`；插件包不卸载 |
| 测试 | 新增 12 项（6 unit + 6 e2e）；常规 591 → **603 项**（602 通过 + 1 平台跳过） |
| 结构 | 复杂函数基线 96 → **95**；`dispatch/registry` 保持 **2419** 行；`dispatch/host/uninstall*` 四个文件均低于 500 行；`check:arch` 139 文件 / 407 边 / 0 循环 |
| 验证 | `npm run check`、`npm test`、typecheck、lint、format:check、build 全绿；`smoke:kernel` 通过，`smoke:gui` 28/28，慢测试 1 项通过 |

### L-4 历史副本 inferred / export 决策（已完成 2026-10-18）

**目标**：无账本副本的推断规则与可移植性边界定稿。

**依赖**：L-2。

**任务清单**：

1. 实现 / 文档化 inferred 规则：
   - 无账本 + 工作区记录 + 重渲染匹配 → `inferred_consistent`；
   - 无账本 + 工作区记录 + 不匹配 → `inferred_drift`；
   - 无账本 + 无工作区记录 → `untracked`（工作区可读）；
   - 无工作区 → `undetermined` + `untracked_candidate`；
   - 无副本 → `not_distributed`，不判 missing；
2. `export/import`：不纳入 `host_landings`；
3. 卸载备份：不纳入内容备份；账本由 L-3 处理；
4. `restore`：不恢复账本；后续盘点推断 / 漂移；
5. 输出 `evidence: { managed, content, source }` 与 `ledger_source`。

**契约 / 规范变更**：不新增规范 / schema；更新 `cli-contract` / 盘点输出说明（M4c-4 落结构）。

**测试**：

1. inferred 一致 / 漂移 / untracked / undetermined / not_distributed；
2. export 不出现 `host_landings`；
3. restore 后账本不复活；
4. 616 项全绿（603 基线 + 13 项新增）；actual 615 通过 + 1 项平台跳过。

**验收**：

1. 历史副本不被误判 missing / 权威 managed；
2. export / 备份结论有明确理由；
3. 双源权威等级在输出字段体现；
4. 不改既有 export / backup 契约语义。

**门禁**：L-3 全绿；文档与测试一致。

**落地记录（2026-10-18）**：

| 项 | 结果 |
|---|---|
| 类型 | `contract/src/host-reconciliation.ts`：观察副本、账本记录、工作区基线、三轴证据与分类输出 |
| 纯函数 | `kernel/core/host-landings/reconcile.ts`：`reconcileHostCopy`，只消费入参，不做文件系统枚举 |
| 判定表 | host active 一致 / 内容漂移 / 可见性漂移 / 来源漂移 / 版本漂移 / 缺失 / 不可读 / 渲染基线变化；无账本 inferred / drift / untracked / not_distributed |
| orphaned 定论 | 副本残留且工作区有记录：`orphaned` + content/source inferred，并区分 `orphaned_inferred_consistent/drift`；工作区无记录：all insufficient + `untracked_candidate`；副本不存在：`orphaned` + `copy_present:false` |
| 插件证据 | managed / missing 权威；content 与 source 最多 inferred；无重渲染基线时 `undetermined`，不伪造内容一致 |
| 无工作区 / 根不可读 | 一律 `undetermined`、三轴 insufficient，不判 missing/drift；账本 active 也不例外 |
| 降级 | `ledger_state: missing 或 unreadable` 走无账本推断，带 `ledger_unavailable_degraded`，不抛崩、不伪造权威 |
| export | `host_landings` 不进入 export 包；restore 不恢复账本；测试断言导出文档无 `host_landings`/`landings`，restore 前后账本字节一致 |
| 测试 | 新增 13 项（12 unit / 1 contract）；常规 603 → **616 项**（615 通过 + 1 平台跳过） |
| 结构 | complexity 基线保持 **95**；`reconcile.ts` ≤ 500 行；`check:arch` 141 文件 / 408 边 / 0 循环 |
| 验证 | `npm run check`、`npm test`、typecheck、lint、format:check、build 全绿；`smoke:kernel` 通过，`smoke:gui` 28/28，慢测试 1 项通过 |

### L-5 v0.3.0 兼容 / 不做破坏性迁移（已完成 2026-10-18）

**目标**：旧工作区无账本时不阻塞、不隐式写入、不丢数据。

**依赖**：L-4。

**任务清单**：

1. 无 `host_landings.yaml` → 空账本；不自动创建；
2. 首次 `install/update/enable/disable --host` 才创建；
3. 旧宿主副本 → inferred；不批量回填；
4. `plugin_index.landings` 原样读取；
5. `skill_index` / `plugin_index` schema 不改；
6. 版本 / CHANGELOG 记录 v0.4.0 兼容口径；
7. 技术债 TD-01 继续登记。

**契约 / 规范变更**：无新增；兼容说明入 L-1 规范 / CHANGELOG。

**测试**：

1. v0.3.0 工作区无账本 → 盘点不崩溃、不写；
2. 首次分发创建账本；
3. 插件 landings 不改；
4. 621 项全绿（616 基线 + 5 项新增）；actual 620 通过 + 1 项平台跳过。

**验收**：

1. 不破坏旧工作区；
2. 不做隐式迁移；
3. 旧副本口径可见（inferred）；
4. 账本缺失不阻断 M4c 只读盘点。

**门禁**：兼容测试 + 现有全套全绿。

**落地记录（2026-10-18）**：

| 项 | 结果 |
|---|---|
| 缺失 | 无 `host_landings.yaml` 按空账本读取：`exists:false` / `index:null` / `findings:[]`；不报错、不归类损坏 |
| 损坏 | 文件存在但不可解析 / schema 不合规：`E-LANDING-001`；测试断言损坏字节不被重置、副本不被先改 |
| 懒初始化 | 写命令首次遇到缺失文件时，`prepareBuiltinLanding` / `prepareToggleLedger` 幂等补建空账本；dry-run 与被拒确认不写 |
| 不迁移 | 升级本身不扫描宿主、不批量写记录；只读路径保持文件缺失，历史副本走 inferred；不伪造 distributed |
| adopted | 首次 `disable --host` 补建账本并以 `origin: adopted` 入账；首次 `update/install --host` 正常 `distributed` |
| 字节断言 | 只读 / enable-disable 前后 `skill_index.yaml`、`plugin_index.yaml` 字节一致；update 只改 skill 索引且插件索引字节不变 |
| 版本 | 新账本 `schema_version: "1"`，`tool_version` 取当前工具版本；后续演进按 schema 版本递增，不静默降级 |
| 测试 | 新增 5 项 e2e；常规 616 → **621 项**（620 通过 + 1 平台跳过） |
| 结构 | complexity 基线保持 **95**；`dispatch/registry` 保持 2419 行；`check:arch` 保持 141 文件 / 408 边 / 0 循环 |
| 验证 | `npm run check`、`npm test`、typecheck、lint、format:check、build 全绿；`smoke:kernel` 通过，`smoke:gui` 28/28，慢测试 1 项通过 |

---

## 2. M4c 功能批次（v0.4.0 契约第二批）

### M4c-1 `scan --inventory` CLI（已完成 2026-10-19）

**目标**：在 `scan` 上增加只读盘点模式，未初始化工作区可用。

**依赖**：P1-a、P1-b、L-5。

**任务清单**：

1. `--inventory` 布尔选项登记；
2. 在 `dispatch/scan/index.ts` 的扫描计划与索引存在性检查之前分流；
3. 互斥：`--kind` / `--root` / `--dry-run`；
4. 不 `withLock`、不写 `last_scan_at`、不调用 `scanWorkspace`；
5. 工作区缺失 / 索引不可读 → `workspace.state`，不报整体失败；
6. help / 契约语法 / 错误码更新；
7. 预留 M4c-2~5 的 use case 接口。

**契约 / 规范变更**：`cli-contract.md` 增加 `scan --inventory`；指令数 16；规范 / schema 份数不变。

**测试**：

1. 互斥组合各一条；
2. 未初始化工作区可运行；
3. 不创建锁 / 索引 / 临时文件；
4. 既有 `scan` / `scan --kind plugin` 不变；
5. 634 项全绿；本批新增 5 项。

**验收**：

1. 只读模式在索引检查前分流；
2. 互斥与未初始化行为正确；
3. 无写盘；
4. 不新增指令。

**门禁**：P1-b 路由就位；CLI 契约登记；只读测试通过。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 参数 | `--inventory` 已登记为布尔选项；与 `--kind` / `--root` / `--dry-run` 及位置参数互斥，错误为 `E-INPUT-002`；允许 `--workspace` 与通用输出选项 |
| 分流 | `scanHandler` 在 `scanPlanOf()` 后进入 `inventoryScanCommand()`；早于 workspace 索引存在性检查，不调用 `withLock` |
| 工作区 | 无索引 → `workspace.state = uninitialized`、exit 0；可读索引 → `ok`；存在但不可读 → `unreadable`，不写索引 |
| 根清单 | 内置 `inventoryRootsForAll` + 已启用插件 catalog，输出 `mode / workspace / roots[]`；含 root_role、recursive、origin、is_x_host、consumed_by、configured 与降级 reason |
| 配置 / 插件 | `host.<id>.root` / `.rules_root` 覆盖根可见；已启用 x- 宿主可见，未启用插件不出现 |
| 只读 | inventory 源码不调用锁、索引写入、`scanWorkspace` 或 `last_scan_at`；运行前后 `skill_index.yaml` 字节一致 |
| 测试 | 新增 5 项（2 unit / 3 e2e）；常规 629 → **634 项**（单元 402、契约 125、端到端 107；633 通过 + 1 平台跳过） |
| 结构 | `check:arch` 155 文件 / 474 边 / 0 循环；complexity 保持 **94**；`inventory.ts` 低于 500 行 |

### M4c-2 宿主枚举 / root_role / 深度 / 去重（已完成 2026-10-19）

**目标**：实现根枚举、角色分组、宿主级发现深度、识别 / 物理去重 / 可见性。

**依赖**：M4c-1、P1-a。

**任务清单**：

1. 内置根枚举（user/system/platform/project；legacy origin）；
2. `x-` 宿主根枚举（enabled / valid / project / global config）；
3. 根状态：ok / empty / missing / unconfigured / unreadable / not_applicable；
4. 深度：Cursor recursive；其余 direct；system 根单独 direct；
5. 有效 `SKILL.md` 三层判定；
6. `.disabled` 可见性；
7. `realpath` 去重 + 消费方标注 + 跨宿主视图；
8. 单根 / 单技能失败隔离。

**契约 / 规范变更**：无新增规范 / schema；使用 P1-a `inventory_roots`。

**测试**：

1. 7 内置 + 2 x- 根 fixture；
2. 顶层 vs 递归；
3. 共享根唯一计数 / consumers；
4. 符号链接 / 大小写 / 损坏目录；
5. 639 项全绿；本批新增 5 项。

**验收**：

1. 根角色 / 深度 / 识别 / 去重与设计一致；
2. sub-skills / references / examples 不计数；
3. 单宿主失败不阻断；
4. 主计数用的物理唯一技能可复算。

**门禁**：M4c-1 全绿；fixture 测试通过。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 发现 | `kernel/core/inventory/discover.ts` 只读遍历根：direct 只枚举一级子目录；recursive 任意深度查找 SKILL.md；references/examples 等无 SKILL.md 目录不计数 |
| 识别 | skill 要求 SKILL.md frontmatter 的 name/description；SKILL.md.disabled 为 disabled；bad YAML / 缺 name/description / visibility conflict 进入 corrupt；rules 只识别 `.mdc`；agents-md entry 根为 not_applicable |
| 观察 | copies[] 输出 path、host/root/role、format、visibility、recursive、skill_id/version、content_digest、readable/exists；`content_digest` 复用 `computeLandingChecksum` |
| 去重 | physical_key = realpath + Windows casefold；共享根、父子根重叠合并为一条并聚合 consumed_by/root_ids/sources；同一 skill_id 的不同物理根保留多条 |
| 根状态 | ok / empty / missing / unconfigured / unreadable / not_applicable；损坏副本单独 `corrupt[]`，不伪造有效计数 |
| 性能 | 200 个技能、每技能 10 个 references 文件（2200 文件），Windows 本机 **214 ms**；无写盘、无缓存（观察值，不作门禁） |
| 测试 | 新增 5 项（4 unit / 1 e2e）；常规 634 → **639 项**（单元 406、契约 125、端到端 108；638 通过 + 1 平台跳过） |
| 结构 | `check:arch` 157 文件 / 480 边 / 0 循环；complexity 保持 **94**；`discover.ts` 457 行 |

### M4c-3 双源对账（已完成 2026-10-19）

**目标**：实现权威四分类 + inferred + undetermined，分开两源权威等级。

**依赖**：M4c-2、L-2~L-5。

**任务清单**：

1. 读取 `host_landings` + `plugin_index.landings`；
2. 构建 `LandingView` 合并模型；
3. 有账本路径：missing / unreadable / visibility / content / source；
4. 插件账本：managed / 缺失权威，内容 / 漂移 `inferred`；
5. 无账本路径：inferred_consistent / inferred_drift / untracked / not_distributed；
6. 无工作区：undetermined + untracked_candidate；
7. 漂移原因 / 逐文件差异；
8. 账本损坏 → insufficient，不虚报。

**契约 / 规范变更**：无新增；按 L-1 / L-3 语义。

**测试**：

1. 权威四类矩阵；
2. 插件账本 managed / missing / content inferred；
3. 无账本 inferred；
4. 无工作区 undetermined；
5. 账本损坏；
6. 644 项全绿；本批新增 5 项。

**验收**：

1. 每类有数据来源与判定依据；
2. 不把插件内容一致性写成权威；
3. 不把无账本判成 missing；
4. 不把无工作区判成权威四分类。

**门禁**：M4c-2 全绿；对账矩阵测试通过。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 正向 | `kernel/dispatch/scan/reconcile.ts` 将 M4c-2 copies/corrupt 接入 `reconcileHostCopy`；分类写入 `reconciliation`，包含 ledger_source / evidence / reasons / drift_reasons |
| 反向 | active host_landings / plugin_index.landings 按规范化 target_path 反查；不在 observed 集合时进入 `missing[]`；orphaned 不反查 missing |
| 工作区 | 读取 `skill_index` 记录与 source/meta，构造 checksum/version/source_ref/expected_content_digest/expected_visibility；未初始化映射为无工作区，索引不可读保留 degraded |
| 插件 | plugin landing managed / missing 为权威；content/source 使用插件 profile 重渲染，最高 `inferred`；无基线时 `undetermined` |
| 共享根 | 物理副本按 path 匹配多条记录；单个副本删除时按 active host 账本分别缺失 |
| 测试 | 新增 5 项（2 unit / 3 e2e）；常规 639 → **644 项**（单元 408、契约 125、端到端 111；643 通过 + 1 平台跳过） |
| 结构 | `check:arch` 158 文件 / 496 边 / 0 循环；complexity 保持 **94**；`reconcile.ts` 474 行 |

### M4c-4 结构化输出（已完成 2026-10-19）

**目标**：输出 host → root(role) → skill，含主计数、分类、证据、消费方、排除项。

**依赖**：M4c-3。

**任务清单**：

1. `data.summary.main` = user 角色唯一技能；
2. `summary.roles` / `summary.classifications` / `untracked_candidates`；
3. `roots[]` / `hosts[]` / `items[]` / `excluded[]`；
4. `evidence {managed, content, source}` / `ledger_source`；
5. `untracked_import_hint`；
6. 结果形状契约 / schema 登记；
7. 人类可读输出与 `--json` 对齐。

**契约 / 规范变更**：结果形状 / 输出载荷登记；指令数 16；规范 / schema 份数不变。

**测试**：

1. 字段完整性 / schema；
2. 主计数 / roles / classifications 一致；
3. CLI 与 GUI 数据对齐（M4c-6）；
4. 647 项全绿；本批新增 3 项。

**验收**：

1. 主计数只算 user；
2. system / platform 折叠但不丢失；
3. 每条结论带权威等级；
4. 未纳管 / 无法判定分开。

**门禁**：M4c-3 全绿；输出契约登记。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 主计数 | `summary.main` = role=user 的有效物理副本数与 `unique_skills`；system/platform/project 独立分组，共享根去重后只计一份 |
| 分类聚合 | `by_classification` 保留 L-4 原分类；`groups` 将 managed/drift 聚合并保留 authoritative/inferred；missing/untracked/undetermined/unreadable/not_distributed/orphaned 单列，orphaned 区分工作区在/不在 |
| 层级 | `hosts → roots → copies/corrupt/missing`；扁平 copies/missing/corrupt 保留可下钻明细 |
| 人类输出 | 首行 user 主计数；role 摘要、分类摘要、宿主分组；`--verbose` 展示副本明细，默认不刷屏 |
| 测试 | 新增 3 项（2 unit / 1 e2e）；常规 644 → **647 项**（单元 410、契约 125、端到端 112；646 通过 + 1 平台跳过） |
| 结构 | `check:arch` 159 文件 / 498 边 / 0 循环；complexity 93；`aggregate.ts` 253 行 |

### M4c-5 只读断言（已完成 2026-10-19）

**目标**：证明盘点前后工作区 + 宿主目录字节一致。

**依赖**：M4c-1。

**任务清单**：

1. 递归清单：相对路径 / 类型 / 大小 / SHA-256 / mtime；
2. 断言工作区 + 所有被扫描宿主根不变；
3. 索引 / 账本 mtime / 字节不变；
4. 无临时 / 锁 / 日志 / 缓存；
5. 无网络、无宿主启动；
6. 覆盖空工作区 / 损坏账本 / 缺失或不可读根 / 共享根 / x- 宿主 / 大规模副本。

**契约 / 规范变更**：无。

**测试**：

1. 五种只读夹具；
2. 重复运行一致；
3. 652 项全绿；本批新增 5 项。

**验收**：

1. 盘点前后树哈希一致；
2. 不写 `last_scan_at`；
3. 不创建锁；
4. 单宿主失败仍只读。

**门禁**：M4c-1 全绿；只读测试通过。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 静态守卫 | `check:arch` 增加盘点只读源审计：只允许只读 fs API，拒绝写调用与索引 / 锁 / 落位 / 账本提交导入 |
| 反例自检 | synthetic `writeFileSync` 与 `saveIndex` 源均被 `checkInventoryReadonly` 捕获 |
| 动态快照 | `tests/helpers/snapshot.ts` 递归记录路径、类型、mtime、大小、SHA-256；工作区 + 全部宿主根前后逐项比较 |
| 场景 | 已初始化多宿主/共享根/x- 宿主、未初始化工作区、损坏 host_landings、缺失/非目录根、100 副本规模 |
| 证据 | 损坏账本字节不变；无锁/临时/缓存残留；`last_scan_at` 与索引不变；全部场景快照一致 |
| 测试 | 新增 5 项（1 contract / 4 e2e）；常规 647 → **652 项**（单元 410、契约 126、端到端 116；651 通过 + 1 平台跳过） |
| 结构 | `check:arch` 159 文件 / 498 边 / 0 循环；complexity 93 |

### M4c-6 GUI 盘点视图（已完成 2026-10-19）

**目标**：在既有页面族新增 `hosts` 视图，展示分组 / 分类 / 未纳管 / 空工作区入口。

**依赖**：M4c-4。

**任务清单**：

1. `hosts` 视图 + 导航；
2. user 主计数 + system/platform/project 折叠；
3. 四分类 / 推断 / 无法判定分开展示；
4. 未纳管清单 + 二期导入占位；
5. 空工作区仍展示宿主技能；
6. 异步 / 局部失败；
7. 不提供写操作入口。

**契约 / 规范变更**：无。

**测试**：

1. GUI 组件 / 视图测试；
2. GUI 冒烟；
3. 658 项全绿；本批新增 6 项。

**验收**：

1. 界面计数与 CLI 一致；
2. 主计数 / 折叠 / 空状态正确；
3. 无导入 / 修复执行入口；
4. 盘点期间可交互。

**门禁**：M4c-4 全绿；`smoke:gui` 通过。

**落地记录（2026-10-19）**：

| 项 | 结果 |
|---|---|
| 入口 | 侧边导航新增「全机盘点」；空工作区与已初始化空列表均提供「盘点这台电脑上已安装的 Skill」，未初始化可直接运行 |
| IPC | 复用通用 `kernel:invoke`；调用 `scan --inventory`，不新增专用通道、不走预览/确认 |
| 主计数 | 首屏 `summary.main` 置顶展示「X 个安装副本 / Y 个不同技能」；system/platform/project 用折叠分组并标注平台/系统内置 |
| 分组与分类 | 内置宿主 / 第三方 x- 宿主分区；根路径、状态、role、深度、共享根 `consumed_by`；managed/drift/missing/untracked/undetermined/unreadable/orphaned 分项，managed/drift 保留 authoritative/inferred |
| 下钻 | 宿主 → 根 → 副本表；id、版本、路径、可见性、分类、权威等级、账本来源与判定依据；损坏、缺失、未纳管各自可查看 |
| 只读边界 | 无安装/卸载/启用/更新/导入/修复执行入口；二期动作仅禁用占位；盘点前后工作区与 settings 字节一致 |
| 组件 | 新增 `HostInventoryView` + `InventorySummary` / `InventoryHostGroups` / `InventoryCopyDetails` 与纯展示映射；`App.vue` 858 → **844** 行，新组件均低于 800 行 |
| 发现修正 | x- 宿主的 rules 模板使用 `.md`；发现器保持内置 Cursor 仅 `.mdc`，插件宿主兼容 `.md`，避免第三方副本在盘点中显示为 0 |
| 冒烟 | `smoke:gui` 28 → **40/40**；空工作区入口、主计数、平台折叠、共享根、损坏、未纳管、x- 宿主、只读字节与 200 副本滚动均实测 |
| 测试 | 新增 6 项（2 unit / 4 contract）；常规 652 → **658 项**（单元 412、契约 130、端到端 116；657 通过 + 1 平台跳过） |
| 结构 | `check:arch` 167 文件 / 511 边 / 0 循环 / 0 allowlist；complexity 保持 **94**；`scripts/gui-smoke.mjs` 743 → **660** 行 |

### M4c-7 三平台 CI fixture 探针

**目标**：在 Windows / Linux / macOS runner 上用 fixture 验证路径 / 识别 / 去重 / 四分类；真实用户目录待真机。

**依赖**：M4c-4。

**任务清单**：

1. `scripts/probe-host-inventory.mjs`（设计名）三平台 fixture；
2. config 覆盖指向临时宿主根；
3. 共享根 / Cursor 递归 / root_role / 主计数 / 四分类 / 只读断言；
4. CI 矩阵 windows / ubuntu / macos；
5. 真实用户目录登记为待真机（EX-08 模式）；
6. 不触碰真实宿主根。

**契约 / 规范变更**：无。

**测试**：

1. 三平台 fixture 探针；
2. 失败自证输出；
3. 658 项全绿；新增预计 3 项。

**验收**：

1. 三平台 fixture 均通过；
2. 真实目录未被伪称实测；
3. 只读断言通过；
4. 可独立手工运行。

**门禁**：M4c-4 全绿；CI 矩阵成功；真机项登记。

---

## 3. 依赖关系与关键路径

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

**硬边界**：

1. L-1 规范 / schema 未完成，不得先写账本实现；
2. L-3 未完成，不得把 M4c-3 的缺失 / 孤儿语义写成已完成；
3. P1-a 已完成的 `inventory_roots` / `InventoryRootView` 是 M4c-2 的唯一根枚举入口，不得另写一套 hostId 根分支；
4. P1-b 已完成的 `dispatch/scan` 是 M4c-1 的唯一入口，后续不得把扫描逻辑重新放回 registry；
5. P1-c/P1-d/P2 不得插到 M4c CLI 前。

---

## 4. 契约 / schema / 计数

| 阶段 | 契约规范 | JSON Schema | 指令 | 新问题码 |
|---|---:|---:|---:|---|
| 起始 | 6 | 7 | 16 | — |
| P0-a~d | 6 | 7 | 16 | — |
| L-1 | **7** | **8** | 16 | `E-LANDING-001/002` 登记 |
| L-2 | 7 | 8 | 16 | — |
| L-3 | 7 | 8 | 16 | `E-LANDING-002` 语义 |
| L-4/L-5 | 7 | 8 | 16 | — |
| P1-a | 7 | 8 | 16 | —（host_registry 扩展，不新增份数） |
| M4c-1 | 7 | 8 | 16 | — |
| M4c-4 | 7 | 8 | 16 | —（输出形状登记） |
| M4c-7 | 7 | 8 | 16 | — |

**新增选项**：

1. `scan --inventory`（布尔）；
2. `uninstall --host <宿主|all>`（取值扩展；`all` 是特殊值）；
3. 不改 `--target` 语义；不新增指令。

**新增契约 / schema**：

1. `host-landings.spec.md`（第 7 份规范）；
2. `host_landings.schema.json`（第 8 份 schema）。

---

## 5. 测试与基线（M4c-6 后 658）

> P0 批次的任务条目保留当时的 569 项历史基线；L-1 ~ L-5、P1-a/P1-b、M4c-1/M4c-2/M4c-3/M4c-4/M4c-5 条目保留各自的时点值；自 M4c-6 起，后续各批的实际基线为 **658 项（657 通过 + 1 项平台跳过）**，新增测试按批累加。

| 批次 | 测试增量（预计） | 说明 |
|---|---:|---|
| L-1 | +4（已完成，569 → 573） | schema / 规范 / digest |
| L-2 | +18（已完成，573 → 591） | 11 unit + 7 e2e：落账 / 共享根 / adopted / 回滚 |
| L-3 | +12（已完成，591 → 603） | 6 unit + 6 e2e：单宿主 / all / 原件阻断 / 互斥 / 再激活 |
| L-4 | +13（已完成，603 → 616） | 12 unit / 1 contract：判定表 / orphaned / 降级 / export |
| L-5 | +5（已完成，616 → 621） | v0.3.0 缺失 / 损坏 / 懒初始化 / adopted / 字节不变 |
| P1-a | +6（已完成，621 → 627） | 注册表单一来源 / 默认根等价 / role / depth / config / x- 视图 |
| P1-b | +2（已完成，627 → 629） | scan 实现归属 / registry 路由 / inventory 分流点 |
| M4c-1 | +5（已完成，629 → 634） | 互斥 / 未初始化 / 根清单 / config / x- / 只读 |
| M4c-2 | +5（已完成，634 → 639） | 根 / 深度 / 规则 / 损坏 / 去重 / 只读 |
| M4c-3 | +5（已完成，639 → 644） | 两源 / 四分类 / 反向 missing / 插件重渲染 |
| M4c-4 | +3（已完成，644 → 647） | role 主计数 / 分类分组 / 宿主层级 / 人类摘要 |
| M4c-5 | +5（已完成，647 → 652） | 静态只读守卫 / 全状态快照 / 损坏账本 / 大规模副本 |
| M4c-6 | +6（已完成，652 → 658） | 2 unit / 4 contract：GUI 结构 / 只读边界 / 展示映射 / 结果类型 |
| M4c-7 | +3 | 三平台 fixture |

原预计约 **58** 项；L-2 实际新增 18 项、L-3 实际新增 12 项、L-4 实际新增 13 项、L-5 实际新增 5 项、P1-a 实际新增 6 项、P1-b 实际新增 2 项、M4c-1 实际新增 5 项、M4c-2 实际新增 5 项、M4c-3 实际新增 5 项、M4c-4 实际新增 3 项、M4c-5 实际新增 5 项、M4c-6 实际新增 6 项，后续按实际回填。每批基线：658 项（657 通过 + 1 项平台跳过）不回归；纯重构批不新增功能测试。

---

## 6. v0.4.0 范围与发版

### 6.1 v0.4.0 范围

**包含**：

1. P0-a ~ P0-d（结构护栏，内部）；
2. L-1 ~ L-5（账本 + 卸载闭环 + 兼容）；
3. P1-a / P1-b（宿主三处合一、scan 段，内部）；
4. M4c-1 ~ M4c-7（CLI / 对账 / 输出 / 只读 / GUI / 三平台 fixture）。

**不包含**：

1. P1-c lifecycle 拆分；
2. P1-d plugins/manifest 拆分；
3. P2 收口；
4. 二期导入 / 修复动作；
5. 双源账本统一（技术债 TD-01）。

### 6.2 发版门禁

1. 三平台 CI / fixture 探针成功；
2. 658 项 + 新增测试全绿；慢测试 / GUI 冒烟通过；
3. 发版前守卫、版本一致性、发布资产沿用 v0.3.0 机制；
4. `host_landings` 契约 / schema / 问题码齐备；
5. CHANGELOG 记录 v0.4.0 范围与技术债；
6. 真实 macOS / Linux 用户目录仍为待真机项，不阻塞发版；
7. 发布后 P1-c/P1-d/P2 随主干，不单独发版。

---

## 7. 验收映射

| 需求 / 风险 | 批次 | 验收 |
|---|---|---|
| M4c-R1 盘点入口 / 可见结果 | M4c-1/2/4/6 | 空 / 非空 / 混合；CLI/GUI 一致 |
| M4c-R2 扫描范围 / 根解析 | M4c-2/7 | 7 内置 + 2 x-；根状态 |
| M4c-R3 识别 / 去重 / 跨宿主 | M4c-2 | 共享根唯一计数 / consumers |
| M4c-R4 四分类 | M4c-3 | 权威 / inferred / undetermined 矩阵 |
| M4c-R5 只读 | M4c-5 | 前后树哈希一致 |
| M4c-R6 CLI 只读模式 | M4c-1/4 | 互斥 / 未初始化 / 输出 |
| M4c-R7 GUI | M4c-6 | 角色折叠 / 主计数 / 空状态 |
| M4c-R8 插件范围 | L-1/L-3/M4c-3 | 两源 / 排除 rules/entry |
| M4c-R9 二期预留 | M4c-6 | 无导入 / 修复入口 |
| NFR-M4c-01 | M4c-5/7 | 只读 / 隔离 / 三平台 fixture |
| M-R-17 共享根重复计数 | M4c-2 | 物理去重 |
| M-R-18 无账本 / 缺失误判 | L-3/L-4/M4c-3 | 阻断 / inferred / undetermined |
| M-R-19 根不可读 / 规模 | M4c-2/5 | 单根隔离 / 只读 |
| M-R-20 只读误触写路径 | M4c-1/5 | 不进 withLock / 不写 |
| M-R-21 结构改造回归 | P0/P1/M4c | 658 全绿；纯重构批行为不变 |

---

## 8. 遗留项与技术债

| 编号 | 遗留项 | 类型 | 处理 |
|---|---|---|---|
| TD-01 | 双源账本 → 单账本统一 | 技术债 | L-1 / L-5 + CHANGELOG 登记；触发 plugin_index v2 / 下一次分发契约变更 |
| TD-02 | macOS / Linux 真实用户宿主目录 | 待真机 | M4c-7 fixture 不替代；EX-08 模式 |
| TD-03 | `W-DRIFT-001` 措辞批次 | 既有遗留 | 按 one-summary 既有登记 |
| TD-04 | `--host all` 对历史无账本副本覆盖有限 | 已知边界 | M4c inferred / untracked；二期 |
| TD-05 | 工作区 + 宿主 + 账本单一事务 | 未闭环 | 当前保证宿主副本 + 账本；更大编排重构另立 |

---

## 9. 门禁与检查清单

每批提交前：

1. 纯重构 / 功能严格分离；本批只做一类变化；
2. 658 项全绿；新增测试按批归属；
3. 契约 / schema / 问题码 / 选项登记完成；
4. 三平台不触碰真实宿主根；
5. 只读批不写文件 / 不锁 / 不刷新时间戳；
6. 不引入第二套账本 / 第二套分类 / 第二套根枚举；
7. 双源权威等级在输出中可见；
8. 文档 / 计划 / CHANGELOG / one-summary 计数同步；
9. 回滚路径明确；
10. `docs/reviews/` 未改。

---

**计划结束**。本计划只定义批次、任务、验收与门禁，不含实现代码。
