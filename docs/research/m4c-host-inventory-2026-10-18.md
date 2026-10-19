# M4c 宿主盘点技术调研（分发账本、真实宿主根与只读形态）

| 项目 | 内容 |
|---|---|
| 文档名称 | M4c 宿主盘点技术调研 |
| 文档路径 | `docs/research/m4c-host-inventory-2026-10-18.md` |
| 文档状态 | **调研完成，待需求侧裁决**（2026-10-18） |
| 依据 | 需求 9.3.7（M4c）、9.4.7、9.5、9.6；`docs/specification/` 六份规范 |
| 关联 | `docs/research/host-mechanisms.md`、`docs/specification/host-registry.spec.md`、`docs/specification/plugin-format.md`、`docs/specification/skill-meta-spec.md`、`docs/specification/index-format.md` |
| 边界 | 只做只读取证与分析；不改代码、不改契约、不改 `docs/reviews/`、不改 `docs/requirements.md` |

> 本文回答三个问题：四分类在一期到底能不能判、宿主真实目录到底是什么、只读盘点应当以什么形态承载。文中所有结论都给出代码位置、契约原文或本机实测命令；无法实测的平台明确标注证据等级，不把代码推导写成实测。

---

## 0. 方法与证据等级

### 0.1 环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11 家庭版中文版，10.0.26300 |
| Node / npm | v24.14.1 / 11.11.0 |
| 实测时间 | 2026-10-18（Asia/Shanghai） |
| 实测方式 | 只读枚举目录、只读读取 `SKILL.md` 头部、只读解析 frontmatter；未创建、修改或删除任何宿主文件 |

### 0.2 证据等级

| 等级 | 含义 |
|---|---|
| **[本机实测]** | 本机 Windows 上可直接复现的目录、计数或命令输出 |
| **[代码路径]** | 由当前源码的控制流与路径展开推导，未在目标平台运行 |
| **[契约原文]** | 需求或规范中的明确条文 |
| **[官方文档]** | 宿主 / 标准官方文档；引用既有调研快照时同时注明 |
| **[既有调研]** | `docs/research/host-mechanisms.md` 已登记的证据 |
| **[待确认]** | 目前没有一手证据，不能作为设计前提 |

### 0.3 方法与限制

1. Windows 侧对实际存在的宿主根做顶层目录枚举、递归 `SKILL.md` 枚举、frontmatter `name` / `description` 解析与耗时测量；
2. macOS / Linux 本机不可运行（无 macOS 主机、无 WSL），只能采用 `defaultRootFor` 的代码路径、现有平台契约测试与官方文档；**不把这两平台写成实测**；
3. 不读取技能正文，只读取 frontmatter 与目录结构；报告不记录技能内容；
4. 不运行 `install --host` / `enable --host` / `disable --host`，避免触碰真实宿主根；账本结论来自源码与契约，不来自对真实宿主的写入实验；
5. 所有计数均为 2026-10-18 时点快照，宿主升级或用户增删技能后会变化。

---

## 1. 结论摘要

1. **内置宿主没有统一的 Skill 宿主分发账本**。`targets[]` 只记录工作区目标；`enable` / `disable --host` 只改宿主副本内的 `SKILL.md` 文件名，不写索引；`uninstall` 不接受 `--host`，也不会清理宿主真实根副本。因此对内置宿主，现有数据只能支撑「工作区有记录 + 宿主有同名副本」的推断，不能支撑权威的「已纳管 / 缺失」判定。
2. **插件 `landings` 只覆盖 `x-` 宿主，且字段不足以单独判一致 / 漂移**。它有 `target_path` 与 `state`，可判 managed 与 path 缺失；没有渲染摘要、可见性与来源 checksum，无法仅凭账本判内容一致或漂移。
3. **四分类中「缺失」在一期只能对 plugin `landings` 的 active 条目成立**。内置宿主的「缺失」只能标「无法判定 / 未分发」，除非一期补建内置宿主账本，或用可复现的确定性重渲染建立推断基线。
4. **本机实际目录与注册表默认根存在明显偏差**：`~/.agents/skills` 不存在，Codex 实际可用技能在 `~/.codex/skills`（20 个有效用户技能 + 5 个 system 技能）；豆包 `.user_skills` 为空，平台 `.skills` 有 141 个有效技能。若只扫描注册表默认根，Codex 会显示 0，豆包会显示 0。
5. **顶层技能目录与递归 `SKILL.md` 是两种口径**。本机 Codex 为 20 vs 31，豆包为 141 vs 174；多出的 `sub-skills` / `references` / `examples` 不应默认当作独立安装技能。Cursor 是官方递归发现，其他宿主不能直接套用。
6. **只读盘点必须在 `scan` 上承载且先于索引初始化检查**。现有 `scan` 在索引缺失时直接返回 `E-ENV-001`；M4c 需要独立只读分支，工作区无索引时仍能扫宿主并把所有宿主技能标为未纳管 / 工作区记录未知。
7. **性能不是瓶颈**：本机顶层枚举 Codex 20 项 17 ms、豆包 141 项 82 ms；递归枚举分别约 35 ms / 273 ms。数百技能规模下不需要缓存；真正需要的是根枚举、识别口径与账本证据。

---

## 2. 分发账本现状（首要）

### 2.1 `targets[]` 记录什么

`targets[]` 在元文件与索引中都是**工作区目标**，不是宿主副本：

| 位置 | 字段 | 含义 |
|---|---|---|
| `skill_meta.yaml` 的 `targets[]` | `target` / `scope` / `path` / `mode` / `enabled` / `file_map` | 用户声明的工作区目标；`path` 是相对工作区的 `.claude/skills/<id>` 等可推导路径 |
| `skill_index.yaml` 的 `targets[]` | `target` / `scope` / `enabled` | 元文件目标的摘要投影，不含落位路径与逐文件映射 |

