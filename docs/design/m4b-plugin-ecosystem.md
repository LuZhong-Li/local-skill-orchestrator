# M4b 插件生态：调研与设计

| 项目 | 内容 |
|---|---|
| 文档名称 | M4b 插件生态调研与设计（需求边界、现状取证、声明式/代码形态、安全模型、manifest、八项裁决） |
| 文档路径 | `docs/design/m4b-plugin-ecosystem.md`（调研设计；八项裁决已采纳，T0~T3 计划见 `docs/plan/m4b-plugin-ecosystem.md`；本阶段不改代码） |
| 依据 | 需求 9.3.5（M4b-R1 ~ R5）；需求 9.3.6（M5 内置适配器边界）；需求 9.5（M4b 沙箱/隔离排除项）；M4a 9.3.4 与 `docs/design/m4a-auto-update.md` |
| 当前基线 | `v0.2.0`；16 条指令；7 个内置宿主条目（6 个可实现适配器 + 1 个不适用条目）；现有适配器随内核交付，不由外部加载 |
| 证据口径 | 一手官方文档/源码记 [已查证]；本机源码取证记 [源码]；无证据的能力边界直接标 [不可表达] 或“需代码”，不做“推测可用” |

---

## 0. 结论先行（已裁决，尚非实现）

1. **本期只做声明式插件**：插件包只含受严格 schema 约束的 manifest，可声明一个或多个“新宿主 profile”，复用现有 `skill` / `rules` / `entry` 三种产物形态和共用渲染/落位核心；**不加载任何第三方代码**。
2. **代码插件不进入本期**：现有 SEA 交付形态、Node 权限模型、`node:vm`、worker 与平台签名机制都不能在当前工程约束下提供可论证的恶意代码隔离；代码形态必须另立安全设计与立项。
3. **M5 的内置宿主注册表仍是内核资产，不成为插件契约**：插件使用独立 manifest、独立发现/校验/合并路径和 `x-` 第三方宿主命名空间。内置 7 条目只读、不可覆盖、不可伪装，M4b 加载前后必须逐字段不变。
4. **插件默认不加载、不启用**：安装/登记只记录 manifest 与来源审计信息；启用是显式动作。插件失效只影响该插件贡献的宿主 profile，不影响内置能力或其他插件。
5. **不新增指令**：管理动作复用 `install` / `uninstall` / `enable` / `disable` / `list` / `inspect` 的既有语义，通过显式 `--kind plugin` 扩展消费面；插件更新不在本期，保持 16 条指令不变。

> 以上为已裁决范围；第 10 节记录裁决结果，T0~T3 拆解见实施计划。

---

## 1. 需求原文与边界

### 1.1 M4b 原文取证

需求 9.3.5 的原文目标：

> 为「更多类型的扩展纳入统一入口」建立高层需求与边界——让用户在同一处登记、查看与管理 Skill 之外的扩展类型，并允许管理器的能力被扩展。

| 条目 | 原文要求（摘要） | 性质 |
|---|---|---|
| M4b-R1 扩展清单 | 需要一份统一的扩展登记清单，记录标识、类型、来源、状态与落位信息，并与既有索引在概念上对齐；候选字段 `id` / `version` / `author` / `capabilities` / `compatibility` / `source_url` / `manifest_path`，字段细节待契约阶段 | **硬性**：统一清单与唯一事实源；**开放**：字段必填性/取值域 |
| M4b-R2 注册 | 发现、登记、更新记录、移除记录；不合格项不静默丢弃、重复登记幂等、单条失败不中断整体；必须支持注册、注销、列出 | **硬性**：三种操作与失败口径；**开放**：操作落在 CLI 还是 GUI |
| M4b-R3 能力扩展方式 | 明确扩展由扩展提供服务实现，还是由管理器声明扩展点并加载实现；明确扩展能否新增指令 | **硬性**：必须先明确方式；**开放**：声明式/代码式或混合 |
| M4b-R4 版本与兼容 | 扩展声明所依赖的契约版本；不兼容扩展的处理 | **硬性**：兼容性格式与拒绝路径；**开放**：版本 schema 与匹配策略 |
| M4b-R5 失败隔离 | 单个扩展失效不得使管理器整体不可用 | **硬性**：失败隔离；**开放**：隔离粒度与降级呈现 |

原文逐条（与 `docs/requirements.md` 9.3.5 逐字核对）：

