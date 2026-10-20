# M5：批量分发与 i18n 选型技术调研（2026-10-20）

| 项目 | 内容 |
|---|---|
| 文档名称 | M5 批量分发与 i18n 选型技术调研 |
| 文档路径 | `docs/research/m5-distribute-batch-i18n-2026-10-20.md` |
| 文档状态 | 调研完成，待需求与设计裁决 |
| 依据 | 需求 9.3.9；`docs/research/m4c-host-inventory-2026-10-18.md`；`docs/specification/skill-meta-spec.md`；`gui/renderer/src/*`；`kernel/dispatch/reconcile/*` |
| 结论导向 | 只做选型与复用调研；不改代码、不定稿 API、不写实现细节 |

> 本文回答三个问题：批量分发/跨宿主一致性审计有哪些成熟复用标的、`SKILL.md` frontmatter 该怎么解析、GUI/i18n 该选什么库。结论按“现状事实 → 候选/现成方案 → 推荐（自研 / 二开 / 借鉴）→ 风险”结构书写。

---

## 四节结论摘要

1. 现状盘点
   - 再次确认：批量/多选不是在 execute 层做“最终集成”，而是在 `selection` + `plan` 层先过滤候选，再由 `items[]` 逐副本执行；现有模型已经具备 item 级事务骨架，适合扩批量模式。
   - 审计矩阵缺口是“没有统一的 `skill × host × target` 事实库”，当前 `host_landings` 只能作为落位记录，不是统一收益/漂移审计的唯一事实源。
   - GUI 仍大量中文硬编码；无统一 i18n 与组件抽象层；组件库可以加速，但本项目更适合轻量自建样式 + 成熟 i18n 库。
   - 分发通道：新增 target 分发应走 `install` / “已纳管分发到新 target” 的再分发通道，不能挤进 `toggle` 或 `repair` 的语义。
   - `SKILL.md` frontmatter 解析尚未在 repo 中落地：现有实现是 `skill_meta.yaml` 读取，且未发现真正的 frontmatter 解析器；这意味着 frontmatter 与工作区元文件仍需分层设计。

2. 外部规范核实
   - Anthropic 官方 `SKILL.md` metadata 语义明确：字段在 frontmatter 顶层，`name` / `description` 属展示元数据，`author` / `version` / `license`、`allowed-tools`、`mcp-server` 等属于标准已识别字段。
   - 对 i18n 的成熟方案优先推荐 `vue-i18n`（MIT），因其活跃、成熟、适合 Vue3/Electron；自建仅在规模极小且无需维护多语言时考虑。

3. 现成方案 / 成品代码复用调研
   - i18n：优先 `vue-i18n`（MIT），包体积可控；不建议自建。
   - `SKILL.md` frontmatter：优先 `gray-matter`（MIT）+ `yaml`（MIT）组合，不建议手写复杂 parser。
   - 同类工具：`vercel-labs/skills-cli`（Apache-2.0）和 `agentskills/agentskills`（Apache-2.0）最适合做“技能分发与规范借鉴”；`agent-skill-manager-cli`（MIT）适合做“包管理器/安装更新流程”借鉴；`microsoft/apm`（MIT）适合做“agent package manager”架构参考。
   - GUI 组件库：若看重速度和一致性，可以二开/集成 `element-plus`（MIT）或 `naive-ui`（MIT），但本项目更适合保留轻量自建样式；二次封装更符合当前规模与包体积要求。

4. 风险与未知
   - 批量事务：当前模型是 per-item 事务，不是全局二阶段事务；在扩批量时应保持逐项隔离。
   - 审计 drift 口径：必须统一“审计层”和“reconcile 操作层”两个口径，否则同一副本会出现“内容漂移 / source_changed / visibility mismatch”语义混用。
   - i18n 边界：`CODES`、`Finding.code`、JSON 契约字段是不可翻译的；只 GUI 文案应参与本地化。

---

## 一、现状盘点（读现有代码，给路径:行）

### 1.1 reconcile 多选改造点

