# skill-manager 内置宿主分发账本规范

| 项目 | 内容 |
|---|---|
| 文档名称 | skill-manager 内置宿主分发账本规范 |
| 文档路径 | `docs/specification/host-landings.spec.md` |
| 规范版本 | 1 |
| 文档状态 | 待评审 |
| 契约角色 | 第七份契约规范：定义 `<workspace>/host_landings.yaml` 的字段、摘要、状态机、共享根形态与双源读取边界 |
| 机器可读形态 | [`schemas/host_landings.schema.json`](../../schemas/host_landings.schema.json) |
| 上游需求 | [`docs/requirements.md`](../requirements.md) 9.3.7（M4c-R4、M4c-R5、M4c-R8、M-R-18） |
| 关联规范 | [`plugin-format.md`](plugin-format.md) 4.6、[`skill-meta-spec.md`](skill-meta-spec.md) 2.3、[`result-and-exit-codes.md`](result-and-exit-codes.md) 4.2 与 4.3 |

> 本规范只定义数据契约与判定规则，不包含实现代码。文中字段名、枚举、摘要算法、状态转移与问题码均为契约定义。

---

## 1. 文档概述

### 1.1 目的

本规范定义内置宿主分发副本的**唯一权威账本**：`host_landings.yaml`。

账本回答四个问题：

1. skill-manager 曾把哪个 Skill 分发到哪个内置宿主的哪个物理位置；
2. 该副本在落位时的渲染内容摘要、来源摘要、可见性与渲染基线是什么；
3. 该副本当前处于 `active` 还是 `orphaned` 生命周期；
4. 盘点时哪些结论可以标为权威、哪些只能标为推断或无法判定。

### 1.2 适用范围

| 属于本规范范围 | 不属于本规范范围 |
|---|---|
| `host_landings.yaml` 的位置、顶层结构与记录字段 | `skill_index.yaml` 的工作区目标 `targets[]` |
| 内置宿主副本的内容摘要与来源摘要口径 | `plugin_index.yaml` 的插件记录与 `landings` 结构 |
| 落位、切换可见性、卸载与重装的状态转移 | 指令参数解析、确认级别与输出封装的实现 |
| 共享物理根的账本形态与读取层去重边界 | 宿主根解析、`root_role` 判定与目录发现深度 |
| `E-LANDING-001` / `E-LANDING-002` 的触发边界 | M4c 盘点结果的具体字段与 GUI 布局 |
| 与插件账本的双源权威等级 | 未纳管导入与缺失修复动作 |

### 1.3 术语

| 术语 | 定义 |
|---|---|
| 内置宿主 | 随内核注册表交付、`host_id` 不以 `x-` 开头的宿主 |
| 落位记录 | `landings[]` 中的一条记录，对应一个 Skill 在一个内置宿主上的一个物理目标 |
| 物理目标 | `target_path` 指向的技能目录（`format: skill`）或规则文件（`format: rules`） |
| 共享根 | 多个宿主读取同一物理目录的宿主根 |
| 活跃记录 | `state: active` 的落位记录；账本断言该副本应存在并受 manager 管理 |
| 孤儿记录 | `state: orphaned` 的落位记录；账本不再断言副本存在，仅保留审计轨迹 |
| 规范化落位视图 | 把禁用标记还原为可见文件名后的渲染文件集合；用于计算 `content_digest` |
| 来源摘要 | 工作区中心库原件目录按既有完整性算法计算的 `source_checksum` |
| 权威等级 | `authoritative` / `inferred` / `insufficient`；按 managed、content、source 三个维度分别标注 |
| 消费宿主 | 读取某个物理根的宿主集合；由注册表与配置推导，不写入账本 |

---

## 2. 载体与全局不变量

### 2.1 载体与位置

| 项目 | 规定 |
|---|---|
| 文件名 | `host_landings.yaml` |
| 位置 | `<workspace>/host_landings.yaml`，与 `skill_index.yaml`、`plugin_index.yaml` 同级 |
| 数量 | 每个工作区至多一份；缺失表示尚未写入过任何内置宿主副本 |
| 所有者 | 内核写入；用户与外部程序不得直接编辑 |
| 读取者 | 内核分发生命周期与 M4c 只读盘点 |
| 编码 | UTF-8，LF 行尾 |