> **M4b-R1 扩展清单**
>
> 要求：需要一份统一的扩展登记清单，记录扩展的标识、类型、来源、状态与落位信息，并与既有索引在概念上对齐（「唯一事实源」原则不变）。**候选字段清单（待契约阶段定稿）**：`id`、`version`、`author`、`capabilities`、`compatibility`、`source_url`、`manifest_path`——字段的必填性、取值域与校验强度由契约阶段裁定，本阶段只登记候选集合。

> **M4b-R2 注册**
>
> 要求：需要一套把扩展纳入统一入口的注册机制（发现、登记、更新记录、移除记录），口径与既有 Skill 登记一致——不合格项不静默丢弃、重复登记幂等、单条失败不中断整体；注册机制只作用于**元信息层面**，必须支持注册、注销与列出三种操作。

> **M4b-R3 能力扩展方式**
>
> 要求：需要明确管理器自身能力的扩展方式（由扩展提供服务实现，还是由管理器声明扩展点并加载实现），以及扩展与既有指令的关系（扩展能否新增指令、新增指令如何进入既有契约清单）。

> **M4b-R4 版本与兼容**
>
> 要求：需要明确扩展与契约版本的关系（扩展声明所依赖的契约版本、管理器对不兼容扩展的处理方式）。

> **M4b-R5 失败隔离**
>
> 要求：需要明确单个扩展失效时对其他扩展与既有能力的影响边界；最小要求是单个扩展失效不得使管理器整体不可用。

验收标准原文：

> 1. 每条高层需求均可转化为后续设计阶段可判定的设计目标；
> 2. 需求与边界已落文档，且不与第 7.1 节边界总原则冲突（不执行被管理对象的业务逻辑、不解释其正文）；
> 3. 本章未展开契约层细节，可核对的排除清单已列出（见下）；
> 4. 已明确声明本阶段不做沙箱与隔离，并登记为排除项（与 9.5 节一致）；
> 5. 后续进入设计阶段的前置条件已写明。
>
> **后续实现阶段的高层验收目标**（本阶段只登记、不判定）：
>
> 6. 能在注册表中登记 / 查询插件元信息、列出已注册插件，并**导出插件列表报告**；
> 7. 插件 manifest 的**基础字段校验（schema）**与**兼容性声明格式校验**可执行；兼容性匹配的运行时行为不在验收范围内。

边界声明原文：

> 1. 本阶段**不为插件提供运行时沙箱与权限隔离**：插件的信任边界等同用户自行安装的可执行内容，管理器不隔离其能力范围；
> 2. 本阶段不实现扩展的执行（加载并运行扩展代码）、不做扩展的自动分发、不做扩展市场、不做扩展的在线检索；
> 3. 本阶段不修改既有 Skill 管理路径与契约：插件生态的引入不得使既有 16 条指令的行为发生变化；
> 4. **新契约层设计属大工程**：扩展清单字段、注册协议、能力接口与扩展点定义、版本与兼容策略、失败隔离机制等详细契约层设计不在本章定义，留待独立的调研 / 设计阶段（见 9.6 节风险 M-R-04）。

需求同时明确：

- 本阶段只验收需求边界，不验收插件功能可用性；
- 不执行被管理对象的业务逻辑、不解释其正文；
- 本章不做沙箱与隔离，具体契约另立调研/设计；
- 不新增指令与既有 16 条指令行为变化，若确需新增指令必须另行裁决。

用户本次前置约束进一步收紧：

- **插件 ≠ 技能**：技能是被管理对象，插件是扩展工具能力的载体；
- 第三方默认不信任、默认不加载/不启用；
- 与 M5 内置机制在命名空间、解析顺序、配置、审计上完全分开；
- 任何第三方代码执行路径先有安全模型，否则不进入本期。

### 1.2 与 M5 的边界

M5 设计第 8 章原文：

> 两条机制不得共用同一套注册、发现与加载路径；M4b 若立项，其扩展点设计不得以 M5 的适配器接口为对外契约。宿主注册表是内核资产，不构成对外扩展接口。

因此 M4b 可以复用**内部通用能力**（共用渲染核心、落位原语、原子写、备份），但不能：

- 让插件写入 `kernel/core/hosts/registry-data.ts`；
- 把 `HostAdapter` 接口发布为第三方 API；
- 让插件覆盖内置宿主形态绑定（`adapter_forms`）、内置 `host_id` 或 `host_registry.schema`；
- 让插件使用 `host.<id>.root` 的内置配置命名空间。

### 1.3 与 M4a 的边界