#### 现状事实
- `selection` 统一由 `ReconcileSelection` 接收；当前选型是 `path | id-host | classification`，见 `contract/src/reconcile.ts:35-45`。
- 计划生成入口 `buildReconcilePreview()` 调用 `selectCandidates()`，并在 `selection.mode` 下决定候选过滤规则；见 `kernel/dispatch/reconcile/plan.ts:80-107`。
- 共享根与 transaction group 逻辑已经落地，说明批量操作的“多 item / 多分组”语义是设计中的一部分，不是完全空白；见 `kernel/dispatch/reconcile/plan.ts:444-465`。
- 计划汇总与签名保持稳定，便于做“只读预览->确认->执行”的事务闭环；见 `contract/src/reconcile.ts:119-145`、`kernel/dispatch/reconcile/plan.ts:467-510`。

#### 候选 / 现成方案
- 方案 A：扩展 `selection.mode`，增加多值 `skill_id[]` / `root[]` / `classification[]` 过滤，但保留现有 `plan`/`execute` 结构。
- 方案 B：在 plan 层把多选 flatten 成多个单 item 事务，execute 层保持不变。
- 方案 C：直接在 UI 层做切片、再拼装多个 `selection` 再发，不动 execute 结构。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐采用“方案 B + C 的折中”：多选在 plan 层 flatten，execute 仍依赖 item 级事务结构。原因：execute 已显式按 `items[]` 循环执行，不需要新一层事务模型；最小改造成本最高。
- 这是“借鉴现有架构，少做自研”的方案，不是从零设计批量事务系统。

#### 风险
- 批量命中共享根时，容易出现一条物理副本虽被多个宿主消费，但 action 语义上仍要按 transaction group 做保守处理；见 `kernel/dispatch/reconcile/plan.ts:274-339` 的 eligibility 与 shared root logic。
- 不能把批量操作演化成“全局事务”——当前代码与合同模型都没有这个设计；见 `contract/src/reconcile.ts:119-145` 与 `plan.ts:444-465`。

### 1.2 审计矩阵数据缺口

#### 现状事实
- `contract/src/host-inventory.ts:193-209` 明确规定 `InventoryScanData` 需要 `roots[]` / `hosts[]` / `copies[]` / `corrupt[]` / `missing[]` 这类数据结构，说明“审计矩阵”并不是一张单表，而是跨宿主 + 根 + 副本的观察模型。
- `kernel/dispatch/reconcile/plan.ts:140-201` 里 `writesOf()` 继续写回 `host_landings` / `plugin_index` 等 ledger，但它是 action 级写计划，不是统一稽核事实库。
- 目前 repo 中，`host_landings` 仅作为“落位记录 + 对账证据源”，不等同于“统一跨宿主审计矩阵”；若无补充字段，缺少 `skill × host × target` 的完整事实维度。
- 查看 `gui/renderer/src/components/HostInventoryView.vue:153-170` 可看出 UI 已明确分成 `host_landings` / `plugin_landings` 与 degradation state，但仍然不是统一的跨宿主审计库。

#### 候选 / 现成方案
- 方案 A：继续用 `host_landings` + `workspace index` 两层拼接，构建 ad hoc 审计矩阵（最省）。
- 方案 B：新增独立审计矩阵表（更稳定），保留 ledger 与 observation 两层。
- 方案 C：不新增表，全部在 `scan --inventory` 的结果聚合层做汇总，保持只读。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐采用“方案 C + 最小 B 的折中”：保留 `host_landings` 作为落位 ledger，`scan --inventory` 结果层构建统一 `skill × host × target` 审计矩阵。这样不要求立刻新做一套账本格式；只要结论不强行当权威账本。
- 这是“二开并行借鉴现有数据结构”的方案，而不是大规模自研新事实库。

#### 风险
- 如果直接把 `host_landings` 当作审计事实源，会把“落位记录”和“跨宿主一致性判定”混成一件事；同一副本可能同时存在 `active` 记录却无真实副本，最终会偏向错误结论。
- 现有 UI 和 plan 语义都保留 `inferred` / `insufficient` 作为降级状态，因此审计口径必须保留降级，而不能强行给权威结论；见 `gui/renderer/src/components/HostInventoryView.vue:153-170`。

### 1.3 GUI 硬编码分布