`host_landings.yaml` 与另外两份数据的分工是固定的：

| 数据 | 权威范围 | 不是 |
|---|---|---|
| `skill_index.yaml` 的 `targets[]` | 工作区内的目标投影 | 宿主分发账本 |
| `host_landings.yaml` | 内置宿主的副本、摘要、可见性与生命周期 | 工作区目标，也不是插件账本 |
| `plugin_index.yaml` 的 `landings` | `x-` 插件宿主的副本与生命周期 | 内置宿主账本 |

M4c 读取层可以合并两源形成统一视图，但不得把两源写回同一文件，也不得用一个确定性字段掩盖两源的权威差异。

### 2.2 顶层字段

| 字段 | 类型 | 必填 | 取值与约束 |
|---|---|---|---|
| `schema_version` | 字符串 | 是 | 固定 `"1"`；读取到更高版本时拒绝使用 |
| `tool_version` | 字符串 | 是 | 写入该账本的工具版本，语义化版本前缀 |
| `generated_at` | 时间 | 是 | 最近一次账本写入时间；UTC 秒级 |
| `landings` | 数组 | 是 | 落位记录；无记录时为空数组，不得省略 |

顶层与记录均允许携带未知字段；读取方必须保留未知字段，不得在重写时静默丢弃。

### 2.3 原子写与损坏处理

1. 写入必须沿用工作区既有的原子写原语：临时文件落盘、刷盘、原子替换；不得直接截断目标文件。
2. 账本使用独立锁，锁对象为 `host_landings.yaml` 自身；不得复用 `skill_index.yaml` 的锁。
3. 写前必须先读取现有账本。现有文件不可读、无法解析、版本不受支持或主键重复时，**拒绝写入**，不得覆盖可能可恢复的数据，返回 `E-LANDING-001`。
4. 账本写入与宿主副本写入属于同一个可回滚操作：账本写失败时，宿主副本必须恢复到写前状态；不允许留下「副本已写、账本无记录」的半截状态。
5. 账本不存在按空账本读取，不触发 `E-LANDING-001`；首次需要写入时创建。
6. 读取失败时不得崩溃、不得猜测记录、不得返回半份解析结果。

### 2.4 全局不变量

1. 同一 `skill_id + host_id + target_path` 至多一条记录。
2. 同一 `target_path` 只能对应一个 `skill_id`；出现不同 `skill_id` 时账本不可信，报 `E-LANDING-001`，不得按任一条继续分类。
3. 同一 `target_path` 的全部 `active` 记录必须具有相同的 `content_digest` 与 `visibility`；不一致时账本不可信，报 `E-LANDING-001`。
4. `state: active` 表示账本断言副本应存在；`state: orphaned` 表示账本不再断言副本存在，仅保留审计信息。
5. `root_role`、`root_id`、消费宿主集合与宿主根来源不写入记录；它们由注册表与配置在读取时判定。
6. 账本不保存凭据、令牌、Skill 正文或宿主配置内容。

---

## 3. 落位记录

### 3.1 记录字段

| 字段 | 类型 | 必填 | 取值与约束 | 写入来源 |
|---|---|---|---|---|
| `skill_id` | 字符串 | 是 | 小写字母、数字与短横线；1 ~ 128 字符 | 工作区 Skill 标识 |
| `source_version` | 字符串 | 否 | 1 ~ 128 字符；省略表示来源没有可比较版本 | 工作区记录 / 元文件 |
| `source_ref` | 字符串 | 否 | 1 ~ 256 字符；省略表示来源没有可比较引用 | 工作区来源声明 |
| `host_id` | 字符串 | 是 | 内置宿主标识；1 ~ 32 字符；不得以 `x-` 开头 | 宿主注册表 |
| `target_path` | 字符串 | 是 | 绝对路径；1 ~ 4096 字符；不得含空字节 | 落位解析结果 |
| `format` | 枚举 | 是 | `skill` / `rules` | 适配器形态 |
| `visibility` | 枚举 | 是 | `visible` / `disabled`；`rules` 只允许 `visible` | 副本实际标记 |
| `state` | 枚举 | 是 | `active` / `orphaned` | 生命周期 |
| `origin` | 枚举 | 是 | `distributed` / `adopted` | 当前活跃生命周期的来源 |
| `source_checksum` | 字符串 | 是 | `sha256:` 加 64 位小写十六进制 | 工作区中心库原件 |
| `content_digest` | 字符串 | 是 | `sha256:` 加 64 位小写十六进制 | 规范化落位视图 |
| `adapter_ref` | 字符串 | 是 | 1 ~ 128 字符；小写字母、数字、点、下划线、短横线 | 渲染适配器标识 |
| `registry_version` | 字符串 | 是 | 1 ~ 64 字符 | 写入时的宿主注册表版本 |
| `created_at` | 时间 | 是 | UTC 秒级 | 首次入账时间 |
| `updated_at` | 时间 | 是 | UTC 秒级；不得早于 `created_at` | 最近变更时间 |