| 能力 | M4a 现状 | M4b 本期裁决 |
|---|---|---|
| 检查对象 | 已登记 **Skill**，数据源为 `inspect <id> --json` | 插件不是 Skill；不得被现有 `checkUpdates` 当作 Skill 检查 |
| 更新执行 | 确认后复用 `update <id> --ref <tag>` | 插件更新**不在本期**；版本变化通过手动 `uninstall` 后再 `install`，不新增插件更新分支 |
| 频率/只读 | 定期/即时检查只提示，不执行 | 插件更新检查**不在本期**；后续若加入，必须另立独立 checker 与 GUI 四态，不混用 Skill 检查结果 |
| 来源错误 | `E-SRC-*` 口径 | 可以复用同一来源错误口径，但不能把插件当成 Skill 候选 |

---

## 2. 现状取证：当前扩展面

### 2.1 内置宿主注册表

[源码] `kernel/core/hosts/registry-data.ts`：7 个 `host_id` 条目：

| host_id | adapter_state | support_state | 当前形态 |
|---|---|---|---|
| `claude` | implemented | confirmed | skill |
| `codex` | implemented | confirmed | skill |
| `cursor` | implemented | confirmed | skill + rules |
| `doubao` | implemented | confirmed | skill |
| `agentskills` | implemented | confirmed | skill（通用标准目标） |
| `agents-md` | implemented | confirmed | entry（片段，不落盘） |
| `deepseek` | planned | not_applicable | 无适配器、无落位根 |

[源码] `kernel/core/hosts/index.ts`：

- `loadHostRegistry()` 在加载期做 HR-01 ~ HR-13 校验，成功后 `Object.freeze` 注册表和条目；
- `hostById()` / `listHosts()` / `selectableHostIds()` 只读；
- 安全控制字段准入由注册表数据与渲染期共用同一判定原语。

[源码] `schemas/host_registry.schema.json` 已能表达：宿主标识、支持状态、证据、三维分类、roots、capability、render_policy、adapter_ref。

**但不能表达**：

- 插件身份、插件版本、插件 API 兼容范围；
- 插件来源与 manifest 哈希；
- 第三方命名空间/origin；
- 插件启停状态；
- 通用形态绑定（当前只有 `adapter_ref`，真正形态在代码里）。

### 2.2 适配器与渲染

[源码] `kernel/core/adapters/index.ts`：

- `adapter_forms` 是宿主 → 形态的注册表绑定，selector 由此派生出共用形态实现（P1-a 前的 `FORM_BY_HOST` 已删除）；
- 6 个有适配器的宿主复用 `SKILL_FORM` / `ENTRY_FORM` / `RULE_FORM`；
- `adapterFor()` / `allAdapters()` 从注册表绑定取值；
- `HostAdapter` 接口是内核内部接口，不是外部契约。

[源码] `kernel/core/render/index.ts`：

- `renderWithPolicy()` 是共用渲染核心；
- 标准六字段、扩展白名单、降级形态、安全控制字段准入都不依赖宿主专有代码；
- `policyOf()` 直接读内置 `hostById()`。

这意味着：**一个新宿主若复用 `skill` / `rules` / `entry` 形态，只需注册表数据；第三方声明式宿主仍必须走独立 manifest 与解析器，不能直接写入内置 schema。**

### 2.3 根路径与配置

[源码] `kernel/core/adapters/roots.ts`：

- `resolveHostRoot()` 先查内置 registry，再接受 `host.<id>.root` / `host.<id>.rules_root` 配置；
- 默认路径由 `defaultRootFor()` 展开注册表 `landing_roots[]` 给出；
- 未登记宿主直接返回 undefined。

[源码] `kernel/core/index/index.ts:121`：

- 配置键正则仅为 `^host\.([a-z0-9-]+)\.(root|rules_root)$`；
- `setConfig()` 要求该 host_id 已在内置注册表，并且有对应 root kind；
- 因此第三方插件宿主无法直接写入 `host.*` 命名空间。

### 2.4 生命周期与落位

[源码] `kernel/dispatch/registry/index.ts`：

- `install` 读取 `skill_meta.yaml`，写入 Skill 中心库，登记 Skill index，再可选执行 `--host` 分发；
- `uninstall` / `enable` / `disable` 都按 Skill 标识和 Skill 目标语义工作；
- `runHostLanding()` 通过 `adapterFor()` 和内置 host root 解析落位；
- `update` 通过 Skill 生命周期服务刷新。

[源码] `kernel/core/lifecycle/index.ts`：

- `installSkill` / `uninstallSkill` / `updateSkill` 都以 `SkillMeta`、Skill 目录和 Skill index 为中心，没有插件类型分支。

**结论**：现有 `install/enable/disable/uninstall` 的底层写盘、备份、原子写和确认机制可复用；但当前入口/Target 解析严格绑定 Skill，不能直接把插件 manifest 塞进 `skill_meta.yaml`。