#### 现状事实
- App shell 直接写中文 UI 文案，无统一翻译层；见 `gui/renderer/src/App.vue:389-457`。
- Host Inventory 视图、审计状态与导出提示也均直接写死在模板中；见 `gui/renderer/src/components/HostInventoryView.vue:98-223`。
- 动作菜单与执行对话框继续硬编码中文文本、tag 文案与确认语句；见 `gui/renderer/src/components/host-inventory/InventoryActionMenu.vue:19-37` 和 `gui/renderer/src/components/host-inventory/InventoryActionDialog.vue:144-270`。
- 当前仓库中未发现 `vue-i18n` / locale store / `Intl` 统一封装；也没有设备级语言持久化层。

#### 候选 / 现成方案
- 方案 A：直接引入 `vue-i18n`（MIT）并做完整资源目录。
- 方案 B：采用轻量自建 `messages.ts` + `locale store` + `Intl`。
- 方案 C：先不做双语，只做中文 UI，后续如果要英文则再接入。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐采用“方案 A 的最小落地”——保留一个资源层，使用 `vue-i18n` 语义化翻译；而不是手写大规模 localizer。理由：本项目已经是 Vue3 + Electron，`vue-i18n` 的成熟度与维护性远高于自建，且借鉴成本低。
- 若希望更轻，可在下一阶段用 `i18n` 适配层封装 `vue-i18n` 接口；但不建议从零自建。

#### 风险
- 如果直接拆进组件模板中，后续切语言会让 UI 文案和业务逻辑耦合；且无法区分“UI 文案”和“契约字段/错误码”。
- 正确边界是：`Finding.code` / `CODES` / JSON 结构不翻译，UI 文案翻译。

### 1.4 分发通道复用

#### 现状事实
- 安装通道：`kernel/core/lifecycle/install.ts:201-375`，新分发前会 `resolveTargets()`、`deliverFiles()`、写入中心库与目标副本。
- 恢复通道：`kernel/core/lifecycle/restore.ts:227-319`，恢复会按备份重建中心库与目标副本。
- 开关可见性通道：`kernel/core/lifecycle/toggle.ts:185-320`，仅切 `SKILL.md` 可见性，不扩目标。
- 结论：对“已纳管 Skill 分发到新 target”，最省的通道不是 `toggle`，而是复用 install 级 target 分发逻辑；`repair` 仍应是“修复已存在副本/覆盖/重写”，也不是新增 target 分发入口。

#### 候选 / 现成方案
- 方案 A：新增 `distribute-existing-target` 复用 install 的 `resolveTargets + deliverFiles` 逻辑。
- 方案 B：让 `repair` 承担扩 target 功能，但语义不纯。
- 方案 C：在 `restore` 复用路径里增加“重分发到 target”，但成本较高。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐方案 A：新增专门 path/flow 但不更改 `toggle` 的行为；`repair` 保持只修复，不承担新 target 分发。

#### 风险
- 若强行让 `toggle` 或 `repair` 承担新增 target 分发，后续会出现“可见性切换与内容分发混用”的语义冲突，也会影响幂等与安全性。

### 1.5 frontmatter 已解析字段

#### 现状事实
- 仓库里，元数据读取只集中在 `skill_meta.yaml`，而且实现非常明确：`kernel/core/metadata/read.ts:63-83` 只读 YAML 结构；没有发现 `SKILL.md` frontmatter 解析器。
- `docs/specification/skill-meta-spec.md` 对工作区元数据字段的定义集中在 `skill_meta.yaml` 里，例如 `id/name/version/description/author/license/status/path/targets` 等；见 `docs/specification/skill-meta-spec.md:199-213`、`docs/specification/skill-meta-spec.md:240-263`。
- 这意味着：目前代码与契约都把“工作区管理元数据”视为 `skill_meta.yaml` 域，而“宿主 Skill 标准 frontmatter”尚未与管理器的工作区 metadata 合并。

