# M4c 二期盘点动作技术调研（从只读对账到可回滚写路径）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 二期盘点动作技术调研 |
| 文档路径 | `docs/research/m4c-inventory-actions-2026-10-19.md` |
| 文档状态 | **调研完成，待需求 / 设计评审** |
| 依据 | 需求 9.3.7（M4c 一期）、9.3.8（M4c 二期）、9.4.7、9.5；`docs/specification/host-landings.spec.md`；`docs/specification/cli-contract.md` |
| 关联 | `docs/research/m4c-host-inventory-2026-10-18.md`、`docs/design/m4c-host-inventory.md`、`docs/plan/m4c-host-inventory.md` |
| 边界 | 只做代码 / 契约取证与外部惯例分析；不改代码、不改 schema、不改 `docs/reviews/` |

> 本文回答四个问题：一期已经有哪些可复用写原语；二期真正缺的是什么；untracked 导入与 drift 双向修复有哪些可行口径；哪些动作必须明确拒绝或延后。

---

## 0. 结论摘要

1. **一期读路径已完整，动作路径尚未建模。** `scan --inventory` 已经产出稳定的物理副本观察、双源账本、三轴证据、分类与 missing 反向枚举；动作层不需要重新扫描并自行拼装分类，而应消费同一份对账结果。
2. **现有写原语覆盖大部分底层工作。** `landPlan` 已实现写前备份、目录 / 文件落位、写入记录与逆序回滚；`prepareBuiltinLanding` / `commitBuiltinLanding` 已实现内置账本与物理副本的失败回滚；`executeHostUninstall` 已实现按物理副本分组的临时改名、两账本提交与恢复。二期不应另造文件复制、哈希或回滚核心。
3. **真正缺口有五个：**
   - 缺少按盘点观察精确选择「一个物理副本 / 一个 root / 一个分类」的动作计划；
   - 缺少把宿主副本接回工作区的 `adopt` / `accept` 语义与元数据合成规则；
   - 缺少不重新拉取来源、不依赖 `update` 远端语义的本地重渲染修复；
   - 缺少只改账本的 `forget` 与无账本历史副本的 `clean`；
   - 缺少把工作区、宿主副本、两本账本串成一个可回滚事务的编排层。
4. **`update --host` 不能直接充当通用修复入口。** 代码路径 `runHostLanding -> landPlan` 在目标不存在时具备创建能力，现有 e2e 也覆盖过该行为；但 CLI 契约第 4.11 节仍写「只作用于已存在的宿主副本，不新建副本」。这是已经存在的契约 / 实现边界漂移。二期应把「reconcile repair 可创建缺失副本」写成明确新语义，并单独处理是否同步修正 `update` 文案，不能让用户依赖含糊行为。
5. **推荐新增一个显式 `reconcile` 动作入口，而不是把多方向动作塞进 install / update / enable / uninstall。** 动作方向有宿主→工作区、工作区→宿主、宿主→删除、账本→孤儿四种，继续复用现有动词会让「更新」「启用」「卸载」承担互相冲突的含义。
6. **推荐默认只预览，显式 `--apply` 才写。** 这不是普通轻确认的替代，而是对盘点动作的额外进入门槛；`--yes` 仍只表示跳过交互确认，不表示授权执行。
7. **推荐 `adopt` 与 `track` 分离：** `adopt` 把宿主内容接入中心库；`track` 只把「工作区已有一致副本」从推断提升为账本纳管。仅写账本、不建工作区的 untracked 导入不推荐作为默认，因为它无法支持后续重分发与缺失修复。

---

## 1. 调研方法与证据边界

### 1.1 证据等级

| 等级 | 含义 |
|---|---|
| **[代码路径]** | 当前仓库源码可直接复核的控制流与写盘位置 |
| **[测试证据]** | 现有单测 / e2e 已覆盖的行为 |
| **[契约原文]** | 需求、CLI 契约、账本规范与 schema 的明确条文 |
| **[外部惯例]** | 同类工具官方文档的公开行为；只用于设计取舍，不替代本仓库契约 |
| **[待评审]** | 需要产品 / 架构拍板的语义，不写成已实现事实 |

