# M4c 二期盘点动作设计（确认后纳管、修复与清理）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 二期盘点动作设计 |
| 文档路径 | `docs/design/m4c-inventory-actions.md` |
| 文档状态 | **已评审通过**（2026-10-19；T0 骨架已完成） |
| 设计依据 | 需求 9.3.8（M4c2-R1 ~ R10）、9.3.7、9.4.7、9.5；`docs/research/m4c-inventory-actions-2026-10-19.md`；`docs/specification/host-landings.spec.md` |
| 设计边界 | 设计与契约已评审；本次实现只落 T0 注册 / 只读计划，不改 schema、不改 `docs/reviews/` |
| 关键前置 | M4c 一期只读验收已通过；host_landings / plugin landings 双源读取；L-4 对账纯函数；现有 `landPlan` / 备份 / 原子写 / 锁 |

> 设计目标不是让盘点“自动修好”，而是把每个候选动作变成可解释的计划：用户知道方向、看到写入、理解证据、确认执行，并在失败时回到操作前状态。

---

## 0. 结论先行

### 0.1 推荐设计

1. **保持 `scan --inventory` 只读**：新增动作入口，不把扫描器改成写命令；
2. **推荐新增第 17 条指令 `reconcile`**：动作由 `--action` 明确指定，不把命令行为藏在 `install` / `update` / `enable` / `uninstall` 的模糊分支里；
3. **动作词固定为 `adopt / track / repair / accept / clean / forget`**；每个动作只接受明确的分类、证据与选择键；
4. **默认预览，`--apply` 才执行**：`--yes` 只跳过交互确认，不代表授权写入；
5. **工作区是默认修复基线**：`repair` 从工作区重渲染；`accept` 只有用户显式选择磁盘内容 / 可见性时才走宿主→工作区方向；
6. **不猜来源**：`adopt` 的 `source.type` 只能是 `unknown`，`accept` 不根据宿主 frontmatter 推断 URL、ref、来源类型；
7. **物理副本组是共享根的事务单位**：共享路径只写一次，多条 host 账本记录同步更新；
8. **宿主副本删除使用可回滚事务快照**：不把宿主副本当作可长期恢复的 Skill 备份；工作区内容覆盖使用既有标准备份。

### 0.2 已拍板的核心决策

| 编号 | 裁决 | 落地口径 |
|---|---|---|
| D-01 | 新增 `reconcile`，指令数 16 → 17 | 独立动作族与只读扫描分离；T0 已注册 |
| D-02 | `adopt` 导入磁盘实际内容到中心库，`track` 仅补账本 | adopt 不反向解渲染，`source: unknown`；T1+ 实现 |
| D-03 | drift 默认 `repair`（工作区）；`accept` 只接内容 / 可见性 | source/version 永不从宿主反向接受 |
| D-04 | adopt 的 target 默认按工作区默认目标与 `skill_id` 推导 | 不使用源 host id；目标冲突提示显式 `--target` |
| D-05 | `clean` 使用操作级临时快照 | 不新增用户可见 backup 类型；成功后清理快照 |
| D-06 | 插件 `x-` 先限制 `track / repair / clean / forget` | 插件技能源归插件包，不进入工作区 adopt |

---

## 1. 范围与术语

### 1.1 范围

| 本期设计覆盖 | 不在本期 |
|---|---|
| 盘点分类到动作的映射 | 自动全盘修复、自动批量删除 |
| 动作预览、显式 apply、确认与结果结构 | 宿主加载验证、启动宿主、执行 Skill |
| 工作区 / 宿主副本 / 两本账本的事务边界 | 双源账本统一（TD-01） |
| adopt / track / repair / accept / clean / forget | 插件包安装 / 卸载（仍走 M4b） |
| 共享根与多宿主影响面 | IDE 扩展、宿主插件缓存、运行时 |
| CLI / GUI 共用动作计划 | 新的宿主适配器或注册表来源 |

### 1.2 术语