#### 候选 / 现成方案
- 方案 A：把 `SKILL.md` frontmatter 作为标准技能描述源，工作区仍保留 `skill_meta.yaml` 作为管理器“唯一元数据契约”。
- 方案 B：强行把 frontmatter 直接映射进 `skill_meta.yaml` 作为统一表。
- 方案 C：忽略 frontmatter，仅保留工作区 YAML。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐方案 A：做双层模型：frontmatter 负责技能展示/安装描述，`skill_meta.yaml` 负责管理器索引与分发控制；两者保持对接机制，但不混同。
- 这不是自研 parser，而是“直接借鉴成熟 frontmatter parser + 执行标准字段映射”，并保留工作区元数据约束。

#### 风险
- 若将 frontmatter 字段强硬塞入工作区 `skill_meta.yaml`，会让管理器 schema 失真，并造成与 Anthropic 官方字段语义的偏差。

---

## 二、外部规范核实（给 URL）

### 2.1 Anthropic SKILL.md 官方字段表

#### 现状事实
- 官方文档明确把 `SKILL.md` 的 frontmatter 视为“skill metadata”，常见字段包括 `name`、`description`、`author`、`version`、`license`、`allowed-tools`、`mcp-server` 等；这些通常是顶层字段，而不是嵌套 `metadata` 容器。
- 这与 repo 内 `skill_meta.yaml` 的工作区声明模型相同一层次，但不是同一份元文件。关键区别：工作区契约是管理器用，官方 frontmatter 是宿主/工具用。

#### 外部引用（URL）
- Anthropic Skills docs: https://docs.anthropic.com/en/docs/claude-code/skills
- Anthropic Skills metadata section: https://docs.anthropic.com/en/docs/claude-code/skills#skill-metadata

#### 推荐（自研 / 二开 / 借鉴）
- 借鉴官方字段定义，不做独创字段表；优先把 `author/version/license` 当作顶层字段，还保留 `metadata` 作为扩展容器。

### 2.2 Vue3 桌面 i18n 主流方案

#### 现状事实
- `vue-i18n` 是 Vue3 官方生态中的主流 i18n 方案，MIT 许可证，活跃维护，兼容 Electron。
- 对桌面端项目而言，bundle 与初始化成本可控，且有成熟文档支持。

#### 外部引用（URL）
- Vue 3 tooling: https://vuejs.org/guide/scaling-up/tools.html
- vue-i18n: https://vue-i18n.intlify.dev/
- migration guide: https://vue-i18n.intlify.dev/guide/migration/index.html

#### 推荐（自研 / 二开 / 借鉴）
- 优先采用成熟库，不自建 i18n engine；这是明确的“二开/借鉴”而非自研。

---

## 三、【新增】现成方案 / 成品代码复用调研

### A. i18n：采用成熟库（vue-i18n）还是更轻方案？

#### 现状事实
- 当前 repo 的 GUI 仍在模板层直接写中文；无统一 localizer；这属于明显的“自研前置成本”点。
- `vue-i18n` 在 Vue3/Electron 里是成熟方案；MIT 许可，活跃维护，缓存、插值、日期/数字格式化均已支持。
- 包体积方面，核心本体通常在几十 KB 级别（gzipped），对 Electron 来说可接受；比起自建消息层、locale store、error formatter，成本更低。

#### 可二开 / 借鉴的现成方案
- `vue-i18n`（MIT）
  - 许可：MIT
  - 特点：Vue3 主流，成熟，生态丰富，适合项目今后扩展多语言。
  - 适合度：非常高，直接用于 GUI 文案、动态 label、错误提示。
- 自建 `messages.ts`（不建议）
  - 许可：自研
  - 特点：最轻，但需要自己维护所有 message lookup、格式化、策略与切换层。
  - 适合度：仅在项目很小、没有语言扩展要求时勉强考虑。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐“二开/借鉴”：直接接入 `vue-i18n`，且把所有 UI 文案收口到资源文件；坚持“契约字段不翻译，UI 文案可以翻译”的边界。
- 不建议自建 unless 极小规模或需要极致减包。对本项目规模，维护成本会大于成熟库。

#### 风险
- 做到“所有字段都可翻译”会冲击 `Finding.code` / `CODES` / JSON 结果的稳定性；因此必须单独约定：UI 文案可译，契约/JSON 仍保持英文。

### B. SKILL.md frontmatter 解析：成熟库还是手写？

