# Skill / Plugin 管理器 开源项目结构调研报告

> 调研对象：GitHub 上「AI Agent 生态的 Skill / Plugin 管理器」同类项目
> 调研日期：2026-10-12（star / 活跃度为当日 GitHub API 快照）
> 调研方式：GitHub Search API 关键词检索 -> 候选筛选 -> `git clone --depth 1` 拉取真实仓库 -> 直接阅读目录结构、清单文件、Schema 与核心源码
> 约束：本阶段只做调研，不产出任何业务代码。

---

## 0. 结论速览（先看这一段）

如果只想从这份报告里拿走三件事：

1. **对标首选 `OlegHQ/agentpack`**（Go，16 star）：它是唯一一个把「manifest -> lockfile -> cache -> 按 harness 渲染 -> 启动」做成完整工程链路的项目。`agentpack.toml` + `pack.lock` + `content_hash` 校验 + `--verify-only/--repair` 的组合，几乎就是我们要的元数据管理器骨架。
2. **对标次选 `luongnv89/asm`**（TypeScript，955 star）：它把「跨 21 个 agent 的 skill 清单聚合 + 启用/禁用 + 安装/卸载 + 本地库 + 安全审计 + 全量 `--json`」做成了纯 CLI。`SKILL.md -> SKILL.md.disabled` 的禁用方案和 `skill-state.json` 索引文件可以直接抄作业。
3. **规范必须遵守 `agentskills/agentskills`**：`SKILL.md` 的 YAML frontmatter 只有 `name` / `description` / `license` / `compatibility` / `allowed-tools` / `metadata` 六个合法字段；name 必须小写 kebab-case、不超过 64 字符、且**必须与目录名一致**。任何自研字段都应该塞进 `metadata`，而不是平铺到 frontmatter 顶层。

一个关键架构判断：**这个圈子里没有「全局单一索引文件」的主流做法**。成熟项目走的是「每个包/技能目录自带清单 + 一个 workspace 级 lock/index 文件」的双层结构（agentpack 的 `pack.lock`、OpenPackage 的 `openpackage.index.yml`、EfanWang 的 `sources.json`、asm 的 `skill-state.json` 都是这一层）。集中式大 JSON 索引只出现在 marketplace（`buzhangsan`、asm 的 catalog、claude-plugins.dev），那是分发侧，不是管理侧。

---

## 1. 检索方法与筛选过程

### 1.1 实际执行的检索关键词

| 关键词 | GitHub 命中总数 | 有效产出 |
|---|---|---|
| `skill manager` | 5,673 | `xingkongliang/skills-manager`、`luongnv89/asm`、`cchao123/skills-manager`、`EfanWang/skills-manager`、`Dimillian/CodexSkillManager`、`jiweiyeah/Skills-Manager` |
| `plugin manager agent cli` | 34 | `OlegHQ/agentpack`、`RealZST/HarnessKit`、`bobmatnyc/claude-mpm` |
| `agent plugin registry` | 141 | `Kamalnrf/claude-plugins`、`Railly/tinte`、`IBM/mcp-context-forge` |
| `llm skill loader` | 118 | `Hmbown/aleph`、`udapy/rust-agentic-skills`、`kdpa-llc/local-skills-mcp` |
| `plugin index yaml` | 3 | 无有效产出（说明「index + yaml」不是社区通用叫法） |
| `agent skill marketplace` | 1,581 | `numman-ali/n-skills`、`jeremylongshore/tons-of-skills-marketplace`、`obra/superpowers`、`davepoon/buildwithclaude` |
| `claude code plugin marketplace manager` | 29 | `spencerbeggs/ai-plugin-marketplace-manager`、`aniganti/pm-superpowers` |
| `SKILL.md manager cli install enable disable` | 0 | 无（GitHub 检索不支持这种长自然语言串） |

### 1.2 采用的筛选标准

**纳入（优先）**

- 轻量，纯 CLI 或 CLI 优先；
- 以 YAML / JSON 清单驱动，元数据是唯一事实源；
- 只负责元信息与文件编排，不执行业务逻辑；
- 面向 AI Agent 生态的 Skill / Plugin 管理。

**排除**

- 大而重的完整 Agent 运行时（如 `Hmbown/aleph`：MCP server + 递归语言模型运行时 + 代码执行沙箱）；
- IDE 底层插件机制（VS Code / JetBrains extension host 那类）；
- 纯 skill 内容合集（只有 `SKILL.md`、没有管理逻辑，如 `davepoon/buildwithclaude`、`OthmanAdi/planning-with-files`）；
- 传统软件包管理器（npm / helm 等，即使关键词撞车）。

### 1.3 对输入笔记的校正

你附上的那份先前笔记提到的仓库大部分确实存在，但有几处需要修正：

| 笔记中的说法 | 校正 |
|---|---|
| `agentskills/agentskills` 是「规范仓库，含 skills-ref 参考实现」 | 正确，且 `skills-ref` 是可运行的 Python CLI（`validate` / `read-properties` / `to-prompt`） |
| `microsoft/skills-for-copilot-studio` 是同类管理器 | 部分成立。它是 Copilot Studio 的 YAML authoring/管理工具集，绑定微软生态，不算通用管理器，本报告仅作边缘参考 |
| `aktsmm/vscode-agent-skill-ninja` | 按排除标准应剔除（VS Code 扩展 UI） |
| `awesome-skills/agent-skills-manager`（软链接方案） | 仅 6 star、无许可证、纯 Shell 脚本。作为「symlink 单一原件」思路参考可以，作为工程对标不合适 |
| 笔记完全没提到的高价值项目 | `OlegHQ/agentpack`、`luongnv89/asm`、`enulus/OpenPackage`、`xingkongliang/skills-manager`、`RealZST/HarnessKit`、`numman-ali/n-skills`、`jeremylongshore/tons-of-skills-marketplace` —— 这七个才是最值得读的 |

---

## 2. 候选仓库总览

### A 类：直接同类（Skill / Plugin 管理器，元数据驱动）