证据：

1. `schemas/skill_meta.schema.json` 的 `targets` 定义与 `docs/specification/skill-meta-spec.md` 3.5 节；
2. `docs/specification/skill-meta-spec.md` 341 行明确：索引 `targets` 仅含 `target` / `scope` / `enabled` 三个子字段；
3. `docs/specification/plugin-format.md` 4.6 节明确：`landings` **不是** Skill 的 `targets[]`；
4. `kernel/core/lifecycle/index.ts` 的 `toIndexRecord` 与 `projectRecord` 只从工作区目标生成 `targets` 摘要。

**结论**：`targets[]` 无法回答「这个副本是否由 `--host` 分发到宿主真实根」。把 `targets[]` 当宿主账本会把工作区目标误报成宿主分发。

### 2.2 `enable` / `disable --host` 留下什么

契约写明（`docs/specification/cli-contract.md` 426、455 行）：

1. `enable --host`：把宿主副本内带禁用后缀的 `SKILL.md` 改回 `SKILL.md`；
2. `disable --host`：把 `SKILL.md` 改成 `SKILL.md.disabled`；
3. 两者都**不修改索引状态**，不新建副本，目录与其余文件不动。

代码路径：

1. `kernel/dispatch/registry/index.ts` 的 `runHostToggle` 调用 `setHostSkillVisibility`；
2. `kernel/core/adapters/land.ts` 的 `setHostSkillVisibility` 只调用 `setCopyVisibility`；
3. `kernel/store/library-fs/index.ts` 的 `setCopyVisibility` 仅 `renameSync` 两个文件名；
4. 该路径没有任何 `saveIndex` / 账本写入。

**可留下的证据**：宿主副本目录是否存在、`SKILL.md` 还是 `SKILL.md.disabled`、以及文件内容本身。**没有留下的证据**：这个副本是否由管理器分发、上次分发时间、上次渲染摘要、与工作区记录的对应关系。

### 2.3 插件 `landings` 的覆盖范围与差异

`plugin_index.yaml` 的 `landings[]` 字段（`docs/specification/plugin-format.md` 4.6 节、`schemas/plugin_index.schema.json`）：

| 字段 | 用途 |
|---|---|
| `plugin_id` | 提供该宿主 profile 的插件 |
| `skill_id` | 已分发的 Skill |
| `host_id` | canonical `x-...` 宿主 |
| `host_key` | 插件内局部宿主键 |
| `target_path` | 实际写入路径（绝对路径） |
| `state` | `active` / `orphaned` |
| `created_at` / `updated_at` | 首次落位 / 最近变更 |

写入路径：`kernel/dispatch/registry/index.ts` 的 `hostLandingResult` 只在 `channel.plugin !== undefined`、非 `dry-run`、无错误时调用 `upsertPluginLanding` 并 `savePluginIndex`。内置宿主没有对应分支。

**覆盖范围**：仅已安装、已启用、manifest 校验通过的插件宿主（`x-...`）。**不覆盖**：claude / codex / cursor / doubao 等内置宿主。

**字段差异**：

1. 有 `target_path` 与 `state`，可判「这个插件宿主副本曾被记录为 active」；
2. 没有 `rendered_digest`、`source_checksum`、`visibility`、`adapter_ref`、`registry_version`；
3. 因此 `landings` 可判 managed 与 path 缺失，**不足以单独判一致 / 漂移**；一致性仍需确定性重渲染并比较，或扩展账本字段。

### 2.4 四分类的 authoritative 数据来源

| 分类 | 需要的证据 | 现有数据能否权威判定 | 现有一期可用的证据等级 |
|---|---|---|---|
| 已纳管且一致 | 宿主副本存在且有效；有纳管记录；有可复现的渲染基线；可见性一致 | 插件：有 landings + 可重渲染；内置：没有纳管记录，只有工作区记录 | 插件 `authoritative`（可见性/摘要需重渲染补足）；内置 `inferred` |
| 漂移 | 同上 + 上次渲染 / 来源摘要或逐文件基线 | 插件：landings 无摘要；内置：无账本 | `inferred`；有记录但无基线时 `insufficient` |
| 未纳管 | 宿主副本有效；无工作区记录；无 active plugin landing | **可以** | `authoritative`（前提是工作区索引可读；不可读时标工作区记录未知） |
| 缺失 | 有 authoritative 分发账本；根可读；目标路径不存在 | 插件：active landings 可判；内置：不可判 | 插件 `authoritative`；内置 `insufficient` / 未分发 |

补充口径：

1. 宿主副本存在但没有有效 `SKILL.md` 时，归「不可读 / 不合格」，不归缺失；
2. 根整体不存在 / 未挂载 / 不可读时，归「根不可用」，不归缺失；
3. 工作区有记录、宿主无副本、也没有账本时，归「未分发 / 无法判定」，不归缺失；
4. 插件 disabled / 卸载 / manifest 校验失败时，不把其 landings 当作一期 managed 证据；输出排除原因。

### 2.5 内置宿主缺账本时「缺失」的具体范围

**可以判缺失的场景**：

1. plugin `landings` 中 `state: active`，插件已启用、manifest 有效，`target_path` 所在根可读，但路径不存在；
2. 若未来新增内置宿主账本，账本 active 且路径不存在。

**不能判缺失、只能标「无法判定 / 未分发」的场景**：