### 2.5 来源与网络

[源码] `kernel/core/lifecycle/source.ts`：

- `looksRemote()` 识别远端地址；
- `assertProtocolAllowed()` 只允许 `https` / `git` 与回环 `http`；
- `REMOTE_TIMEOUT_MS = 60_000`、`REMOTE_MAX_BYTES = 128 MiB`；
- `acquireSource()` 按 git/archive 分支克隆或下载，临时目录隔离，失败清理。

这些是 M4b 可以复用的**来源获取机制**，但插件来源声明、manifest 位置、校验和与插件注册表必须另立契约。

### 2.6 指令清单

[源码] `kernel/dispatch/registry/index.ts:81` 的 `REGISTERED_COMMANDS` 固定为 16 条；[源码] `docs/specification/cli-contract.md` 第 3 节同样固定 16 条。

M4b 不能通过注册新指令扩展；只能扩展数据模型、既有命令的选项/消费面或 GUI 主进程能力。

---

## 3. 扩展点清单与判定

| 扩展点 | 当前实现 | 本期判定 | 理由 |
|---|---|---|---|
| **新宿主**（目录/文件布局 + 标准字段/`host_declared`） | 注册表数据 + `adapter_forms` 形态绑定 | **可声明式扩展（需 M4b 新 manifest + 独立解析器）** | 可复用 `skill` / `rules` / `entry` 形态和共用渲染核心；不修改内置 registry |
| **新渲染算法**（自定义 frontmatter 转换、合并、二进制格式） | 共用 render 核心 + 形态实现代码 | **需代码，本期不可扩展** | 会执行第三方逻辑；现有渲染策略是有限枚举 |
| **新来源类型**（协议、认证、索引服务） | `source.ts` 的固定 type/protocol 分支 | **需代码，本期不可扩展** | 涉及网络/凭据/协议与供应链，必须独立安全模型 |
| **新校验规则/新元数据字段语义** | 元数据 schema + 校验代码 | **需代码或新契约，本期不可扩展** | 插件不能改变 Skill 的校验语义 |
| **新指令** | `REGISTERED_COMMANDS` 固定 16 条 | **不可扩展** | 用户前置约束明确；插件不得进入 CLI 契约清单 |
| **新 GUI 面板/动作** | Vue 视图 + 主进程 IPC | **本期可有限扩展** | 只读展示插件清单、启用/禁用状态、来源/哈希/兼容性与错误；不得加载代码 |
| **Skill 更新检查的插件化** | M4a 对应 Skill 来源检查 | **本期不扩展** | 插件不是 Skill；插件更新检查另立后续设计 |
| **宿主内置配置** | `host.<id>.root` | **不可由插件写入** | 与 M5 内置机制隔离；插件使用独立配置命名空间 |
| **内置注册表/适配器表** | 内核资产 | **不可覆盖/不可伪装** | `adapter_forms`、`adapter_ref`、内置 7 条目保持只读 |

---

## 4. 声明式插件 vs 代码插件

### 4.1 能力与风险对照

| 维度 | 声明式插件（manifest-only） | 代码插件（ESM/可执行） |
|---|---|---|
| 交付内容 | 严格 schema 的 manifest；无 JS、无二进制、无钩子 | JS/ESM/原生扩展或外部可执行 |
| 新宿主能否覆盖 | 复用 `skill` / `rules` / `entry` 的静态 profile | 可实现任意适配逻辑、协议、合并策略 |
| 能覆盖的第三方场景 | 目录型技能、标准 frontmatter、简单规则文件、指令片段；**不能**做动态转换/自定义 IO | 广泛，但风险与审计成本高 |
| 沙箱需求 | 无代码执行，无需运行时沙箱 | 必须有权限边界、进程隔离、超时/内存限制、签名/审计 |
| 失败隔离 | manifest 校验失败 → 该插件不加载；不影响其他插件 | 未捕获异常/死循环/内存耗尽/恶意 IO 可能拖垮进程 |
| 供应链 | manifest 哈希 + 来源审计；仍要防投毒/伪装 | 需签名、哈希锁定、权限声明、代码审计/信誉机制 |
| 当前 SEA 兼容性 | 仅读 JSON/YAML 数据，天然兼容 | Node 22 SEA 的 `require()` 默认只加载内置模块；文件式加载需 `createRequire(process.execPath)` 或 `import()` 外部文件，形成外部代码路径 |
| 本期建议 | **纳入** | **排除**（安全模型前置未满足） |

### 4.2 代码形态的安全证据