| 术语 | 含义 |
|---|---|
| 动作计划 | 只读生成的稳定预览：选择对象、方向、前后分类、写入、备份、影响宿主、确认级别 |
| 物理副本组 | 由 `realpath + 平台大小写规范化` 得到的同一物理目录 / 规则文件及其全部账本记录 |
| 工作区基线 | 中心库 `skills/<id>`、`skill_meta.yaml`、索引记录与当前适配器重渲染结果 |
| 宿主基线 | 选取的物理副本内容、可见性、摘要与解析出的 ID / 版本 |
| 规范化 | 按当前工作区元数据与适配器重渲染宿主副本；不等同于直接复制宿主文件 |
| 操作快照 | 为一次动作回滚而临时保存的副本；不等同于可被 `restore` 消费的 Skill 备份 |
| apply | 明确写入模式；不带 apply 的动作调用只预览 |

---

## 2. 动作模型

### 2.1 动作总表

| 动作 | 方向 | 允许输入分类 | 默认写入 | 默认确认 | 最终分类 |
|---|---|---|---|---|---|
| `adopt` | 宿主 → 工作区 | `untracked`、`orphaned_without_workspace`、可读的 `corrupt` 副本需先修复元数据后才允许 | 中心库、合成元文件、索引、宿主账本 | 常规 | `managed_consistent`（content 可能为 `inferred`，直到后续 `repair`） |
| `track` | 宿主 → 账本 | `inferred_consistent`、无账本但工作区与宿主内容一致的副本 | 账本 | 轻确认 | `managed_consistent` |
| `repair` | 工作区 → 宿主 | `missing`、`not_distributed`、`orphaned_with_workspace`、`drift`、`inferred_drift`、有工作区记录的 `corrupt/unreadable` | 宿主副本、账本 | 常规 | `managed_consistent` |
| `accept` | 宿主 → 工作区 | `drift`（内容 / 可见性）、`inferred_drift`；有工作区记录 | 中心库、索引、宿主账本；可见性仅改账本 | 常规 | `managed_consistent`（content 可能为 `inferred`） |
| `clean` | 宿主 → 删除 | `orphaned`、`corrupt/unreadable`、明确的未纳管副本；不做默认批量 | 物理宿主副本、账本 | 常规 | `orphaned` 或物理不存在 |
| `forget` | 账本 → 孤儿 | 副本已确认不存在的 `missing` active 记录 | 账本 | 轻确认 | `orphaned` |

### 2.2 分类矩阵

| 盘点分类 | 允许动作 | 拒绝 / 处理原则 |
|---|---|---|
| `managed_consistent` | `clean`（仅精确选择）、无默认动作 | 不提供“一键修复”；不因一致而自动做任何事 |
| `inferred_consistent` | `track` | 仅当工作区记录、期望摘要、来源 checksum 都与观测匹配 |
| `inferred_drift` | `repair`（工作区）或 `accept`（磁盘） | 不允许 `track`；track 会把漂移冻结成新基线 |
| `drift`（content） | `repair` 或 `accept` | 两者都必须预览；默认 `repair` |
| `drift`（visibility） | `repair` 或 `accept` | `accept` 只同步账本可见性，不改工作区内容 |
| `drift`（source / version） | `repair` | 不从宿主猜 source/ref；`accept` 返回不可用动作 |
| `untracked` | `adopt`、`clean`（仅精确路径） | `adopt` 需要合法 ID 与可合成元数据；不自动删除 |
| `missing` | `repair`、`forget` | `repair` 需工作区可渲染；`forget` 需确认副本不存在 |
| `orphaned_with_workspace` | `repair`、`clean` | 副本存在时 repair 回到 active；不存在时 forget |
| `orphaned_without_workspace` | `adopt`、`clean` | adopt 建立工作区；clean 明确删除残留 |
| `corrupt` / `unreadable` | 有工作区记录：`repair`；无工作区记录：`clean` | 不能把损坏副本判作 missing |
| `not_distributed` | `repair` | 工作区记录存在但从未分发；首次创建宿主副本 |
| `undetermined` | 无 | 不提供动作；先修复工作区 / 根 / 账本不可读问题 |