| # | 仓库 | 语言 | 许可证 | star | 最近推送 | 形态 |
|---|---|---|---|---|---|---|
| A1 | [OlegHQ/agentpack](https://github.com/OlegHQ/agentpack) | Go | MIT | 16 | 2026-10-10 | CLI（agent 包管理器） |
| A2 | [luongnv89/asm](https://github.com/luongnv89/asm) | TypeScript | MIT | 955 | 2026-10-10 | CLI + TUI |
| A3 | [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager) | Rust + Tauri | MIT | 6,118 | 2026-10-11 | 桌面 App + 内置 CLI |
| A4 | [enulus/OpenPackage](https://github.com/enulus/OpenPackage) | TypeScript | Apache-2.0 | 617 | 2026-05-29 | CLI |
| A5 | [Kamalnrf/claude-plugins](https://github.com/Kamalnrf/claude-plugins) | TypeScript | MIT（README 声明） | 563 | 2026-10-05 | 双 CLI + Web |
| A6 | [EfanWang/skills-manager](https://github.com/EfanWang/skills-manager) | Python | MIT | 30 | 2026-05-19 | 脚本 CLI（本身是 skill） |
| A7 | [RealZST/HarnessKit](https://github.com/RealZST/HarnessKit) | Rust | Apache-2.0 | 457 | 2026-10-10 | 桌面 + CLI + Web（共享 core） |
| A8 | [cchao123/skills-manager](https://github.com/cchao123/skills-manager) | TypeScript + Tauri | MIT | 125 | 2026-05-28 | 桌面 App |
| A9 | [buzhangsan/skill-manager](https://github.com/buzhangsan/skill-manager) | JavaScript | 未声明 | 321 | 2026-02-06 | Skill（agent 驱动） |
| A10 | [numman-ali/n-skills](https://github.com/numman-ali/n-skills) | TypeScript | Apache-2.0 | 1,050 | 2026-09-12 | Marketplace（索引 + 同步脚本） |
| A11 | [jeremylongshore/tons-of-skills-marketplace](https://github.com/jeremylongshore/tons-of-skills-marketplace) | Python + TS | MIT | 2,831 | 2026-10-12 | Marketplace（重度治理） |
| A12 | [udapy/rust-agentic-skills](https://github.com/udapy/rust-agentic-skills) | Rust | MIT | 56 | 2026-02-12 | MCP server + 清单 |
| A13 | [kdpa-llc/local-skills-mcp](https://github.com/kdpa-llc/local-skills-mcp) | TypeScript | MIT | 40 | 2026-10-04 | MCP server |
| A14 | [obra/superpowers](https://github.com/obra/superpowers) | Shell | MIT | 297,892 | 2026-10-10 | 多 harness 插件打包 |

### B 类：规范与标准（必须遵守，非工具）

| # | 仓库 | 语言 | 许可证 | star | 作用 |
|---|---|---|---|---|---|
| B1 | [agentskills/agentskills](https://github.com/agentskills/agentskills) | Python | Apache-2.0（文档 CC-BY-4.0） | 26,062 | Agent Skills 开放规范 + `skills-ref` 参考实现 |
| B2 | [anthropics/skills](https://github.com/anthropics/skills) | Python | 未声明（含 THIRD_PARTY_NOTICES） | 180,594 | 官方示例技能 + `.claude-plugin/marketplace.json` 事实标准 |

### C 类：明确排除（记录原因）

| 仓库 | 排除原因 |
|---|---|
| [Hmbown/aleph](https://github.com/Hmbown/aleph) | MCP server + 递归语言模型运行时 + 代码执行沙箱，属于完整 Agent 运行时，与「只管理元信息」定位冲突 |
| [aktsmm/vscode-agent-skill-ninja](https://github.com/aktsmm/vscode-agent-skill-ninja) | VS Code 扩展，属于 IDE 插件系统层 |
| `IBM/mcp-context-forge`、`Railly/tinte` | MCP 网关 / 服务编排，不是 skill/plugin 元信息管理器 |

---

## 3. 逐仓库深度分析

> 统一维度：1 定位 2 目录结构 3 元数据与数据模型 4 生命周期 5 索引与存储 6 校验机制 7 对外交互 8 依赖管理 9 优点 / 缺陷 / 可借鉴点

---

### A1. OlegHQ/agentpack —— 「AI coding agent 的包管理器」

**1) 核心定位**

一句话：`Pin, resolve, and sync skills & plugins across Claude Code, Cursor, OpenCode, Codex, Grok, and Antigravity - from one manifest.`

它把 Go modules 的心智模型搬到 agent 扩展上：声明式 manifest + 精确 commit 锁定 + 内容寻址缓存 + 按 harness 渲染 staging + 启动。

**2) 目录结构**

```
agentpack/
  agentpack.toml                # 用户手写 manifest
  pack.lock                     # 锁定文件（lockfile_version = 2）
  cmd/agentpack/main.go
  internal/
    manifest/                   # manifest 解析与编辑
    lockfile/                   # 锁定文件读写
    resolve/                    # 版本约束与依赖图：constraints.go / graph.go / module_id.go
    cache/                      # 内容缓存：asset / digest / index / layout / materialize / restore / tree / normalize
    staging/                    # 按 harness 渲染落盘：claude_skills / dot_agents / guidance / mcp / collision / pipeline / rebuild_lock
    harness/                    # 每个 agent 一个适配器目录
      claude/ codex/ cursor/ opencode/ grok/ agy/
      registry/ contracts.go target.go launch.go link_directory_{unix,windows}.go
    sync/                       # add / remove / integrity / preflight / launch_fingerprint
    environment/                # bundle / capsule / contract / receipt / compare（可移植环境）
    hooks/ mcp/ mode/ modecatalog/ modetui/
    github/                     # archive / download / metadata / refs / source
    database/cache.go
    paths/ slug/ proxy/
  schemas/
    contract.v1.schema.json
    receipt.v1.schema.json
    examples/contract.valid.json, examples/contract.invalid-duplicate.json
  docs/src/                     # mdbook：concepts/ guides/ harnesses/ reference/
  integration/                  # cli_test.go / installer_test.go
  evaluation/icse/              # 学术评测脚本与证据 JSON
```

**3) 元数据与数据模型**

`agentpack.toml`（manifest）：

```toml
name    = "acme-backend"   # 必填
version = "0.5.0"          # 必填，SemVer

[dependencies]
"github.com/anthropics/skills/skills/canvas-design" = { branch = "main" }
"github.com/acme/shared-rules"                      = { tag = "v2.1.0" }
"github.com/acme/monorepo/packages/agent"           = "^2.0"
"local-dev"                                         = { path = "../local-dev" }

[modes.default]
base    = "all"
disable = ["package-path:github.com/acme/shared-rules:commands/noisy.md"]

[modes.review]
base   = "none"
enable = ["package:github.com/acme/shared-rules", ".agents:rules/backend.mdc"]

[mcp.servers.filesystem]
command = "npx"
args    = ["-y", "@modelcontextprotocol/server-filesystem"]
```

关键设计：**包的子目录路径是 key 的一部分**，不是独立字段（`github.com/owner/repo/path/inside/repo`）。这消灭了「同一 repo 多包」的歧义，也天然构成去重主键。

`pack.lock` 每个 package 记录：`module / direct / kind(skill|plugin|mcp) / url / owner / repo / path / commit / cache_key`。其中 `cache_key` 是内容哈希，`commit` 是精确 SHA。

**4) 生命周期**

| 阶段 | 命令 | 行为 |
|---|---|---|
| 初始化 | `agentpack init` | 创建 `agentpack.toml` + 空 `pack.lock` + `AGENTPACK_HOME`；manifest 已存在则失败 |
| 安装 | `agentpack add <spec>` | 解析 spec -> 写 manifest `[dependencies]` -> 刷新 lock -> 同步。`--no-sync` 可只写元数据 |
| 卸载 | `agentpack remove <spec>` | 删除依赖项 + 剪除指向它的 mode selector -> 刷新 lock -> 同步 |
| 锁定 | `agentpack lock [--update]` | 只解析与写锁，下载内容以计算 `content_hash`；`--update` 重解析浮动 pin |
| 同步 | `agentpack sync [--dry-run / --verify-only / --update-lock / --repair]` | 校验缓存与 lock 的 content_hash，重建 staging；不匹配则非零退出且不落盘任何东西 |
| 启用/禁用 | `[modes.*]` + `--mode <name>` | 用 `base=all/none` + `enable/disable` selector 表达本次要装哪些，等价于可复现的启用/禁用预设 |
| 体检 | `agentpack preflight` | 纯离线只读检查，输出带稳定 finding code / severity / source / target / remedy 的报告 |
| 观测 | `agentpack probe` | 调用 agent 原生能力（如 Claude 的 `plugin list --json`）验证发现结果，写 receipt |

**5) 索引与存储**

- **不存全局索引**。manifest + lockfile 就是索引，且全部位于项目根目录。
- 内容缓存在 `AGENTPACK_HOME`（内容寻址：`cache_key` = 内容哈希）；可移植环境（`env` / `--definition-root`）可把 manifest/lock 放在 checkout 之外。
- 状态回执（receipt）写在 `$AGENTPACK_HOME/projects/<hash>/probe-receipts/`。

**6) 校验机制（样本里最完整的一个）**

- Schema 校验：`schemas/contract.v1.schema.json`、`receipt.v1.schema.json`，并带重复项反例 `contract.invalid-duplicate.json`；
- 完整性校验：lock 里每个包的 `content_hash`，`sync` 时逐项比对，不匹配即非零退出；
- 锁定文件一致性：malformed 或 inconsistent 的 lock 一律拒绝；`sync` 永不修改已锁定条目的 pin；
- staging 漂移检测：`--verify-only` 重新哈希已落盘文件，发现增/删/改就逐个点名报错；
- 契约与 receipt 的 freshness 校验，stale / incomplete receipt 直接 fail closed；
- `--strict-external` 拒绝需要写 workspace overlay 的 harness，避免污染 checkout。

**7) 对外交互**

纯 CLI。全局 flag：`--project-root` / `--definition-root` / `--workspace` / `--strict-external` / `--mode` / `--yolo` / `-q` / `--debug` / `--proxy`，以及 `completion bash|zsh|fish|powershell`。启动器子命令即 harness 名（`agentpack claude` / `codex` / `cursor-agent` / `opencode` / `grok` / `agy`）。`preflight --json` 提供机器可读报告。

**8) 依赖管理**

SemVer 约束（`1.2.3` / `^` / `~` / `>=` / 区间 / `*`）、branch / tag / commit 三种 pin、`path` 本地依赖、依赖图解析（`internal/resolve/graph.go`）、传递依赖也进 lock。**不自动执行外部依赖安装**，只锁定、校验、报警。

**9) 评价**

优点：

- manifest / lock / cache / staging 四段式是目前看到最干净、最可复现的架构；
- content_hash + verify-only + repair 三联是元数据管理器的正确姿势；
- `[modes]` 用声明式 selector 表达启用/禁用，比命令式开关更适合「可复现环境」；
- 内容永不写进用户全局 agent 配置（`nothing is copied into it, and nothing is written to your global agent config`）。

缺陷：

- 只支持 `github.com` 单一 host；
- 仅 16 star，生态小、可参考的 issue/PR 少；
- Go 实现，对 Python / TS 团队有移植成本；
- `--proxy` 等实验特性偏离核心定位，容易让项目膨胀。

可借鉴：直接抄 manifest + lock 双层设计、`content_hash` 完整性校验、`--dry-run/--verify-only/--repair` 三件套、`[modes]` 声明式预设、preflight 的 finding code 结构。避开它的 proxy 实验与单一 host 限制。

---

### A2. luongnv89/asm（agent-skill-manager）—— 纯 CLI 的跨 Agent Skill 管理器

**1) 核心定位**

`CLI to install and manage agent skills`。面向 AI agent 与自动化脚本设计：每条命令都支持 `--json` 与 `--yes`，可被 agent 直接驱动；同时提供可选 TUI。

**2) 目录结构**

```
asm/
  src/
    cli.ts                       # 命令分发
    commands/                    # 每个命令一个文件
      install.ts  uninstall.ts  toggle.ts（enable/disable）
      list.ts  search.ts  inspect.ts  get.ts
      activate.ts  library.ts  bundle.ts  tag.ts
      audit.ts  stats.ts  doctor.ts  deps.ts  cleanup.ts
      export-import.ts  init.ts  link.ts  eval.ts  publish.ts
      index-cmd.ts  config.ts  outdated-update.ts
    config.ts                    # 配置目录 + 默认 provider 表
    skill-state.ts               # 禁用状态持久化 + 落盘改名
    scanner.ts  skill-locator.ts  installer.ts  uninstaller.ts
    registry.ts  skill-index.ts  # 市场索引与本地索引检索
    dependency-leases.ts  dependency-leases-store.ts
    security-auditor*.ts  evaluator*.ts  residency.ts  stats-tokens.ts
    skill-tags.ts  library-core.ts  bundler.ts  importer.ts  exporter.ts
    utils/
      frontmatter.ts             # 手写 YAML frontmatter 解析（支持 dependencies 数组、多行折叠）
      atomic-file.ts             # 原子写
      lock.ts                    # 文件锁
      version.ts  machine.ts  path-shadowing.ts  token-count.ts
  data/
    skill-index/<owner>_<repo>.json   # 每仓库一个索引文件（懒加载 + memo）
    skill-index-resources.json
    repo-stars.json
    bundles/*.json                    # 预置技能包
  skills/                             # 项目自身也以 skill 形式发布
  docs/  website/  tests/
```

**3) 元数据与数据模型**

技能元数据来自 `SKILL.md` frontmatter，解析后映射为 `SkillInfo`：

```ts
interface SkillInfo {
  name; version; description; creator; license; compatibility;
  allowedTools: string[];
  tags?: string[];              // 自由标签
  dependencies?: string[];      // 首次使用时解析获取的依赖技能
  modelInvocable?: boolean;     // 模型可调用，默认 true
  userInvocable?: boolean;      // 用户/斜杠可调用，默认 true
  dirName; path; realPath; originalPath;
  location; scope: "global" | "project"; provider; providerLabel;
  isSymlink: boolean; symlinkTarget: string | null;
  fileCount?; effort?; warnings?: SkillWarning[];
  tokenCount?;                  // ~tokens 估算（words + spaces 启发式）
  marketplace?; codexPlugin?;   // 来源扩展
  disabled?: boolean;
}
```

持久化状态文件（用户级）：

```ts
interface SkillStateFile {                 // skill-state.json
  version: 1;
  disabled: Record<string /*dirName*/,
            Record<string /*provider*/,
              Partial<Record<"global" | "project", true>>>>;
}
interface SkillTagStateFile {              // 本地标签增量，不改 SKILL.md
  version: 1;
  skills: Record<string, { added: string[]; removed: string[] }>;
}
```

配置目录：`~/.config/agent-skill-manager/`（可用 `ASM_CONFIG_DIR` 覆盖），内含 `config.json`、`skill-index/`、`bundles/`、`lock`、`library`。`config.json` 里是一张 **provider 表**：

```ts
{ name: "claude", label: "Claude Code",
  global: "~/.claude/skills", project: ".claude/skills", enabled: true }
```

内置 21 个 provider（agents / claude / pi / opencode / codex / omp / grok / hermes / openclaw / cursor / copilot / windsurf / ...）。

**4) 生命周期**

- **安装** `asm install github:user/repo` 或 `asm install <skill-name>`：先做 security scan -> 校验 frontmatter -> pin registry commit -> 落地到目标 provider 路径；`-p/--tool` 指定 provider，`--library` 则装进本地库。
- **启用/禁用** `asm disable <target>` / `asm enable <target>`：实现方式是把 `<skillDir>/SKILL.md` 重命名为 `SKILL.md.disabled`，目录与名称保持不变；`skill-state.json` 是「哪些是 asm 禁用的」的事实源，`asm list` 靠它把扫描器看不见的行重新列出来。支持 glob、`prefix:`、`prefix-`、`--all`、`--tool`、`--scope`。多 provider 共享同一 `SKILL.md` 时会警告并记录所有 sibling。
- **卸载** `asm uninstall`：删除文件并清理状态。
- **激活** `asm activate`：配合 `--library`，把本地库里的一份技能按 provider 铺开（install once, activate per provider）。
- **更新 / 体检 / 清理**：`asm outdated`、`asm doctor`、`asm cleanup`。
- **打标签** `asm tag add|remove`：写入本地增量文件，不改 `SKILL.md`。

**5) 索引与存储**

双层：

1. **分发侧（catalog）**：`data/skill-index/<owner>_<repo>.json`，每个上游仓库一个 JSON，共 6,082 个技能 / 77 个仓库；配合 `skill-index-resources.json`；加载时 memoize，检索用自写打分函数（name 精确 10 分、name 部分 5 分、desc 精确 3 分、desc 部分 1 分）。
2. **管理侧（state）**：`~/.config/agent-skill-manager/skill-state.json` 记录禁用状态，`skill-tags` 记录本地标签增量，`library` 记录本地库，`lock` 做并发保护。**没有全局已安装索引**——已安装清单每次扫描文件系统实时得出。

**6) 校验机制**

- frontmatter 结构校验，`dependencies` 必须是「非空标量字符串」否则抛错；
- 安装前安全扫描（shell exec / 网络访问 / 凭据泄露）；
- `asm audit` 系列：重复技能清理、语义重叠检测、context residency 审计（哪些技能白白占着常驻 prompt）；
- `asm eval` 质量评估（quality provider、skill-best-practice provider，附正反例 fixtures）；
- `asm doctor` 环境体检；`path-shadowing` 检测路径遮蔽；
- 状态文件损坏时自动备份为 `.bak` 并降级为空状态（容错优先）。

**7) 对外交互**

CLI 为主：`list / search / inspect / get / install / uninstall / enable / disable / activate / library / bundle / tag / audit / stats / doctor / deps / cleanup / update / outdated / export / import / init / link / eval / publish / index / config`。全部支持 `--json`（结构化输出）与 `--yes`（非交互），部分支持 `--machine`（TSV）。无参数运行进入 TUI。

**8) 依赖管理**

`dependencies` 是元数据级依赖（技能名列表），配合 `dependency-leases.ts` 做「租约」式记录，不做自动递归安装。真实运行时依赖（Node.js >= 22）在 README 声明。

**9) 评价**

优点：

- 命令面最完整、最贴近「你要的那个东西」；
- `--json + --yes + --machine` 让 agent 可以放心驱动；
- 禁用方案（改文件名）实现极简、跨 agent 通用、不依赖各 agent 的配置语义；
- provider 表把「多 agent 路径差异」收敛成配置；
- 本地库 + activate 是「一份原件、多端启用」的轻量解；
- 审计维度（重复 / 重叠 / residency / token 成本）很有产品洞察。

缺陷：

- 索引靠扫描文件系统实时算，规模大时慢（有 memo 但不是持久索引）；
- 禁用靠改名，属于约定式 hack，对不识别 `.disabled` 的 agent 有效但语义不显式；
- frontmatter 用手写解析器而非标准 YAML 库，边界 YAML 上容易出错；
- 功能面铺得很宽（含 eval、publish、website），复杂度已经不低。

可借鉴：provider 表 + `--json/--yes` 命令风格 + 「状态文件是事实源、落盘改名是执行手段」的分离 + 每仓库一个索引文件的 catalog 分片方案。避开它「实时扫描当索引」的做法，改用持久索引 + 增量更新。

---

### A3. xingkongliang/skills-manager —— 功能最全的桌面 + CLI 双形态

**1) 核心定位**

`One app to manage AI agent skills across all your coding tools.` 以中心化技能库（默认 `~/.skills-manager`）为核心，向各类 agent（Global / Project / Linked 三类 workspace）分发；同时内置 CLI 供 agent 反向驱动。

**2) 目录结构**