`format` 只允许可落盘的 `skill` 与 `rules`。`entry`（如 `agents-md`）只产出待合并片段，不产生宿主副本，因此不属于本账本；不得伪造 `entry` 记录或 `target_path`。

### 3.2 主键与共享根

**唯一键**：`skill_id + host_id + target_path`。

1. 同一 Skill 在同一宿主、同一物理目标只保留一条记录；重复写入按更新处理，保留 `created_at`。
2. 同一 Skill 在同一宿主的不同物理根（例如 user 与 system 根）可以各有一条记录，因为 `target_path` 不同。
3. 不同宿主共享同一物理目标时，按 `host_id` 各记一条，`target_path` 相同；账本**不去重**。
4. 读取层按真实物理路径去重，并保留每个宿主的视图与消费宿主标注。
5. 同一 `target_path` 出现不同 `skill_id`，或同一 `target_path` 的活跃记录摘要 / 可见性不一致，均判定账本不可信，返回 `E-LANDING-001`。

### 3.3 不写入账本的根属性

`root_role`、`root_id`、`root_origin` 不进入记录，理由如下：

1. 角色与根标识是宿主根的属性，不是某次落位的事实；同一 `target_path` 的语义可能随配置覆盖或注册表修订变化。
2. 把角色固化进账本会形成第二套权威；配置改变后账本会与注册表冲突，盘点无法判断应以哪一方为准。
3. 读取层以 `host_id + target_path` 定位副本，再由注册表与配置解析 `root_role`、`root_id` 与消费宿主；账本只保存不会因根语义变化而失真的落位事实。

---

## 4. 内容摘要与来源摘要

### 4.1 算法唯一来源

本规范**不定义新的哈希算法**。`content_digest` 与 `source_checksum` 均复用 [`kernel/core/integrity/index.ts`](../../kernel/core/integrity/index.ts) 的 `collectHashEntries` / `computeChecksum` 口径：

1. 算法为 SHA-256，表示形式为 `sha256:` 加 64 位小写十六进制；
2. 参与文件按相对路径的 UTF-8 字节序升序排列；
3. 逐文件以「相对路径 UTF-8 字节、一个空字节、文件字节流」累加；
4. 全部文件按序累加后只做一次 SHA-256；
5. 不跟随符号链接；`.git`、`node_modules`、以点开头的文件、`.tmp`、`.bak`、`~` 结尾的文件不参与；
6. `skill_meta.yaml` 不参与；空目录不贡献文件，但仍按空输入产生稳定摘要；
7. 不把 mtime、atime、权限位、文件大小或路径大小写规范化纳入摘要。

### 4.2 规范化落位视图

`content_digest` 覆盖**宿主渲染落位后的应有文件**，不是工作区原件。计算前先构造规范化落位视图：

1. `format: skill` 时，递归收集 `target_path` 目录下的参与文件；`format: rules` 时，只收集 `target_path` 指向的规则文件。
2. 可见性标记规范化：`SKILL.md.disabled` 按 `SKILL.md` 参与；规则文件的 `<name>.disabled` 按 `<name>` 参与。
3. 规范化后若出现重复相对路径（可见标记与禁用标记同时存在），判为可见性冲突，不得计算摘要。
4. 规范化后的相对路径统一使用 `/` 分隔，再按 UTF-8 字节序排序。
5. 按 4.1 的同一累加口径计算一次 SHA-256。
6. `enable` / `disable` 只改变文件名的禁用后缀，不改变 `content_digest`；可见性由 `visibility` 字段单独表达。