1. 用户曾执行 `install --host claude`，后来手工删除 `~/.claude/skills/<id>`；
2. 用户曾执行 `install --host codex`，后来删除 `~/.agents/skills/<id>`；
3. 用户曾执行 `disable --host` 后手工删除整个副本；
4. 工作区有记录、宿主没有副本，但从未通过 `--host` 分发；
5. 工作区索引缺失 / 不可读，无法建立工作区记录；
6. 宿主副本存在但无有效 `SKILL.md`（归不可读，不归缺失）。

这就是需求文档中「内置宿主缺账本时缺失只能标无法判定 / 未分发」的具体范围。它不是实现细节，而是产品能否给出「缺失」结论的边界。

### 2.6 一期是否补建内置宿主账本

#### 方案 A：新增独立 `host_landings.yaml`（推荐，若四分类必须完整）

**最小字段**（建议，待设计定稿）：

| 字段 | 作用 |
|---|---|
| `skill_id` | Skill 标识 |
| `host_id` | 内置宿主或 `x-` 宿主 |
| `host_key` | 插件宿主局部键；内置可空 |
| `target_path` | 实际落位路径 |
| `format` | `skill` / `rules` / `entry` |
| `state` | `active` / `orphaned` |
| `visibility` | `enabled` / `disabled` |
| `rendered_digest` | 落位后宿主副本（或渲染产物 + 文件清单）的确定性摘要 |
| `source_checksum` | 落位时工作区记录的 checksum |
| `adapter_ref` | 使用的适配器 / 形态 |
| `registry_version` | 落位时的注册表版本 |
| `created_at` / `updated_at` | 首次落位 / 最近一次落位或可见性变更 |

**写入时机**：

1. `install --host` / `update --host` 成功落位后写 `active`；
2. `enable --host` / `disable --host` 成功后更新 `visibility`；
3. `uninstall` 将对应条目标 `orphaned`，保留追踪，不删除宿主副本；
4. `dry-run` 不写；失败不写；
5. M4c 盘点只读，不写账本。

**历史副本**：不自动回填。升级前已存在的宿主副本没有账本，一期标 `inferred` / `insufficient`；二期确认后的修复/纳管动作再做回填。这样 M4c 自身仍保持只读。

**影响面**（至少）：

1. 新增一份契约规范 / schema（或明确作为索引格式扩展）；
2. `kernel/store/` 新增加载 / 原子写 / 锁；
3. `kernel/store/workspace/index.ts` 增加账本路径；
4. `kernel/core/adapters/land.ts` 返回落位摘要；
5. `kernel/dispatch/registry/index.ts` 的 install / update / enable / disable / uninstall 接线；
6. `kernel/core/lifecycle/index.ts` 的卸载与恢复路径；
7. `kernel/store/backup`、`export` / `import` / `restore` 是否携带账本；
8. 测试：单元、契约、e2e、GUI 冒烟；
9. 文档：契约、架构、需求、one-summary。

**优点**：内置宿主也能权威判「已纳管 / 缺失」；插件与内置宿主可以有统一口径；后续漂移可定位到副本。

**风险 / 代价**：

1. 这是一次真实的契约与数据模型变更，必须独立于 M4c 读需求先走设计；
2. 落位内容、索引、账本三者不是同一原子写，账本写失败会出现「内容已落位但账本未记」；需要可恢复策略或下次修复；
3. 历史副本无账本，短期仍有一段时间的 `inferred`；
4. 账本本身可能被用户删除或手改，需要校验与 `insufficient` 处理。

#### 方案 B：一期不补，只用工作区记录 + 确定性重渲染推断

**做法**：

1. 对同 id 的工作区记录，按宿主注册表 + 适配器重新渲染预期产物；
2. 与宿主副本逐文件比较，得到 `inferred` 的一致 / 漂移；
3. 没有工作区记录 → 未纳管；
4. 没有账本 → 缺失不可判，标未分发 / 无法判定；
5. 插件 landings 仍用于插件宿主的 managed / 缺失。

**优点**：不新增契约、不写任何文件；M4c 一期可以纯粹只读；实现面小。

**缺点**：无法区分「手工复制但内容恰好一致」与「管理器分发」；内置宿主的缺失永远不可判；四分类只能算「三类 + 推断」。

#### 推荐

**如果四分类是 M4c 的核心验收指标，推荐方案 A，但把它作为 M4c 前置的独立契约/实现批次，而不是塞进 M4c 的只读扫描。** 理由：

1. 没有账本，`缺失` 对内置宿主永远不可判，产品承诺与验收标准会自相矛盾；
2. 方案 B 的 `inferred` 可以保留为历史副本与无账本场景的降级，但不能替代权威账本；
3. 方案 A 的写发生在既有分发命令中，M4c 扫描仍然只读，不违反只读硬需求；
4. 最小账本可以只覆盖 `install/update/enable/disable/uninstall --host`，不扩大到宿主运行时或自动同步。

若排期不接受新增契约，则 **一期明确收窄为**：插件 `landings` 可判缺失；内置宿主只做未纳管、推断一致 / 漂移、未分发 / 无法判定，不承诺内置宿主缺失。该收窄必须在需求验收与 GUI 文案中显式可见。

---

## 3. 宿主真实目录结构

### 3.1 注册表、根解析器与库存枚举不是同一件事

当前代码里存在三类对象：

1. **注册表 `hosts[].roots[]`**：描述宿主可用的落位模板（`path_template`），例如 `.<目标标识>/skills/<Skill 标识>`、`<用户主目录>/.agents/skills/<Skill 标识>`；它服务于分发，不是库存根枚举器；
2. **`resolveHostRoot()`**：把一个宿主 + 根类别解析成**一个**真实路径，来源为配置覆盖或 `defaultRootFor()`；它不会枚举项目级 / 用户级 / 遗留 / 平台自有的多个根；
3. **M4c 需要的库存根枚举**：一个宿主可能对应多个实际根（用户级、项目级、遗留、平台自有、system），需要逐根给出 `root_role`、`scope`、`source`、`exists/readable` 与 `consumers`。

