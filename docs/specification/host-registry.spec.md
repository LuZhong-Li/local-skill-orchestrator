# skill-manager 宿主注册表规范

| 项目 | 内容 |
|---|---|
| 文档名称 | skill-manager 宿主注册表规范 |
| 文档路径 | `docs/specification/host-registry.spec.md` |
| 规范版本 | 1 |
| 文档状态 | 待评审 |
| 契约角色 | 第五份契约规范：定义宿主注册表的文件级契约、字段与校验规则 |
| 机器可读形态 | [`schemas/host_registry.schema.json`](../../schemas/host_registry.schema.json) |
| 关联文档 | [`docs/requirements.md`](../requirements.md) 9.3.6；[`docs/design/m5-host-adapter.md`](../design/m5-host-adapter.md)；[`docs/research/host-mechanisms.md`](../research/host-mechanisms.md) |

> 本规范只定义数据契约与校验规则，不包含实现代码，也不定义格式映射规则（映射规则属适配器设计，见设计文档第 5 章）。

> **与第三方插件视图的边界（M4b）**：本规范只定义随内核交付的**内置注册表**；它是内置宿主不可变事实源，也是合并视图中内置部分的唯一来源。第三方插件通过独立的 `plugin.json` 与 `plugin_index.yaml` 贡献 `x-<plugin_id>-<host_key>` 宿主 profile，由 `docs/specification/plugin-format.md` 定义；合并视图不得回写本注册表、不得改变本规范条目的字段或顺序。

---

## 1. 文档概述

### 1.1 文档目的

宿主注册表是宿主适配层的**唯一事实源**：渲染与落位行为必须由注册表条目推导，不得在别处硬编码宿主差异。本规范定义该注册表的载体、字段、取值域、不变量与校验规则，供内核实现、契约测试与评审共同引用。

### 1.2 适用范围

1. 适用于随内核交付的 `host_registry.yaml`（下称「注册表」）；
2. 适用于注册表的结构校验与字段一致性断言（契约测试）；
3. **不适用**于：宿主格式映射规则、规则文件的合并策略、指令语法与选项（后者的登记落在指令契约规范）。

### 1.3 术语定义

| 术语 | 定义 |
|---|---|
| 宿主 | 能识别并加载技能或规则文件的 agent 产品（如 Claude、Codex、Cursor、豆包） |
| 宿主标识 | `host_id`，注册表条目的主键，同时是 `--target` 的取值 |
| 落位根 | 宿主读取技能或规则文件的位置；技能根与规则路径分条登记 |
| 消费宿主 | 会读取某个落位根的宿主；一个落位根可被多个宿主消费（重叠消费为特性而非冲突） |
| 透传白名单 | 允许写入宿主产物的非标准字段集合（`render_policy.allowed_extensions`） |
| 降级形态 | 宿主无 skill 机制时采用的替代载体形态（规则文件或指令文件条目） |
| 证据等级 | 支撑条目事实的来源强度分级（见 4.2 节） |

### 1.4 与上游文档的关系

1. 本规范落实需求文档 9.3.6 的 **M5-R1、M5-R3、M5-R4、M5-R8、M5-R9** 与设计文档的 **DP-03、DP-04**；
2. 本规范的建立方式（新增第五份规范而非并入既有规范）见设计文档 9.3 决策点 DP-03 的裁决与第 7 章契约变更清单；
3. 既有四份契约规范的内容与版本不因本规范而变更。

---

## 2. 载体与全局不变量

### 2.1 载体与位置

| 项目 | 说明 |
|---|---|
| 载体形态 | **类型化数据模块**（本期实现，随内核打包）或 `host_registry.yaml` 文档；两种形态的字段契约与校验规则完全相同 |
| 文件名 | 类型化数据模块为 `kernel/core/hosts/registry-data.ts`；文档形态为 `host_registry.yaml` |
| 位置 | **随内核交付**（内核包内的数据文件）；**不位于工作区**，一期与二期的工区布局不变 |
| 数量 | 每个内核版本有且仅有一份 |
| 权限 | 只读资产：由内核随版本更新，用户不编辑；如需用户自定义，另按变更流程立项 |
| 权威性 | 宿主差异（落位根、能力、渲染策略、透传白名单）以本文件为权威来源 |