[已查证] Node.js v22 SEA：

- 注入主脚本里的 `require()` **不是文件式的**，只能加载内置模块；
- 需要文件式加载时必须显式创建基于 `process.execPath` 的 require；
- 即：动态第三方模块在 SEA 中只能作为**外部文件**加载，无法保持“单文件闭世界”的供应链边界。

[已查证] Node.js v22 `node:vm`：

> `node:vm` 不是安全机制，不应用于运行不可信代码。

[已查证] Node.js v22 Permission Model：

> 它是“seat belt”，不防恶意代码；恶意代码可以绕过权限模型并执行任意代码。

[已查证] Node.js `worker_threads`：

- worker 与主线程可共享内存；
- worker 仍是同一进程内的运行时，不是安全沙箱。

[已查证] VS Code：

- Extension Host 拥有与 VS Code 相同的权限，能读写文件、发网络请求、启动外部进程、修改设置；
- Workspace Trust 无法阻止恶意扩展执行代码；
- Marketplace 对扩展做签名验证，但这只证明来源与完整性，不证明无恶意行为。

[已查证] kubectl 插件：

- 插件是 PATH 中的独立可执行文件，无安装/预加载；
- 它继承 kubectl 的环境，平台不对插件做权限沙箱。

**结论**：代码插件的“同一进程 import”“worker”“vm”均不能作为安全边界；外部进程只能是故障隔离候选，仍继承用户权限、网络与文件系统。若未来引入代码形态，至少需要：

1. 独立进程/受限进程边界（非 `vm`）；
2. 文件系统/网络/子进程/凭据权限声明与运行时拒绝；
3. 每调用超时、内存上限、输出上限、崩溃回收；
4. manifest 与代码包哈希锁定、来源/发布者审计、可撤销的信任清单；
5. 插件失败不得影响内置宿主和 Skill 管理主路径。

在上述安全模型独立评审通过前，代码插件**不进入本期实现**。

---

## 5. 推荐形态：声明式 host-profile 插件

### 5.1 概念模型

插件是“扩展工具能力的载体”，不是 Skill：

- 插件记录进入扩展登记清单；
- 插件可贡献若干 **host profile**；
- host profile 只描述“目录/文件布局 + 形态 + 有限渲染策略”；
- 插件不拥有 Skill 生命周期，不修改 Skill index，不被当作 Skill 检查/更新。

### 5.2 命名空间与内置隔离

| 对象 | 规则 |
|---|---|
| 插件标识 | `plugin_id`：小写短横线，不超过 64 字符；不得为空 |
| 第三方宿主键 | manifest 只声明局部 `host_key`；加载器生成 canonical `host_id = x-<plugin_id>-<host_key>` |
| 内置 host_id | 7 个既有值冻结；永远不允许以 `x-` 开头；插件不得声明相同 canonical id |
| 配置命名空间 | 插件使用 `plugin.<plugin_id>.<host_key>.root` / `.rules_root`；**不得写入** `host.<id>.*` |
| 适配器命名空间 | 插件 host profile 不能写入内置 `adapter_forms`、`adapter_ref` 或 M5 registry |
| 加载顺序 | 内置注册表先加载并冻结；插件后加载且只追加独立命名空间；冲突即拒绝该插件，不 last-wins |

可机械验证的隔离断言（计划阶段落地）：

1. 加载插件前后，`loadHostRegistry()` 深比较完全一致；
2. 内置 `hostIds()` 集合完全一致，且无 `x-` 开头项；
3. 插件 canonical host 全部以 `x-` 开头，且不等于任何内置 id；
4. 内置适配器 `host_id` 集合加载前后不变；
5. 插件 host 不出现在内置 `host.<id>.root` 配置校验中；
6. 插件 manifest 校验失败不影响内置 registry 与其它插件。

### 5.3 manifest 候选结构

路径约定建议：`<workspace>/plugins/<plugin_id>/plugin.json`，插件根仅允许 manifest 与静态资源；**不允许** `.js/.mjs/.cjs/.node/.exe/.dll/.dylib/.so` 或 `main`/`exports`/`scripts` 字段。

```json
{
  "manifest_version": "1",
  "plugin_id": "acme-tools",
  "name": "Acme Tools",
  "version": "1.0.0",
  "description": "Declarative host profiles for Acme agents",
  "author": "Acme",
  "compatibility": {
    "skill_manager": ">=0.2.0 <1.0.0",
    "plugin_api": "1"
  },
  "capabilities": ["host_profile"],
  "hosts": [
    {
      "host_key": "zed",
      "display_name": "Zed",
      "form": "rules",
      "roots": [
        {
          "kind": "rules",
          "path_template": ".zed/rules/<skill_id>.md",
          "scope": "project"
        }
      ],
      "capability": {
        "auto_discovery": false,
        "strict_filename": true
      },
      "render_policy": {
        "field_mode": "standard6",
        "degrade_form": "rule_file"
      }
    }
  ],
  "source": {
    "type": "git",
    "url": "https://example.com/acme-tools.git",
    "ref": "v1.0.0"
  }
}
```