**禁止**：

1. 先对每个文件单独求哈希、再对哈希列表求第二次聚合哈希；
2. 用工作区原件摘要冒充 `content_digest`；
3. 用 mtime 或目录遍历顺序代替内容摘要；
4. 为账本另造一套排除规则。

### 4.3 来源摘要

`source_checksum` 是对工作区中心库原件目录按 4.1 算法计算的摘要，写入时取当时的工作区记录值。它回答「落位时工作区原件是什么」，不回答「宿主副本是否与原件逐字节相同」；宿主副本的一致性只由 `content_digest` 判定。

### 4.4 缺失与孤儿

1. `state: active` 且 `target_path` 不存在时，不计算空摘要，也不把 `content_digest` 改写为空输入摘要；该记录进入「缺失」判定。
2. `state: orphaned` 保留最后一次成功落位时的 `content_digest` 与 `source_checksum`，供审计；它不参与当前副本的四分类计数。
3. 目标存在但不可读、类型与 `format` 不符或可见性标记矛盾时，不得返回一个看似正常的摘要；该条目进入不可读 / 无法判定状态，账本层面的结构冲突按 2.4 处理。

---

## 5. 共享物理根

### 5.1 账本形态

设 Codex 与 Cursor 都读取 `~/.agents/skills`，同一 Skill 落位到该目录：

```yaml
schema_version: '1'
tool_version: 0.4.0
generated_at: 2026-10-18T00:00:00Z
landings:
  - skill_id: code-review
    host_id: codex
    target_path: /home/u/.agents/skills/code-review
    # 其余字段相同
  - skill_id: code-review
    host_id: cursor
    target_path: /home/u/.agents/skills/code-review
    # 其余字段相同
```

两条记录共享 `target_path`，但 `host_id` 不同，因此不违反唯一键。

### 5.2 共享根的物理一致性

共享根上的副本只有一个，任何物理变更都会同时影响全部消费宿主。因此：

1. 分发到共享根时只写一次副本，但为每个参与宿主 upsert 一条记录；
2. `enable` / `disable --host` 改变的是物理副本，必须同步更新同一 `target_path` 的全部 `active` 记录；输出必须列出实际受影响的宿主；
3. `update --host` 重渲染共享副本后，必须同步更新同一 `target_path` 的全部 `active` 记录；
4. `uninstall --host <host>` 在共享根仍被其他 `active` 宿主消费时**必须拒绝**，返回 `E-LANDING-001`，提示使用 `uninstall <id> --host all`；不得只删除一条记录而让副本继续被该宿主读取；
5. `uninstall <id> --host all` 对共享副本只删除一次，并把全部相关记录标为 `orphaned`。

读取层按真实路径去重后，同一物理技能只计一次唯一技能；每个宿主视图保留自己的 `host_id`、`visibility`、分类与证据。消费宿主集合由注册表与配置推导，不从账本推断。

---

## 6. 状态机

### 6.1 状态定义

| 状态 | 语义 | 是否参与四分类 | 是否阻断原件卸载 |
|---|---|---|---|
| `active` | 账本断言副本应存在，且由 manager 管理 | 是 | 是 |
| `orphaned` | 账本不再断言副本存在，仅保留审计轨迹 | 否 | 否 |

`origin` 描述当前活跃生命周期的来源：

| 取值 | 含义 |
|---|---|
| `distributed` | 由内核在本次或最近一次落位 / 重渲染中写入 |
| `adopted` | 内核只接管了既有副本的可见性状态，没有重写其内容 |

### 6.2 状态转移表