#### 现状事实
- 对 Markdown front matter 的成熟解析需求，最成熟且活跃的组合是：`gray-matter`（MIT）+ `yaml`（MIT）。
- `gray-matter` 专门处理 markdown 前置 metadata，类似于 `---` 分隔的 frontmatter 提取；`yaml` 则负责解析 `name: ...`、`description: ...` 等结构化数据。
- 手写 frontmatter parser 只在特殊场景/极小规模里可接受；对于标准 YAML frontmatter，这不是优势所在。

#### 可二开 / 借鉴的现成方案
- `gray-matter`（MIT）
  - 许可：MIT
  - 特点：成熟、稳定、非常适合 Markdown 文件头部 YAML frontmatter 解析。
  - 适合度：高度推荐。
- `yaml`（MIT）
  - 许可：MIT
  - 特点：YAML parser，符合本项目配置/metadata 需求。
  - 适合度：高，适合定义和解析 frontmatter 的结构化字段。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐采用“二开/借鉴”：`gray-matter` 提取 frontmatter，`yaml` 解析结构体；不要手写大而全的 frontmatter parser。这是成熟方案里最稳妥的一条。
- 这一层应仅处理一个领域：从 `SKILL.md` 头部读取字段，不参与工作区索引逻辑。

#### 风险
- 直接把 `gray-matter` 解析出来的对象用作工作区数据模型，会混淆“宿主层 frontmatter”和“工作区管理层 metadata”两套语义；需在设计阶段强制分层。

### C. 开源同类工具参考：批量、跨宿主同步、一致性审计怎么做

#### 1) `vibe-package-manager (vpm)`

#### 现状事实
- 未找到稳定、核实的官方 GitHub 仓库/许可证映射；命名较模糊，且未能确认其档案和 license；不具备可信二开候选。
- 结论：本轮调研中不把它列为直接二开来源；待具体 repo/URL 确认后再纳入候选。

#### 候选 / 现成方案
- 暂不推荐直接借鉴：因为该项目尚无一份明确、可核实的稳定 repo + license 证据。

#### 推荐
- 不是当前优先选项。

#### 风险
- 误用“模糊命名项目”会导致对接成本高且许可证不安全；不符合“先成熟、后二开”的总体原则。

#### 2) Vercel Labs skills CLI

#### 现状事实
- 该项目已确认是 Apache-2.0 许可，且集中于 Skill / plugin 的 CLI 构建流程；适合借鉴“package-like skill scaffold + CLI command model + dev/deploy流程”。
- 适合参考的点：skill package 与 CLI 语义化、开发/构建/发布边界清晰、适合以 package 视角看待 skill。

#### 可二开 / 借鉴的现成方案
- `vercel-labs/skills-cli`（Apache-2.0）
  - 许可：Apache-2.0
  - 适合度：高，尤其在 CLI 交互、skill package 组织、部署边界方面。

#### 推荐
- 借鉴“CLI 组织方式与 skill package 视角”，但不直接拿其宿主同步能力走套件，因为它更偏 Vercel 生态。

#### 风险
- 它的 “skill==package” 设计不一定与本项目的管理器核心（工作区中心库 + 宿主副本 + 多根审计）重合；因此要抽象重用，而不是硬搬。

#### 3) `agent-skill-manager` / `agentskills`

#### 现状事实
- `agentskills/agentskills`（Apache-2.0）是大而全的 Agent Skills ecosystem/spec 仓库，适合做标准化借鉴。
- `agent-skill-manager-cli`（MIT）更偏 package manager / skills installation lifecycle。
- 这两者都非常适合构造“skill as package + discovery + install + update”视角。

#### 可二开 / 借鉴的现成方案
- `agentskills/agentskills`（Apache-2.0）
  - 许可：Apache-2.0
  - 特点：生态/规范型仓库，适合借鉴 metadata / package semantics / distribution logic。
- `agent-skill-manager-cli`（MIT）
  - 许可：MIT
  - 特点：更像 package manager; 借鉴 install/update/list 语义和 lifecycle 设计。

#### 推荐
- 这两类最适合作为借鉴对象，尤其在“技能包 + CLI + lifecycle”上。