候选字段说明：

| 字段 | 必填 | 用途 | 备注 |
|---|---|---|---|
| `manifest_version` | 是 | manifest schema 版本 | 当前建议 `1`；不支持版本拒绝加载 |
| `plugin_id` | 是 | 插件命名空间 | 不能与内置 host_id 相同；与 `host_key` 共同生成 canonical host |
| `name` / `version` | 是 | 展示与版本守卫 | `version` 必须是 semver 正式版，不接受 prerelease |
| `description` / `author` / `license` | 否 | 展示与审计 | 不做业务解释 |
| `compatibility` | 是 | 兼容性 | `skill_manager` 语义版本范围 + `plugin_api` 精确主版本 |
| `capabilities` | 是 | 声明贡献类型 | 本期只允许 `host_profile` |
| `hosts` | 是 | host profile 列表 | 至少 1 项；本期最多建议 8 项 |
| `hosts[].form` | 是 | 形态 | 仅 `skill` / `rules` / `entry` |
| `hosts[].roots` | 是 | 落位根/路径 | 仅相对工作区或以插件配置根展开；禁止绝对路径和 `..` |
| `hosts[].render_policy` | 是 | 渲染策略 | 不允许安全控制字段透传；白名单字段仅限非安全字段 |
| `source` | 否 | 审计来源 | 复用 `E-SRC-*` 获取口径；不支持自动分发/市场 |

不进入 manifest 的字段：

- `main` / `exports` / `scripts` / `dependencies` 的代码入口；
- 任意权限声明（本期无代码权限可授）；
- `enabled`（状态在扩展登记清单中维护，不在插件包里自声明）；
- 内置 host_id / adapter_ref；
- 远端市场索引或自动更新命令。

### 5.4 声明式能力边界

可表达：

- 新宿主的技能目录（`.foo/skills/<skill_id>` 形式）；
- 规则文件路径（`rules/<skill_id>.md` 等固定单文件形态）；
- 标准六字段或有限扩展白名单；
- 降级为指令片段（只登记、不落盘）；
- 宿主能力声明与展示名称。

不可表达（需代码，故本期拒绝）：

- 自定义 frontmatter→文件格式转换；
- 多文件合并/追加到用户既有规则文件；
- 非标准目录发现、动态加载协议、二进制产物；
- 新来源协议、认证流程、远端索引；
- 新的校验语义或新指令。

---

## 6. 发现、注册与生命周期

### 6.1 插件清单与既有索引

推荐把插件放在独立扩展登记区，而不是伪造为 `SkillIndex.skills`：

| 方案 | 优点 | 风险 | 裁决 |
|---|---|---|---|
| 同一 `skill_index.yaml` 增加 `extensions[]` | 天然只有一个事实源，事务一致 | 污染技能索引单一职责，耦合两种对象模型，与“插件不能伪装成 Skill 记录”冲突 | **未采用** |
| 独立 `plugin_index.yaml` | 对现有 Skill index 零侵入，schema/版本/锁独立 | 需要明确“插件类型的唯一事实源” | **采用（裁决 ③）** |
| 插件只存 GUI userData | 实现简单 | CLI 不可见、不可审计、违背统一入口 | 未采用 |

裁决采用独立 `plugin_index.yaml`：它是**插件类型的唯一事实源**，与 `skill_index.yaml` 物理分离、schema 与版本独立；两者各自原子写与加锁，不建立跨索引事务。底层原子写、备份与落位机制可复用，但不混数据。

### 6.2 注册/启用状态

插件记录建议字段：

| 字段 | 说明 |
|---|---|
| `id` | `plugin_id` |
| `kind` | 固定 `plugin` |
| `version` | semver 正式版 |
| `author` | 审计展示 |
| `capabilities` | 本期 `host_profile` |
| `compatibility` | 原始声明 + 解析后的兼容结论 |
| `source_url` / `source_ref` | 来源审计；本地来源可空 |
| `manifest_path` | 工作区相对路径 |
| `manifest_hash` | 安装时计算的 sha256 |
| `hosts[]` | canonical `x-...` host id、form、roots、validation |
| `state` | `disabled`（默认）/ `enabled` / `invalid` |
| `installed_at` / `updated_at` | 审计时间 |