```
skills-manager/
  src/                          # React 前端
    components/ views/ hooks/ context/ i18n/(en,zh,zh-TW) lib/
  src-tauri/
    src/
      bin/skills-manager-cli.rs          # 共享内核的 CLI（clap）
      commands/                          # skills / presets / projects / sync / scan /
                                         # tools / agent_workspace / browse / settings / git_backup
      core/
        central_repo.rs  skill_store.rs  skill_metadata.rs
        installer.rs  removals.rs  scanner.rs  project_scanner.rs
        sync_engine.rs  sync_metadata.rs  tool_adapters.rs  tool_service.rs
        content_hash.rs  path_guard.rs  repo_lock.rs  file_watcher.rs
        skill_auto_updater.rs  skillssh_api.rs  well_known.rs
        git_backup.rs  git_fetcher.rs  git2_engine.rs  github_api.rs
        audit_log.rs  migrations.rs  crypto.rs  error.rs
        merge/                            # 多设备合并：apply/decision/pending/
                                          # protocol/resolve/snapshot/treebuild/validate
    capabilities/  icons/
  skills/manage-skills/SKILL.md   # 让 agent 反向管理技能的那个 skill
```

**3) 元数据与数据模型**

- 技能元数据：`SKILL.md` 的 frontmatter，**只解析 `name` 与 `description`**（`skill_metadata.rs` 的 `parse_frontmatter` -> `SkillMeta { name, description }`），且同时接受 `SKILL.md` 与 `skill.md` 两种大小写。
- 目录识别：`SKILL_DIR_MARKERS = ["SKILL.md", "skill.md"]`，含其一即视为技能目录。
- 应用侧概念模型：**Library（中心库）/ Preset（预设分组）/ Global Workspace / Project Workspace / Linked Workspace / Agent**。Preset 是「命名的技能分组」，在某个 workspace 里点一下即整体激活/停用（一次性 copy，非实时同步）。
- 辅助组件：`content_hash.rs`（内容哈希）、`path_guard.rs`（路径越界防护）、`repo_lock.rs`（仓库级锁）、`migrations.rs`（存储迁移）。

**4) 生命周期**

- 安装：支持 Git 仓库、本地文件夹、`.zip` / `.skill` 归档、skills.sh marketplace 四种来源，全部先进入中心库；
- 启用/禁用：双层——全局 workspace 里对每个 agent 增删技能；Preset 一键批量启用/禁用；项目 workspace 支持批量启用/禁用；
- 卸载：`removals.rs` 处理，配合批量操作与审计日志；
- 更新：`skill_auto_updater.rs` 检查 Git 源技能的上游更新；本地导入的技能可重新导入；
- 同步：`sync_engine.rs` 支持 **symlink 或 copy 两种模式**，每个技能卡片显示各 agent 的启用徽标。

**5) 索引与存储**

- 中心库目录（默认 `~/.skills-manager`，可在 Settings 修改）是事实源，各 agent 目录是分发目标；
- **无集中索引 JSON**，状态由中心库目录结构 + `sync_metadata` + `audit_log` 表达；
- 备份：`git_backup.rs` 把中心库推送到私有 GitHub 仓库（或任意 git remote）；多设备同步时有 skill-aware merge 引擎（重命名 + 编辑可自动合并；真冲突给「保留本地 / 用远端 / 两者都留」三选）。

**6) 校验机制**

- `content_hash` 内容哈希比对；
- `path_guard` 防路径逃逸；
- `repo_lock` 防并发写；
- `migrations` 版本化存储迁移；
- 上游更新检测（git 源）+ `SKILL.md`/README 预览与本地/上游 diff 对比；
- 操作全量写入 activity log，可一键导出 zip 供报障。

**7) 对外交互**

- 桌面 GUI（主）；
- 内置 CLI（`skills-manager-cli`，clap）：子命令 `repo`（status / set-path / reset-path）、`agents`（别名 `tools`）、`skills`、`presets`（别名 `scenarios`）、`git`，全局 `--json` / `--skills-root`；
- **反向驱动**：把 `manage-skills` skill 部署给指定 agent，agent 通过 CLI 来 install / deploy / 报告，而不是偷偷写 agent 目录——这样来源元数据、preset 归属、更新跟踪、跨 agent 部署状态都不会被破坏。

**8) 依赖管理**

无显式技能级依赖声明；依赖体现为「技能与 agent 的部署关系」以及 preset 分组。

**9) 评价**

优点：

- 产品完成度最高（i18n、自动备份、多设备合并、托盘、自动更新、活动日志）；
- 中心库 + 多 workspace + preset 的心智模型非常清晰；
- CLI 与 GUI 共享同一 core；
- 「让 agent 通过 CLI 反向管理」是很好的元数据保护设计；
- symlink / copy 双模式提供了可移植的 fallback。

缺陷：

- Tauri 桌面应用，构建与分发成本高，Windows/macOS 差异需要大量适配；
- 6k star 但 237 个 open issue，说明复杂度已超前于维护带宽；
- 元数据只读 name/description，对 rich metadata 不敏感；
- 自动备份、合并引擎、自动更新等功能会让「元信息管理器」迅速膨胀成「平台」。

可借鉴：中心库 + workspace 分层、Preset 这种「命名分组」抽象、CLI 与 GUI 共享 core 的分层、symlink/copy 双模式、content_hash 复用。避开它的重型桌面依赖与自动更新/合并引擎。

---

### A4. enulus/OpenPackage —— 索引清单设计的最佳范本

**1) 核心定位**

面向 AI agent 内容的包管理器：把 rules / commands / agents 等内容用统一 manifest 描述，安装时按平台差异渲染到 `.cursor/`、`.opencode/` 等目录，并用一个 workspace 索引文件精确记录「包内路径 -> 实际落盘路径」的映射。

**2) 目录结构**

```
OpenPackage/
  packages/
    cli/src/{cli,commands,utils}          # 命令实现（add/install/remove/save/set/publish/schema/...）
    core/src/{core,constants,types,utils,generated}
    gui/src-tauri/
  schemas/
    platforms-v1.json  agent-frontmatter-v1.json  map-pipeline-v1.json
    formats/{claude-agent,opencode-agent,universal-agent}.schema.json
  specs/                                  # 设计规范（文档即规格）
    package/{package-index-yml, package-root-layout, registry-payload-and-copy, universal-content}.md
    install/{install-behavior, version-resolution, git-cache, marketplace-installation}.md
    platforms/{specification, map-pipeline, universal-converter, overview}.md
    auth/ new/ remove/ save/ set/ list/ publish/ add/
    directory-layout.md  architecture.md  registry.md  scope-management.md
  platforms.jsonc
  examples/  tests/
```

**3) 元数据与数据模型**

三级清单。第一级是包清单 `openpackage.yml`（包身份 + 声明路径）；第二级是 workspace 索引，也是精华所在：

```yaml
# .openpackage/openpackage.index.yml
# 由 OpenPackage 自动维护，勿手工编辑
packages:
  <package-name>:
    path: <声明的路径>            # 相对于 workspace，或推自 registry
    version: <安装版本>           # 可选 SemVer
    dependencies:                 # 可选，缓存直接依赖名
      - <dep-name>
    files:
      <registry-key>:             # 相对包根：commands/x.md | AGENTS.md | root/tools/a.sh | rules/
        - <installed-path>        # 简单映射（字符串）：整文件归一个包所有
        - target: <installed-path>
          merge: deep             # 复杂映射（对象）：合并写入，带 key 级追踪
          keys: [key.path.1, key.path.2]
```

第三级是全局目录：`~/.openpackage/` 下分 `packages/<name>`（含 `@scope/<name>` 形式）与 `registry/<name>/<version>/`，以及 `config.yml`。

关键设计：**索引同时记录「哪些文件是我写的」和「合并文件里我负责哪些 key」**。这让 `uninstall` 能精确回滚而不误删别人的内容——这正是 skill-manager 做「安装 / 卸载 / 冲突保护」最需要的机制。

**4) 生命周期**

| 命令 | 方向 | 可变源 | 不可变源 |
|---|---|---|---|
| `new` | 创建包清单 | - | - |
| `add` | 文件系统 -> 源 | 只改源，不动索引 | 报错 |
| `remove` | 源 -> 删除 | 只改源，不动索引 | 报错 |
| `save` | workspace -> 源（哈希比对） | 允许 | 报错 |
| `set` | 改 manifest 元数据 | 允许 | 报错 |
| `install` | registry -> workspace（并更新索引） | - | 允许 |
| `list` | 报告同步状态 | 允许 | 允许 |
| `uninstall` | 删文件 + 删映射 | 允许 | 允许 |
| `publish` | 源 -> registry | 允许 | - |
| `configure` | 配置 | - | - |

核心不变式：**「可变源（mutable）」与「不可变快照（immutable / registry）」严格分离**——registry 只读，install 才写 workspace，add/remove 只改源且不更新索引（必须再 install 才同步）。这把「编辑」和「生效」彻底解耦。

**5) 索引与存储**

workspace 级单文件索引 `openpackage.index.yml`，且明确**排除在 registry payload 之外**（索引本身不会被发布）；全局 registry 用「目录 + 版本号」形式而非 tarball。`list` 命令直接报告同步状态（源与 workspace 是否漂移）。

**6) 校验机制**

- JSON Schema：`platforms-v1.json`、`agent-frontmatter-v1.json`、`map-pipeline-v1.json`，外加每个平台的 agent 格式 schema（claude / opencode / universal）；
- `schema` 子命令可直接校验 manifest；
- `save` 用哈希比对判断 workspace 内容是否偏离源；
- `--dry-run` 预览、`--force` 跳过确认；
- 索引里显式排除 `openpackage.yml` 与 `openpackage.index.yml`，避免自身被同步。

**7) 对外交互**

CLI（`opkg ...`）：`new / add / remove / save / set / install / list / uninstall / publish / configure / move / search / sync / view / login / logout / schema`。文档以 `specs/` 下的 markdown 为准（设计先于实现）。

**8) 依赖管理**

manifest 声明依赖；索引缓存「直接依赖名」；安装做版本解析（`specs/install/version-resolution.md`）与 git 缓存（`git-cache.md`）。

**9) 评价**

优点：

- workspace 索引文件的字段设计是全样本里最强的（path / version / dependencies / files + 简单与复杂两种映射 + key 级合并追踪）；
- 可变源与不可变 registry 的分离带来极干净的语义；
- schemas + specs 双轨，规范先行；
- `platforms.jsonc` + map-pipeline 把「一套内容 -> 多平台格式」的转换显式化。

缺陷：

- 更偏「内容包」而非「技能元数据」，对 `SKILL.md` 生态只是部分兼容；
- 最近推送停在 2026-05，活跃度低；
- specs 极多、学习曲线陡（对轻量目标来说过重）；
- 使用 `.openpackage/` 自有目录约定，而非 `.claude/`、`.agents/` 等社区约定。

可借鉴：索引文件结构（packages -> path/version/dependencies/files 映射 + merge/keys 追踪）、mutable/immutable 分离、`save` 的哈希漂移检测、`schema` 子命令、specs 先行的文档组织。避开它的自有目录约定与庞杂 specs。

---

### A5. Kamalnrf/claude-plugins —— 插件管理器 + 技能安装器的双 CLI

**1) 核心定位**

`A plugin manager and skills installer for AI coding agents.` 用一个 registry（claude-plugins.dev）索引 11,989 个 Claude Code 插件与 63,065 个 agent skills，对外提供两个聚焦 CLI。

**2) 目录结构**

```
claude-plugins/                 # bun monorepo
  packages/
    cli/src/
      commands/{install,list,enable,disable,skills/install}.ts
      core/{marketplace,plugin,resolver,skill-resolver,settings}.ts
      types/index.ts  config.ts
      utils/{fs,git,validation}.ts
    skills-installer/src/
      cli.ts
      commands/{install,list,search}.ts
      lib/{api,client-config,download,paths,select-scope-and-clients,validate}.ts
    web/                        # claude-plugins.dev 前端
  skills/skills-discovery/      # 「让 agent 自己找技能并安装」的元技能
```

**3) 元数据与数据模型**

- 插件：`.claude-plugin/marketplace.json`（含 `plugins[]` 数组即判定为 marketplace）或 `.claude-plugin/plugin.json`（单个插件）；
- 启用状态写进 Claude Code 的 `settings.json`：

```json
{ "enabledPlugins": { "<pluginName>@<marketplaceName>": true } }
```

禁用 = 置 `false`（文件保留）；`removePluginFromSettings` = 删除该 key；

- 技能安装目标：`skills-installer/src/lib/client-config.ts` 里的 `CLIENT_CONFIGS`，每个 client 有 `globalDir` / `localDir`：

```ts
"shared":      { globalDir: ~/.agents/skills,   localDir: ./.agents/skills }
"claude-code": { globalDir: ~/.claude/skills,   localDir: ./.claude/skills }
"openclaw":    { globalDir: ~/.openclaw/skills, localDir: ./skills }
"pi":          { globalDir: ~/.pi/agent/skills, localDir: ./.pi/skills }
```

另有 `CLIENT_ALIASES` 把 codex / cursor / gemini / copilot 等十几个客户端映射到 `shared`（`.agents/skills`）。这是「多客户端 -> 少量真实目录」的收敛做法。

**4) 生命周期**