证据：`kernel/core/adapters/roots.ts` 的 `defaultRootFor()` 与 `resolveHostRoot()`；`kernel/core/hosts/registry-data.ts` 的 `roots[]`；`docs/specification/host-registry.spec.md` 3.3 节。

**结论**：M4c 不能直接调用一次 `resolveHostRoot()` 就当作完整盘点；需要新增只读的根枚举模型，或至少把「注册表模板根 + 配置覆盖根 + 已知遗留 / 平台根」组合起来。该模型属设计阶段，不在本调研中实现。

### 3.2 内置 7 宿主的事实表

| 宿主 | 注册表落位根（模板） | 默认 / 已知实际根 | 平台证据 | 本机 Windows 观测 | 消费方 |
|---|---|---|---|---|---|
| Claude | `.claude/skills/<id>`（project） | 用户级 `~/.claude/skills`；项目级 `<workspace>/.claude/skills` | `defaultRootFor` 在 linux/win32/darwin 均给 `~/.claude/skills`；契约测试覆盖 linux | 目录不存在 | `claude`、`cursor` |
| Codex | `<用户主目录>/.agents/skills/<id>`（global） | 官方 USER `~/.agents/skills`；官方 REPO `<repo>/.agents/skills`；遗留 `~/.codex/skills`（仅配置覆盖） | 官方文档 + `host-mechanisms` 2.3/6.3；`defaultRootFor` 在 darwin 返回 `~/.agents/skills` | `.agents/skills` **不存在**；`.codex/skills` 存在，21 个顶层目录、31 个递归 `SKILL.md`；其中 `.system` 下 5 个 | `codex`、`cursor`、`dsh`（外部消费方） |
| Cursor | `.cursor/skills/<id>`（project）；`.cursor/rules/<id>.mdc`（rules） | 用户级 `~/.cursor/skills`；项目级 `<workspace>/.cursor/skills`；规则 `~/.cursor/rules` / `<workspace>/.cursor/rules` | `defaultRootFor` 在 linux 给 `~/.cursor/skills` / `~/.cursor/rules`；官方文档支持递归 | 目录不存在 | `cursor`；并读取 Claude / Codex 根 |
| 豆包 | `.user_skills/<id>`（external） | 用户根 `<agent workspace>/.user_skills`；平台根 `<agent workspace>/.skills`（平台持有、禁止写入）；`.agents/skills` 第三根待确认 | 仅 Windows 有默认路径；linux/darwin `defaultRootFor` 返回 undefined；`host-mechanisms` 2.5 补记 | `.user_skills` 存在但为空；`.skills` 存在，141 个顶层目录、174 个递归 `SKILL.md` | `doubao` |
| 通用 Agent Skills | `<调用方指定的技能根>/<id>` | 无默认根；必须显式配置 | `defaultRootFor` 返回 undefined | 无实际根 | 由调用方指定；不是具体宿主 |
| 通用 AGENTS.md | `AGENTS.md`（rules，文件） | 无技能目录 | 规则载体；不产生 `SKILL.md` | 本机有 `~/.codex/AGENTS.md`（非 skill） | `codex`、`cursor` |
| DeepSeek | 无 roots | 无 | 官方定位模型提供方；`resolveHostRoot` 返回 undefined | 无 | 不适用 |

**三平台证据矩阵**

| 平台 / 对象 | 路径展开证据 | 实际宿主目录 | 当前结论 |
|---|---|---|---|
| Windows | 本机实测 `defaultRootFor` 对应路径；`~/.codex/skills`、豆包 `.skills` / `.user_skills` 实际存在 | **[本机实测]** 见 3.3 | 有实际目录证据 |
| macOS | `defaultRootFor('codex', ... 'darwin')` → `~/.agents/skills`；`defaultRootFor('claude', ...)` 等由代码路径给出；`tests/contract/land.test.ts:50-90` 覆盖 darwin 路径展开 | **[待确认]** 本环境无 macOS 主机 | 路径展开有代码 / 契约证据；实际目录未实测 |
| Linux | `defaultRootFor('claude'/'cursor', ... 'linux')` → `~/.claude/skills` / `~/.cursor/skills` / `~/.cursor/rules`；`tests/contract/land.test.ts:50-90` 覆盖 linux 路径展开 | **[待确认]** 本环境无 Linux 主机 / WSL | 路径展开有代码 / 契约证据；实际目录未实测 |
| Claude / Cursor 本机 | 代码与官方文档给出用户级根 | **[待确认]** 本机未安装 / 目录不存在 | 不能把“目录不存在”推断为“宿主一定未安装”；只标根缺失 |
| 豆包非 Windows | `defaultRootFor('doubao', ... 'linux')` 返回 undefined，契约测试断言“不给默认值” | **[待确认]** | 非 Windows 必须配置根；不能猜路径 |

> 结论：三平台的**路径展开**有代码与既有契约测试证据；三平台的**实际宿主目录**目前只有 Windows 本机实测。macOS / Linux 的实际目录与宿主安装形态仍是待补事实，不应在设计中写成已验证。

### 3.3 本机 Windows 实测计数

**有效 `SKILL.md`** 指：顶层技能目录下存在 `SKILL.md`，frontmatter 可解析且含字符串 `name` 与 `description`。完整 skill-manager 元数据 schema **不参与**该判定（宿主技能通常没有 `skill_meta.yaml`）。