默认状态为 `disabled`。`enable` 前必须完成 manifest schema、兼容性、命名空间、路径和 host profile 校验；失败保持 disabled 并给出可读 finding。

### 6.3 复用既有生命周期

消费面（已裁决）：

- `install`：按目录/文件中的 `plugin.json` 识别插件包，走“插件登记 + 默认 disabled”分支；不写 Skill 中心库。
- `uninstall`：删除插件登记与插件包；不触碰 Skill 记录；不做 Skill 式中心库备份。
- `enable` / `disable`：切换插件记录状态；不加载代码。
- `list` / `inspect`：增加插件类型消费面（`--kind plugin`），不把插件混进 Skill 卡片。
- `update`：**不提供插件更新分支**；版本变化通过手动 `uninstall` 后 `install`，不与 M4a 检查混用。
- `scan`：不自动发现/登记插件；只核对已登记插件并报告未登记候选，插件注册由 `install --kind plugin` 显式触发。
- `config set`：`plugin.<plugin_id>.<host_key>.root` / `.rules_root` 写入插件索引，按前缀路由；`host.<id>.*` 仍只认内置注册表。

七个指令使用显式 `--kind <skill|plugin>`：省略时为 `skill`，插件操作必须显式 `--kind plugin`，不根据来源或标识自动猜测。CLI 与 GUI 共享同一个插件登记清单，且仍不新增指令。

### 6.4 停用后的 Skill 与宿主

插件停用/删除时：

1. 立即停止提供其 host profile，并从可落位宿主集合移除；
2. **不回滚、不删除**已经落在第三方宿主根中的 Skill 副本；
3. M5 的 `--host` 分发副本不进入 Skill 索引的 `targets[]`；插件宿主副本改由 `plugin_index.yaml` 的独立 `landings` 账本记录（plugin/skill/host/target/时间/状态），停用保留、卸载标记 `orphaned`，从而不出现无法追踪的副本；
4. 依赖该宿主的后续 `--host` 选择、分发、enable/disable/update 操作明确拒绝，不猜测替代宿主；
5. 重新启用且版本兼容时，后续操作恢复可用；若插件版本不兼容，保持停用并要求用户确认升级/迁移；既有副本由用户显式清理。

---

## 7. 安全与审计

### 7.1 声明式插件的威胁面

即使无代码，manifest 仍可能：

- 伪装内置宿主或覆盖渲染策略；
- 通过路径模板写入任意系统位置；
- 通过扩展字段注入安全控制语义；
- 通过来源/版本伪造供应链信息；
- 以超大 manifest/大量 host profile 消耗资源。

对应设计约束：

| 风险 | 约束 |
|---|---|
| 内置伪装 | canonical `x-` 命名空间；内置 7 id 冻结；冲突整插件拒绝 |
| 任意路径 | roots 只接受相对模板，禁止绝对路径、盘符、`..`、未知占位符；外部根必须走插件专用配置并要求用户显式确认 |
| 安全控制字段 | 第三方 manifest **不得包含** `disable-model-invocation` 等安全控制字段；不承认自报 `security_control_evidence` |
| 供应链伪造 | 记录 manifest 哈希、来源 URL/ref、安装时间；来源通过 M4a 同口径 `E-SRC-*` 获取；本阶段不提供市场/自动分发 |
| 资源膨胀 | manifest 大小上限、host 数量上限、字段长度上限、source 下载 60s/128MiB 沿用 |
| 失败拖垮 | manifest 独立校验；失败只禁用该插件，不影响内置 registry 或其他插件 |

### 7.2 代码插件的安全前置（未来）

若未来立项，必须单独满足：

1. **权限模型**：声明并强制文件系统路径、网络域名、子进程、凭据、环境变量权限；默认拒绝。
2. **隔离模型**：不把 `vm`/worker 当作安全边界；采用受控外部进程或同等 OS 级隔离。
3. **故障隔离**：超时、内存上限、输出上限、崩溃回收；插件失败不影响主进程与内置宿主。
4. **供应链**：manifest+代码包签名/哈希锁定、发布者身份、信任清单、撤销机制。
5. **审计**：安装来源、版本、权限、加载/执行事件、失败原因可导出；不采集遥测。
6. **兼容性**：插件 API 主版本与工具版本范围；不兼容插件默认不加载。

---

## 8. 错误与失败口径