| 命令 | 行为 |
|---|---|
| `claude-plugins install <plugin>` | 从 registry 安装到 `~/.claude/plugins/marketplaces/` |
| `claude-plugins list` | 列出已安装插件及启用状态 |
| `claude-plugins enable <name>` | 在 settings.json 中置 `true` |
| `claude-plugins disable <name>` | 在 settings.json 中置 `false`（不删文件） |
| `skills-installer search [query]` | 检索 registry |
| `skills-installer install <skill>` | 安装/更新技能，支持 `--client <name>`、`--local` |
| `skills-installer list` | 列出已安装技能 |

**5) 索引与存储**

索引在远端 registry（claude-plugins.dev，由爬虫自动发现并索引所有公开 plugin / skill），本地不存索引；本地只有 `settings.json`（启用状态）与文件目录。

**6) 校验机制（较薄弱）**

- 插件有效性：目录存在 -> `.claude-plugin/` 存在 -> `marketplace.json` 或 `plugin.json` 至少有一个，否则返回带 `reason` 的失败结果；
- 仓库类型判定：有 `plugins[]` 数组即 marketplace，否则单插件；
- 技能有效性：`SKILL.md` 存在且 `trim()` 后非空；
- 无哈希校验、无依赖校验、无 schema 校验。

**7) 对外交互**

两个 CLI（`npx claude-plugins ...` / `npx skills-installer ...`），交互式提示用 `@clack/prompts`，输出用 `picocolors`；另有 web 站点与一个 `skills-discovery` 元技能，让 agent 自主发现并安装。

**8) 依赖管理**

无技能级依赖；依赖 registry 的 API 做版本与来源解析。

**9) 评价**

优点：

- `enabledPlugins` 的 `name@marketplace` 键值对是「启用/禁用」最语义化的实现：不动文件、可被宿主 agent 原生识别；
- `CLIENT_CONFIGS` + `CLIENT_ALIASES` 的两级收敛是多客户端路径问题的漂亮解法；
- 双 CLI 聚焦（插件归插件、技能归技能）职责清晰。

缺陷：

- 校验太弱（只看文件存在与非空，无 schema / hash / 依赖）；
- 强绑定 Claude Code 的 `settings.json` 语义，换宿主就失效；
- 索引在远端，离线不可用；
- 顶层 `package.json` 标 `private: true`，仓库无公开许可证文件（README 声明 MIT）。

可借鉴：`enabledPlugins` 这种「宿主原生开关」思路（若宿主支持）、client 路径两级收敛表、双 CLI 的职责切分。避开它的弱校验与远端索引依赖。

---

### A6. EfanWang/skills-manager —— 最轻量的 CLI 优先实现

**1) 核心定位**

`a simple, practical skill manager for the SKILL.md ecosystem`。扫描当前 skills root 下的同级技能目录，用 `sources.json` 记录来源，提供清单、溯源、更新检查、更新、安装、删除。**它本身就是一个 SKILL.md 技能**，靠 agent 调用脚本执行。

**2) 目录结构**

```
skills-manager/                 # 被整个 clone 进某个 agent 的 skills root
  SKILL.md                      # 触发词 + 场景化的运行指引
  sources.json                  # 轻量 registry
  scripts/
    _common.py                  # skills_root / load_sources / save_sources /
                                # validate_skill_name / fetch_remote_skill_md
    inventory.py                # 扫描 + 分类（--check-remote --audit-unclaimed）
    audit_unclaimed.py          # 批量识别无来源技能
    check_remote.py             # 单个技能上游更新检查
    update_skill.py             # 拉取上游 + 备份 + 原子替换（--dry-run）
    install_skill.py            # 从 GitHub URL clone 并原子落位 + 注册来源
    sources.py                  # 安全维护 sources.json（list/remove/claim-local/claim-remote）
    similarity.py               # 名称相似度
  tests/
  README.md  README.zh-CN.md  LICENSE
```

**3) 元数据与数据模型**

```json
{ "version": 1, "skills": { "<skill-name>": {} } }
```

每条记录的三种形态：

- `{}` -> **local**（用户标记为私有/本地，跳过检查）；
- `{ "url": "...", "branch": "...", "subpath": "...", "installed_revision": "<sha>" }` -> **remote**；
- 无记录 -> **unclaimed**（未知来源，等待被 claim）。

三态（remote / local / unclaimed）是这个项目最值得学的抽象：它把「来源未知」当成一等公民，而不是异常。

**4) 生命周期**

- 清单/入库：`inventory.py` 遍历同级目录并尝试补全 `sources.json` 记录；
- 溯源：`audit_unclaimed.py` 批量分析本地证据，无法判定的交给 agent 去 web search；
- 安装：`install_skill.py <github-url>` -> clone 到临时目录 -> 校验 -> 原子替换（rename）-> 写 `sources.json`；
- 更新：`update_skill.py <name>` -> 先建备份 -> 原子替换；
- 删除：`sources.py remove` + 删除前自动备份；
- 启用/禁用：无（有意不做）。

**5) 索引与存储**

单个 `sources.json` 放在 skills-manager 目录内充当 registry。所有脚本 stdout 输出 JSON、日志走 stderr。范围是「当前 root 下的同级目录」，不做跨 root 聚合（README 明确声明 scope）。

**6) 校验机制**

- `validate_skill_name`（技能名合法性）；
- 结构化退出码：`2` 输入错误 / `3` `sources.json` 损坏 / `4` 远端操作失败 / `5` 文件系统替换失败；
- 更新与删除前强制备份；
- 原子替换（先 clone 到临时目录再 rename）；
- `sources.json` 只允许通过 `sources.py` 修改（手工编辑被明确警告会损坏文件）。

**7) 对外交互**

Python 脚本 CLI（`python scripts/xxx.py`），且**只以 JSON 作为对外契约**，因此既能被 CI 调用，也能被上层 agent / UI 调用。同时 `SKILL.md` 用「场景 A/B/C -> 运行哪个脚本」的方式把 CLI 包装成 prompt 指令。

**8) 依赖管理**

无技能级依赖；运行时依赖 Python 3.9+ 与 `git`。

**9) 评价**

优点：

- 轻到极致（44 个文件 / 0.14MB），却是全样本里工程纪律最好的小项目；
- 原子替换 + 强制备份 + 结构化退出码 + JSON 契约 + 来源三态 + 明确 scope 声明；
- 「脚本 + SKILL.md 包装」同时服务人和 agent。

缺陷：

- 没有 schema 校验、没有内容哈希、没有依赖检查（按它的定位是刻意的）；
- 不做跨 root 聚合，多 agent 场景需要装多份；
- 无启用/禁用；
- `sources.json` 无锁，并发写有风险。

可借鉴：「来源三态」模型、原子替换 + 备份 + 回滚、结构化退出码、JSON-only 对外契约、SKILL.md 场景化包装 CLI 的写法。这是 skill-manager 做 MVP 时最该模仿的骨架。

---

### A7. RealZST/HarnessKit —— 备份 / 导入导出（Kit）设计的最佳参考

**1) 核心定位**

`One home for every agent.` 从统一界面管理 16 个 agent 的五类扩展：Skills、MCP Servers、Plugins、Hooks、Agent-first CLIs。

**2) 目录结构**

```
HarnessKit/
  crates/
    hk-core/src/
      models.rs  config.rs  manager.rs  service.rs  scanner.rs  deployer.rs
      marketplace.rs  skills_cli.rs  store.rs  sanitize.rs
      adapter/            # 每个 agent 一个适配器 + hook_events
        claude codex cursor gemini copilot hermes kiro antigravity
        opencode openclaw omp penguin qoder_cn windsurf grok dsh
      auditor/            # rules/{permissions,content,mcp,plugin,cli,shared}
      kits/               # 导出/导入包
        manifest.rs  install_plan.rs  install_records.rs  source_resolver.rs
        project_summary.rs  paths.rs  zip_io.rs  util.rs  agent_overlap.rs
      store/              # SQLite
        schema.rs  extensions.rs  kits.rs  install_meta.rs
        projects.rs  settings.rs  sync.rs  audit.rs
    hk-cli/src/{main.rs, grouping.rs}
    hk-desktop/src/commands/
    hk-web/src/handlers/
  src/                    # React 前端
```

**3) 元数据与数据模型**

Kit 清单（`kits/manifest.rs`）——这就是「备份导入导出」的数据模型：

```rust
const KIT_FORMAT_VERSION: u32 = 1;

struct KitManifest {
    kit_format_version: u32,
    kit_id: String, name: String, description: String,
    created_at: DateTime<Utc>, exported_from: String,
    extensions: Vec<ManifestExtension>,
    config_files: Vec<ManifestConfigFile>,
    secrets_stripped: Vec<String>,        // 导出时被剥离的密钥路径
}
struct ManifestExtension {
    name: String, kind: ExtensionKind,
    source_extension_id: String, source_url: Option<String>,
    content_hash: String,                 // "sha256:<hex>"
    asset_path: String, position: i64,
    source_revision: Option<String>,      // git commit
    source_branch: Option<String>,
}
struct ManifestConfigFile {
    agent: String, category: ConfigCategory,
    filename: String, asset_path: String, position: i64,
}
```

哈希实现：`sha256_of_bytes` 与 `sha256_of_dir`（按相对路径排序，条目贡献 `<relpath>\0<bytes>`，保证跨机器一致）。

**4) 生命周期**

安装 / 启用 / 禁用 / 更新检查 / 跨 agent 部署 / 导出为 Kit / 从 Kit 导入。禁用状态可保留原始配置文本（含密钥），因此数据库用 `PRAGMA secure_delete = ON` 并在 Unix 上设 `0600` 权限。

**5) 索引与存储**

**SQLite**（`rusqlite`，schema 迁移 v1 -> v9，迁移前自动备份为 `{db}.backup-v{n}`），不是 YAML/JSON 索引。表按领域拆分：extensions / kits / install_meta / projects / settings / sync / audit。

**6) 校验机制（样本里最全面）**

- 内容哈希 `sha256:` 校验；
- `auditor/rules/*` 分维度审计（权限、内容、MCP、插件、CLI）；
- 权限与 trust score 展示；
- 数据库 schema 版本检查（比当前二进制新则告警）；
- 迁移前备份 + 幂等迁移（忽略 duplicate column）；
- `zip_io` 打包 Kit 时剥离密钥并记录 `secrets_stripped`。

**7) 对外交互**

桌面 App（主）+ `hk-cli` + Web（`hk-web`），三者共享 `hk-core`。

**8) 依赖管理**

`install_plan.rs` 产出安装计划，`source_resolver.rs` 解析来源，`install_records.rs` 记录安装事实；无技能级依赖图。

**9) 评价**

优点：

- Kit 清单就是备份/导入导出的完整数据模型（版本号、内容哈希、来源 URL/commit/branch、剥离密钥清单、config_files 分 agent 归类），几乎可以直接照搬到 skill-manager 的 `export` / `import`；
- `auditor/rules` 的插件化审计很值得学；
- 迁移前备份 + 幂等迁移是数据安全的正确姿势；
- core / cli / desktop / web 四端共享 core 的分层非常干净。

缺陷：

- SQLite 存储对「YAML 配置可读可 diff」的目标不友好（用户看不到、git 没法 review）；
- Rust + 桌面 + Web 三端对轻量目标是巨大负担；
- 支持 16 个 agent 意味着适配面积爆炸。

可借鉴：Kit manifest 的字段集（尤其 `content_hash` / `source_revision` / `source_branch` / `secrets_stripped` / `config_files`）、审计规则插件化、迁移前备份。

---

### A8. cchao123/skills-manager —— 中文生态的桌面聚合器

**1) 核心定位**

「在多个 AI Agent 之间统一管理、同步与分发 Skills 的桌面应用」（Tauri 2 + React + Rust）。内置 agent 预设：Claude Code、Cursor、Codex、OpenClaw、OpenCode、Trae、Qoder、Antigravity、Kiro。

**2) 目录结构**

```
src-tauri/src/
  models.rs  scanner.rs  linker.rs  settings.rs  state.rs  tray.rs  main.rs
  commands/{skills, settings, marketplace, github, theme, window, mod}.rs
  github/{git_remote.rs, marketplace.rs, mod.rs}
  tests/{linker, models, scanner, settings}.rs
app/src/{api, components, contexts, hooks, i18n, lib,
         pages/{Dashboard, Marketplace, GitHubBackup, Settings}, types}
```

**3) 元数据与数据模型**

以 `SKILL.md` 的 frontmatter 为主（`name` / `description` 必需，README 建议含 `license` / `author` / `version` / `dependencies` 等扩展字段）；应用自身的配置与索引存 `~/.skills-manager/config.json` 与 `~/.skills-manager/skills/`。

**4) 生命周期**

发现/聚合（扫描多个 agent 目录）-> 按 agent 开关启用 -> 安装（Marketplace / GitHub / 拖拽文件夹）-> 卸载 -> 备份/恢复到 GitHub。

**5) 索引与存储**

文件系统 + `config.json`（非 DB）；Marketplace 走 `skills.sh` 外部索引源（All Time / Trending / Hot 三榜）。

**6) 校验机制**

较薄：`models.rs` 与 `tests/` 覆盖扫描与链接逻辑；导入时校验目录含 `SKILL.md`。README 未声明哈希或依赖校验。