### 2.3 动作后置条件

1. `repair` 成功后，账本的 `content_digest`、`source_checksum`、`source_version`、`source_ref`、`visibility` 与工作区基线一致；
2. `adopt` 成功后，中心库、索引与账本均存在；`source.type` 为 `unknown`；后续盘点不再为 `untracked`；
3. `track` 成功后，物理副本与账本摘要一致，工作区字节不变；
4. `accept` 成功后，宿主内容进入中心库，工作区元文件声明区除明确允许的版本外不被推测覆盖；`source` / `ref` 保持工作区原值；
5. `clean` 成功后，选中物理副本不存在；有账本记录者为 `orphaned`，无账本者不伪造记录；
6. `forget` 成功后，账本记录不再是 active，且物理磁盘不被触碰。

---

## 3. 命令形态

### 3.1 候选比较

| 方案 | 指令数 | 优点 | 风险 | 结论 |
|---|---:|---|---|---|
| 扩展现有命令 | 16 | 少一条指令 | 方向与对象语义冲突；`--host` / `--target` / `--kind` 组合爆炸 | 不推荐 |
| 新增 `reconcile` | 17 | 方向、选择、预览、回滚集中；不污染既有生命周期 | 需要新契约、确认表与 GUI 通道 | **推荐** |
| `adopt` + 扩展其余命令 | 17 | untracked 直观 | 三套语义与回滚仍分散 | 不推荐 |

### 3.2 已采纳语法

```text
skill-manager reconcile --action <adopt|track|repair|accept|clean|forget>
  [--path <物理副本路径>]
  [--id <Skill 标识> --host <宿主|all>]
  [--classification <分类>]
  [--root <根路径>]
  [--target <工作区目标标识>]
  [--apply] [--yes] [--dry-run] [--json] [--verbose]
```

### 3.3 选择器规则

1. **`--path`**：精确选择一个物理副本，适用于 untracked、corrupt、无账本副本；优先级最高。路径必须是当前盘点中出现的物理路径或其规范化等价路径；
2. **`--id` + `--host`**：选择一个技能在某个宿主的副本；`--host all` 表示该技能已有的全部宿主副本；
3. **`--root`**：限定盘点根，可与其他选择器组合做过滤；不作为删除授权；
4. **`--classification`**：批量选择分类；只允许与 `repair` / `track` / `adopt` 组合，且必须提供 `--root` 或 `--host` 限定；
5. **不提供裸 `--all`**：全盘批量写入与删除风险过高；需要批量的用户使用分类 + 范围，或在未来版本单独评审；
6. `clean` 仅接受 `--path` 或 `--id` + `--host`；`forget` 仅接受 `--id` + `--host` 或账本精确路径；
7. `--target` 只用于 `adopt`：指定工作区目标标识；省略时按 3.4 推导；
8. `--apply` 必填才执行；`--dry-run` 与默认预览等价，和 `--apply` 同时出现按参数错误处理；
9. 非终端 `--apply` 必须同时给出 `--yes`；否则返回参数错误，不等待输入。

### 3.4 `adopt` 的元数据合成

1. **ID**：优先取 `--id`；否则取宿主 frontmatter 的 `name`，仅当其满足 Skill ID 规则且目录名一致；否则拒绝并提示 `--id`；
2. **name**：取 frontmatter `name`；为空或超长时拒绝；
3. **description**：取 frontmatter `description`；为空时拒绝；
4. **version**：frontmatter `version` 合法时进入元文件，否则省略；
5. **source**：固定 `{type: unknown}`；不猜 URL / ref / 本地路径；
6. **status**：可见性 `visible` → `enabled`，`disabled` → `disabled`；
7. **targets**：优先取 `--target`；省略时使用工作区配置的 `default_target`，工作区路径按 `skill_id` 与既有 install 相同的 `.target/skills/<skill_id>` 约定推导；不使用源 host id，也不强制要求 `--target`；目标冲突时提示显式 `--target`；
8. **path**：`./skills/<id>`；
9. 合成元文件必须通过现有 `validateMetaRecord`；任何错误都不得写入中心库；
10. 目标副本仅作为工作区目标镜像，真实宿主副本仍由 `host_landings` 记录；不把工作区 `.host/skills` 误认为宿主真实根。