### 1.2 不做什么

1. 不启动真实 Claude / Codex / Cursor / 豆包宿主；
2. 不在真实用户宿主根上试验写入；
3. 不把外部工具的目录命名习惯当成宿主兼容性证据；
4. 不把 `scan --inventory` 的分类结果直接当作执行授权。

---

## 2. 一期可复用能力盘点

### 2.1 盘点与对账

| 能力 | 代码位置 | 二期用途 | 不应重复实现 |
|---|---|---|---|
| 根枚举、识别、去重 | `kernel/core/inventory/discover.ts` | 生成物理副本观察与 `physical_key` | 目录遍历与 `realpath + casefold` |
| 双源对账 | `kernel/dispatch/scan/reconcile.ts`、`kernel/core/host-landings/reconcile.ts` | 生成 before 分类、证据与 drift 原因 | 分类判定与证据等级 |
| 账本读取 | `kernel/store/host-landings/index.ts`、`kernel/store/plugin-registry/index.ts` | 选择记录、校验损坏 | 账本解析与 schema |
| 输出聚合 | `kernel/dispatch/scan/aggregate.ts` | 生成预览中的宿主 / 路径 / 共享消费方 | 重新计数 |

结论：动作选择键应直接来自 `InventoryCopyObservation` / `MissingInventoryCopy`：

- `physical_key`：去重与动作组的主键；
- `path` / `target_path`：物理副本位置；
- `host_id` / `sources[].host_id` / `consumed_by`：账本记录与共享根；
- `format` / `visibility` / `content_digest` / `skill_id`：动作前置证据；
- `reconciliation`：before 分类、三轴证据与 drift 原因。

### 2.2 宿主写入与回滚

| 能力 | 代码位置 | 可直接复用 | 限制 |
|---|---|---|---|
| 渲染与落位计划 | `kernel/core/adapters/index.ts`、`plan.ts`、`land.ts` | 生成 skill / rules 目标文件与内容 | `entry` 不落盘 |
| 写前备份与失败回滚 | `kernel/core/adapters/land.ts` 的 `landPlan`、`rollbackLandWrites` | 覆盖 / 新建宿主副本 | 回滚记录在进程内；跨多组需上层编排 |
| 共享根同步 | `kernel/core/host-landings/index.ts` 的 `applyHostLandingRecords` | 同一路径多宿主记录一起更新 | 需要先按物理路径分组 |
| 内置账本提交 | `kernel/dispatch/host/landing-result.ts` | 先物理写入、后账本、账本失败回滚物理 | 当前主要接在 install / update / enable / disable 路径 |
| 插件账本 | `kernel/core/plugins/host.ts`、`kernel/dispatch/host/landing-result.ts` | `upsertPluginLanding` / `savePluginIndex` | 无 digest / visibility 字段 |
| 宿主卸载事务 | `kernel/dispatch/host/uninstall-execute.ts` | 物理副本临时改名 → 两账本提交 → 删除；失败恢复 | 当前要求有账本记录 |
| 原子写 / 锁 | `kernel/store/atomic/index.ts`、`kernel/store/locking/index.ts` | 索引与账本原子写、工作区互斥 | 盘点只读路径不得引入锁 |

### 2.3 工作区生命周期

| 命令 | 现有能力 | 二期缺口 |
|---|---|---|
| `install` | 从含 `skill_meta.yaml` 的来源建立中心库、索引、目标副本，可再 `--host` | 不能从仅含 `SKILL.md` 的宿主副本直接安装；重复 ID 拒绝 |
| `update` | 按来源重新获取或本地刷新；可重分发到 `--host` | 远端来源会触发网络；`--check` 只报告；契约与实现关于“是否创建缺失副本”不一致 |
| `enable` / `disable --host` | 只切换宿主副本可见性；无账本时 adopted 入账 | 不创建副本、不能修复内容、不能选择未纳管副本 |
| `uninstall --host` / `--host all` | 有账本副本的物理清理与两账本孤儿化 | 不能清理无账本历史副本；不能按盘点路径选择损坏 / 未纳管副本 |
| `restore` | 从备份恢复中心库与工作区分发 | 不针对宿主副本；不能把宿主副本作为新来源 |