**7) 对外交互**

GUI 为主（Tauri），无独立 CLI。

**8) 依赖管理**

无技能级依赖管理。

**9) 评价**

优点：「聚合多 agent 视图 + 按 agent 开关 + Marketplace 一键装 + GitHub 备份恢复」这四件套的 UX 组合很实用；`linker.rs` 的链接/复制策略可参考；中文文档与 i18n 友好。

缺陷：桌面形态，跨平台打包成本高；索引非结构化（无 schema、无哈希、无依赖检查）；无 CLI，自动化能力弱；更新停在 2026-05。

可借鉴：「聚合视图 + 按 agent 开关 + GitHub 备份/恢复」的产品组合，以及配置目录布局（`~/.skills-manager/config.json` + `skills/`）。避开无 CLI 与薄校验。

---

### A9. buzhangsan/skill-manager —— 大规模 catalog 与扩展 frontmatter 的样本

**1) 核心定位**

以 skill 形态提供的「搜索 + 一键安装 31,767 个社区技能」工具，面向 Claude Code / Antigravity，支持双语检索。

**2) 目录结构**

```
skill-manager/
  SKILL.md      # 元数据 + 使用说明（agent 读它来使用本工具）
  src/{index.js, package.json}
  data/all_skills_with_cn.json.gz   # 42MB 压缩索引（31,767 条，含中文翻译）
  docs/{README_CN.md, ...}
```

**3) 元数据与数据模型（扩展 frontmatter 的典型）**

```yaml
---
name: skill-manager
description: A Claude Code skill that allows you to search, browse, and install skills ...
version: 2.0.0
author: buzhangsan@github
license: MIT
allowed-tools: [Bash, Read, Write, Edit, WebFetch]
tags: [skill-management, package-manager, search, installation, svn, git]
requirements:
  - Node.js >= 14.0.0
  - Internet connection
  - SVN client (recommended) or Git
---
```

注意：`version` / `author` / `license` / `tags` / `requirements` 全部平铺在顶层——这正是 `agentskills` 规范不允许的写法（规范只认 `name` / `description` / `license` / `compatibility` / `allowed-tools` / `metadata`）。这是要避免的反面样本；正确做法是塞进 `metadata:`。

**4) 生命周期**

发现 -> 搜索 -> 一键安装（SVN export / Git sparse checkout / HTTP 三种降级方案）-> 展示 GitHub 统计。无启用/禁用/卸载的显式设计（依赖 agent 自行处理）。

**5) 索引与存储**

集中式单一大 JSON 索引（gzip 后 42MB）。优点是分发简单；缺点是更新、去重、同步困难，加载成本高。

**6) 校验机制**

无 schema、无哈希、无依赖校验。安装方案有多级 fallback（SVN -> Git sparse -> HTTP）算一种鲁棒性设计。

**7) 对外交互**

纯 prompt 驱动（agent 读 `SKILL.md` 后自行调用 `src/index.js`），无独立 CLI 契约。

**8) 依赖管理**

`requirements` 仅作声明，不解析。

**9) 评价**

优点：证明了「大规模 catalog + 中文检索 + 多级下载 fallback」的可行性；`SKILL.md` 作为「工具说明书」配合脚本的分发模式很轻。

缺陷：集中式巨型 JSON 索引是典型反模式（42MB，更新与并发都是问题）；`SKILL.md` 元数据不合规；无校验；无完整生命周期；无许可证文件；更新停在 2026-02。

可借鉴：多级下载 fallback（SVN -> Git sparse -> HTTP）与双语检索体验。明确避开：单文件巨型索引、顶层自造 frontmatter 字段。

---

### A10. numman-ali/n-skills —— `sources.yaml` 索引设计范本

**1) 核心定位**

`One marketplace. Every agent.` 策展型 marketplace：用一个 `sources.yaml` 声明外部技能来源，用 GitHub Actions 每日同步上游内容，再据此自动重建 `marketplace.json` 与 `AGENTS.md`。

**2) 目录结构**

```
n-skills/
  sources.yaml                        # 唯一的来源事实源
  .claude-plugin/marketplace.json     # 由 sources.yaml 生成
  AGENTS.md                           # 由 sources.yaml 生成
  scripts/sync-external.mjs           # 从上游 repo 复制技能目录
  scripts/update-registry.mjs         # 由 sources.yaml 重建 marketplace.json + AGENTS.md
  skills/
    tools/{zai-cli, gastown}/
    automation/dev-browser/
    workflow/{orchestration, open-source-maintainer}/
```

**3) 元数据与数据模型（`sources.yaml` 字段）**

```yaml
version: 1
skills:
  - name: dev-browser
    description: Browser automation with persistent page state. Use when users ask ...
    native: false                       # true = 本仓库自维护，无 source
    source:
      repo: SawyerHood/dev-browser      # owner/name
      path: skills/dev-browser          # 上游子目录
      ref: main                         # branch / tag / commit
    target:
      category: automation              # 目录分类
      path: skills/automation/dev-browser   # 本仓库落位
    author: { name: Sawyer Hood, github: SawyerHood }
    license: MIT
    homepage: https://github.com/SawyerHood/dev-browser
    verified: true                      # 人工审核通过
    sync:
      include: [SKILL.md, references/, scripts/, src/, server.sh, package.json]
```

生成物 `marketplace.json` 形态：`{ name, description, owner{}, plugins[] { name, description, source, category, author{name,github} } }`。

**4) 生命周期**

提交 PR 改 `sources.yaml` -> 每日 GitHub Action 执行 `sync-external.mjs` 拉取上游 -> `update-registry.mjs` 重建 registry 文件。安装由外部工具完成（Claude 的 `/plugin marketplace add` + `/plugin install`，或 `openskills install`）。

**5) 索引与存储**

三层：`sources.yaml`（来源事实源，人写）-> 同步后的 `skills/` 目录树（内容）-> `.claude-plugin/marketplace.json` + `AGENTS.md`（机器生成，供宿主消费）。索引是「人写的 YAML」加「生成的 JSON」双轨，而不是手改 JSON。

**6) 校验机制**

中等：`verified` 人工标记；`sync.include` 白名单限制同步文件范围；CI 维护一致性（生成物由脚本重建，避免手工漂移）。无哈希、无依赖校验。

**7) 对外交互**

非交互工具：以 marketplace 清单 + `AGENTS.md` 形式被 Claude Code / openskills / 各类 agent 消费。安装侧走宿主原生命令（prompt 指令 `/plugin install`）。

**8) 依赖管理**

无显式依赖图；`sync.include` 间接表达内容依赖。

**9) 评价**

优点：`sources.yaml` 的字段设计干净且可直接复用（name / description / native / source{repo,path,ref} / target{category,path} / author / license / homepage / verified / sync.include）；「人写 YAML -> 生成 JSON」的双轨避免了手改清单；上游镜像 + 白名单 include 的可控同步很适合做「外部技能引入」。

缺陷：不是管理器（无启用/禁用/卸载），只是 marketplace；无哈希校验（无法确认同步内容未被篡改）；依赖 GitHub Actions 定时任务，无本地兜底。

可借鉴：`sources.yaml` 字段集、人写 YAML 生成 marketplace.json 的流水线、`sync.include` 白名单；建议在其上加 `content_hash` 并把 `ref` 锁定成 commit 来补上完整性。

---

### A11. jeremylongshore/tons-of-skills-marketplace —— 重度治理型 marketplace（边界参考）

**1) 核心定位**

超大型 marketplace（26,027 个文件、171MB），带完整 catalog 治理、Schema 校验、外部同步与发布隔离。

**2) 目录结构（节选）**

```
  sources.yaml / sources.lock.json       # 来源声明 + 锁定
  skills.sh.json                         # 分组展示配置
  schemas/canonical/v0/
    skill-contract.schema.json           # 技能契约 schema
    capability-map.json  model-id-exclusions.json  adapter-thinness-waivers.json
  scripts/
    validate-skills-schema.py            # 技能 schema 校验
    validate-catalog-invariants.py       # catalog 不变式校验
    sync-external.mjs  sync-lockfile.mjs  scan-synced-content.mjs
    validate-mcp-config.mjs  validate-unicode-hygiene.py
    validate-harness-registry.mjs  validate-cowork-*.mjs
  plugins/  skills/  templates/  marketplace/  config/  ci/
  .gitleaks.toml  .sops.yaml  commitlint  husky  ...
```

**3) 元数据与数据模型（`sources.yaml` 字段，最丰富的一版）**

```yaml
sources:
  - name: sugar
    description: Autonomous AI Development Platform
    repo: roboticforce/sugar              # 上游 owner/name
    source_path: .claude-plugin           # 上游取哪
    target_path: plugins/devops/sugar     # 本仓库放哪
    author: { name: Steven Leggett, github: cdnsteve, email: contact@roboticforce.io }
    license: MIT
    category: devops
    verified: true        # 维护者已审核质量与可信度
    curated: false        # 本地是否加固过；true 则冻结镜像，sync 永不回退本地修改
    include: ['/plugin.json', '/README.md', '/PLUGIN_OVERVIEW.md']
    # exclude: [...]
    # publication_disposition: { status: quarantined, channels: [], artifacts: [...] }
```

`verified` 与 `curated` 被明确设计为**正交**（`curated: true + verified: false` 是合法状态），`publication_disposition` 提供 fail-closed 的发布隔离。另有 `sources.lock.json` 做锁定。

**4) 生命周期**

同步（每周一 06:00 UTC + 手动/事件触发）-> 校验（多层脚本）-> 分类分组 -> 发布（含隔离通道）。安装侧由宿主完成。

**5) 索引与存储**

`sources.yaml`（人写）+ `sources.lock.json`（锁定）+ `skills.sh.json`（分组展示）+ 生成的 catalog。索引分散在多个受校验的文件里。

**6) 校验机制（本样本最强）**

- JSON Schema：`skill-contract.schema.json`；
- Python 校验：schema、catalog 不变式；
- 其他：MCP 配置校验、Unicode 卫生、harness registry 校验、密钥扫描（gitleaks）、SOPS 加密配置；
- 发布隔离：`publication_disposition` 未通过的来源不进安装 catalog；
- 锁定文件保证可复现。

**7) 对外交互**

以 marketplace / catalog 形式对外；深度集成 Claude Code / Gemini（`.claude/`、`.gemini/` 目录）与丰富的 CI 工作流。

**8) 依赖管理**

`sources.lock.json` 锁定外部来源；无技能级依赖图。

**9) 评价**

优点：`skill-contract.schema.json` + `validate-skills-schema.py` 是契约式校验的完整范例；`verified` / `curated` 正交双旗与 `publication_disposition` 发布隔离是很成熟的分发治理设计；多层校验脚本覆盖 schema、不变式、密钥、Unicode。

缺陷：极其重（171MB / 26k 文件 / 十几套校验脚本 / husky + commitlint + sops + gitleaks），对 skill-manager 属于明显的过度工程；耦合大量具体 CI 工具链；不是管理器。

可借鉴：契约式 schema 校验思路、`verified`/`curated` 正交双旗、发布隔离（fail-closed）、锁定文件。明确避开其体量与工具链耦合。

---

### A12. udapy/rust-agentic-skills —— `skills.json` 清单 + MCP 动态路由

**1) 核心定位**

用 **Brain-Tool-Context** 架构组织的 Rust 技能集，通过 MCP server 让 Claude / Gemini 动态路由到具体技能。

**2) 目录结构**

```
  skills/{rust-core, lint-hunter, pest-specialist, ron-specialist,
          general-debug, general-security, general-syntax, router}/
  src/{main.rs, skills.rs, bin/verify_borrow.rs}   # MCP server（JSON-RPC stdin）
  skills.json                                      # 技能索引
  .claude-plugin/  gemini-extension.json
  bootstrap.sh  Makefile
```

**3) 元数据与数据模型**

```json
{
  "version": "1",
  "skills": [
    { "id": "rust-core", "name": "Rust Core Specialist",
      "description": "Implementing idiomatic, safe, and performant Rust code.",
      "path": "skills/rust-core",
      "entrypoint": "skills/rust-core/SKILL.md" }
  ]
}
```

技能内部遵循 Brain（`SKILL.md`，含 `trigger` / `rpi_phase` 等最小元数据）/ Hands（`scripts/`）/ Context（`references/`，懒加载）三分。

**4) 生命周期**

无安装/卸载语义——它是随仓库分发的技能集。激活通过 MCP server 启动时读取 `skills/` 动态路由。

**5) 索引与存储**

仓库内 `skills.json` 单文件索引（轻量、可手写、带 `entrypoint`）。

**6) 校验机制**

`skills.rs` 读索引并校验路径存在；`src/bin/verify_borrow.rs` 是技能自带的工具。无 schema、无哈希。

**7) 对外交互**

- prompt 指令（Claude 插件 marketplace.json）；
- MCP server（`./bootstrap.sh` 或 `cargo run`，stdin 收 JSON-RPC）；
- Gemini 扩展（`gemini extensions link .`）。

**8) 依赖管理**

无技能级依赖；`references/` 懒加载代替「前置依赖」。

**9) 评价**