> 若评审认为“只用宿主 id 作为目标标识”过于隐式，可把 `--target` 改为 `adopt` 的必填项。设计要求是：不能在没有目标的情况下伪造 `targets`。

---

## 4. 动作执行设计

### 4.1 规划层（纯逻辑）

执行前先生成 `ReconcilePlan`，输入是当前盘点观察、两本账本、工作区只读基线；输出不读写文件：

```text
ReconcilePlan
  action, source_of_truth, selection, apply_requested
  items[]:
    item_id, physical_key, target_path, host_ids, consumed_by, format
    before: classification, ledger_source, evidence, drift_reasons
    after_expected: classification, evidence
    writes[]: action, kind, path, scope
    ledger_changes[]: source, record_key, from_state, to_state
    backups[], warnings[], skippable_reason
  summary: selected, actionable, skipped, destructive, shared_groups
```

规划层不调用 `landPlan`、`saveIndex`、`saveHostLandings` 或任何写 API；沿用 M4c-5 的静态守卫。

### 4.2 执行层（事务）

所有 apply 动作先获取工作区锁，再重新读取索引与两本账本，确认计划未过期。之后按物理副本组执行：

1. 对每个组生成临时操作快照（仅回滚用）；
2. 执行工作区 / 宿主写入；
3. 提交两本账本；
4. 删除临时快照并清理空目录；
5. 失败时按逆序回滚本组的全部物理与账本变更；
6. 保持其他组不受影响；批量结果逐项返回成功 / 失败。

### 4.3 各动作的写入序列

#### `repair`

1. 读取工作区记录与 `skill_meta.yaml`；
2. 用当前适配器生成宿主落位计划（不访问网络）；
3. `landPlan` 写宿主副本（目标不存在时创建，存在时备份后覆盖）；
4. 写内置 `host_landings`；x- 宿主写 `plugin_index.landings`；
5. 账本失败 → `rollbackLandWrites`；成功 → 清理临时快照；
6. 不修改工作区索引、中心库或来源声明。

#### `adopt`

1. 只读复制宿主副本到临时目录，计算 checksum / digest；
2. 生成并校验 `skill_meta.yaml`；确认 ID 不在索引、目标位置无冲突；
3. 标准备份目标中心库（若存在冲突则拒绝，不做覆盖）；
4. 原子替换 / 创建 `skills/<id>`；
5. 写索引；
6. 写内置账本或插件账本；失败时恢复索引、移除中心库、恢复临时快照；
7. 不修改源宿主副本；后续 `repair` 才做规范化。

#### `track`

1. 只读确认工作区记录存在、期望重渲染摘要与观测一致；
2. 写入内置账本 / 插件账本，`origin: adopted`；
3. 不改中心库、索引或宿主文件；账本失败恢复原字节。

#### `accept`

1. 只读确认工作区记录与宿主副本身份；
2. 对 `source_ref` / `source_type` 不一致或无法解释的漂移拒绝；
3. 备份中心库；
4. 将宿主副本内容复制到中心库，**排除**宿主副本中的 `skill_meta.yaml`；保留工作区元文件的 source/targets/dependencies；
5. 重新计算 checksum / digests，更新索引；
6. 更新宿主账本的 content digest、source checksum、visibility；不重写源宿主副本；
7. 任意一步失败恢复中心库、索引、账本到操作前。

#### `clean`