| 根 | 顶层目录 | 顶层有效技能 | 递归 `SKILL.md` | 顶层枚举耗时 | 递归枚举耗时 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| `~/.codex/skills` | 21 | 20 | 31 | 17 ms | 35 ms | `.system` 无直接 `SKILL.md`；其下 5 个 system 技能 |
| `~/.codex/skills/.system` | 5 | 5 | 5 | — | — | system 根；是否计入「实际安装」需裁决 |
| 豆包 `.skills` | 141 | 141 | 174 | 82 ms | 273 ms | 平台持有；`sub-skills` / `references` 产生额外 33 个嵌套 `SKILL.md` |
| 豆包 `.user_skills` | 0 | 0 | 0 | — | — | 当前为空 |
| `~/.claude/skills` | 不存在 | 0 | 0 | — | — | 未安装 / 未创建 |
| `~/.agents/skills` | 不存在 | 0 | 0 | — | — | Codex 官方默认根，但本机实际未使用 |
| `~/.cursor/skills` | 不存在 | 0 | 0 | — | — | 本机未安装 Cursor |

**同一台机器的不同口径**：

| 口径 | 数量 |
|---|---:|
| 只算注册表默认根（Codex `.agents` + 豆包 `.user_skills`） | **0**（Codex、豆包均为 0） |
| 只算 Codex 用户根 + 豆包用户根 | 20 + 0 = **20** |
| Codex 用户根 + 豆包平台根 | 20 + 141 = **161** |
| 再加 Codex `.system` | 20 + 5 + 141 = **166** |
| 递归 `SKILL.md`（Codex 用户根 + 豆包平台根） | 31 + 174 = **205** |
| 再算 Codex 插件缓存（`~/.codex/plugins/cache`，134 个 `SKILL.md`） | **339**（按 205 + 134） |

这不是计数误差，而是**范围定义差异**。M4c 必须先裁决：注册表默认根、用户根、项目根、平台自有根、system 根、宿主插件缓存分别算不算。

本机还观测到 `~/.codex/plugins/cache` 下有 134 个 `SKILL.md`。按需求 9.3.7「仅统计 skill-manager 自身插件」，Codex 宿主插件缓存**不在 M4c 领域内**，不能把这 134 个算入 Skill 数量；但应在排除清单中给出原因。

### 3.4 共享根与物理去重

事实：

1. Codex 官方 USER 根 `~/.agents/skills` 同时被 Cursor 与 `dsh` 读取；注册表 `consumed_by` 为 `['codex', 'cursor', 'dsh']`；
2. Claude 的 `.claude/skills` 被 Cursor 兼容读取；注册表 `consumed_by` 为 `['claude', 'cursor']`；
3. 豆包 `.agents/skills` 是否为第三根仍为 Q-08，未确认；
4. 本机 `.agents/skills` 不存在，因此本机无法用真实目录验证共享根；只能依据注册表与既有调研。

**去重口径建议**：

1. 对每个技能目录取 `realpathSync.native()`（或等价真实路径），得到物理目录；
2. 以「平台规范化后的真实路径」为唯一键；Windows 默认大小写不敏感，macOS 可能大小写不敏感，Linux 通常敏感；
3. 不把「同一物理技能被多个宿主读取」算成多份；但保留每个宿主 / 消费方的视图；
4. 符号链接 / junction 必须解析；解析后落在登记根之外或形成环时标不可读，不跟随；
5. 不能用文件内容哈希作为唯一键——两个不同技能可以内容相同；也不能只用目录名——同名不同目录可能不同技能。

**消费方标注**：`consumers` 取注册表 `roots[].consumed_by` + `classification.root_consumed_by` + `external_consumers`；外部消费方（如 `dsh`）只出现在消费方集合，不单独作为宿主分组或计数。

### 3.5 第三方 `x-` 宿主的根来源

第三方宿主只在工作区 `plugins/` 中由已启用且校验通过的插件提供：

1. `plugin.json` 的 `hosts[]` 声明 `host_key`、`form`、`roots[]`；
2. canonical id 为 `x-<plugin_id>-<host_key>`；
3. `scope: project` 的根相对工作区展开；`scope: global` 的根必须由 `plugin.<plugin_id>.<host_key>.root` / `.rules_root` 显式配置，未配置即报错；
4. 只有 `form: skill` 进入 Skill 计数；`rules` / `entry` 标非技能形态；
5. 枚举来源是 `loadPluginCatalog()` + `pluginHostIds()`，只取 `enabled` 且 manifest 有效的宿主。

证据：`kernel/core/plugins/host.ts`、`kernel/core/plugins/catalog.ts`、`docs/specification/plugin-format.md` 3.3 / 4.5 节。

本机当前仓库不是已初始化工作区，未发现可枚举的 `x-` 宿主；这项只能做代码路径与契约层面的确认，不能声称有实际第三方宿主实测。

### 3.6 识别深度：顶层技能 vs 递归 `SKILL.md`

| 宿主 / 根 | 建议深度 | 依据 |
|---|---|---|
| Claude 用户 / 项目根 | 1 层（技能目录直接含 `SKILL.md`） | 注册表模板 `<root>/<id>/SKILL.md`；官方技能包结构 |
| Codex 用户根 `.codex/skills` | 1 层；`.system` 作为独立 system 根再扫 1 层 | 本机 20 个用户技能 + 5 个 system；递归会把 `references/examples` 误计 |
| Codex 官方 `.agents/skills` | 1 层 | 官方目录约定；实际本机不存在 |
| Cursor skills 根 | **递归**（官方明确） | `host-mechanisms` 2.4：仓库内任意层级 `.cursor/skills` 递归发现 |
| 豆包 `.skills` / `.user_skills` | 1 层 | 本机 141 个顶层技能；`sub-skills` / `references` 是技能内部资产 |
| 第三方 `x-` skill 根 | 1 层，除非插件 manifest 明确声明递归 | 插件格式没有递归声明；不应猜测 |
| `agents-md` | 不扫技能 | 规则文件，不是技能根 |
| `deepseek` | 不扫 | 无技能机制 |