优点：`skills.json` 的 `{id, name, description, path, entrypoint}` 是最小可用索引结构，可以直接作为 skill-manager 的索引雏形；Brain-Tool-Context 的懒加载分层对 token 成本友好；一个仓库同时适配 Claude 插件 / Gemini 扩展 / MCP 三种消费方式。

缺陷：无生命周期管理（无安装/启用/禁用/卸载）；无校验；索引与目录需人工保持一致（无生成脚本）。

可借鉴：`skills.json` 索引字段、`entrypoint` 显式化、懒加载分层。补上「由扫描自动生成索引」以避免人工漂移。

---

### A13. kdpa-llc/local-skills-mcp —— MCP 作为交互面的方案

**1) 核心定位**

通用 MCP server，让任何 MCP 客户端（Claude Code / Desktop、Cline、Continue.dev、自研 agent）访问本地文件系统上的技能。

**2) 目录结构**

```
  src/
    index.ts            # MCP server 入口
    skill-loader.ts     # 多来源聚合加载
    skill-validator.ts  # SKILL.md 校验
    eval-runner.ts      # 触发可靠性评估
    types.ts
  skills/{local-skills-mcp-guide, local-skills-mcp-usage, skill-creator}/
  vendor/anthropic-skills/   # git submodule
  evals/  scripts/  docs/
  mcp-config-auto-detect.json  mcp-config-example.json
```

**3) 元数据与数据模型**

技能 = 含 `SKILL.md` 的目录（`name` + `description` 先加载，正文按需）。多来源聚合：内置 skills、`~/.claude/skills`、`./.claude/skills`、`./skills`、自定义路径。

**4) 生命周期**

无安装/启用/禁用/卸载——只做「发现 + 读取 + 校验 + 评估」。热重载：新增/编辑/删除技能即刻生效，无需重启。

**5) 索引与存储**

不落盘索引：启动时扫描来源目录，内存中维护「名字 + 描述」轻索引（约 50 tokens / 技能），正文懒加载。

**6) 校验机制**

`skill-validator.ts` 校验 `SKILL.md`；`eval-runner.ts` + `evals/` 度量技能的**触发可靠性**（是否在该触发时触发）。

**7) 对外交互**

MCP 三个工具：`get_skill`（加载单个）、`validate_skill`（校验）、`evaluate_skill`（评估触发可靠性）。这是「函数调用 / prompt 指令」类交互的代表。

**8) 依赖管理**

无。

**9) 评价**

优点：MCP 作为交互面，天然跨客户端；「轻索引（name + description）+ 正文懒加载」与 agentskills 的渐进式披露完全一致；`evaluate_skill` 度量触发可靠性是很独特的能力，值得单列进 skill-manager 的 roadmap；热重载体验好。

缺陷：完全没有生命周期管理，校验薄，无哈希与依赖检查；MCP 客户端差异需自行兜底。

可借鉴：MCP 工具面（get / validate / evaluate 三函数）、轻索引 + 懒加载、热重载。若 skill-manager 要暴露给 agent，这是最值得抄的对外接口形态。

---

### A14. obra/superpowers —— 「一个源，多 harness 打包」的范式

**1) 核心定位**

一套软件开发方法论（可组合技能集），通过**为每个 harness 提供原生插件清单**的方式，把同一份技能内容分发到 16 个以上 agent。

**2) 目录结构（关键点：每个 harness 一个插件目录）**

```
  .claude-plugin/{marketplace.json, plugin.json}
  .codex-plugin/plugin.json
  .cursor-plugin/plugin.json
  .antigravity-plugin/plugin.json
  .devin-plugin/plugin.json
  .kimi-plugin/plugin.json
  .muse-plugin/{marketplace.json, plugin.json}
  .hermes-plugin/{plugin.yaml, __init__.py}      # YAML 形态
  .agents/plugins/marketplace.json
  .opencode/plugins/superpowers.js
  .pi/extensions/superpowers.ts
  skills/  agents/  commands/  hooks/
  docs/porting-to-a-new-harness.md
```

**3) 元数据与数据模型**

同一内容、多份宿主原生清单：`.claude-plugin/plugin.json`（JSON）、`.hermes-plugin/plugin.yaml`（YAML）、`.opencode/plugins/*.js`（代码扩展）、`.pi/extensions/*.ts`。`docs/porting-to-a-new-harness.md` 描述了移植契约。

**4) 生命周期**

按各 harness 的原生机制安装（Claude 走官方 marketplace、Codex 走 `.codex-plugin`、Cursor 走 `.cursor-plugin` 等）。项目本身不做管理器。

**5) 索引与存储**

每个 harness 一份清单文件；技能内容共享同一份 `skills/` 目录。

**6) 校验机制**

有 `.pre-commit-config.yaml`、`.version-bump.json`；无明显 schema 校验。

**7) 对外交互**

prompt 指令为主（各 harness 的原生安装命令），技能自动触发。

**8) 依赖管理**

无。

**9) 评价**

优点：「一份内容 + 按 harness 生成原生清单」是解决多 agent 分发的现实答案；同步维护 16 个 harness 的清单目录，说明「每个 harness 一个适配目录」的约定可以规模化；`porting-to-a-new-harness.md` 把适配过程文档化。

缺陷：清单目录各自手工维护，容易漂移（对比 agentpack 的「由 manifest 渲染」是更工程的解法）；不是管理器；体量大且与具体方法论耦合。

可借鉴：harness 到适配目录/清单文件的映射约定，以及「移植到新 harness」的文档化流程。实现上应像 agentpack 那样**由统一 manifest 渲染**，而不是手工维护多份清单。

---

### B1. agentskills/agentskills —— 必须遵守的规范

**1) 核心定位**

Agent Skills 的开放规范（Anthropic 起草并开源），定义 `SKILL.md` 格式与加载模型。

**2) 目录结构**

```
agentskills/
  docs/specification.mdx              # 规范正文
  docs/client-implementation/adding-skills-support.mdx
  skills-ref/                         # 参考实现
    src/skills_ref/{cli,models,parser,prompt,validator,errors}.py
    tests/{test_parser,test_validator,test_prompt}.py
  AGENTS.md  CLAUDE.md  CONTRIBUTING.md
```

一个技能的标准形态：

```
my-skill/
  SKILL.md          # 必需：元数据 + 指令
  scripts/          # 可选：可执行代码
  references/       # 可选：文档
  assets/           # 可选：模板与资源
  ...               # 任意附加文件
```

**3) 元数据与数据模型（唯一权威）**

```python
@dataclass
class SkillProperties:
    name: str                     # 必需，kebab-case
    description: str              # 必需
    license: Optional[str] = None
    compatibility: Optional[str] = None
    allowed_tools: Optional[str] = None   # 实验性
    metadata: dict[str, str] = field(default_factory=dict)  # 客户端私有键值
```

**4) 生命周期（规范定义的加载模型：渐进式披露）**

1. **Discovery**：启动时只加载每个技能的 `name` + `description`（知道什么时候可能相关）；
2. **Activation**：任务匹配描述时，把完整 `SKILL.md` 读进上下文；
3. **Execution**：按指令执行，按需执行打包代码或加载引用文件。

**5) 索引与存储**

规范不规定索引：以「含 `SKILL.md` 的文件夹」为最小单位，索引由实现方（即 skill-manager 这类工具）决定。

**6) 校验机制（`skills-ref/validator.py`，规则可直接抄）**

| 规则 | 约束 |
|---|---|
| 允许字段 | 仅 `name` / `description` / `license` / `allowed-tools` / `metadata` / `compatibility`；出现其他字段即报错并列出 unexpected fields |
| `name` | 非空字符串；NFKC 归一；不超过 **64** 字符；必须**全小写**；不能以 `-` 开头或结尾；不能含连续 `--`；只允许字母、数字、`-`（支持 Unicode 字母） |
| 目录名一致性 | **目录名必须等于 `name`** |
| `description` | 非空；不超过 **1024** 字符 |
| `compatibility` | 必须是字符串；不超过 **500** 字符 |

**7) 对外交互**

`skills-ref` CLI（参考实现，明确标注「仅供演示，勿用于生产」）：

- `skills-ref validate <skill_path>`：退出码 0 合法 / 1 有错；
- `skills-ref read-properties <skill_path>`：输出 JSON 属性；
- `skills-ref to-prompt <skill_paths...>`：生成 `<available_skills>` XML 供 agent prompt 使用。

**8) 依赖管理**

规范不涉及。

**9) 评价**

优点：字段最少、约束最明确、被大量客户端采纳（客户端列表覆盖 Claude / ChatGPT / Cursor / Copilot / Codex / Gemini / Goose 等）；`metadata` 字段为扩展预留了合法出口；`to-prompt` 给出了「技能清单如何进入 prompt」的标准答案。

缺陷：规范本身不管安装/启用/禁用/卸载/依赖——这些空白正是 skill-manager 要填的部分；`skills-ref` 明确不是生产实现；无哈希与签名机制（完整性需要管理器自建）。

可借鉴：严格按这份字段表与命名约束做校验，白名单外字段一律拒绝并给出可读错误；`metadata` 作为扩展出口；`to-prompt` 的 `<available_skills>` 输出约定。

---

### B2. anthropics/skills —— 事实标准与示例模板

**1) 核心定位**

官方示例技能集合与插件清单事实标准。

**2) 目录结构**

```
anthropics/skills/
  .claude-plugin/marketplace.json   # 事实标准
  spec/agent-skills-spec.md         # 指向 agentskills.io/specification
  template/SKILL.md                 # 最小模板
  skills/{xlsx,docx,pptx,pdf,algorithmic-art,brand-guidelines,
          canvas-design,doc-coauthoring,claude-api,skill-creator,
          internal-comms,mcp-builder,slack-gif-creator,theme-factory,
          web-artifacts-builder,webapp-testing,...}/
```

**3) 元数据与数据模型**

插件清单（`.claude-plugin/marketplace.json`）：

```json
{
  "name": "anthropic-agent-skills",
  "owner": { "name": "...", "email": "..." },
  "metadata": { "description": "Anthropic example skills", "version": "1.0.0" },
  "plugins": [
    { "name": "document-skills",
      "description": "Collection of document processing suite ...",
      "source": "./",
      "strict": false,
      "skills": ["./skills/xlsx", "./skills/docx", "./skills/pptx", "./skills/pdf"] }
  ]
}
```

技能模板（`template/SKILL.md`）只有两个字段：

```markdown
---
name: template-skill
description: Replace with description of the skill and when Claude should use it.
---
```

注意 `plugins[]` 里的 `strict` 与 `skills[]`（一个 plugin 打包多个 skill 目录）——这是「插件是技能的分组容器」的标准表达。

**4) 生命周期 / 5) 索引 / 6) 校验 / 7) 交互**

仓库本身不提供管理工具，靠 Claude Code 原生 `/plugin` 机制消费；无校验脚本。

**8) 依赖管理**

无。

**9) 评价**

优点：`.claude-plugin/marketplace.json` 的 `{name, owner, metadata{description,version}, plugins[]{name, description, source, strict, skills[]}}` 是事实标准，兼容它等于兼容 Claude 生态；`template/SKILL.md` 证明了最小元数据就是 name + description；`skills[]` 表达一插件多技能。

缺陷：无工具、无校验、无索引；`strict` 字段语义缺乏公开文档。

可借鉴：同时支持 `SKILL.md`（单技能）与 `.claude-plugin/marketplace.json`（插件分组）两层元数据；把 `plugins[]` 当作「命名分组」的实现载体。

---

### C1. Hmbown/aleph —— 被排除的样本（记录原因）

MCP server + 递归语言模型运行时，把搜索索引、代码执行、证据、递归全部放在 prompt 之外的 Python 进程里（`aleph/{cache,mcp,providers,repl,swarm,utils}`），并自带 `.claude-plugin` 与 `plugins/` 打包。

排除理由：它执行代码、维护运行时状态、做递归推理，属于完整 Agent 运行时，与「只管理插件元信息、不执行业务逻辑」的定位冲突。但它的 `.claude-plugin/{marketplace.json,plugin.json}` + `.codex-plugin/` 多 harness 打包结构值得作为参考。

---

## 4. 综合对比总结

### 4.1 架构对比表

按「你要的九个维度」横向对比。`-` 表示该项目不做这件事。