---

## 3. 缺口矩阵

| 分类 / 需求 | 现有可复用部分 | 缺口 | 风险 |
|---|---|---|---|
| untracked → 工作区 | 可读 `SKILL.md`、`computeChecksum`、`saveIndex`、`copyTree` | 需要从 frontmatter 合成 `skill_meta.yaml`；ID / name / targets / source 规则未定义 | 伪造成“manager 分发”；覆盖既有 ID；丢失用户内容 |
| inferred_consistent → managed | 工作区记录、重渲染摘要、账本 upsert | 缺少只写账本的 track 入口 | 误登记漂移副本 |
| missing → 重分发 | `landPlan`、`runHostLanding`、账本提交 | 缺少按 missing 观察创建的显式路径；`update --host` 契约不一致 | 旧契约说“不新建”，实现却可新建 |
| drift workspace→host | 适配器渲染、`landPlan`、`computeLandingChecksum` | 缺少不拉取来源、按物理副本选择的本地修复入口 | 误触发远端网络或被 `update` 的其他语义干扰 |
| drift host→workspace | 可读宿主内容、`createBackup`、`replaceTree` | 需要保留 `skill_meta.yaml`、更新索引与账本，并把内容规范化 | 用宿主渲染文本覆盖声明字段、猜来源 |
| orphaned（工作区在） | 账本状态机、`landPlan` | 没有显式再激活预览 | 与普通 `enable` / `update` 语义混淆 |
| orphaned（工作区不在） | 无账本副本读取、`copyTree` | 需要 adopt 或 clean 的明确选择 | 自动删除用户残留 |
| corrupt / unreadable | 物理路径、备份、`executeHostUninstall` | 无账本时 `uninstall --host` 拒绝；无修复来源时只能清理 | 把损坏当缺失；无法确定 skill_id |
| not_distributed | 工作区记录、渲染、账本提交 | 没有「首次分发到该宿主」的显式动作 | 批量时误分发到所有宿主 |
| ledger-only missing | 两账本 | 缺少 `forget` 状态转移 | 删除记录后无法审计 |

---

## 4. 同类工具惯例

### 4.1 观察

| 工具 | 公开行为 | 对 M4c 的启发 |
|---|---|---|
| chezmoi | `status` / `diff` / `apply` 将目标状态与源状态比较；`re-add` 把目标侧的改动重新纳入源侧；支持 `--dry-run`、交互确认 | 先展示差异，再让用户选择“以源为准”或“采纳目标改动”；不要自动覆盖 |
| GNU Stow | `--adopt` 可在存在目标文件时把目标移入 package，再建立链接；文档强调冲突与预览 | “adopt” 是真实写操作，必须显式、可回滚，且先展示目标与来源 |
| pacman | `-Qk` / 文件检查用于发现缺失 / 改动；重新安装包是常见修复路径；`-R` 删除包 | 包管理器把“检查”和“修复包”分离；修复不能靠扫描器自动执行 |
| dpkg / apt | `dpkg --verify` / `--audit` 报文件差异；重新安装或 `apt install --reinstall` 恢复包文件 | 权威来源是已安装包 / 声明；不一致默认用重装，不以磁盘副本反向覆盖包元数据 |

外部文档：

- chezmoi `re-add`：<https://www.chezmoi.io/reference/commands/re-add/>
- GNU Stow manual：<https://www.gnu.org/software/stow/manual/stow.html>
- pacman(8)：<https://man.archlinux.org/man/pacman.8.en>
- dpkg(1)：<https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html>

### 4.2 可借鉴的三条原则

1. **检查与动作分离**：读路径只报告差异，写路径有独立命令 / 显式 apply；
2. **方向必须可见**：是“以声明源为准重装”，还是“采纳目标侧改动”，不能由工具自行猜；
3. **删除未纳管内容不是修复**：包管理器不会因为发现一个未登记文件就自动删除；只会报告或要求显式卸载 / 清理。