### 2.2 全局不变量

1. `host_id` 在文档内唯一，且与 `--target` 取值一一对应；
2. 一个宿主的技能根与规则路径**分条登记**，不得合并为一条；
3. 任一落位根的消费宿主集合必须显式登记（未登记的消费关系视为登记缺陷）；
4. 支持状态为「机制已确认」的条目必须携带一手证据等级；
5. **安全控制字段按宿主语义证据准入**：`disable-model-invocation` 等安全控制字段，只有在 `render_policy.security_control_evidence` 中逐字段登记了**已确认语义**与**一手证据**的宿主，才允许进入该宿主的透传白名单；未登记者一律禁止（HR-09）；
6. **外部消费方须显式登记**：非本注册表宿主（如 `dsh`）只有在顶层 `external_consumers` 中登记（含一手证据来源）后，才可出现在 `consumed_by` / `root_consumed_by` 中（HR-07、HR-13）；
7. 注册表不含任何凭据、令牌或个人标识。

### 2.3 写入权限

| 数据 | 写入者 |
|---|---|
| 注册表全文 | 内核（随版本交付）；用户与外部程序不得写入 |
| 条目的证据等级与来源 | 内核维护；变更以调研补记为依据 |

---

## 3. 宿主注册表文档（`host_registry.yaml` 或等价的类型化数据模块）

### 3.1 顶层结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `registry_version` | 字符串 | 必填 | 注册表格式版本标识 | 当前取值 `1`；不兼容变更递增，见 7.2 节 |
| `generated_at` | 字符串 | 可选 | 注册表生成时间 | 协调世界时秒级，格式见 2.4 节同名约束（`YYYY-MM-DDTHH:MM:SSZ`） |
| `hosts` | 映射数组 | 必填 | 宿主条目列表 | 至少一项；`host_id` 不得重复；结构见 3.2 节 |
| `external_consumers` | 映射数组 | 可选 | 非宿主外部消费方（会读取落位根但不作为适配对象的产品） | 每项 `id` 不得与任何 `host_id` 重复；结构见 3.8 节 |

### 3.2 条目字段

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `host_id` | 字符串 | 必填 | 宿主标识 | 全小写字母、数字与短横线；不超过 64 字符；文档内唯一；同时作为 `--target` 取值 |
| `display_name` | 字符串 | 必填 | 展示名称 | 非空字符串 |
| `adapter_state` | 字符串枚举 | 必填 | 适配器实现状态 | 仅允许 `implemented`、`planned`、`degrade_only`；取值与可落位性见 5 节 HR-10 |
| `support_state` | 字符串枚举 | 必填 | 宿主机制支持状态 | 仅允许 `confirmed`、`pending_evidence`、`degrade_only`、`not_applicable` |
| `evidence` | 映射 | 必填 | 证据等级与来源 | 结构见 3.3 节；与 `support_state` 的绑定见 HR-04 |
| `classification` | 映射 | 必填 | 三维分类 | 结构见 3.4 节 |
| `roots` | 映射数组 | 条件必填 | 落位根列表 | 至少一项；同一宿主内 `kind` 不得重复；结构见 3.5 节。**`support_state = not_applicable` 时可省略**（表示无任何宿主侧落位根，见 HR-06） |
| `adapter_forms` | 字符串数组 | 条件必填 | 适配器形态 | 非空、去重；仅允许 `skill`、`rules`、`entry`；结构见 3.5.1 节。**`support_state = not_applicable` 时必须省略**（HR-14） |
| `landing_roots` | 映射数组 | 条件必填 | 现有分发默认根 | 可为空数组；结构见 3.5.2 节；只影响分发落位，不参与盘点枚举。**`support_state = not_applicable` 时必须省略**（HR-14） |
| `inventory_roots` | 映射数组 | 条件必填 | 盘点候选根 | 可为空数组；结构见 3.5.3 节；只用于 M4c 宿主枚举，不参与分发。**`support_state = not_applicable` 时必须省略**（HR-14） |
| `capability` | 映射 | 必填 | 能力声明 | 结构见 3.6 节；字段均可选 |
| `render_policy` | 映射 | 必填 | 渲染与透传策略 | 结构见 3.7 节 |
| `adapter_ref` | 字符串 | 条件必填 | 适配器引用标识 | 非空；与 `host_id` 一对一。**`support_state = not_applicable` 时可省略**（不产出适配器） |
| `open_items` | 字符串数组 | 可选 | 关联的待确认项编号 | 每项形如 `HD-01`（设计文档 2.5 节的编号） |