| 维度 | agentpack | asm | xingkongliang | OpenPackage | claude-plugins | EfanWang | HarnessKit | n-skills |
|---|---|---|---|---|---|---|---|---|
| 形态 | Go CLI | TS CLI + TUI | 桌面 + CLI | TS CLI | 双 CLI + Web | Python 脚本 + SKILL.md | 桌面 + CLI + Web | Marketplace 脚本 |
| 元数据载体 | `agentpack.toml` | `SKILL.md` frontmatter | `SKILL.md` frontmatter | `openpackage.yml` | `.claude-plugin/*.json` | `SKILL.md` + `sources.json` | SQLite + YAML/JSON/Toml 适配 | `sources.yaml` |
| 是否 YAML | 否（TOML） | 是 | 是 | 是 | 否（JSON） | 是 + JSON | 部分 | 是 |
| 注册（install） | `add`（写 manifest + lock + sync） | `install` | GUI/CLI 导入中心库 | `install`（registry -> workspace） | `install` | `install_skill.py` | GUI/CLI | 由宿主 `/plugin install` |
| 启用/禁用 | `[modes]` 声明式 selector | `SKILL.md` -> `SKILL.md.disabled` | Preset + 按 agent 开关 | 可变源 vs 不可变快照 | `settings.json` 的 `enabledPlugins` | - | GUI 开关 | - |
| 卸载 | `remove` | `uninstall` | `removals.rs` | `uninstall`（删文件 + 删映射） | 删 settings key + 文件 | 备份后删除 | GUI | - |
| 索引存储 | `pack.lock`（项目根） | `skill-state.json`（用户级） | 中心库目录 + sync_metadata | `openpackage.index.yml`（workspace） | 远端 registry + `settings.json` | `sources.json` | SQLite | `sources.yaml` + 生成 JSON |
| 单文件 vs 分散 | 单文件 lock | 单文件 state（+ 分片 catalog） | 分散（目录即索引） | 单文件 workspace 索引 | 远端集中 | 单文件 | SQLite 单库 | 单文件 YAML |
| 配置校验 | Schema + content_hash + lock 一致性 + staging 漂移 | frontmatter 结构 + 安全扫描 + 审计 | content_hash + path_guard + 更新 diff | 4 套 JSON Schema + 哈希漂移 | 文件存在性 + 非空 | 名称合法性 + 退出码 + 备份 | sha256 + 规则化审计 + schema 版本 | verified + include 白名单 |
| 哈希校验 | 有（content_hash） | 无 | 有（content_hash） | 无（save 时比对内容哈希） | 无 | 无（有 installed_revision） | 有（`sha256:`） | 无 |
| 依赖检查 | 有（SemVer 图 + 传递依赖） | 有（元数据级 + 租约） | 无 | 有（声明 + 版本解析） | 无 | 无 | 有（install_plan） | 有（声明，不解析） |
| 仅管理元信息 | 是 | 是 | 是（含大量平台功能） | 是 | 是 | 是 | 是（含审计部署） | 是 |
| 对外交互 | CLI（+ `--json`） | CLI（`--json/--yes/--machine`）+ TUI | GUI + CLI | CLI | CLI + Web | 脚本 + SKILL.md 指令 | GUI + CLI + Web | 生成清单给宿主 |
| 备份/导入导出 | `env` 可移植定义根 | `export` / `import` | GitHub 备份 + 合并 | registry + `publish` | registry 远端 | 备份目录 + 手动恢复 | Kit 包（zip + manifest） | git 镜像 |
| 许可证 | MIT | MIT | MIT | Apache-2.0 | MIT（README 声明） | MIT | Apache-2.0 | Apache-2.0 |

#### 关键结论

1. **索引形态分两种流派**：单文件清单（agentpack / OpenPackage / EfanWang / n-skills）与「目录即索引 + 状态文件」（asm / xingkongliang）。前者更适合可复现与 code review，后者更适合频繁变动的本地环境。推荐混合：单文件 registry 为事实源，目录实时扫描只用于对账与发现孤儿。
2. **启用/禁用三种实现各有取舍**：宿主原生开关（claude-plugins 的 `settings.json`）最语义化但强绑定宿主；改名（asm 的 `.disabled`）最通用但有 hack 味；声明式 selector（agentpack 的 `[modes]`）最适合可复现环境。推荐以 registry 的 `state` 字段为唯一事实源，再按适配器能力选择落地方式。
3. **哈希校验只在两个项目出现**（agentpack、HarnessKit），而这两个项目的可信度恰恰最高。这是 skill-manager 必须补的一课。
4. **YAML 是元数据事实标准的默认选择**（TOML 只有 agentpack 用，JSON 是 Claude 插件生态的历史包袱），符合「基于 YAML 配置」的偏好。

### 4.2 可直接复用的设计思路清单

**A. 拿来即用（结构可直接照搬）**

1. `SKILL.md` frontmatter 的字段白名单与校验规则（来自 `agentskills/agentskills` 的 `validator.py`）：六个合法字段、name 全小写 kebab-case、不超过 64 字符、目录名必须等于 name、description 不超过 1024、compatibility 不超过 500。
2. 来源三态模型（来自 `EfanWang/skills-manager`）：`remote`（有来源）/ `local`（用户私有）/ `unclaimed`（未知来源），把「来源未知」当一等公民。
3. 外部来源清单字段集（来自 `numman-ali/n-skills`）：`name / description / source{repo,path,ref} / target{category,path} / author / license / homepage / verified`。
4. Kit manifest 字段集（来自 `RealZST/HarnessKit` 的 `manifest.rs`）：`format_version / id / name / description / created_at / exported_from / items[]{name,kind,source_url,content_hash,asset_path,position,source_revision,source_branch} / secrets_stripped[]`。
5. 最小技能索引结构（来自 `udapy/rust-agentic-skills`）：`{id, name, description, path, entrypoint}`。
6. 插件分组清单（来自 `anthropics/skills`）：`{name, owner, metadata{description,version}, plugins[]{name, description, source, skills[]}}`。
7. 原子替换 + 备份 + 回滚流程（来自 `EfanWang/skills-manager`）：临时目录写入 -> 校验 -> rename 替换 -> 失败回滚到备份。
8. 结构化退出码（来自 `EfanWang/skills-manager`）：输入错误 / 配置损坏 / 远端失败 / 文件系统失败 分码。
9. 迁移前自动备份 + 幂等迁移（来自 `RealZST/HarnessKit`）。

**B. 稍加改造（结构好，需适配我们的场景）**

10. workspace 索引的映射结构（来自 `enulus/OpenPackage`）：`files: { registry-key: [installed-path] | [{target, merge, keys}] }`。有了它，卸载才能精确回滚而不误删。
11. 可变源与不可变快照分离（来自 `enulus/OpenPackage`）：用户手写的 manifest 可变，锁定的快照只读。
12. manifest + lockfile 双层（来自 `OlegHQ/agentpack`）：把「用户意图」与「解析结果」分开，lock 里存 commit 与 content_hash。
13. 声明式启用/禁用预设（来自 `OlegHQ/agentpack` 的 `[modes]`）：`base = all | none` 加 `enable` / `disable` selector 列表。
14. 三件套命令语义（来自 `OlegHQ/agentpack`）：`--dry-run`（预演）/ `--verify-only`（只校验不写）/ `--repair`（重取并替换）。
15. provider 表（来自 `asm` 与 `claude-plugins`）：每个 agent 一条 `{name, label, global_path, project_path, enabled, capabilities}`，并允许 alias 收敛。
16. 双轨生成（来自 `numman-ali/n-skills`）：人写 YAML -> 生成宿主消费的 JSON 清单，避免手工漂移。
17. `--json / --yes / --machine` 三条输出通道（来自 `asm`）。
18. 本地库 + 按需激活（来自 `asm` 的 `library` + `activate`）：install once，activate per provider。
19. Kit 导出时剥离密钥并记录 `secrets_stripped`（来自 `HarnessKit`）。
20. `verified` 与 `curated` 正交双旗 + 发布隔离（来自 `tons-of-skills-marketplace`）。

**C. 只借思想（形态不同，理念可用）**

21. 渐进式披露：只加载 name + description，正文按需（来自 `agentskills` 规范与 `local-skills-mcp`）。
22. MCP 工具面三函数：`get` / `validate` / `evaluate`（来自 `local-skills-mcp`）。
23. 让 agent 通过 CLI 反向管理，而不是直接写目录（来自 `xingkongliang` 的 `manage-skills`）——这样元数据不会被绕过。
24. 契约式 schema 校验（来自 `tons-of-skills-marketplace` 的 `skill-contract.schema.json`）。
25. 每个 harness 一个适配目录的移植契约（来自 `obra/superpowers` 的 `porting-to-a-new-harness.md`）。
26. 审计规则插件化（来自 `HarnessKit` 的 `auditor/rules/*`）。
27. 内容寻址缓存 + cache_key（来自 `agentpack`）。

### 4.3 坑点 / 风险清单（不适合我们项目的设计）

| 坑点 | 出现在 | 为什么对我们是坑 | 建议 |
|---|---|---|---|
| 集中式巨型 JSON 索引 | `buzhangsan`（42MB 单文件）、asm 的 catalog 目录 | 更新粒度粗、并发写风险高、加载慢、git diff 不可读 | 索引分片（每来源一个文件）+ 懒加载 + 增量更新；大索引只用于远端 marketplace |
| 索引靠实时扫描文件系统 | `asm` | 已安装清单每次都要扫盘，规模上去很慢，且状态无法审计 | 持久 registry 为事实源，扫描只用于对账 |
| 用 SQLite 作为唯一事实源 | `HarnessKit` | 用户读不到、git 无法 review、迁移有风险，与 YAML 配置化诉求冲突 | YAML/JSON 为主，DB 仅作可选缓存层 |
| 禁用靠改文件名 | `asm` | 语义隐式，对不识别 `.disabled` 的 agent 行为不一致，易被其他工具误判 | 状态存 registry 的 `state` 字段，落地方式按适配器能力分级降级 |
| 元数据字段平铺在 frontmatter 顶层 | `buzhangsan`（`version`/`author`/`tags`/`requirements`） | 违反 agentskills 白名单，严格校验的客户端会判为非法 | 自研字段一律放 `metadata:` 下 |
| 弱校验（只看文件存在与非空） | `claude-plugins` | 装进来的技能可能缺字段、内容被篡改、来源不可追溯 | 上 schema 校验 + content_hash + 来源必填 |
| 远端唯一索引、离线不可用 | `claude-plugins` | 断网完全不可用，registry 挂掉整个工具瘫痪 | 本地缓存 + 可选远端刷新 + 离线只读 |
| 手工维护多份宿主清单 | `obra/superpowers` | 多份清单必然漂移，改一处忘一处 | 由统一 manifest 渲染各宿主清单 |
| 巨型仓库 + 十几套校验脚本 + 一堆 CI 工具 | `tons-of-skills-marketplace` | 维护成本远超收益，新人无法上手 | 只保留 1 套 schema 校验 + 1 个 catalog 不变式校验 |
| Agent 直接往 agent 目录写文件 | 多数项目的默认行为 | 绕过管理器，元数据失真（来源丢失、更新跟踪失效） | 所有写入必须经由管理器，给 agent 只暴露 CLI/MCP |
| 安装即执行第三方脚本 | 行业通病 | 供应链攻击面 | 安装只做元数据与文件落位 + 静态安全扫描，执行需显式确认 |
| 无来源记录（provenance） | `cchao123`、`buzhangsan` | 后续无法做更新检查、无法做安全验证、无法复现环境 | 来源 URL + commit + content_hash 必填，缺失即标记 `unclaimed` |
| 直接覆盖更新导致本地改动丢失 | 常见 | 用户手改的技能被静默覆盖 | 更新前检测本地漂移（哈希比对），把覆盖做成显式选项 |
| symlink 无 fallback | `awesome-skills/agent-skills-manager` | Windows 权限、部分 agent 不跟随 symlink，技能会不可见 | symlink + copy 双模式，能力探测后自动降级 |
| 核心定位漂移（塞入 proxy、自动更新、合并引擎） | `agentpack` 的 `--proxy`、`xingkongliang` 的自动更新 | 「只管理元信息」的项目会迅速膨胀成平台，维护带宽被打爆 | 明确划线：管理元信息与文件编排，不做运行时、不做自动更新引擎 |
| 只支持单一 host（仅 github.com） | `agentpack` | 限制来源多样性（gitlab、本地 tar、私有 registry） | 来源做成 `{type, locator, ref}` 的可扩展结构 |

---

### 4.4 推荐 skill-manager 采纳的方案

#### 4.4.1 目录结构

```
skill-manager/
  README.md  LICENSE  CHANGELOG.md
  pyproject.toml            # 或 package.json —— 由实现语言决定

  src/skillmanager/
    cli/                    # 命令层：只做参数解析与输出编排
      __main__.py
      commands/{add,remove,list,inspect,enable,disable,
                validate,doctor,sync,export,import,index}.py
    core/                   # 领域层：无 I/O 副作用，可单测
      manifest.py           # SKILL.md frontmatter 读写
      schema.py             # 字段白名单与约束（对齐 agentskills 规范）
      registry.py           # 注册表读写（唯一事实源）
      lockfile.py           # 锁定快照读写
      index.py              # 索引构建与查询
      lifecycle.py          # install/enable/disable/uninstall/update 编排
      integrity.py          # content_hash 计算与比对
      dependency.py         # 依赖图与约束求解
      backup.py             # export/import（Kit 模型）
      errors.py             # 结构化错误码
    adapters/               # 每个 agent 一个适配器
      base.py               # 能力声明：支持 symlink？支持原生开关？路径？
      agents_shared.py      # .agents/skills
      claude_code.py  codex.py  cursor.py  opencode.py  ...
    store/                  # 文件系统与原子操作
      atomic.py             # 原子写 / 原子替换 / 备份回滚
      paths.py              # 路径解析与越界防护
      lock.py               # 文件锁
    output/                 # 输出层
      human.py  json_out.py  machine.py

  schemas/                  # JSON Schema（供外部校验与 IDE 提示）
    skill-frontmatter.schema.json
    registry.schema.json
    lock.schema.json
    kit.schema.json

  docs/
    specification/          # 自研规范（对齐 agentskills）
    research/               # 本报告

  tests/
    fixtures/               # 正例与反例的 SKILL.md 与 registry
```