**结论**：不能用一个全局 `find SKILL.md` 递归扫所有宿主。顶层技能目录与嵌套资产必须分开；只有 Cursor 的官方规则明确递归。未知宿主默认 1 层并标证据等级，不能把 `references/examples` 计为安装技能。

---

## 4. 识别、一致性与性能

### 4.1 有效 `SKILL.md` 判定

建议分三层，不要混为一个布尔值：

| 层 | 判据 | 失败时的状态 |
|---|---|---|
| 可读 | 文件存在、可读、frontmatter 可解析 | `unreadable` / `invalid_yaml` |
| 宿主可识别 | 至少含 `name` 与 `description`（宿主另有要求时按注册表 / 官方规则） | `invalid_meta` |
| skill-manager 元数据合格 | 完整 `skill_meta` schema（仅工作区记录适用） | `workspace_invalid`，不影响宿主盘点计数 |

本机实测：Codex 用户 20 个有效、`.system` 5 个有效、豆包平台 141 个有效；没有发现 YAML 解析失败或 `name` / `description` 缺失。`.system` 本身没有直接 `SKILL.md`，不能把 `.system` 目录当作一个技能。

### 4.2 一致性比对的可行方法

**不能直接拿工作区 `checksum` 与宿主副本比较**：宿主副本是渲染产物（frontmatter 可能被裁剪 / 重排），工作区 checksum 是对原件目录计算的。`update --check` 的漂移检测（`kernel/core/lifecycle/index.ts` 1549 起）比较的是**中心库原件**与记录，不是宿主副本。

可行层次：

1. **渲染基线（推荐）**：从工作区记录 + 宿主注册表 + 适配器重新渲染预期产物；对宿主副本按文件清单 / 内容摘要比较；得到一致 / 漂移与逐文件差异；
2. **账本摘要（补强）**：落位时记录 `rendered_digest` + `source_checksum`；盘点只读比较；比现渲染更便宜，也能识别「落位后源已更新但宿主仍旧」；
3. **mtime**：只能作为启发式，不能作为唯一判据；复制、备份、同步、文件系统精度都会改变 mtime；
4. **文件清单 + 内容摘要**：用于逐文件差异；目录复制类技能要排除 `.disabled` 改名差异，或把它作为可见性状态而非内容差异。

`plugin landings` 目前没有摘要；若要判插件宿主的一致 / 漂移，仍需第 1 层重渲染，或扩展 `landings` 字段。

### 4.3 损坏、不可读、符号链接与重复目录

1. 目录没有 `SKILL.md`：标 `no_skill_file`，不计数；
2. `SKILL.md` 存在但不可读 / YAML 错误：标 `unreadable` / `invalid_yaml`，不计数；
3. `SKILL.md` 存在但缺 `name` / `description`：标 `invalid_meta`，不计数；
4. 符号链接 / junction：解析真实路径；落在登记根之外或形成环时标 `unsafe_link`，不跟随；
5. 同一物理目录被多个根枚举到：按真实路径去重；同一物理目录在同一个宿主下有多个路径别名时，只保留一个主路径，其余作为别名；
6. 目录名与 `name` 不一致：宿主可能仍识别；标 `id_mismatch` 警告，不静默丢弃；是否计数按宿主识别规则。

### 4.4 性能与缓存

本机实测（Windows，冷启动进程不计）：

| 操作 | 数量 | 耗时 |
|---|---:|---:|
| Codex 顶层 21 目录 + `SKILL.md` 检查 | 21 | 17 ms |
| Codex 递归 31 个 `SKILL.md` | 31 | 35 ms |
| 豆包顶层 141 目录 + `SKILL.md` 检查 | 141 | 82 ms |
| 豆包递归 174 个 `SKILL.md` | 174 | 273 ms |

参考 M3 实测（`docs/one-summary.md`）：1000 技能 `scan` 约 1.1 s，5000 技能约 11 s（源码线，Windows）。宿主盘点只做目录枚举 + 少量 frontmatter 解析，规模远低于完整 `scan`。

**结论**：数百技能不需要持久缓存；一次盘点在内存中完成即可。不要为了缓存写临时文件 / 缓存文件（会违反只读）。若要优化，只做进程内短期缓存，并且不得跨扫描写盘。

### 4.5 失败隔离

单宿主 / 单根 / 单条目失败不得中断整体：

1. 根不存在 → `missing_root`（跳过，不报整体失败）；
2. 根不可读 / 不是目录 → `unreadable_root`；
3. 单技能不可读 → `unreadable_item`；
4. 插件 manifest 无效 / 插件 disabled → `excluded_plugin`；
5. 结果保留其他宿主的成功数据，并给出每个失败的 `host_id` / `root` / `path` / 原因。

---

## 5. CLI 与 GUI 形态

### 5.1 `scan` 只读模式候选

现有 `scan`（`kernel/dispatch/registry/index.ts` 1499 起）流程：

1. `--kind plugin` → 插件扫描；
2. 计算 workspace layout；
3. **索引不存在 → `E-ENV-001`**；
4. 加锁、加载索引、`scanWorkspace()`、写索引（非 dry-run）。

因此 M4c 的只读分支必须放在第 3 步之前，且不能调用 `scanWorkspace()`。

候选语法：