| 事件 | 前置 | `state` | `visibility` | `origin` | 记录动作 |
|---|---|---|---|---|---|
| `install --host` 成功落位 | 无记录 | `active` | `visible` | `distributed` | 新建；`created_at = updated_at = now` |
| `update --host` 成功重落位 | 无记录 / `active` / `orphaned` | `active` | `visible` | `distributed` | upsert；保留已有 `created_at` |
| `enable --host` 成功 | 无记录 + 副本存在 | `active` | `visible` | `adopted` | 新建；`created_at = updated_at = now` |
| `enable --host` 成功 | `active` / `orphaned` | `active` | `visible` | 保持 | 更新 `updated_at` |
| `disable --host` 成功 | 无记录 + 副本存在 | `active` | `disabled` | `adopted` | 新建；`created_at = updated_at = now` |
| `disable --host` 成功 | `active` / `orphaned` | `active` | `disabled` | 保持 | 更新 `updated_at` |
| `uninstall --host <host>` 成功 | `active`，且不是共享根冲突 | `orphaned` | 保持最后已知值 | 保持 | 删除副本；保留记录并更新 `updated_at` |
| `uninstall --host <host>` 成功 | `active`，但副本已不存在 | `orphaned` | 保持最后已知值 | 保持 | 不创建副本；保留记录并更新 `updated_at` |
| `uninstall --host <host>` 成功 | 无记录，但历史副本存在 | — | — | — | 删除副本；不新建账本，输出 `legacy: true` |
| `uninstall --host all` 成功 | 任意，含 `x-` 宿主 | `orphaned` | 保持 | 保持 | 删除该 Skill 的全部宿主副本；`host_landings` 与 `plugin_index.landings` 的相关记录均转 `orphaned` |
| `uninstall <id>` / `uninstall <id> --hard` | 仍存在任一 `active` 记录 | 不变 | 不变 | 不变 | 阻断，返回 `E-LANDING-002` |
| `uninstall <id>` / `uninstall <id> --hard` 成功 | 无 `active` 记录 | — | — | — | 删除工作区记录后，物理清除该 `skill_id` 的全部 `orphaned` 记录 |
| `uninstall --kind plugin` | 插件卸载 | 不变 | 不变 | 不变 | 本账本不变；插件 `landings` 按 `plugin-format.md` 标 `orphaned` |
| `restore` | 任意 | 不变 | 不变 | 不变 | 不写账本；恢复后的内容差异由下一次盘点判漂移 |
| `scan --inventory` | 任意 | 不变 | 不变 | 不变 | 纯只读，不写账本 |

### 6.3 共享根的转移约束

1. 可见性切换与重渲染按 5.2 同步全部共享记录；只更新目标宿主的一条记录属于账本损坏。
2. 单宿主卸载遇到共享消费者时拒绝；不把「删除一条记录」当作卸载成功。
3. `--host all` 是共享副本的唯一单命令清理入口；它不删除工作区原件。

### 6.4 失败与回滚

| 失败点 | 结果 |
|---|---|
| 宿主副本备份失败 | 不写副本、不写账本；保持原状态 |
| 副本写入失败 | 回滚已写内容；不写账本 |
| 账本写入失败 | 回滚宿主副本到写前状态；返回 `E-IO-002`（或底层 `E-IO-001`） |
| 回滚失败 | 返回 `E-LANDING-001`，并把宿主副本与账本的实际状态原样报告；不得声称已回滚 |
| 账本读前损坏 | 拒绝写入，返回 `E-LANDING-001`；不覆盖原文件 |
| 共享根单宿主卸载被拒 | 不删除副本、不改账本、不改其他宿主记录 |

---

## 7. 双源读取模型与权威等级

### 7.1 统一读取视图

M4c 读取层把内置账本与插件账本合并为如下字段形状。本规范只定义形状与权威边界，不定义盘点输出布局。