### 3.3 `evidence` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `level` | 字符串枚举 | 必填 | 证据等级 | 见 4.2 节取值表 |
| `sources` | 字符串数组 | 可选 | 来源清单 | 官方等级须为 URL；实测等级须为路径或命令；不得包含凭据 |
| `note` | 字符串 | 可选 | 补充说明 | 非空字符串；用于登记证据的时效或限制 |

### 3.4 `classification` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `skill_mechanism` | 布尔 | 必填 | 是否支持 skill 机制 | 与 `rules_only` 不得同时为假；**`support_state = not_applicable` 的宿主豁免**，见 HR-05 |
| `rules_only` | 布尔 | 必填 | 是否仅支持规则文件 | 同上 |
| `root_consumed_by` | 字符串数组 | 可选 | 该宿主**输出去向**被哪些宿主消费 | 取值须为本注册表内的 `host_id`，或顶层 `external_consumers` 中登记的 `id`，见 HR-07 与 HR-13 |

### 3.5 `roots` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `kind` | 字符串枚举 | 必填 | 落位根类别 | 仅允许 `skill`（技能根）、`rules`（规则路径）、`external`（工作区外技能根）；**`not_applicable` 宿主的 `roots` 为空数组时不适用** |
| `path_template` | 字符串 | 必填 | 落位路径模板 | 非空；**模板粒度由 `kind` 决定**：`skill` 与 `external` 是技能**目录**模板（形如 `.<目标标识>/skills/<Skill 标识>`），`rules` 是规则**文件**模板（形如 `.cursor/rules/<Skill 标识>.mdc`）；技能根类须与可推导布局一致或说明工作区外模板；禁止包含凭据 |
| `scope` | 字符串枚举 | 可选 | 作用域 | 仅允许 `global`、`project` |
| `consumed_by` | 字符串数组 | 可选 | 会读取该落位根的宿主集合 | 取值须为本注册表内的 `host_id`，或顶层 `external_consumers` 中登记的 `id`；登记重叠消费关系（HR-07、HR-13） |
| `platform_notes` | 字符串 | 可选 | 平台差异说明 | 非空字符串；差异须与跨平台一致性口径一致 |

### 3.5.1 `adapter_forms` 结构

`adapter_forms` 是**宿主到形态实现的唯一绑定数据**。适配器 selector 只读取该字段并复用通用形态实现；不得另设宿主→形态映射表，也不得为新增宿主在 selector 中追加分支。

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| （数组项） | 字符串枚举 | 必填 | 适配器支持的形态 | 仅允许 `skill`、`rules`、`entry`；数组非空且不得重复（HR-14） |

新增宿主的最小步骤固定为：

1. 在注册表增加一条完整条目，声明 `adapter_forms` 与根模型；
2. 若形态已存在，只把宿主绑定到既有形态实现；只有引入新形态时才新增形态实现；
3. 不修改 `defaultRootFor`、`formImplementationOf` 或 `adapterFor` 的宿主分支。