| 场景 | 结果 | 是否影响其他对象 |
|---|---|---|
| manifest schema 非法 | 插件 `invalid` / disabled；给出字段与原因 | 否 |
| 兼容性不满足 | 插件 disabled；提示所需/当前 API | 否 |
| canonical host 与内置冲突 | 整插件拒绝；不加载任一 host profile | 否 |
| 两个插件争用同一 canonical host | 后加载插件拒绝；先加载者保持 | 否 |
| root 路径越界/绝对路径 | 插件拒绝；不创建目标目录 | 否 |
| 插件禁用 | 其 host profile 从可选集合移除；已有 Skill 记录保留 | 内置与其他插件不受影响 |
| 插件启用时渲染/落位失败 | 仅该 host/该次操作失败；不自动回滚其他 Skill | 否 |
| manifest 文件损坏/缺失 | 该插件 invalid；其他插件继续校验 | 否 |
| 插件更新失败 | 保留旧版本与旧 enabled 状态，除非用户显式确认切换 | 否 |

错误码设计留到契约阶段；建议沿用现有 `E-FIELD-*` / `E-VER-*` / `E-SRC-*` / `E-CONFLICT-*` 类别，不新增“插件专属”码体系，除非契约评审需要。

---

## 9. GUI 边界

建议插件管理仅做：

- 列出已登记插件（名称/版本/状态/来源/hash/贡献的 host profile）；
- 启用/禁用/卸载；
- 显示 manifest 校验/兼容性/失败原因；
- 显示“插件提供的宿主”与“内置宿主”分组，明确不可覆盖；
- 对 disabled/invalid 插件不提供任何执行或代码加载入口。

不做：

- 在线市场、自动分发、在线检索；
- 插件代码运行状态/日志（本期无代码）；
- 后台自动启用/自动更新；
- 把插件混进 Skill 卡片或 M4a Skill 检查四态。

---

## 10. 裁决结果（已采纳）

| # | 决策点 | 裁决 |
|---|---|---|
| ① | **本期范围** | **A 仅声明式**：不加载第三方代码；9.5 的沙箱/代码托管排除项继续有效 |
| ② | **插件存放位置** | **A 工作区级** `<workspace>/plugins/<plugin_id>/plugin.json`；全局插件留待安全模型成熟后 |
| ③ | **插件登记载体** | **B 独立 `plugin_index.yaml`**：插件类型的唯一事实源，与 Skill 索引物理分离、schema/版本/锁独立 |
| ④ | **命名空间** | **A canonical `x-<plugin_id>-<host_key>`**：前缀保证内置不可覆盖，来源可机器判定 |
| ⑤ | **生命周期复用** | **A 既有指令加类型消费面**：`scan/install/uninstall/enable/disable/list/inspect` 显式 `--kind plugin`；不新增指令；技能/插件输出分区 |
| ⑥ | **插件更新检查** | **A 本期不做**：插件模型独立于 Skill；未来独立 checker；本期更新 = 手动 `uninstall` + `install`，不与 M4a 混用 |
| ⑦ | **第三方安全控制字段** | **A 一律禁止**：第三方无一手证据来源；仅复用 `skill` / `rules` / `entry` 三种形态 |
| ⑧ | **代码形态** | **维持排除**；触发条件为安全沙箱模型 + 稳定适配器 API + 独立立项，三者齐备再议 |

---

## 11. 验收映射（本次调研设计）

| 验收要求 | 落实 |
|---|---|
| 需求原文逐条引用 | 第 1.1 节 |
| 现状逐处有代码位置 | 第 2 节 |
| 扩展面清单完整 | 第 3 节（9 项判定） |
| 安全专题结论先行 | 第 0 / 4.2 / 7 节 |
| 无安全模型的代码形态不进入本期 | 第 0、4.2、7.2、10 节 |
| 每个扩展点判定 | 第 3 节 |
| 与 M5 隔离可机械验证 | 第 5.2 节 6 条断言 |
| 每平台/每形态结论不悬空 | 第 4、5、7 节 |
| LF、表格列数、reviews 快照不动 | 本文件采用 LF 表格；本批不改 `docs/reviews/` 与既有定稿 |

---

## 12. 文档计数

| 项目 | 数量 |
|---|---|
| 章节 | 13（0 ~ 12） |
| 表格 | 15 |
| 扩展点判定行 | 9 |
| 外部证据主题 | 6 组（Node SEA / vm / Permission Model / worker / VS Code / kubectl） |
| 裁决结果 | 8 |
| 机械隔离断言 | 6 |
| 新指令 | 0（保持 16） |

---

**文档结束**。本文档只做调研与设计，不包含实现代码，也不改变 `docs/reviews/` 或既有定稿。
