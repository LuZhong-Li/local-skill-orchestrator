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
| 文件名 | `host_registry.yaml` |
| 位置 | **随内核交付**（内核包内的数据文件）；**不位于工作区**，一期与二期的工区布局不变 |
| 数量 | 每个内核版本有且仅有一份 |
| 权限 | 只读资产：由内核随版本更新，用户不编辑；如需用户自定义，另按变更流程立项 |
| 权威性 | 宿主差异（落位根、能力、渲染策略、透传白名单）以本文件为权威来源 |

### 2.2 全局不变量

1. `host_id` 在文档内唯一，且与 `--target` 取值一一对应；
2. 一个宿主的技能根与规则路径**分条登记**，不得合并为一条；
3. 任一落位根的消费宿主集合必须显式登记（未登记的消费关系视为登记缺陷）；
4. 支持状态为「机制已确认」的条目必须携带一手证据等级；
5. 透传白名单**不得**包含 `disable-model-invocation`（语义不明，禁止跨宿主透传）；
6. 注册表不含任何凭据、令牌或个人标识。

### 2.3 写入权限

| 数据 | 写入者 |
|---|---|
| 注册表全文 | 内核（随版本交付）；用户与外部程序不得写入 |
| 条目的证据等级与来源 | 内核维护；变更以调研补记为依据 |

---

## 3. `host_registry.yaml`（宿主注册表）

### 3.1 顶层结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `registry_version` | 字符串 | 必填 | 注册表格式版本标识 | 当前取值 `1`；不兼容变更递增，见 7.2 节 |
| `generated_at` | 字符串 | 可选 | 注册表生成时间 | 协调世界时秒级，格式见 2.4 节同名约束（`YYYY-MM-DDTHH:MM:SSZ`） |
| `hosts` | 映射数组 | 必填 | 宿主条目列表 | 至少一项；`host_id` 不得重复；结构见 3.2 节 |

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
| `root_consumed_by` | 字符串数组 | 可选 | 该宿主**输出去向**被哪些宿主消费 | 取值须为本注册表内的 `host_id`，见 HR-07 |

### 3.5 `roots` 结构

| 字段名 | 数据类型 | 必填/可选 | 描述 | 校验规则 |
|---|---|---|---|---|
| `kind` | 字符串枚举 | 必填 | 落位根类别 | 仅允许 `skill`（技能根）、`rules`（规则路径）、`external`（工作区外技能根）；**`not_applicable` 宿主的 `roots` 为空数组时不适用** |
| `path_template` | 字符串 | 必填 | 落位路径模板 | 非空；技能根类须与可推导布局一致或说明工作区外模板；禁止包含凭据 |
| `scope` | 字符串枚举 | 可选 | 作用域 | 仅允许 `global`、`project` |
| `consumed_by` | 字符串数组 | 可选 | 会读取该落位根的宿主集合 | 取值须为本注册表内的 `host_id`；登记重叠消费关系 |
| `platform_notes` | 字符串 | 可选 | 平台差异说明 | 非空字符串；差异须与跨平台一致性口径一致 |

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
| `allowed_extensions` | 字符串数组 | 可选 | 透传白名单 | `host_declared` 时非空、`standard6` 时为空或缺省；不得含 `disable-model-invocation`，见 HR-08 与 HR-09 |
| `drop` | 字符串数组 | 可选 | 明确裁剪的字段 | 每项为非空字符串；被裁剪项须进入运行的字段差异报告 |
| `degrade_form` | 字符串枚举 | 可选 | 降级形态 | 仅允许 `entry`（指令文件条目）、`rule_file`（规则文件）、`none` |

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
| HR-07 | 消费关系闭合 | `roots[].consumed_by` 与 `classification.root_consumed_by` 的取值必须是本注册表内的 `host_id`；实际已知的消费关系必须登记 |
| HR-08 | 模式与白名单一致 | `field_mode=host_declared` 时 `allowed_extensions` 非空；`standard6` 时为空或缺省 |
| HR-09 | 透传禁列 | `allowed_extensions` 不得包含 `disable-model-invocation` |
| HR-10 | 可落位性 | 仅 `adapter_state` 为 `implemented` 或 `degrade_only` 的宿主可参与落位；`planned` 宿主可登记但取值时按未登记取值处理 |
| HR-11 | 证据来源形式 | 官方等级须给出 URL；实测与运行期等级须给出路径或命令；任何来源不得含凭据 |
| HR-12 | 版本兼容 | 内核读取到高于自身支持的 `registry_version` 时按「不支持」处理，给出明确问题码并拒绝加载 |

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
| 透传白名单与禁列 | M5-R2 的降级与透传规则 | DP-04、HD-02 |

---

## 修订记录

| 序号 | 日期 | 说明 |
|---|---|---|
| 1 | 2026-10-15 | 建立第五份契约规范：宿主注册表规范。依据需求文档 9.3.6（M5-R1 ~ M5-R9）与设计文档决策点 DP-03 的裁决；同时建立机器可读形态 `schemas/host_registry.schema.json` |
| 2 | 2026-10-15 | 兼容澄清（T2 实现反馈）：① `support_state = not_applicable` 的宿主豁免 HR-05 与 HR-06，`roots` 与 `adapter_ref` 改为条件必填——「不适用 / 模型提供方」类宿主（如 DeepSeek）在规范中此前无法表达（两类机制皆无且无落位根）；② HR-06 的「技能根」判定同时接受 `skill` 与 `external` 两类落位根——工作区外的技能根（如豆包的用户技能根）此前会被误判为缺技能根。规则编号与其余取值域未变，机器可读形态同步 |