### 3.5.2 `landing_roots` 结构

`landing_roots` 是**现有分发行为的默认根数据**，由 `defaultRootFor()` 按形态与平台选择并展开。它与 `roots[]` 的分工是：`roots[]` 描述宿主侧路径模板、作用域与消费关系；`landing_roots` 描述默认文件系统基址与路径。配置覆盖 `host.<id>.root` / `host.<id>.rules_root` 仍在解析层优先于默认根，本字段不改变既有优先级。

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `kind` | 字符串枚举 | 必填 | 落位根类别 | 仅允许 `skill`、`rules`、`external` |
| `base` | 字符串枚举 | 必填 | 基址类型 | 仅允许 `home`、`env` |
| `path_template` | 字符串 | 必填 | 相对基址的路径模板 | 非空；不得含凭据 |
| `env_var` | 字符串 | 条件必填 | 环境变量名 | `base = env` 时必填；其余情况省略 |
| `platform` | 字符串枚举 | 可选 | 适用平台 | 仅允许 `any`、`win32`、`darwin`、`linux`；缺省等同 `any` |

约束：本字段只表达既有默认根。增加、删除或改变条目会改变分发行为，必须作为行为变更单独验收；盘点新增候选根不得写入本字段。

### 3.5.3 `inventory_roots` 结构

`inventory_roots` 是 M4c 的**静态盘点候选根数据**。根枚举 selector 将静态条目按平台筛选、展开路径，并在运行时追加配置覆盖根；本字段本身不读取目录、不判断存在性、不写缓存。

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `root_id` | 字符串 | 必填 | 根标识 | 小写字母、数字、短横线与斜线；同一宿主内唯一 |
| `role` | 字符串枚举 | 必填 | 根角色 | 仅允许 `user`、`system`、`platform`、`project` |
| `kind` | 字符串枚举 | 必填 | 根类别 | 仅允许 `skill`、`rules`、`external` |
| `base` | 字符串枚举 | 必填 | 基址类型 | 仅允许 `home`、`env`、`workspace`、`absolute` |
| `path_template` | 字符串 | 必填 | 相对基址的路径模板 | 非空；`base = absolute` 时须为绝对路径 |
| `env_var` | 字符串 | 条件必填 | 环境变量名 | `base = env` 时必填；其余情况省略 |
| `platform` | 字符串枚举 | 可选 | 适用平台 | 仅允许 `any`、`win32`、`darwin`、`linux`；缺省等同 `any` |
| `depth` | 字符串枚举 | 必填 | 发现深度 | 仅允许 `direct`（顶层）或 `recursive`（递归）；由宿主约定决定 |
| `origin` | 字符串枚举 | 必填 | 根来源 | 静态条目仅允许 `default`、`legacy`；`config` 仅由运行时追加，不得写入注册表 |
| `consumed_by` | 字符串数组 | 可选 | 消费该物理根的宿主 | 缺省视为当前宿主；取值须闭合到 `host_id` 或 `external_consumers.id` |
| `platform_notes` | 字符串 | 可选 | 平台或角色说明 | 非空字符串 |
| `pending_verification` | 布尔 | 可选 | 该根的**真实默认布局事实**是否尚待真机验证 | 机制类路径展开由 CI fixture 证明后不再据此保留；真实工具是否使用该根、官方与遗留根的口径仍无证据时必须保留 |

口径：

1. 默认主计数的角色为 `user`；`system` 与 `platform` 根必须单独分组展示，不能并入用户安装数。
2. 共享物理根按宿主各登记一条候选根，`consumed_by` 标注全部消费宿主；物理去重发生在盘点读取层，不在注册表内合并。
3. 配置覆盖根由 selector 追加为 `origin: config`、`role: user` 的视图，不写回注册表。
4. 第三方 `x-` 宿主不写入本注册表；插件 catalog selector 从已启用插件的宿主 profile 产出同一 `InventoryRootView` 形状。