| 字段 | 类型 | 说明 |
|---|---|---|
| `ledger_source` | 枚举 | `host_landings` / `plugin_landings` / `none` |
| `skill_id` | 字符串 | Skill 标识 |
| `host_id` | 字符串 | 宿主标识；插件宿主为 `x-...` |
| `host_key` | 字符串 / 省略 | 仅插件账本 |
| `plugin_id` | 字符串 / 省略 | 仅插件账本 |
| `target_path` | 字符串 | 物理目标 |
| `format` | 枚举 / 省略 | 内置账本为 `skill` / `rules`；插件账本未记录时省略 |
| `state` | 枚举 | `active` / `orphaned` |
| `visibility` | 枚举 / 省略 | `visible` / `disabled`；插件账本未记录时省略 |
| `content_digest` | 字符串 / 省略 | 仅内置账本 |
| `source_checksum` | 字符串 / 省略 | 仅内置账本 |
| `source_version` | 字符串 / 省略 | 仅内置账本 |
| `source_ref` | 字符串 / 省略 | 仅内置账本 |
| `adapter_ref` | 字符串 / 省略 | 仅内置账本 |
| `registry_version` | 字符串 / 省略 | 仅内置账本 |
| `origin` | 枚举 / 省略 | 仅内置账本 |

读取层必须同时输出三个证据维度，不得压成一个布尔值：

```text
evidence:
  managed: authoritative | inferred | insufficient
  content: authoritative | inferred | insufficient
  source:  authoritative | inferred | insufficient
```

### 7.2 权威边界

| 数据来源 | managed | content | source | missing |
|---|---|---|---|---|
| `host_landings` `active` | 权威 | 权威（`content_digest`） | 权威（`source_checksum` / 版本） | 权威：账本声明应存在且根可读、路径不存在 |
| `plugin_index.landings` `active` | 权威 | 推断：必须按当前注册表与适配器确定性重渲染后比对 | 推断：账本无来源摘要 | 权威：账本声明应存在且根可读、路径不存在 |
| 无账本、工作区记录可读 | 推断 | 推断：确定性重渲染 | 推断 | 不得判缺失 |
| 无账本、无可复现基线 | 不足 | 不足 | 不足 | 不得判缺失 |
| 账本损坏 / 版本不受支持 | 不足 | 不足 | 不足 | 不得判缺失 |
| 无工作区 | 不足 | 不足 | 不足 | 不得判缺失 |
| `orphaned` | 不参与 | 不参与 | 不参与 | 不参与 |

硬约束：

1. 插件账本没有 `content_digest`，不得因为「路径存在」就判「已纳管且一致」；内容一致性只能标 `inferred`。
2. 内置账本损坏时，其全部记录标 `insufficient`；不得回退到「工作区记录 + 猜测」并冒充权威。
3. 无账本历史副本只能标 `inferred_consistent` / `inferred_drift` / `untracked` / `undetermined`，不得标 `missing`。
4. 输出中的每条结论必须带 `ledger_source` 与三个证据维度；不得把双源数据混成同一确定性。

---

## 8. 问题码

### 8.1 `E-LANDING-001`：内置宿主账本或共享副本状态不可安全处理

| 项目 | 规定 |
|---|---|
| 级别 | 错误 |
| 退出码 | 1 |
| 触发 | `host_landings.yaml` 不可读、无法解析、`schema_version` 不受支持、主键重复、记录不符合本规范，或同一物理目标出现互相矛盾的活跃记录 |
| 副本绑定异常 | `format: skill` 的 `target_path` 是普通文件、`format: rules` 的 `target_path` 是目录，或共享根单宿主卸载会破坏其他活跃宿主时，同样触发本码 |
| 不触发 | 路径单纯不存在（判 `missing`）；内容字节不同（判 `drift`）；可见性不同（判 `drift`）；账本缺失（按空账本）；账本以外的普通文件读写失败（按 `E-IO-*`） |
| 可读消息 | `内置宿主分发账本或共享副本状态不可安全处理：<路径>（<原因>）` |
| 可执行修复建议（账本损坏） | `备份后修复或移除 <workspace>/host_landings.yaml，再重新执行对应的 --host 分发操作重建账本` |
| 可执行修复建议（共享根冲突） | `执行 skill-manager uninstall <id> --host all，一次清理共享副本与全部相关记录` |

本码不使用 `E-YAML-001` / `E-VER-001` / `E-IO-001` 表达，因为后三者的对象分别是通用 YAML、工作区索引版本与通用文件读写；本码的对象是「账本能否作为宿主分发的权威事实源」。底层原因写入 `cause`，不改变问题码。

### 8.2 `E-LANDING-002`：原件卸载被宿主账本阻断