---

## 5. 命令形态候选

### 5.1 方案 A：扩展现有命令

做法：用 `install --adopt`、`update --repair`、`uninstall --clean` 等分支承载。

优点：指令数保持 16。

缺点：

1. `install` / `update` / `enable` / `uninstall` 的对象和方向各不相同，新增 `--adopt` / `--repair` / `--clean` 会让同一动词承载多个源与真相方向；
2. 需要同时理解 `--host`、`--target`、`--kind`、`--adopt` 的组合矩阵；
3. 既有退出码、确认级别、输出载荷与测试基线都会受到分支污染；
4. 盘点动作需要 `physical_key` / `classification` / `ledger_source` 选择，这些不是现有命令的稳定参数。

结论：不推荐。

### 5.2 方案 B：新增 `reconcile` 动作入口

做法：新增第 17 条指令 `reconcile`，用 `--action` 或子命令表达 `adopt / track / repair / accept / clean / forget`。

优点：

1. 动作方向在名字上可见；
2. 盘点选择键可以成为稳定参数；
3. 预览、apply、确认、回滚与输出可以集中在一处；
4. `scan --inventory` 的只读守卫保持原样。

缺点：

1. 指令数 16 → 17，需要契约、确认表、help、GUI bridge 与测试同步；
2. `reconcile` 仍是宽动作域，必须用严格动作枚举和选择器防止变成“万能写命令”。

结论：**推荐**。

### 5.3 方案 C：新增 `adopt`，其余扩展现有命令

做法：只新增 `adopt`；missing 用 `update --repair`，orphaned / corrupt 用 `uninstall --force`。

优点：对 untracked 的入口最直观。

缺点：

1. 需要同时改三条既有指令；
2. `uninstall --force` 在无账本 / 共享根下难以定义；
3. drift 双向仍然无处表达；
4. 会把“导入”能力和“修复”能力拆成两套预览 / 回滚模型。

结论：不推荐。

### 5.4 推荐语法（待评审）

```text
skill-manager reconcile --action <adopt|track|repair|accept|clean|forget>
  [--path <物理副本路径>]
  [--id <Skill 标识> --host <宿主|all>]
  [--classification <分类>]
  [--root <根路径>]
  [--target <工作区目标标识>]
  [--apply] [--yes] [--dry-run] [--json] [--verbose]
```

约束：

1. 默认是预览，不带 `--apply` 不写任何文件；
2. `--apply --yes` 才允许非交互执行；`--apply` + 无 TTY + 无 `--yes` 返回参数错误；
3. `--path` 是最高优先级精确选择；`--id` + `--host` 是语义选择；`--classification` 只用于安全批处理；
4. 不提供无约束的 `--all`；若要批量，必须至少给出 `--classification` 或 `--root`，且预览逐项列出；
5. `clean` 不允许仅按 `--classification` 批量删除未纳管副本；必须给出 `--path` 或 `--id + --host`；
6. `forget` 只接受确认副本不存在的账本记录。

---

## 6. 契约 / schema 影响

### 6.1 `host_landings` 与 `plugin_index`

`host_landings` 现有字段足以承载 `adopt` / `track` / `repair` / `clean` / `forget`：

- `origin: adopted | distributed`；
- `state: active | orphaned`；
- `content_digest` / `source_checksum` / `source_version` / `source_ref`；
- `visibility` / `format` / `adapter_ref` / `registry_version`。

因此**不建议**为本期动作增加账本字段；动作方向与动作结果属于命令输出，不属于持久账本。`plugin_index.landings` 仍没有 digest / visibility，插件副本的内容一致只能继续按重渲染推断。

### 6.2 `skill_meta` 与 adopt

`skill_meta.yaml` 当前要求 `targets` 至少一项，且 `source` 为必填映射。`adopt` 从宿主副本只能可靠得到：

- frontmatter `name` / `description` / 可选 `version`；
- `SKILL.md` 与附件内容；
- 观测到的可见性。