### 3.6 `capability` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `auto_discovery` | 布尔 | 可选 | 是否支持技能的自动发现 | — |
| `progressive_loading` | 布尔 | 可选 | 是否支持按需加载 | — |
| `strict_filename` | 布尔 | 可选 | 是否要求元数据文件名严格等于 `SKILL.md` | 为真时禁用表达依赖文件改名 |
| `accepted_fields` | 字符串数组 | 可选 | 该宿主实测接受的 frontmatter 字段集合 | 每项为非空字符串 |
| `max_description_chars` | 整数 | 可选 | 描述字段的长度上限 | 正整数 |
| `requires_yaml_name_description` | 布尔 | 可选 | 是否要求 YAML 中给出技能名与描述 | — |

### 3.7 `render_policy` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `field_mode` | 字符串枚举 | 必填 | 字段渲染模式 | 仅允许 `standard6`（标准 6 字段）、`host_declared`（标准字段 + 白名单扩展） |
| `allowed_extensions` | 字符串数组 | 可选 | 透传白名单 | `host_declared` 时非空、`standard6` 时为空或缺省；**安全控制字段（如 `disable-model-invocation`）只有在 `security_control_evidence` 中登记后方可包含**，见 HR-08 与 HR-09 |
| `drop` | 字符串数组 | 可选 | 明确裁剪的字段 | 每项为非空字符串；被裁剪项须进入运行的字段差异报告 |
| `degrade_form` | 字符串枚举 | 可选 | 降级形态 | 仅允许 `entry`（指令文件条目）、`rule_file`（规则文件）、`none` |
| `security_control_evidence` | 映射 | 可选 | 安全控制字段的语义证据（按字段名索引） | 每个键必须同时出现在 `allowed_extensions` 中；值结构见 3.8 节；准入判定见 HR-09 |

### 3.8 `external_consumers` 与 `security_control_evidence` 结构

`external_consumers[]`（顶层）——**不作为 M5 适配对象、但会读取某落位根**的外部产品：

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `id` | 字符串 | 必填 | 外部消费方标识 | 命名同 `host_id`（全小写字母、数字与短横线）；不得与任何 `host_id` 重复；文档内唯一 |
| `display_name` | 字符串 | 必填 | 展示名称 | 非空字符串 |
| `evidence` | 映射 | 必填 | 证据等级与来源 | 结构同 3.3 节；等级须为一手等级（HR-13） |
| `note` | 字符串 | 可选 | 登记说明（如预览状态、后续评估条件） | 非空字符串 |

`render_policy.security_control_evidence`（按字段名索引的映射，值为对象）：

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| （键） | 字符串 | 必填 | 安全控制字段名 | 必须是 2.2 节第 5 条列举的安全控制字段，且必须出现在同一宿主的 `allowed_extensions` 中 |
| `semantics` | 字符串 | 必填 | **已确认的字段语义** | 非空；须为可判定的行为描述（如「`true` 时排除模型自动调用，仅显式调用可用」） |
| `level` | 字符串枚举 | 必填 | 证据等级 | 须为一手等级（`verified_official` / `verified_local` / `verified_runtime`） |
| `sources` | 字符串数组 | 必填 | 来源清单 | 至少一项；官方等级给 URL，实测等级给路径或命令；不得包含凭据 |
| `note` | 字符串 | 可选 | 补充说明（跨宿主一致性与残余不确定性） | 非空字符串 |

---

## 4. 支持状态与证据等级

### 4.1 支持状态取值

| 取值 | 含义 |
|---|---|
| `confirmed` | 机制已确认（须有一手证据） |
| `pending_evidence` | 机制待补证据（不得据此产出适配产物） |
| `degrade_only` | 仅以降级形态支持 |
| `not_applicable` | 不适用（例如模型提供方，无宿主侧加载） |

### 4.2 证据等级取值