| 项目 | 规定 |
|---|---|
| 级别 | 错误 |
| 退出码 | 1 |
| 触发 | `uninstall <id>` 或 `uninstall <id> --hard` 执行前，`host_landings` 或 `plugin_index.landings` 仍存在该 Skill 的 `active` 记录 |
| 检查范围 | 两个账本同时检查；任一命中即阻断；`orphaned` 不阻断 |
| 不触发 | `uninstall <id> --host <host>`；`uninstall <id> --host all`；`uninstall --kind plugin` |
| 可读消息 | `无法卸载 <id>：仍有 <N> 个活跃宿主副本（<host_id...>）` |
| 可执行修复建议 | `先执行 skill-manager uninstall <id> --host <host> 逐宿主清理，或执行 skill-manager uninstall <id> --host all 一次清理全部宿主副本；确认后再卸载原件` |

本码与 `E-LANDING-001` 的边界是固定的：001 是「账本或绑定本身不可用」，002 是「账本可用且明确阻止原件卸载」。两者不得互换，也不得用 002 表达账本损坏。

---

## 9. 生命周期、备份与兼容

### 9.1 初始化

`init` 创建空的 `host_landings.yaml`：

```yaml
schema_version: '1'
tool_version: <当前工具版本>
generated_at: <UTC 秒级时间>
landings: []
```

本节定义 `init` 的目标形态；具体写入由账本实现批次完成。

### 9.2 export / import

`host_landings.yaml` **不纳入** `export` / `import`，理由：

1. 账本含本机绝对路径与宿主运行时事实；跨机器导入会把另一台机器的副本伪造成当前机器的 managed / missing；
2. 导出物的语义是可移植的 Skill 内容与声明，账本不是可移植内容；
3. 导入方重新执行分发即可建立本机真实账本，而不是继承外来事实。

### 9.3 备份与恢复

1. 卸载前的内容备份载体不包含 `host_landings.yaml`；备份对象是 Skill 内容。
2. `restore` 不恢复账本。恢复后的内容与账本摘要不一致时，下一次盘点判 `drift`，由用户重新分发。
3. 账本本身由工作区持有；工具不提供单独的账本导出 / 恢复命令。

### 9.4 v0.3.0 及更早工作区

1. 账本不存在时按空账本读取；盘点、`list`、`validate` 不因缺失而失败。
2. 不自动创建、不批量回填、不做破坏性迁移。
3. 首次 `install` / `update` / `enable` / `disable --host` 成功时创建文件。
4. 历史宿主副本没有账本，只能走推断路径，并显式标注「账本缺失，按工作区记录推断」。
5. `plugin_index.landings` 原样保留，不迁移到 `host_landings.yaml`。

---

## 10. 校验规则

| 编号 | 规则 | 失败处理 |
|---|---|---|
| HL-01 | 文件名为 `host_landings.yaml`，位于工作区根 | 不读取 |
| HL-02 | 顶层必填 `schema_version` / `tool_version` / `generated_at` / `landings` | `E-LANDING-001` |
| HL-03 | `schema_version` 必须为 `"1"` | `E-LANDING-001` |
| HL-04 | `skill_id + host_id + target_path` 唯一 | `E-LANDING-001` |
| HL-05 | `host_id` 是内置宿主标识，且不以 `x-` 开头 | `E-LANDING-001` |
| HL-06 | `target_path` 是绝对路径，长度不超过 4096，不含空字节 | `E-LANDING-001` |
| HL-07 | `format` 只能是 `skill` / `rules`；`entry` 不得入账 | `E-LANDING-001` |
| HL-08 | `visibility` 只能是 `visible` / `disabled`；`rules` 只能为 `visible` | `E-LANDING-001` |
| HL-09 | `source_checksum` / `content_digest` 为 `sha256:` 加 64 位小写十六进制 | `E-LANDING-001` |
| HL-10 | `created_at` / `updated_at` 为 UTC 秒级，且 `updated_at` 不早于 `created_at` | `E-LANDING-001` |
| HL-11 | `state` 只能是 `active` / `orphaned`；`orphaned` 不参与四分类与卸载阻断 | 按状态语义处理 |
| HL-12 | 同一 `target_path` 只能对应一个 `skill_id`，活跃记录摘要 / 可见性一致 | `E-LANDING-001` |
| HL-13 | 共享根单宿主卸载不得破坏其他活跃宿主 | `E-LANDING-001` |
| HL-14 | 未知字段读取时保留，重写时不得丢弃 | 契约测试断言 |
| HL-15 | `origin` 只能是 `distributed` / `adopted` | `E-LANDING-001` |