设计要点：

- **`core` 与 `adapters` 分离**：所有 agent 差异只存在于 `adapters/`，核心逻辑不感知具体 agent（借鉴 agentpack 的 `internal/harness/` 与 HarnessKit 的 `adapter/`）。
- **`output` 单列**：一处决定人类可读 / JSON / TSV 三种输出，避免命令层各写各的（借鉴 asm 的 `formatter-*`）。
- **`store/atomic.py` 集中所有破坏性操作**：原子写、原子替换、备份、回滚只在一个文件里实现（借鉴 EfanWang 的 `_common.py`）。
- **`schemas/` 与 `docs/specification/` 先行**：规范与校验规则先落地再写实现（借鉴 OpenPackage 的 `specs/` 与 tons-of-skills 的 schema）。

#### 4.4.2 YAML 元数据设计

分三层，每层职责单一。

**第一层：技能自身元数据 `SKILL.md`（严格对齐 agentskills 规范，不自造顶层字段）**

```yaml
---
name: code-review              # 必填，小写 kebab-case，<=64，必须等于目录名
description: >                 # 必填，<=1024；写清「做什么」+「何时使用」
  Review a code change for correctness, style and risk. Use when the user asks
  for a code review, a diff review, or pre-merge checks.
license: MIT                   # 可选
compatibility: Claude Code >= 2.0, Codex CLI   # 可选，<=500
allowed-tools: Bash Read Grep  # 可选（实验性）
metadata:                      # 自研扩展全部放这里
  version: 1.2.0
  author: yourname
  homepage: https://github.com/you/code-review
  tags: [review, quality]
  requires:
    skills: [diff-parser >= 1.0]
    runtime: { node: ">=22" }
---
```

**第二层：管理器注册表 `.skillmanager/registry.yml`（唯一事实源，人可读可 review）**

```yaml
registry_version: 1
tool_version: 0.1.0
generated_at: 2026-10-12T10:00:00Z

settings:
  install_mode: copy            # copy | symlink | auto
  default_scope: global         # global | project

agents:                         # provider 表（借鉴 asm 与 claude-plugins）
  claude:
    label: Claude Code
    global_path: ~/.claude/skills
    project_path: .claude/skills
    capabilities: { symlink: true, native_toggle: true }
    enabled: true
  codex:
    label: Codex CLI
    global_path: ~/.codex/skills
    project_path: .agents/skills
    capabilities: { symlink: true, native_toggle: false }
    enabled: true
  cursor:
    label: Cursor
    global_path: ~/.cursor/rules
    project_path: .cursor/rules
    capabilities: { symlink: false, native_toggle: false }
    enabled: false              # 需要时再开

skills:                         # 每个技能一条记录
  code-review:
    dir: ~/.skillmanager/library/code-review     # 中心库中的原件路径
    version: 1.2.0
    state: enabled              # enabled | disabled
    source:                     # 来源三态：remote | local | unclaimed
      type: git                 # git | local | archive | registry | unclaimed
      url: https://github.com/you/code-review
      ref: main                 # branch / tag
      commit: 9b58c1ffb790c075ca32e70a89cf1d80588f4abf
      subpath: skills/code-review
    integrity:
      content_hash: sha256:1f0482bf822835d19552487a2a6345735cdffa0d
      verified_at: 2026-10-12T10:00:00Z
    license: MIT
    tags: [review, quality]
    dependencies:
      skills: [diff-parser >= 1.0]
      runtime: { node: ">=22" }
    installed_at: 2026-10-01T08:00:00Z
    updated_at: 2026-10-12T10:00:00Z
    targets:                    # 分发到哪些 agent
      claude:
        scope: global
        mode: symlink           # symlink | copy
        path: ~/.claude/skills/code-review
        enabled: true
        file_map:               # 借鉴 OpenPackage：包内路径 -> 实际落盘路径
          SKILL.md: [~/.claude/skills/code-review/SKILL.md]
          scripts/:
            - target: ~/.claude/skills/code-review/scripts/
              merge: replace
      codex:
        scope: project
        mode: copy
        path: .agents/skills/code-review
        enabled: false
        file_map:
          SKILL.md: [.agents/skills/code-review/SKILL.md]
```

**第三层：锁定快照 `.skillmanager/registry.lock.yml`（机器生成，只读，用于可复现与漂移检测）**

```yaml
lock_version: 1
generated_at: 2026-10-12T10:00:00Z
entries:
  - id: code-review
    commit: 9b58c1ffb790c075ca32e70a89cf1d80588f4abf
    content_hash: sha256:1f0482bf822835d19552487a2a6345735cdffa0d
    resolved: { source_url: https://github.com/you/code-review, ref: main }
    targets:
      - agent: claude
        scope: global
        mode: symlink
        path: ~/.claude/skills/code-review
        files: { SKILL.md: sha256:aaa..., scripts/run.sh: sha256:bbb... }
```

设计要点：

- **可变与不可变分离**：`registry.yml` 用户可编辑（可加注释、可调 `enabled`、可改 `mode`）；`registry.lock.yml` 只由工具写，用于比对与复现（借鉴 OpenPackage 的 mutable vs immutable，以及 agentpack 的 manifest + lock）。
- **`state` 是启用/禁用的唯一事实源**，`targets.<agent>.mode` 决定落地方式（symlink / copy），`file_map` 保证卸载能精确回滚（借鉴 OpenPackage 的索引映射）。
- **`source.type = unclaimed`** 是一等状态（借鉴 EfanWang），缺失来源不被当成错误，而被当成待补全项。
- **`integrity.content_hash`** 必填，安装、更新、校验三处统一比对（借鉴 agentpack 与 HarnessKit）。
- **自研字段一律不进 frontmatter 顶层**（`metadata:` 承载 version / author / tags / requires），保证与 agentskills 生态兼容。
- **序列化统一用 YAML**：符合「基于 YAML 配置」的偏好，且与 `SKILL.md` frontmatter 同语言，工具链统一。

---

#### 4.4.3 CLI 指令风格

**总体风格**

- `skill-manager <group> <verb> [args] [flags]`，组名与动词都用完整英文单词，不用缩写（借鉴 agentpack）。
- 机器可读输出永远是同一个 JSON 结构加稳定退出码（借鉴 EfanWang 与 asm）。
- 每条写操作命令都必须支持 `--dry-run`；每条命令都必须支持 `--json`；交互确认可用 `--yes` 跳过（借鉴 asm 与 agentpack）。
- 命令读起来像一句英文：`skill-manager enable code-review --agent claude`、`skill-manager export backup.skillkit --no-secrets`。

**命令面（建议的最小完整集）**

| 分组 | 命令 | 作用 | 关键 flag |
|---|---|---|---|
| 元信息 | `init` | 初始化 `.skillmanager/` | `--scope` `--agents` |
| | `config get/set` | 读写 settings 与 agents 表 | `--json` |
| 注册表 | `install <source>` | 登记来源、落库、分发 | `--target` `--mode` `--no-sync` `--dry-run` |
| | `remove <id>` | 按 file_map 精确反安装 | `--keep-library` `--dry-run` |
| | `update [id]` | 拉取新版本，检测本地漂移 | `--all` `--check` `--force` |
| | `list` | 列出已注册技能 | `--agent` `--state` `--tag` `--json` |
| | `inspect <id>` | 展示完整元数据与分发状态 | `--json` |
| 生命周期 | `enable <id>` / `disable <id>` | 改 `state` 并按适配器能力落地 | `--agent` `--scope` `--all` `--dry-run` |
| | `link <id>` / `unlink <id>` | 只做文件系统层面的分发与回收 | `--agent` `--mode` |
| 校验 | `validate [path]` | SKILL.md 规范校验（frontmatter 白名单 + 命名 + 长度 + 目录名） | `--json` `--strict` |
| | `verify` | 比对 content_hash，检测漂移与篡改 | `--agent` `--repair` |
| | `doctor` | 环境体检：缺目录、断链、孤儿、重复、依赖缺失 | `--json` |
| | `deps <id>` | 依赖图与冲突报告 | `--tree` `--json` |
| 索引 | `index build` / `index query` | 构建与检索本地索引 | `--source` `--tag` |
| 备份 | `export <file>` | 导出 Kit（manifest + content_hash + 剥离密钥） | `--include-config` `--no-secrets` |
| | `import <file>` | 导入 Kit，逐项校验后落位 | `--dry-run` `--on-conflict` |
| 检索 | `search <query>` | 在本地索引或远端 marketplace 检索 | `--local` `--json` |

**输出契约示例**

```json
{
  "ok": false,
  "command": "enable",
  "id": "code-review",
  "findings": [
    {
      "code": "TARGET_NOT_INSTALLED",
      "severity": "error",
      "source": "registry",
      "target": "claude/global",
      "message": "skill is not installed for claude/global",
      "remedy": "skill-manager install github:you/code-review --target claude"
    }
  ],
  "changes": [],
  "exit_code": 4
}
```

要点：`findings[]` 使用稳定 `code` + `severity` + `source` + `target` + `remedy`（借鉴 agentpack 的 preflight），让 agent 能自愈，而不必解析自然语言。

**退出码约定（借鉴 EfanWang）**

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用失败 / 校验未通过 |
| 2 | 输入错误 |
| 3 | 注册表或锁定文件损坏 |
| 4 | 远端操作失败 |
| 5 | 文件系统操作失败（含回滚后仍失败） |
| 6 | 依赖未满足 |

---

## 5. 附录：证据与复现方式

本报告的所有结论都来自对真实仓库的直接阅读，而非仅有 README 摘要。复现步骤：

```powershell
# 1) 关键词检索（GitHub Search API）
#    https://api.github.com/search/repositories?q=<keyword>&sort=stars&order=desc

# 2) 浅克隆候选仓库
git clone --depth 1 --single-branch https://github.com/<owner>/<repo>.git

# 3) 重点阅读的文件
#    OlegHQ/agentpack        docs/src/reference/{manifest-schema.md,cli.md}, pack.lock, schemas/*.json
#    luongnv89/asm           src/{config.ts,skill-state.ts}, src/utils/types.ts, src/commands/toggle.ts
#    xingkongliang/skills-…  src-tauri/src/core/{skill_metadata.rs,sync_engine.rs}, bin/skills-manager-cli.rs
#    enulus/OpenPackage      specs/package/package-index-yml.md, specs/directory-layout.md, schemas/*
#    Kamalnrf/claude-plugins packages/cli/src/core/settings.ts, packages/skills-installer/src/lib/client-config.ts
#    EfanWang/skills-manager scripts/sources.py, sources.json, SKILL.md
#    RealZST/HarnessKit      crates/hk-core/src/kits/manifest.rs, crates/hk-core/src/store/schema.rs
#    numman-ali/n-skills     sources.yaml, .claude-plugin/marketplace.json, scripts/update-registry.mjs
#    jeremylongshore/…       sources.yaml, skills.sh.json, schemas/canonical/v0/skill-contract.schema.json
#    agentskills/agentskills skills-ref/src/skills_ref/{models,validator,cli}.py
#    anthropics/skills       .claude-plugin/marketplace.json, template/SKILL.md
```

数据快照说明：star / fork / 最近推送时间取自 2026-10-12 的 GitHub API；仓库内容取自同日 `main`（或 `dev`）分支 HEAD。若后续结论与此处不符，以仓库最新状态为准。

---

## 6. 一页纸摘要

| 问题 | 结论 |
|---|---|
| 该抄谁 | 架构抄 `agentpack`，命令面抄 `asm`，索引文件抄 `OpenPackage`，备份模型抄 `HarnessKit`，来源清单抄 `n-skills`，工程纪律抄 `EfanWang` |
| 规范怎么对齐 | 严格遵守 `agentskills` 六字段白名单；自研字段全部放 `metadata:` |
| 索引怎么存 | `registry.yml`（人可读，唯一事实源）+ `registry.lock.yml`（机器生成，只读）；不给每个技能目录塞私有索引文件 |
| 启用/禁用怎么做 | registry 的 `state` 字段为唯一事实源；落地方式按 agent 能力降级（原生开关 -> 改名 -> 移出目录） |
| 校验做哪些 | frontmatter schema（白名单 + 命名 + 长度 + 目录名一致）、content_hash 完整性、依赖存在性与环检测、锁定文件一致性 |
| 依赖怎么做 | 只做元数据级依赖图与冲突报告，不自动执行外部安装 |
| 交互怎么设计 | 一组 CLI（`--json/--yes/--dry-run`）+ 稳定退出码；可选加一个 MCP 三函数接口（get/validate/evaluate） |
| 最该避开的坑 | 单文件巨型索引、实时扫描当事实源、SQLite 当唯一事实源、改文件名当启用开关、frontmatter 顶层自造字段、弱校验、定位漂移 |