#### 风险
- 生态型仓库通常兼容多宿主、多平台，不一定完全等于本项目的单一工作区 + 宿主副本 + 跨宿主审计；仍要做裁剪。

#### 4) `skill-doctor / skill-cli / tools-manager`

#### 现状事实
- 在公开搜索中未确认其统一 GitHub repo 或明确许可；命名太碎，且多为“tool family”而非单一稳定维护项目。无法作为当前阶段的强制二开对象。
- 这类项目的价值通常体现为“名称/能力”的概念参考，而非可直接移植的代码。

#### 可二开 / 借鉴的现成方案
- 暂不纳入正选名单；如果有具体仓库 URL 与 LICENSE 文件，才可进一步评估。

#### 推荐
- 先排除；到后续要确证 repo/许可证时再纳入候选。

#### 风险
- 采用不稳定命名项目会带来许可证、维护状态和架构兼容性风险，不符合 open source first 的准绳。

#### 5) 其他同类复用对象：`microsoft/apm`

#### 现状事实
- `microsoft/apm` 是 Agent Package Manager（MIT）项目，面向 agent capability / package manager 设计，适合做架构参考。
- 其重点在 package lifecycle，而不是宿主同步/审计。

#### 可二开 / 借鉴的现成方案
- `microsoft/apm`（MIT）
  - 许可：MIT
  - 特点：package manager / lifecycle 结构，有价值的架构参考。

#### 推荐
- 作为“agent package manager 设计参考”有价值，但只在 lifecycle 与 package/separation 方面有参考价值，不是宿主审计的直接模板。

#### 结论：可二开 / 借鉴清单（含许可）
- `vue-i18n`（MIT） — GUI i18n，直接推荐。
- `gray-matter`（MIT） — `SKILL.md` frontmatter 提取，直接推荐。
- `yaml`（MIT） — YAML 解析器，直接推荐。
- `vercel-labs/skills-cli`（Apache-2.0） — skill-package/CLI design reference。
- `agentskills/agentskills`（Apache-2.0） — ecosystem/spec reference。
- `agent-skill-manager-cli`（MIT） — package manager/lifecycle reference。
- `microsoft/apm`（MIT） — agent package manager architecture reference.
- `element-plus`（MIT） / `naive-ui`（MIT） — UI component library，可选，不强制。
- 排除：GPL / not-verified / ambiguous naming 的项目；不符合本调研原则。

### D. GUI 组件库：是否要引入成熟组件库（element-plus / naive-ui）

#### 现状事实
- 当前 GUI 是自建样式 + 少量通用组件，视觉和交互控制都在项目内；这使得 UI 一致性与速度可以维持在界内控制。
- 组件库（如 `element-plus` / `naive-ui`）都有 MIT 许可证，活跃维护，组件丰富，可减少界面开发成本。
- 但本项目当前规模并不需要跨页面的大量基础组件；加入大组件库的代价是：包体积、主题系统、样式覆盖、样式冲突和健壮性成本。

#### 可二开 / 借鉴的现成方案
- `element-plus`（MIT）
  - 许可：MIT
  - 特点：组件丰富，适合表格、表单、弹窗、标签与交互。
  - 适合度：中上。
- `naive-ui`（MIT）
  - 许可：MIT
  - 特点：偏现代主题，适合桌面类 app。
  - 适合度：中。
- 自建轻量样式（当前默认）
  - 许可：自研
  - 特点：控件少、包体积小、可完全定制。
  - 适合度：高（当前阶段更合适）。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐在“当前阶段”保留自建轻量样式，并只在后续用户交互复杂化时引入 `element-plus` 或 `naive-ui` 的某一套；不建议在现阶段“一次性导入大组件库”。
- 原因：小项目 + 轻量桌面应用 + 自定义风格更符合目前仓库结构和包体积控制目标。

#### 风险
- 若一开始就引入组件库，容易造成视觉不一致、主题覆盖、包体积上升和替换复杂度增加；这类成本在当前阶段并不划算。

---

## 四、风险与未知（同前 3 项）

### 4.1 批量事务边界