---

## 11. 示例

### 11.1 最小合法账本

```yaml
schema_version: '1'
tool_version: 0.4.0
generated_at: 2026-10-18T00:00:00Z
landings:
  - skill_id: code-review
    source_version: 1.2.0
    source_ref: main
    host_id: claude
    target_path: /home/user/.claude/skills/code-review
    format: skill
    visibility: visible
    state: active
    origin: distributed
    source_checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    content_digest: sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
    adapter_ref: claude
    registry_version: '1'
    created_at: 2026-10-18T00:00:00Z
    updated_at: 2026-10-18T00:00:00Z
```

### 11.2 共享根

```yaml
schema_version: '1'
tool_version: 0.4.0
generated_at: 2026-10-18T00:00:00Z
landings:
  - skill_id: code-review
    host_id: codex
    target_path: /home/user/.agents/skills/code-review
    format: skill
    visibility: visible
    state: active
    origin: distributed
    source_checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    content_digest: sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
    adapter_ref: codex
    registry_version: '1'
    created_at: 2026-10-18T00:00:00Z
    updated_at: 2026-10-18T00:00:00Z
  - skill_id: code-review
    host_id: cursor
    target_path: /home/user/.agents/skills/code-review
    format: skill
    visibility: visible
    state: active
    origin: distributed
    source_checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    content_digest: sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
    adapter_ref: cursor
    registry_version: '1'
    created_at: 2026-10-18T00:00:00Z
    updated_at: 2026-10-18T00:00:00Z
```

### 11.3 禁用与孤儿

```yaml
schema_version: '1'
tool_version: 0.4.0
generated_at: 2026-10-18T00:00:00Z
landings:
  - skill_id: code-review
    host_id: claude
    target_path: /home/user/.claude/skills/code-review
    format: skill
    visibility: disabled
    state: active
    origin: adopted
    source_checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    content_digest: sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
    adapter_ref: claude
    registry_version: '1'
    created_at: 2026-10-18T00:00:00Z
    updated_at: 2026-10-18T00:00:00Z
  - skill_id: code-review
    host_id: codex
    target_path: /home/user/.agents/skills/code-review
    format: skill
    visibility: visible
    state: orphaned
    origin: distributed
    source_checksum: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    content_digest: sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
    adapter_ref: codex
    registry_version: '1'
    created_at: 2026-10-18T00:00:00Z
    updated_at: 2026-10-18T00:00:00Z
```

---

## 12. 需求追溯

| 需求 | 本规范承载 |
|---|---|
| M4c-R4 对账四分类 | 第 4、6、7 章：权威摘要、状态机、双源证据等级 |
| M4c-R5 只读边界 | 9.1 与 6.2：盘点不写账本；账本是生命周期写入对象 |
| M4c-R8 插件范围 | 1.2、7.1：本账本只覆盖内置宿主；插件走 `plugin_index.landings` |
| M-R-18 缺失误判 | 4.4、7.2：只有 `active` 内置账本或插件账本可判缺失；无账本不得判缺失 |
| M-R-17 共享根重复 | 3.2、5 章：账本按宿主各记一条，读取层物理去重 |
| M-R-20 只读误触写路径 | 6.2：`scan --inventory` 不写本账本 |

---

## 13. 修订记录

| 序号 | 日期 | 修订点 |
|---|---|---|
| 1 | 2026-10-18 | 首次定稿：七份规范中的第七份；定义 `host_landings.yaml` 字段、摘要、共享根、状态机、双源权威等级与 `E-LANDING-001` / `E-LANDING-002` |

---

**文档结束。** 本规范只定义内置宿主分发账本的数据契约与判定规则，不包含实现代码。