| 取值 | 含义 | 对应调研文档表述 |
|---|---|---|
| `verified_official` | 官方文档或官方标准站点 | [已查证]（官方） |
| `verified_local` | 本机实测（结构、字段、行为） | [已查证·本机实测] |
| `verified_runtime` | 本环境运行期证据（如宿主技能根列表、目录权限属性） | [已查证·运行期证据] |
| `secondhand` | 单一非官方来源 | [一方称] |
| `pending` | 未取得证据 | [待确认] |

---

## 5. 统一校验规则总表

| 编号 | 规则 | 判定 |
|---|---|---|
| HR-01 | 顶层结构与版本 | `registry_version` 必须为 `1`；`hosts` 非空 |
| HR-02 | `host_id` 命名与唯一性 | 满足命名规范、不超过 64 字符、文档内不重复 |
| HR-03 | 未知字段 | 注册表由内核维护，出现未登记字段判为不合规（与元文件的宽松策略不同） |
| HR-04 | 状态与证据绑定 | `support_state=confirmed` 时 `evidence.level` 必须属于一手等级（`verified_official` / `verified_local` / `verified_runtime`） |
| HR-05 | 三维分类自洽 | `skill_mechanism` 与 `rules_only` 不得同时为假；**`support_state = not_applicable` 的宿主豁免本规则**（表示两类机制皆无） |
| HR-06 | 落位根完整 | 每个宿主至少一条落位根；`kind` 不重复；`kind` 与 `classification` 自洽（声明支持 skill 机制时须有 `skill` 或 `external` 类落位根——后者表示技能根位于工作区之外）；**`support_state = not_applicable` 的宿主允许 `roots` 为空** |
| HR-07 | 消费关系闭合 | `roots[].consumed_by` 与 `classification.root_consumed_by` 的取值必须是本注册表内的 `host_id`，或顶层 `external_consumers` 中登记的 `id`；实际已知的消费关系必须登记 |
| HR-08 | 模式与白名单一致 | `field_mode=host_declared` 时 `allowed_extensions` 非空；`standard6` 时为空或缺省 |
| HR-09 | 安全控制字段准入 | `allowed_extensions` 中的安全控制字段（`disable-model-invocation`）必须由同一宿主的 `security_control_evidence` 逐字段登记 **`semantics`（非空）+ 一手 `level` + 非空 `sources`**；未登记即禁止透传。反之，`security_control_evidence` 中出现未列入 `allowed_extensions` 的字段同样不合规（防止失效登记） |
| HR-10 | 可落位性 | 仅 `adapter_state` 为 `implemented` 或 `degrade_only` 的宿主可参与落位；`planned` 宿主可登记但取值时按未登记取值处理 |
| HR-11 | 证据来源形式 | 官方等级须给出 URL；实测与运行期等级须给出路径或命令；任何来源不得含凭据 |
| HR-12 | 版本兼容 | 内核读取到高于自身支持的 `registry_version` 时按「不支持」处理，给出明确问题码并拒绝加载 |
| HR-13 | 外部消费方登记完整 | `external_consumers[]` 每项必须有 `id`（命名同 HR-02）、`display_name` 与非空一手 `evidence`；`id` 不得与任何 `host_id` 或彼此重复；未登记的标识不得出现在任何消费关系字段（HR-07） |
| HR-14 | 形态与根模型完整 | 非 `not_applicable` 宿主必须提供 `adapter_forms`、`landing_roots`、`inventory_roots`；`adapter_forms` 非空去重，根条目字段与枚举合法，`inventory_roots[].root_id` 在同一宿主内唯一。`not_applicable` 宿主必须省略三组字段 |
| HR-15 | 分发根与盘点根分离 | `landing_roots` 只驱动现有分发默认根，`inventory_roots` 只驱动盘点枚举；selector 从注册表派生，不得保留宿主→形态或宿主→默认根的第二定义；新增宿主只增加注册表条目与必要的形态实现 |

---

## 6. YAML 最小合法示例