| 候选 | 优点 | 风险 / 冲突 |
|---|---|---|
| **`scan --inventory`（推荐）** | 语义清楚；布尔选项；不与现有 `--kind` / `--root` 混淆 | 需要新增布尔选项登记与帮助文本 |
| `scan --hosts` | 与 `--host` 有词面关联 | 易被误解为「只扫某个 host」，而现有 `--host` 是取值选项 |
| `scan hosts` 位置参数 | 读起来自然 | `scan` 现有位置参数为空；会引入新解析分支 |
| `scan --kind host` | 复用 `--kind` | 现有 `--kind` 只允许 `skill` / `plugin`，扩第三个值会改变既有语义 |

**建议**：`skill-manager scan --inventory [--json]`。约束：

1. 与 `--kind`、`--root` 互斥；与 `--dry-run` 互斥（本身已只读，避免两套只读语义）；
2. 不要求工作区已 `init`；索引缺失时按「工作区记录为空」处理；
3. 不新增指令，指令总数仍为 16；
4. 输出沿用既有结果封装；默认人类可读，`--json` 结构化。

### 5.2 结构化输出字段

建议至少包含：

```text
data:
  scanned_at
  workspace: { root, index_state: ok|missing|unreadable }
  roots[]:
    host_id, display_name, host_group: builtin|plugin,
    root_id, root_role: user|project|legacy|system|platform|config,
    root_kind: skill|rules|external,
    path, source: registry_default|config|legacy|platform,
    status: ok|empty|missing|unreadable|not_configured|not_applicable|non_skill,
    consumers[]
  hosts[]:
    host_id, display_name, counts {total, unique, managed_consistent, drift, untracked, missing},
    evidence_counts {authoritative, inferred, insufficient},
    roots[], items[]
  items[]:
    skill_id, physical_path, host_id, root_id, visibility: enabled|disabled|unknown,
    recognition: valid|invalid_meta|no_skill_file|invalid_yaml|unreadable|unsafe_link,
    reconciliation: managed_consistent|drift|untracked|missing|undetermined|not_distributed,
    evidence: authoritative|inferred|insufficient,
    evidence_refs[], drift_details[], untracked_import_hint
  excluded[]:
    kind: host|plugin|root|path, id, reason
```

`missing` 只应由 authoritative 账本产生；`undetermined` / `not_distributed` 必须与 `missing` 分开统计。

### 5.3 GUI 盘点视图

现有视图族为 `dashboard | validation | backup | plugins | settings`（`gui/renderer/src/App.vue` 33 行）。建议新增一个 **`hosts` 视图**，而不是重做页面族：

1. 顶部：全局唯一技能数 + 四分类统计 + 本次扫描时间；
2. 按宿主分组：显示名、根状态、消费方 chips、四分类计数；
3. 未纳管清单：标识、宿主、路径、版本 / 描述（可得时）、指纹（可得时）、二期导入提示；
4. 不可读 / 不适用 / 根缺失 / 无法判定：单独折叠区；
5. 空工作区：显示宿主已有技能；「导入工作区」按钮标注「二期」，不可执行；
6. 刷新由用户显式触发；进入视图时自动加载一次；异步执行，单宿主失败不使视图空白。

所需字段与 5.2 的 `data` 对齐；GUI 不应自行重新推导分类，只读内核输出。

### 5.4 只读保证的可验证方式

1. 扫描前后对工作区与所有被扫描宿主根做递归清单：相对路径、类型、大小、内容 SHA-256、mtime；
2. 断言清单完全一致；atime 不作为判定项（读取可能改变 atime）；
3. 断言索引文件、`plugin_index.yaml`、`last_scan_at` 的 mtime 与字节不变；
4. 断言没有新增临时文件、锁文件、日志、缓存；
5. 断言没有网络请求、没有执行宿主；
6. 在空工作区、根缺失、根不可读、损坏 `SKILL.md`、共享根五种夹具上各跑一次。

### 5.5 退出码与失败

盘点本身成功、但部分宿主不可读时：建议 `ok: true`，`findings` 使用警告级 / 数据状态，退出码 0；只有整体无法执行（如无法读取任何根、参数非法）才非零。是否新增问题码需在设计中按既有结果规范登记；本调研不新增契约。

---

## 6. 建议与待裁决

### 6.1 建议

1. **账本**：若四分类（尤其内置宿主缺失）必须完整，采用方案 A（独立 `host_landings.yaml`），作为 M4c 前置独立批次；若不接受新增契约，则一期明确只承诺插件缺失 + 内置推断，并在 GUI / 验收中写明。
2. **根范围**：至少把以下作为只读 observed roots 暴露，而不是只扫注册表默认根：
   - Codex `~/.codex/skills`（legacy / user）与 `~/.codex/skills/.system`（system）；
   - 豆包 `.skills`（platform）与 `.user_skills`（user）；
   - 各宿主的项目级根（`<workspace>/.claude/skills` 等）与用户级根；
   - 每个根带 `root_role` 与 `source`，让用户知道「为什么算 / 为什么不算」。
3. **计数**：按宿主声明的识别深度；默认顶层 1 层，Cursor 递归；`sub-skills` / `references` / `examples` 不作为独立安装技能；唯一计数按物理技能目录。
4. **一致性**：优先确定性重渲染 + 文件清单 / 内容摘要；mtime 只作辅助；不要用工作区 checksum 直接比宿主副本。
5. **形态**：`scan --inventory`；工作区未初始化也能跑；不新增指令；GUI 新增 `hosts` 视图，复用既有组件。
6. **性能**：不做持久缓存；进程内一次性盘点即可；本机百级目录耗时 17–273 ms。

### 6.2 待裁决问题