1. 按物理副本组确认路径与共享消费方；
2. 同卷临时移到操作快照目录（先备份、后删除）；
3. 有账本记录时写两本账本为 `orphaned`；无账本时只记录 `legacy: true`；
4. 提交后再删除快照；
5. 任意失败恢复物理副本与两本账本；
6. 不触碰工作区中心库、索引或 `targets[]`。

#### `forget`

1. 读取两本账本，确认目标路径不存在；
2. 把匹配 active 记录转为 `orphaned`，不改物理文件；
3. 原子写账本；失败恢复原字节；
4. 不批量跨技能清理。

---

## 5. 安全与回滚矩阵

### 5.1 确认级别

| 动作 | 级别 | 说明 |
|---|---|---|
| `track` | 轻确认 | 只改管理账本，不改内容 |
| `forget` | 轻确认 | 只把无副本记录转孤儿 |
| `adopt` | 常规 | 写入中心库与索引 |
| `repair` | 常规 | 可能覆盖宿主副本 |
| `accept` | 常规 | 可能覆盖工作区内容 |
| `clean` | 常规 | 删除宿主副本，必须列出路径 |

所有 `apply` 在没有 `--yes` 的非终端环境拒绝；预览不要求确认。

### 5.2 失败回滚矩阵

| 阶段 / 动作 | 失败行为 |
|---|---|
| 预览后事实变化 | 拒绝执行，返回 `E-RECONCILE-002`；不写任何文件 |
| 备份失败 | 中止，中心库 / 宿主 / 账本保持原状 |
| 工作区写入失败 | 恢复中心库快照与索引原字节 |
| 宿主落位失败 | `landPlan` 回滚本次已写项 |
| 账本提交失败 | `repair` 用 `rollbackLandWrites`；`adopt` / `accept` 恢复索引与中心库；`track` / `forget` 恢复账本原字节 |
| 共享根组内部分账本失败 | 整组恢复物理副本与两本账本；不留下部分 host 记录 |
| 删除前移动失败 | 原副本与账本均不变 |
| 删除后账本失败 | 从临时快照恢复物理副本与账本 |
| 回滚自身失败 | 保留诊断，不继续执行后续组；结果标明 `rollback_failed` |
| 批量中单组失败 | 已成功组保留；失败组恢复；其余组继续或停止由 `--continue-on-error`（本期不提供，默认继续逐组结果） |

### 5.3 共享根与未选中对象

1. 一个 `physical_key` 是事务组；组内每个 `host_id` / 账本记录都有结果；
2. `--host <one>` 选中共享根时，动作计划必须展示其他 `consumed_by`；`clean` 在其他活跃消费方存在时拒绝，`repair` 可以写一次并同步全部活跃记录；
3. 未选中的路径、根、宿主、账本记录不写入；测试用字节快照验证；
4. 源宿主副本不是目标时，`adopt` 不改源；`repair` / `accept` 的写入范围必须在预览中逐项列出。

---

## 6. 关键设计决策候选

### 6.1 D-01 untracked 导入方向

| 候选 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 仅登记账本 | 保留宿主副本，只写 `host_landings` | 最小写入、不改变宿主 | 没有工作区来源，无法重建；无完整纳管 | 不作为默认 |
| B 内容读入中心库并重渲染 | 复制宿主内容、合成 meta、索引、账本，再规范化 | 后续可修复、可重分发、可版本管理 | 需要解决 targets / source unknown | **推荐 `adopt`** |
| C 拆分 `adopt` + `track` | `adopt` 负责真正导入；`track` 只处理已有工作区一致副本 | 语义清楚，避免把推断直接冻结 | 多一个动作 | **推荐组合** |

### 6.2 D-02 drift 双向