```yaml
registry_version: "1"
generated_at: "2026-10-15T00:00:00Z"
hosts:
  - host_id: claude
    display_name: Claude Code
    adapter_state: implemented
    support_state: confirmed
    evidence:
      level: verified_official
      sources:
        - "https://docs.claude.com/en/docs/claude-code/skills"
    classification:
      skill_mechanism: true
      rules_only: false
      root_consumed_by:
        - cursor
    roots:
      - kind: skill
        path_template: ".<目标标识>/skills/<Skill 标识>"
        scope: project
        consumed_by:
          - claude
          - cursor
    capability:
      auto_discovery: true
      progressive_loading: true
      strict_filename: true
      max_description_chars: 1024
    render_policy:
      field_mode: standard6
      allowed_extensions: []
      degrade_form: none
    adapter_forms:
      - skill
    landing_roots:
      - kind: skill
        base: home
        path_template: .claude/skills
    inventory_roots:
      - root_id: claude/user
        role: user
        kind: skill
        base: home
        path_template: .claude/skills
        depth: direct
        origin: default
    adapter_ref: claude
  - host_id: agents-md
    display_name: 通用指令文件载体
    adapter_state: implemented
    support_state: confirmed
    evidence:
      level: verified_official
      sources:
        - "https://agents.md/"
    classification:
      skill_mechanism: false
      rules_only: true
    roots:
      - kind: rules
        path_template: "AGENTS.md"
    capability: {}
    render_policy:
      field_mode: standard6
      degrade_form: entry
    adapter_forms:
      - entry
    landing_roots: []
    inventory_roots: []
    adapter_ref: agents-md
```

---

## 7. 规范版本与向后兼容策略

### 7.1 版本标识

注册表以 `registry_version` 标识格式版本，当前为 `1`。版本号只表达**结构**的不兼容级别，不表达条目内容的新旧。

### 7.2 变更分级

| 分级 | 判定 | 处理 |
|---|---|---|
| 兼容变更 | 新增可选字段、新增枚举取值、扩充条目 | 版本号不变；校验规则同步更新并登记 |
| 不兼容变更 | 删除或重命名字段、收紧必填、改变既有字段语义 | 版本号递增；按既有变更流程先改文档再改实现 |

### 7.3 读取与写入策略

1. 内核只读取自身版本支持的注册表；遇到更高版本按 HR-12 拒绝加载并给出问题码；
2. 注册表由内核随版本交付，**用户不编辑**；工作区不落该文件；
3. 证据等级与来源的变更以调研补记为依据，补记先行、注册表随后更新。

---

## 8. 约束边界

### 8.1 本规范不定义的内容

1. 宿主格式的字段映射规则与裁剪策略（属适配器设计，见设计文档第 5 章）；
2. 宿主官方规范的字段全集（属调研产出，见调研文档）；
3. 规则文件类宿主的合并与冲突处理策略（属实现阶段，受「不覆盖用户既有内容」约束）；
4. 指令语法、取值书写形式与错误码（属指令契约规范；`--target` 的两级粒度在该规范登记）。

### 8.2 与需求条目的对应关系

| 本规范内容 | 需求条目 | 设计决策 |
|---|---|---|
| 载体、字段与不变量 | M5-R1 | DP-03 |
| 落位根与两级粒度 | M5-R3、M5-R9 | DP-01 |
| 首批名单与支持状态 | M5-R4 | Q-05、HD-01、HD-06 |
| 消费宿主集合与重叠消费 | M5-R8 | DP-02 |
| 透传白名单与安全控制字段准入 | M5-R2 的降级与透传规则 | DP-04、HD-02 |
| 外部消费方登记（`external_consumers`） | M5-R8 的落位根重叠 | 2026-10-16 裁决（`dsh` 不立注册项） |

---

## 修订记录