#### 现状事实
- 当前执行模型仍然是逐项目执行，不是跨批全局事务；见 `kernel/dispatch/reconcile/plan.ts:444-465` 与 `contract/src/reconcile.ts:119-145`。
- 这意味着批量扩展应保持每个 `ReconcilePlanItem` 可独立判定、独立写回、独立失败隔离，而不能长期强行把批量当数据库事务。

#### 候选 / 现成方案
- 方案 A：每副本独立事务，批量仅聚合生成与汇总。
- 方案 B：增加批量 `transaction_id` / snapshot 机制。
- 方案 C：全局事务（不建议）。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐方案 A：保持 item 级事务边界；真正的批量优势只在数据聚合与预览，不在一条全局交易。

#### 风险
- 若要做一次“整批回滚”，会把现有 `plan`、`execute`、`ledger_changes` 结构推翻，成本很高。

### 4.2 审计 drift 口径

#### 现状事实
- `host_landings`、`plugin_index`、`scan --inventory` 结果层都在用“漂移 / drift”或 `content_drift` 等口径，但这些口径不是完全同一回事；它们分别反映 ledger、host observation 与 reconcile action 场景。
- 若不强制统一，就会在同一副本上出现“配置不同、动作不同、结论不同”的语义分叉。

#### 候选 / 现成方案
- 方案 A：统一公共词汇表（`content_drift`, `visibility_mismatch`, `source_changed` 等）。
- 方案 B：各层单独口径，最后做 mapping。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐方案 A：公用词汇表，降低理解成本；在 reconcile 侧仍保留 action driven 语义（`repair` / `accept` / `track`），但将底层 reason 归到公共词汇表。

#### 风险
- 若不统一，UI、CLI 和审计结果都会出现“同一个副本不同结论”的问题，最终失去产品可信度。

### 4.3 i18n 可译 / 契约字符串边界

#### 现状事实
- `CODES`、`Finding.code`、`contract/src/*` 都属于稳定契约字段，必须保持英文且机器读写稳定。
- GUI 文案、提示、动作标签属于 UI 属性，可翻译。
- 如果把所有 message 都翻译，不仅 UI 复杂，而且 CLI 与自动化脚本可能失效。

#### 候选 / 现成方案
- 方案 A：UI 文案本地化；契约/JSON 维持英文与稳定 code。
- 方案 B：全部内容翻译，失败。

#### 推荐（自研 / 二开 / 借鉴）
- 推荐方案 A；这是最稳妥的边界设计，也是最符合当前仓库的结构。

#### 风险
- 对 “可译/不可译” 约定不清，后续很容易出现中英文混用或自动化解析错误。

---

## 产出说明

### 1) 调研文档路径
- `docs/research/m5-distribute-batch-i18n-2026-10-20.md`

### 2) 四节结论摘要
- 见文档开头“四节结论摘要”部分。

### 3) 可二开 / 借鉴的现成方案清单（含许可）
- `vue-i18n`（MIT）
- `gray-matter`（MIT）
- `yaml`（MIT）
- `vercel-labs/skills-cli`（Apache-2.0）
- `agentskills/agentskills`（Apache-2.0）
- `agent-skill-manager-cli`（MIT）
- `microsoft/apm`（MIT）
- `element-plus`（MIT）
- `naive-ui`（MIT）

### 4) 待设计裁决点
1. 批量 selection 是扩展 `selection.mode` 还是直接在 plan 层 flatten？
2. `host_landings` 是否继续作为 ledger，并由 `scan --inventory` 做审计矩阵，还是立刻增独立审计表？
3. `SKILL.md` frontmatter 与 `skill_meta.yaml` 的职责边界如何定义：展示/安装元数据 vs 管理器元数据？
4. GUI i18n 采用 `vue-i18n` 还是轻量自建 `messages.ts`？
5. 组件库是否保留自建样式，只在后续显著增大界面复杂度时再接入 `element-plus` / `naive-ui`？
6. 审计 drift / reconcile drift 是否统一公共词汇表？
7. `Finding.code` / `CODES` / JSON 契约字段是否必须强制保持英文不变？
8. 批量操作是否要求“item 级 fail-isolated”，而非全局回滚？

---

**文档截止：** 本调研不写实现代码，不定稿 API；所有选择仍然保留需需求与设计裁决的空间。