| 漂移 | 默认 | 备选 | 结论 |
|---|---|---|---|
| content | `repair` 工作区 | `accept` 宿主内容 | 默认工作区；磁盘副本可显式接受 |
| visibility | `repair` 工作区 | `accept` 观测可见性 | 默认工作区；接受只更新账本，不改中心库 |
| source / ref | `repair` 工作区 | 从宿主猜来源 | **拒绝猜来源**；需要来源时用户先编辑元文件或重新 install |
| version | `repair` 工作区 | 读取宿主 frontmatter 版本 | 不把宿主渲染文本当作声明权威；版本变更走来源 / 元文件流程 |

### 6.3 D-03 missing

| 候选 | 结果 | 推荐 |
|---|---|---|
| 自动重分发 | 用工作区内容重建 | 作为 `repair` 的默认建议 |
| 自动删账本 | 清除 missing 假象 | 不推荐，破坏审计 |
| `forget` | 只把不存在副本的账本转 orphaned | 作为显式清理动作 |

### 6.4 D-04 复用关系

| 复用 | 来源 |
|---|---|
| 物理选择与分类 | M4c-2 / M4c-3 的观察与 `ReconciliationOutput` |
| 渲染与目标 | `adapterFor` / `buildHostChannel` / `renderSourceOf` |
| 宿主写入 | `landPlan` / `rollbackLandWrites` |
| 账本同步 | `applyHostLandingRecords` / `commitHostLandings` / plugin upsert |
| 删除事务 | `executeHostUninstall` 的物理分组与临时移动模式 |
| 备份 | `createBackup`（工作区内容 / 既有宿主覆盖） |
| 锁与原子写 | `withLock` / `atomicWriteFile` / `saveIndex` |

不为动作层另造渲染、checksum、账本 schema 或备份格式。

### 6.5 D-05 插件宿主

1. 插件 `x-` 宿主的 `repair` / `track` / `clean` / `forget` 与内置宿主共用动作计划；
2. 插件 landings 没有 digest / visibility，因此 content / visibility 证据最多为 `inferred`；不得用内置账本字段假装插件账本有权威摘要；
3. `adopt` / `accept` 是否对 `x-` 宿主开放由评审决定；若开放，必须要求显式 `--target`，且不修改插件包本身；
4. 插件包卸载仍走 `uninstall --kind plugin`，本动作不删除插件包。

---

## 7. 契约与持久化影响

### 7.1 不改变的持久化

1. `host_landings.schema.json` 不新增字段；
2. `plugin_index.schema.json` 不新增字段；
3. `host_landings` 仍不进入 export / import / restore；
4. `targets[]` 仍只表达工作区目标，不记录宿主真实根；
5. `entry` 形态仍然没有物理副本，也不产生动作。

### 7.2 需要随实现登记的契约

1. CLI 指令表：16 → 17（若采用推荐方案）；
2. `reconcile` 的 action / selector / apply / confirm 语义与帮助；
3. `contract/` 中的动作计划、选择键、前后分类、写入与备份结构；
4. 新问题码 `E-RECONCILE-001/002/003` 与结果规范；
5. GUI bridge 的安全动作白名单；
6. 不修改 `skill_meta` schema；若 `adopt` 无法给出合法 target，则在评审阶段改为必需 `--target`，而不是悄悄放宽 schema。

---

## 8. 验收与不做项

### 8.1 验收

1. 动作矩阵逐分类正反例；
2. preview 零写入、apply 才写入；
3. 预览后摘要是 stale 则拒绝；
4. 共享根多记录整组一致；
5. 失败回滚矩阵全部分支；
6. 未选中对象字节不变；
7. `scan --inventory` 仍通过 M4c-5 静态守卫和快照；
8. 既有 16 指令、插件、盘点与 GUI 回归不变。

### 8.2 明确不做

1. 不自动删除任何 untracked 副本；
2. 不自动全盘修复或全盘清账；
3. 不把宿主副本直接当作 source / ref 的权威声明；
4. 不执行 Skill 内容、不启动宿主、不读取宿主插件缓存；
5. 不修改工作区外未选中的宿主根；
6. 不把 `host_landings` 纳入跨机备份或恢复。