| 序号 | 日期 | 说明 |
|---|---|---|
| 1 | 2026-10-15 | 建立第五份契约规范：宿主注册表规范。依据需求文档 9.3.6（M5-R1 ~ M5-R9）与设计文档决策点 DP-03 的裁决；同时建立机器可读形态 `schemas/host_registry.schema.json` |
| 2 | 2026-10-15 | 兼容澄清（T2 实现反馈）：① `support_state = not_applicable` 的宿主豁免 HR-05 与 HR-06，`roots` 与 `adapter_ref` 改为条件必填——「不适用 / 模型提供方」类宿主（如 DeepSeek）在规范中此前无法表达（两类机制皆无且无落位根）；② HR-06 的「技能根」判定同时接受 `skill` 与 `external` 两类落位根——工作区外的技能根（如豆包的用户技能根）此前会被误判为缺技能根。规则编号与其余取值域未变，机器可读形态同步 |
| 3 | 2026-10-15 | 兼容澄清（T2 实现反馈）：载体形态补充「类型化数据模块」一档。本期实现随内核以 esbuild 打成单个可执行文件，采用 `kernel/core/hosts/registry-data.ts`（类型化数据模块）而不引入构建期资源加载；字段契约、校验规则与不变量不因载体形态而变，`host_registry.yaml` 作为等价文档形态保留 |
| 4 | 2026-10-15 | 兼容澄清（T4 实现反馈）：明确 `path_template` 的模板粒度由 `kind` 决定——`skill` / `external` 为技能目录模板，`rules` 为规则文件模板，供落位计划展开时使用。原表述只写「落位路径模板」，未区分目录与文件，落位计划无法据以判定是否需要拼接产物文件名 |
| 5 | 2026-10-16 | **裁决修订（M5 遗留事实点收口批次）**：① **HR-09 改写**——由「全宿主禁止 `disable-model-invocation`」改为「安全控制字段按宿主语义证据准入」，配套新增 `render_policy.security_control_evidence` 结构（`semantics` + 一手 `level` + `sources`）与 3.8 节；② **HR-07 放宽并新增 HR-13**——消费关系取值允许引用顶层新登记的 `external_consumers[]`（外部消费方须带一手证据，作为**非适配对象**登记），据此把 `dsh`（DeepSeek Harness，开发者预览）登记为 `~/.agents/skills` 的消费方；③ Codex 用户级技能根依据官方文档改为 `$HOME/.agents/skills`（原 `~/.codex/skills` 降为**配置覆盖的遗留兼容根**，不默认双写）。`registry_version` 不递增：注册表随内核同版本交付，本次为可选字段新增与规则放宽，无既有取值语义变更 |
| 6 | 2026-10-19 | **P1-a 结构扩展**：新增 `adapter_forms`、`landing_roots`、`inventory_roots` 三组字段，分别收敛宿主形态、既有分发默认根与 M4c 盘点候选根；新增 3.5.1 至 3.5.3 与 HR-14、HR-15。`landing_roots` 保持既有分发行为不变，Codex 仍默认分发到 `~/.agents/skills`；`~/.codex/skills` 与 `~/.codex/skills/.system` 仅作为盘点候选根登记，豆包 `.user_skills` / `.skills` 按 user / platform 分角色盘点。macOS / Linux 候选根标 `pending_verification`，由 M4c-7 的 CI 探针验证。schema 同步收紧：非 `not_applicable` 宿主必须给出三组字段，`not_applicable` 宿主不得给出，`base = env` 的根必须给出 `env_var` |
| 7 | 2026-10-19 | **M4c-7 验证边界**：三平台 CI fixture 已证明 HOME 展开、分隔符、config 根、发现、去重、对账与 symlink 机制；因此移除 `claude/user`、`cursor/user-skills`、`cursor/user-rules` 的 `pending_verification`。该字段不再表示机制未验证，只表示真实默认布局事实未取证；Codex 三个根（`agents-user` / `legacy-user` / `system`）因官方 `~/.agents/skills` 与遗留 `~/.codex/skills` 口径仍待证据而保留。真实安装环境的默认目录与额外配置登记 TD-02，不伪造“已实测” |