| 编号 | 问题 | 影响 | 建议裁决点 |
|---|---|---|---|
| Q-M4C-01 | 一期是否补建内置宿主账本 | 决定四分类能否完整；决定是否新增契约 / schema | 需求侧拍板；建议方案 A 或明确收窄 |
| Q-M4C-02 | 「实际安装」是否包含 Codex `.system`、豆包 `.skills` 平台根、项目级根 | 本机同机可从 20 变 161/166/205 | 产品口径；建议按 `root_role` 展示，默认计入 user + platform，system 单列 |
| Q-M4C-03 | Codex 默认根用官方 `.agents` 还是实机 `.codex` | 本机只扫默认根时 Codex 显示 0 | 建议 observed roots 同时展示，并标注 official vs legacy |
| Q-M4C-04 | 顶层 vs 递归识别深度 | 本机 161 vs 205；可能把 `references` 误计 | 按宿主规则；Cursor 递归，其余顶层；未知宿主默认顶层 |
| Q-M4C-05 | `--inventory` 与 `--dry-run` / `--kind` / `--root` 的组合 | 影响语法与错误码 | 建议互斥；不新增指令 |
| Q-M4C-06 | 禁用态识别是否只认 `.disabled` 后缀 | Codex 官方禁用还涉及 `config.toml`；不同宿主可能不同 | 建议 `visibility: enabled/disabled/unknown` + `evidence`，不假设单一机制 |
| Q-M4C-07 | 缺失的退出码 / 问题码 | 影响结果契约 | 一期可放 `data` 状态；若新增码，先登记契约 |
| Q-M4C-08 | 第三方 `x-` 宿主的 project / global 根枚举 | 影响插件宿主盘点 | 按 plugin manifest + config；未配置即排除并说明 |
| Q-M4C-09 | macOS / Linux 真实宿主目录 | 本环境无法实测 | 设计前补 macOS / Linux 真机或 CI 证据；当前只做代码 / 官方文档推导 |

---

## 附录 A：本机复现命令与原始形态

### A.1 目录存在性与计数

```powershell
$roots = @(
  "$env:USERPROFILE\.claude\skills",
  "$env:USERPROFILE\.agents\skills",
  "$env:USERPROFILE\.codex\skills",
  "$env:USERPROFILE\.cursor\skills",
  "$env:LOCALAPPDATA\Doubao\User Data\Default\.doubao\agent_mode\workspace\.skills",
  "$env:LOCALAPPDATA\Doubao\User Data\Default\.doubao\agent_mode\workspace\.user_skills"
)
foreach ($p in $roots) {
  if (Test-Path -LiteralPath $p) {
    $top = @(Get-ChildItem -LiteralPath $p -Directory -Force)
    $md = @(Get-ChildItem -LiteralPath $p -Recurse -File -Filter SKILL.md -Force)
    [pscustomobject]@{ Path=$p; TopDirs=$top.Count; RecursiveSkillMd=$md.Count }
  } else {
    [pscustomobject]@{ Path=$p; TopDirs=0; RecursiveSkillMd=0; Missing=$true }
  }
}
```

### A.2 frontmatter 有效性与耗时

```powershell
$root = "$env:USERPROFILE\.codex\skills"
$sw = [Diagnostics.Stopwatch]::StartNew()
$top = @(Get-ChildItem -LiteralPath $root -Directory -Force | Where-Object {
  Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md')
})
$sw.Stop()
"$($top.Count) top-level SKILL.md; $($sw.ElapsedMilliseconds) ms"
```

frontmatter 解析使用本机 `node` + `yaml`（仓库依赖）完成，解析 `name` / `description` 字符串，不读取正文。

### A.3 代码位置索引

| 位置 | 用途 |
|---|---|
| `kernel/dispatch/registry/index.ts:362-430` | `hostLandingResult()`：内置宿主无账本，插件宿主写 landings |
| `kernel/dispatch/registry/index.ts:539-715` | `runHostToggle()`：enable/disable --host 只改文件名 |
| `kernel/dispatch/registry/index.ts:1499-1567` | `scanHandler()`：索引缺失即 `E-ENV-001` |
| `kernel/core/adapters/land.ts:140-180` | `landPlan()`：内容落位；不写账本 |
| `kernel/core/adapters/land.ts:186-200` | `setHostSkillVisibility()` |
| `kernel/core/plugins/host.ts:350-400` | `upsertPluginLanding()` / orphan 标记 |
| `kernel/core/lifecycle/index.ts:440-445` | 工作区 targets 摘要 |
| `kernel/core/lifecycle/index.ts:1549-1690` | `update --check` 的中心库漂移检测 |
| `kernel/core/adapters/roots.ts:26-62` | `defaultRootFor()` 平台路径 |
| `kernel/core/adapters/roots.ts:92-205` | `resolveHostRoot()` 单根解析 |
| `kernel/core/hosts/registry-data.ts` | 7 内置宿主条目与 `consumed_by` |
| `kernel/core/adapters/index.ts:117-128` | `FORM_BY_HOST` 硬编码宿主映射 |
| `kernel/core/metadata/validate.ts:237-280` | 来源字段校验 |
| `kernel/core/discovery/index.ts:77-112` | `scanWorkspace()` 写路径 |
| `docs/specification/skill-meta-spec.md:341` | 索引 `targets` 仅为摘要 |
| `docs/specification/plugin-format.md:245-260` | `landings` 字段与用途 |
| `docs/specification/cli-contract.md:426,455` | enable/disable --host 语义 |

---

## 附录 B：本调研未做的事

1. 未在 macOS / Linux 运行宿主机；未验证其路径存在性；
2. 未在 Claude / Cursor 实际安装环境验证目录结构（本机未安装）；
3. 未执行真实 `install --host` / `enable --host` / `disable --host` 写入实验；
4. 未修改任何契约、schema、代码、测试或 `docs/reviews/`；
5. 未裁决账本、根范围、语法与统计口径；这些留给需求侧拍板与后续设计。