不能可靠得到来源 URL、ref、原始 targets、依赖声明或作者信息。因此推荐：

1. 由 `--id` 或 frontmatter `name` 生成合法 ID；非法 / 冲突时拒绝；
2. `source: { type: unknown }`，不猜来源；
3. `targets` 使用 **显式 `--target`**，或在单宿主且 host id 可作为目标标识时取该 host id；target 只是工作区目标，不是宿主真实根；
4. `path` 按现有约定生成；
5. `status` 取宿主观测可见性；`version` 仅在符合语义化版本时写入；
6. `adopt` 结束时必须用现有 `validateMetaRecord` 验证合成元数据，失败则不写中心库。

该规则可能要求为 `adopt` 增加一个明确的 target 选择提示，但**不需要在本期修改 `skill_meta` schema**；若评审决定允许“无目标、仅中心库”的 adopted Skill，则必须另立 schema 变更，不并入本批。

### 6.3 结果与问题码

建议新增动作级问题码，复用现有 IO / 备份 / 账本码：

| 码 | 语义 |
|---|---|
| `E-RECONCILE-001` | 动作不支持该分类 / 证据；或分类已经变化，不能执行 |
| `E-RECONCILE-002` | 预览后目标事实变化（路径、摘要、账本状态或分类），拒绝应用旧计划 |
| `E-RECONCILE-003` | 共享根 / 多宿主选择不完整，必须整组选择或拆分 |

备份失败、原子写失败、账本损坏继续分别使用 `E-BAK-*`、`E-IO-*`、`E-LANDING-*`；不为同一失败造第二套错误码。

### 6.4 指令与结果契约

- 指令总数：若采用方案 B，**16 → 17**；
- 需要新增 `reconcile` 的 CLI 契约章节、确认级别与帮助；
- 需要在 `contract/` 增加动作计划 / 结果的数据类型；
- `scan --inventory` 输出不新增动作字段；动作计划由新命令重新读取 / 对账生成，确保不拿过期扫描结果直接执行。

---

## 7. 关键设计候选与建议

| 编号 | 问题 | 候选 | 建议 |
|---|---|---|---|
| D-01 | untracked 导入方向 | 内容读入中心库并重渲染 / 仅登记账本 / 两者拆分 | 采用 `adopt` 内容导入 + `track` 仅账本；不做“只登记但宣称完整纳管” |
| D-02 | drift 以哪边为准 | 总是工作区 / 总是磁盘 / 用户选方向 | 默认 `repair`（工作区）；`accept` 仅处理内容 / 可见性，source/ref 不猜 |
| D-03 | missing | 自动重分发 / 自动删账本 / 用户选择 | 默认 `repair`；显式 `forget` 仅用于副本确认不存在的清理 |
| D-04 | 批量动作 | 全盘 `--all` / 分类批量 / 仅单条 | 先支持分类批量预览 + `--apply` 显式执行；不提供裸 `--all`，删除类仅精确选择 |
| D-05 | 插件副本 | 与内置完全同等 / 只读 / 仅 repair / 仅 clean | 与内置共用动作接口；`track` / `repair` / `clean` / `forget` 可先行，`adopt` / `accept` 待插件宿主来源语义评审 |
| D-06 | 共享根单宿主动作 | 只改选中宿主记录 / 物理删除 / 拒绝 | 物理副本组优先；单宿主删除在仍有其他活跃消费方时拒绝，覆盖写入按整组同步 |

---

## 8. 调研结论

二期不需要重写盘点和对账；需要的是一层**动作计划 + 事务编排 + 预览确认**：

1. 以 `scan --inventory` 的稳定观察为输入；
2. 由纯规划层生成动作项、写入清单、账本变化、前后分类和失败恢复点；
3. 由执行层复用现有 `landPlan` / 账本提交 / 备份 / 原子写 / 锁；
4. 由 CLI / GUI 共同消费同一份计划，默认预览，显式 apply；
5. 把“来源未知”“无法安全选择”“必须整组处理”作为一等结果，而不是用自动修复掩盖。
