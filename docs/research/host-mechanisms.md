# skill-manager 宿主机制调研（M5 宿主适配层前置）

| 项目 | 内容 |
|---|---|
| 文档名称 | 宿主机制调研（各 agent 宿主的 skill / 插件机制现状） |
| 文档路径 | `docs/research/host-mechanisms.md` |
| 文档状态 | **调研快照 + 补记**（初始核验 2026-10-15；同日补记见 2.5、6.1、6.2、6.3 的「补记」段） |
| 用途 | 需求文档 9.3.6「M5 宿主适配层（可适配性）」的实施前置：为适配器设计提供事实基础 |
| 关联文档 | [`docs/requirements.md`](../requirements.md) 第 9.3.6 节、[`docs/specification/skill-meta-spec.md`](../specification/skill-meta-spec.md) |

> 本文档只记录事实与可行性初判，**不含任何代码、适配器实现或配置**。文档按「调研快照 + 补记」维护：原始事实结论一旦登记（或经裁决）**不再就地改写**，后续证据与状态变化一律以**补记**承接，保证可追溯。

> **补记（2026-10-15，同日）**：豆包机制已补齐一手证据——**本环境实测**到 agent 模式工作区的技能加载机制（`.skills/<技能标识>/SKILL.md`，本机实测 141 个技能目录、frontmatter 为 `name` / `description` 形态），见 2.5 补记。2.5 原始结论（「未查到」）保留不改，其背景是当日探测位置有误（客户端安装目录）与公开渠道无文档。首批适配器名单等范围结论以 6.2 裁决登记为准。

---

## 0. 调研方法、证据纪律与图例

### 0.1 证据等级

| 等级 | 含义 |
|---|---|
| **[已查证]** | 官方规范文档、官方标准站点，或本机实测（可复现的路径与命令） |
| **[一方称]** | 单一非官方来源：博客、第三方汇总、搜索摘要 |
| **[待确认]** | 本次未取得可引用证据，列为待确认项 |

### 0.2 结论三态

对「宿主是否有正式机制」这一问题，结论只允许以下三态，且必须区分：

1. **确认有**：取得官方文档或本机实测证据；
2. **确认无**：取得足以排除的官方文档证据（例如官方文档体系内不存在该概念）；
3. **未查到**：未取得证据，不等于「无机制」；须同时给出「待确认事实点 + 确认方法」。

### 0.3 本次调研的证据来源与访问限制

| 来源 | 类型 | 访问结果 |
|---|---|---|
| `agentskills.io`（Agent Skills 开放标准：概览 / 规范 / 客户端清单） | 官方标准站 | 可访问（规范与客户端清单可取到完整文本） |
| `docs.claude.com`（Claude Code skills 文档，Markdown 形态） | 官方文档 | 可访问 |
| `docs.claude.com/en/docs/agents-and-tools/agent-skills/overview` | 官方文档 | **受区域限制**（返回「App unavailable in region」空壳页） |
| `cursor.com/docs/context/rules`、`cursor.com/docs/context/skills` | 官方文档 | 可访问 |
| `agents.md` | 官方格式站点 | 可访问 |
| `api-docs.deepseek.com`（含 sitemap 与 Agent Integrations） | 官方文档 | 可访问 |
| `developers.openai.com/codex/**` | 官方文档 | 命令行侧 **403**；**2026-10-16 经浏览器会话取证可达**——该地址重定向到 `learn.chatgpt.com/docs/build-skills`（`.md` 形态可取全文），规范细节已取得，见 6.3 补记（2026-10-16） |
| `www.doubao.com`（官网 / 应用页） | 官方站点 | 可访问，但为前端渲染页，正文不可提取 |
| 搜索引擎（Bing 可用 / DuckDuckGo 不可达） | 检索 | 豆包相关查询仅返回入口页与百科类结果 |
| 本机已安装宿主（Codex、Claude、豆包） | **本机实测** | 可访问（路径见各事实卡） |

### 0.4 本机实测的复现方式

实测均在 Windows 本机的用户目录下进行，核心命令形态（只读列出与读取）：

- `Get-ChildItem $env:USERPROFILE\.codex\skills`（Codex 用户技能目录）
- `Get-Content $env:USERPROFILE\.codex\skills\<名称>\SKILL.md`（技能文件头部）
- `Get-ChildItem $env:USERPROFILE\.codex\plugins\cache -Recurse -Depth 2`（插件缓存与包结构）
- `Get-Content ...\.codex-plugin\plugin.json`（插件清单）
- `Get-ChildItem $env:LOCALAPPDATA\Doubao -Recurse -Depth 3 | Where-Object { $_.Name -match 'skill|plugin|mcp' }`（豆包客户端关键字探测）

---

## 1. 摘要表

| 宿主 / 标准 | 机制形态 | 证据等级 | 是否需适配器 | 映射复杂度 |
|---|---|---|---|---|
| **Agent Skills 开放标准**（基准，非宿主） | SKILL.md + YAML frontmatter 的开放标准，40+ 客户端声明支持 | [已查证] | —（作为映射基准） | — |
| **Claude**（Claude Code / Claude 平台） | 正式 skill 机制（SKILL.md），标准的最大实现者，含 Claude Code 扩展字段与插件体系 | [已查证] | 需要 | **低** |
| **Codex**（ChatGPT & Codex） | 正式 skill 机制（SKILL.md）+ 插件包机制（清单 + skills + assets + MCP/应用配置） | [已查证·本机实测] + [已查证·标准站收录] | 需要 | **中**（规范细节待确认） |
| **Cursor** | 正式 skill 机制（SKILL.md，多根目录，**并兼容读取 Claude 与 Codex 的 skills 目录**）+ 规则文件机制（`.cursor/rules/*.mdc`、`AGENTS.md`）+ 插件 | [已查证] | 需要 | **低**（skills 路径）/ 中（规则路径） |
| **通用 AGENTS.md** | 开放纯 Markdown 约定（无 frontmatter），由 Agentic AI Foundation（Linux Foundation）治理 | [已查证] | 需要（作为降级载体） | **中** |
| **豆包（Doubao）** | **未查到**公开发布的 skill / 插件机制规范；客户端存在 MCP 辅助组件 | [待确认] | 待定 | **未知** |
| **DeepSeek** | **确认无**（官方文档体系内不存在 skill / 插件概念）；官方定位为模型提供方，提供「把 DeepSeek 接入其他 agent 宿主」的集成文档 | [已查证] | 不适用（见 6.1） | **未知**（降级路径待定） |

一句话结论：**行业已在「skill 文件形态」上收敛到单一标准（Agent Skills / SKILL.md），本项目内部规范的宿主可见面与该校验字段几乎一一对应**；因此 M5 的主要工程不是「为每个宿主写一套格式」，而是**字段裁剪、落位根绑定、以及为无 skill 机制的宿主提供规则文件降级**。真正的事实缺口集中在豆包与 DeepSeek，以及 Codex 的官方规范细节（自本环境不可访问）。

> **补记（2026-10-15）**：上表有两行已被后续证据更新，**以补记与裁决登记为准**——豆包一行（原「未查到」→ 经本环境实测确认有正式 skill 机制，见 2.5 补记）；首批名单（原建议 → 以 6.2 裁决登记的名单为准，Codex 纳入、DeepSeek 登记为不适用 / 模型提供方）。

---

## 2. 逐宿主机制事实卡

### 2.1 事实卡 A：Agent Skills 开放标准（基准）

1. **机制形态结论**：**确认有**。Agent Skills 是「给 AI agent 增加能力」的开放标准，官方文档原话为：该格式**最初由 Anthropic 开发、作为开放标准发布，并已被越来越多的 agent 产品采用** [已查证]（`agentskills.io` 概览页）。
2. **官方规范引用**：`https://agentskills.io/specification`（规范）、`https://agentskills.io/clients`（客户端清单）、文档索引 `https://agentskills.io/llms.txt`。规范未标注版本号，属**持续演进**状态 [已查证]。
3. **格式规范细节** [已查证]：
   - 目录结构：`SKILL.md` **必需**（元数据 + 指令），`scripts/`、`references/`、`assets/` 可选，允许任意附加文件与目录；
   - frontmatter 字段：`name`（必填，≤64 字符，小写字母 / 数字 / 连字符，不得以连字符开头或结尾，不得含连续连字符，**必须与父目录名一致**）、`description`（必填，1–1024 字符）、`license`（可选）、`compatibility`（可选，≤500 字符）、`metadata`（可选，字符串键值映射）、`allowed-tools`（可选，实验性，空格分隔）；
   - 正文无格式限制；建议 `SKILL.md` 保持在 500 行以内，文件引用保持一层深度；
   - 渐进披露三层：元数据（约 100 token，启动时加载全部技能的 name/description）→ 正文（激活时加载）→ 资源（按需加载）；
   - 提供参考校验库 `skills-ref`（`skills-ref validate ./my-skill`）。
4. **客户端清单**：官方清单页列出 40 余个客户端，含 Claude Code、Claude、**ChatGPT & Codex**、Cursor、VS Code、GitHub Copilot、Gemini CLI、OpenCode、TRAE（字节跳动）、Kiro、Factory、Roo Code、Goose、Tabnine、Junie、Amp、OpenHands、OpenClaw、Hermes Agent 等 [已查证]。**清单中未出现豆包，也未出现 DeepSeek**。
5. **本机可观测证据**：不适用（标准无本地形态）。
6. **与内部规范的差异与可映射性初判**：内部规范的 `SKILL.md` 字段集（名称 / 描述 / 许可证 / 兼容性 / 允许工具 / 扩展元数据）与该标准字段集**同构**（见第 4 节）。差异只有两点：内部把自研字段收进扩展元数据映射（标准的 `metadata` 正为此设计）；内部另有 `skill_meta.yaml` 承载管理器元数据，标准无对应概念（属管理器侧，不进入宿主格式）。

### 2.2 事实卡 B：Claude（Claude Code / Claude 平台）

1. **机制形态结论**：**确认有正式 skill 机制** [已查证]（官方文档与标准客户端清单双重来源）。
2. **官方规范引用**：
   - `https://docs.claude.com/en/docs/claude-code/skills`（Claude Code skills，文档含「Frontmatter reference」全表）；
   - 客户端清单指向 `https://code.claude.com/docs/en/skills`（Claude Code）与 `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview`（Claude 平台）；
   - 文档明示：Claude Code skills **遵循 Agent Skills 开放标准**，并在此基础上扩展 [已查证]。
3. **格式规范细节** [已查证]：
   - 载体：`SKILL.md`，YAML frontmatter（`---` 包裹，且**必须位于文件第一行**）+ Markdown 正文；frontmatter 解析失败时技能仍加载但字段为空；
   - 字段（**全部可选**，仅 `description` 被推荐）：`name`、`description`、`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context`、`agent`、`background`、`hooks`、`paths`、`shell`、`metadata`、`license`、`compatibility`；**不认识的字段被静默忽略**（不报错）；
   - **跨产品分发时只允许 6 个字段**：`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`——用于 claude.ai 上传、Skills API 与 `package_skill.py` 打包；出现标准外字段会**硬失败**（文档给出实际报错文本）；
   - 命令名派生规则：目录名或 frontmatter `name`；插件技能带插件前缀；`.claude/commands/*.md` 为旧格式（自定义命令已并入技能）；
   - 保留名：`synced`（claude.ai 同步技能占用）、`anthropic-skills` 前缀；名字含零宽字符、控制字符、`<`、`>` 等会导致命令名被拒绝；
   - 附属文件：技能目录可含脚本 / 参考 / 资源（文档小节「Add supporting files」）；
   - 动态注入与替换：`` !`command` `` 内联执行、`$ARGUMENTS` / `$0..$N` / `$name` / `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_SESSION_ID}` / `${CLAUDE_PLUGIN_ROOT}` 等；
   - 另有 `disableBundledSkills`、`skillOverrides`（可见性覆盖）等设置；技能可通过 `context: fork` 在子代理中运行。
4. **加载目录与发现规则** [已查证]：企业级（managed settings 目录）→ 个人级 `~/.claude/skills/<名称>/SKILL.md` → 项目级 `.claude/skills/<名称>/SKILL.md` → 嵌套 `<子目录>/.claude/skills/...` → 附加目录（`--add-dir`）→ 插件 `<plugin>/skills/<名称>/SKILL.md`（命令带 `插件名:` 前缀）→ claude.ai 账号同步（落于 `~/.claude/skills/synced/`）。允许符号链接；插件体系另有 `.claude-plugin/plugin.json`。
5. **能力边界**：宿主侧能力丰富（自动 / 手动调用控制、子代理执行、动态上下文注入、工具预授权、技能作用域 `paths`），但**这些都是 Claude Code 扩展**，不属开放标准；跨产品路径只有 6 个字段可用 [已查证]。
6. **本机可观测证据**：本机存在 `C:\Users\HW\.claude`（Claude Code 的用户目录：`settings.json`、`sessions/`、`projects/`、`backups/`、`ide/`），但**无 `skills/` 子目录** [已查证·本机实测]——即本机装了 Claude Code 但未放置任何技能。
7. **与内部规范的差异与可映射性初判**：**可映射性最高**。内部 6 个宿主可见字段可直接落到标准 6 字段；Claude Code 扩展字段属「可选增强」，默认不渲染仍是合法技能。需注意：内部 `trigger_keywords` 无对应字段（可并入 `description`，注意 1024 字符上限与 Claude Code 列表截断 1536 字符）。

### 2.3 事实卡 C：Codex（ChatGPT & Codex）

1. **机制形态结论**：**确认有正式 skill 机制，且有独立的插件包机制** [已查证·本机实测 + 标准站收录]。**更正**：需求文档 9.3.6 表中把 Codex 记为「机制形态未知」，事实不支持该保守判断，应提升为「确认有机制」。
2. **官方规范引用**：
   - Agent Skills 官方客户端清单收录条目「ChatGPT & Codex」，指向 `https://developers.openai.com/codex/skills/` [已查证]；
   - 该官方页面**自本环境返回 403**（2026-10-15）；**更正（2026-10-16）**：该地址经浏览器会话取证可达并重定向到 `https://learn.chatgpt.com/docs/build-skills`，规范细节（必需字段、可选元数据、加载位置、重名行为、禁用表达、上下文预算）已取得，见 6.3 补记（2026-10-16）[已查证·浏览器一手]；
   - 应用内自带文档（随桌面应用分发的 `openai-docs` 技能参考）把 Skill 与 Plugin 定义为两类不同表面：**Skill** = 可复用工作流（可含参考文件与脚本）；**Plugin** = 可安装的捆绑包，可含 skills、工具、命令、MCP 配置、hooks、apps、assets 与相关元数据 [已查证·本机实测]。
3. **格式规范细节** [已查证·本机实测]：
   - 载体：`SKILL.md`，YAML frontmatter + Markdown 正文；本机实测到的字段包括 `name`、`description`（可为多行块）、`metadata`（含 `short-description`）、`compatibility`、`allowed-tools`（示例：`allowed-tools: Bash`）；
   - 技能目录内可出现 `agents/<名称>.yaml`，声明界面呈现信息（`display_name`、`short_description`、`icon_small`、`icon_large`、`default_prompt`）——属 **Codex 侧扩展**，非标准字段；
   - 插件包结构 [已查证·本机实测]：`<插件根>/{.codex-plugin/plugin.json, .app.json, .mcp.json, skills/, assets/}`；
   - 插件清单 `plugin.json` 字段：`name`、`version`、`author.name`、`description`、`skills`（技能目录路径）、`apps`（应用配置路径）、`interface{displayName, shortDescription, longDescription, category, capabilities, composerIcon, logo, defaultPrompt, developerName, websiteURL, privacyPolicyURL, termsOfServiceURL, supportURL}`；
   - `.app.json` 登记连接器（connector）标识，`.mcp.json` 登记 MCP 服务——即插件可同时携带技能与连接能力。
4. **加载目录与发现规则** [已查证·本机实测]：用户级技能目录为 `~/.codex/skills/<名称>/SKILL.md`；插件包位于 `~/.codex/plugins/cache/<来源市场>/<插件名>/<版本>/skills/<技能名>/SKILL.md`；本机同一目录下另有 `~/.codex/AGENTS.md`（全局代理指引）、`rules/`、`config.toml` 等。**未取得的证据**：目录优先级、项目级技能目录、插件启用与 marketplace 解析规则的官方说明 [待确认]。
5. **能力边界**：具备技能发现 / 自动激活、插件（含 MCP 与外部应用 connector）、hooks、自动化等表面；技能与插件可组合分发（插件内含多个技能）。跨平台分发时是否只接受标准的 6 个字段**未知** [待确认]。
6. **本机可观测证据**：
   - `C:\Users\HW\.codex\skills` 下 21 个技能目录（含 `.system`）、每个含 `SKILL.md`；
   - `C:\Users\HW\.codex\plugins\cache\openai-api-curated\<插件>\<版本>` 下打包的插件，例如 `canva/5fd93af4` 含 8 个技能与 `.codex-plugin/plugin.json`；
   - 本会话注入的技能根表把插件技能映射为 `...\plugins\cache\...\<版本>\skills\<技能名>`，与实测结构一致。
7. **与内部规范的差异与可映射性初判**：技能文件层面与内部规范同构（见第 4 节），映射复杂度**中**——风险不在格式，而在「官方规范细节不可取证」（字段全集、目录优先级、跨平台字段限制）。**注意**：插件机制与 M5 的「内置适配器」是两回事（M5 只做内置适配器，第三方可加载能力归 M4b），此边界须在设计阶段保持。

### 2.4 事实卡 D：Cursor

1. **机制形态结论**：**确认有正式 skill 机制**（并**兼容读取 Claude 与 Codex 的技能目录**），同时保留规则文件机制 [已查证]。**更正**：需求文档 9.3.6 把 Cursor 归入「机制相对确定者」是正确的，但归类为「仅规则文件」的隐含假设不成立——Cursor 现在同时具备 skill 与规则两条路径。
2. **官方规范引用**：`https://cursor.com/docs/context/skills`（Skills）、`https://cursor.com/docs/context/rules`（Rules）；Agent Skills 客户端清单收录 Cursor，指向前者 [已查证]。
3. **格式规范细节** [已查证]：
   - **Skills**：每个技能是含 `SKILL.md` 的文件夹（`name`、`description` 为基本字段；另有 `paths`（`globs` 为兼容旧字段）、`icon`、`color`）；支持 `scripts/` 等附属目录与渐进加载；技能目录可嵌套分类目录（身份取自含 `SKILL.md` 的那一层）；仓库内任意层级的 `.cursor/skills/`、`.agents/skills/` 都会被递归发现，嵌套技能自动按目录作用域生效；
   - **补充（2026-10-16，官方「Frontmatter 字段」表复核）**：`name`（必填；仅小写字母 / 数字 / 连字符，且**必须与父文件夹同名**）、`description`（必填）、`paths`（可选；glob，逗号分隔字符串或列表；旧 `globs` 为后备）、**`disable-model-invocation`（可选；`true` 时仅 `/skill-name` 显式调用，模型不按上下文自动应用）**、`icon`（可选）、`color`（可选；枚举 `default` / `green` / `cyan` / `blue` / `purple` / `magenta` / `orange` / `yellow` / `red` / `brand`）、`metadata`（可选；任意键值映射）[已查证·浏览器一手]；
   - 内置命令：`/create-skill`、`/create-rule`、`/migrate-to-skills`（把「动态规则」与斜杠命令迁移为技能；`alwaysApply: true` 或带具体 globs 的规则**不迁移**）；
   - **Rules**：项目规则位于 `.cursor/rules/`，**必须是 `.mdc` 扩展名**（`.md` 被忽略，因缺少 `description` / `globs` / `alwaysApply` frontmatter）；frontmatter 三要素 `description`、`globs`、`alwaysApply` 决定作用方式；规则来源优先级为 **Team Rules → Project Rules → User Rules**，冲突时以靠前者为准；
   - 另有插件体系（Customize → Plugins）。
4. **加载目录与发现规则** [已查证]：技能根为项目级 `.cursor/skills/`、`.agents/skills/`，用户级 `~/.cursor/skills/`、`~/.agents/skills/`；**为兼容，Cursor 同时加载 `.claude/skills/`、`.codex/skills/`、`~/.claude/skills/`、`~/.codex/skills/`**；云代理只同步 `~/.cursor/skills/`（项目技能与其他位置不上云）。
5. **能力边界**：技能可绑定 Custom Mode（`icon` / `color` 呈现）；嵌套目录自动作用域；规则支持 glob 与「总是应用」两种强制形态；`AGENTS.md` 亦被支持（见第 3 节）。
6. **本机可观测证据**：本机**未安装** Cursor（无 `~/.cursor`、无 `%APPDATA%\Cursor`、无 `%LOCALAPPDATA%\Programs\cursor`）[已查证·本机实测]，故无本地一手结构证据。
7. **与内部规范的差异与可映射性初判**：skills 路径映射复杂度**低**（`name` / `description` 直接对应，`paths` 为宿主扩展，`allowed-tools` 未被文档列出→应视为不支持并登记）。**重要观察**：由于 Cursor 兼容读取 `.claude/skills/` 与 `.codex/skills/`，向 Claude / Codex 的落位根写入即可被 Cursor 同时识别——这既可能带来「一次落位多宿主生效」的便利，也可能造成重复识别与来源歧义，须在设计阶段明确每宿主的落位根选择策略（见 4.5）。

### 2.5 事实卡 E：豆包（Doubao）

1. **机制形态结论**：**未查到**公开发布的 skill / 插件机制规范；**不等于「无机制」**，属「线索待确认」三态的中间态 [待确认]。
2. **官方规范引用**：**未取得**。可访问性说明：官网与应用页（`https://www.doubao.com/`、`/chat/`）均为前端渲染页，正文不可提取；Bing 检索（含 `site:` 限定）只返回入口页、百科与第三方导航站结果，未出现任何技能 / 插件机制的官方文档入口；DuckDuckGo 自本环境不可达 [已查证·检索记录]。
3. **格式规范细节**：无证据。**特别说明**：需求文档 9.3.6 表中「豆包 = SKILL.md 体系（与 Claude 同源）」这一**前提本次未获任何证据支持**；Agent Skills 官方客户端清单中亦**不含**豆包。在该前提被一手证据证实之前，不应据此设计适配器。
4. **加载目录与发现规则**：无证据。
5. **能力边界**：无证据。
6. **本机可观测证据** [已查证·本机实测]：
   - 本机安装有豆包桌面客户端（`%APPDATA%\Doubao`、`%LOCALAPPDATA%\Doubao`）；用户配置文件记录的版本为 **2.25.16**；
   - 客户端目录内存在 **`mcp_helper.dll`、`mcp-helper.exe`**（`...\Doubao\Application\app\`）与 `...\User Data\Default\.doubao\agent_mode`，提示客户端具备 MCP 相关能力与「agent 模式」入口；
   - 深度 3 的文件名扫描**未见**任何 `skills/` 目录或 `SKILL.md` 类文件（命中的 `Extension Rules`、`Subresource Filter\Unindexed Rules` 属 Chromium 内部目录，与 agent 规则无关）。
7. **与内部规范的差异与可映射性初判**：**无法初判**。待确认事实点与确认方法见 6.3。

**补记（2026-10-15，本环境实测）**

1. **机制形态结论变更**：豆包**确认有正式 skill 机制**，证据等级 **[已查证-本环境实测]**（非公开文档）。加载位置为 **agent 模式工作区**的 `.skills/<技能标识>/SKILL.md`，属**工作区级落位根**，而非客户端安装目录；
2. **本机实测记录**（复现命令，只读）：`Get-ChildItem "$env:LOCALAPPDATA\Doubao\User Data\Default\.doubao\agent_mode\workspace"` → 含 `.skills/`（**141 个技能目录**）与 `.user_skills/`（当前为空）；抽样技能 `computer-use`、`doubao-coding-review-code` 的 `SKILL.md` 头部为 `name` + `description` 的 YAML frontmatter，与 Agent Skills 字段同构；
3. **探测位置更正**：原结论的「未查到」源于探测位置有误（客户端安装目录 `Application/`、`User Data/`）与公开渠道无文档；**不是**「豆包无机制」的证据；
4. **新增待确认事实点**：`.skills/`（内置技能）与 `.user_skills/`（用户技能）两级技能根的**落位归属**——用户技能应落位到哪一级、是否两者都会被加载，需在设计阶段以实测确认；
5. 本条补记不修改上述第 1 至 7 项的原始记录，仅登记证据补充与结论变更。

**补记之二（2026-10-15，T0 实测与运行期证据）**

1. **用户技能落位根已确认**：宿主技能发现机制列出的技能根为**多个**——`.skills/`、`.user_skills/`、`.agents/skills/`，即 `.user_skills/` 与 `.skills/` 同级并列、都会被扫描；其中 `.skills/` 由平台持有（只读）、`.user_skills/` 用户可写且当前为空。故**用户技能落位根 = `.user_skills/`**，`.skills/` **禁止写入**。证据等级：运行期证据（用户提供）+ 本机机械实测；本机 Windows ACL 看不出该权限差异（两侧均为当前用户 FullControl），权限结论以运行期属性为准；
2. **T0 机械实测**：在工作区 `.user_skills/` 放置最小测试技能（目录名与 frontmatter `name` 一致、UTF-8 无 BOM、LF），创建成功；期间 `.skills/` 的目录数（141）与时间戳未变；实测后现场已恢复（`.user_skills/` 剩余条目 0，无残留）；
3. **残留观察项**：「测试技能是否进入会话可用清单」属宿主侧人工确认项，不阻塞 HD-04 的关闭（可加载性已由技能根列表与权限属性支撑）；
4. **新增待确认**：`.agents/skills/` 是运行期列表提及的第三个根，但本机工作区内**不存在**该目录；若该根确实被扫描，则它与 Cursor 的 `.agents/skills/` 为同一路径，构成跨宿主共享落位根（对应需求 M5-R8 的重叠消费情形），列为 Q-08；
5. 本条补记同样不修改既有事实结论。

### 2.6 事实卡 F：DeepSeek

1. **机制形态结论**：**确认无**（在其官方文档体系内不存在 skill / 插件机制的概念）。DeepSeek 的官方定位是**模型提供方**，其官方文档「Agent Integrations」章节的方向是**把 DeepSeek 接入其他 agent 宿主**，而不是为自身定义技能格式 [已查证]。**更正（2026-10-16）**：该结论的**范围需收窄为「其 API / 模型产品体系内无技能机制」**——DeepSeek 另有官方开源的 **agent harness（DeepSeek Harness，`dsh`）**，其中**技能是一等子系统**，仓库本身即以 `.agents/skills/<名称>/SKILL.md` 组织技能，并有 `docs/subsystems/skills.md` 定义技能能力族与发现根；详见 6.3 补记第 3 条 [已查证·浏览器一手]。
2. **官方规范引用**：`https://api-docs.deepseek.com/`（含 sitemap：API 参考、指南、Agent Integrations、新闻）；集成条目覆盖 Claude Code、Codex、OpenCode、OpenClaw、Hermes、Reasonix、WorkBuddy/CodeBuddy、Qoder [已查证]。集成文档示例（Codex 篇）说明 Codex 通过 Responses API 与模型通信、由 DeepSeek API 原生支持，并给出配置模型提供方的步骤与一键脚本 [已查证]。
3. **格式规范细节**：**无**。官方文档未定义任何技能文件格式、目录约定或 frontmatter 字段 [已查证]。
4. **加载目录与发现规则**：不适用。
5. **能力边界**：作为模型提供方可被其他宿主调用；不提供宿主侧的技能加载能力。
6. **本机可观测证据**：本机未安装 DeepSeek 客户端（无 `~/.deepseek`、无 `%APPDATA%\DeepSeek`）[已查证·本机实测]。
7. **补充线索（须一手确认）**：检索结果中出现 **DeepSeek Harness（DSH）** 线索——GitHub 组织 `deepseek-ai` 下存在 `deepseek-harness` 仓库，摘要描述为「Everything is a Plugin」；第三方文章称其支持插件扩展 [一方称]。该仓库在本次环境下**不可访问**（GitHub 请求失败），故「DSH 是否构成 DeepSeek 的正式插件 / 技能机制」列为待确认。**若成立，其形态是「插件」而非「SKILL.md 技能」，与 M5 的适配对象可能不同类**。**已关闭（2026-10-16）**：该仓库现可达且为公开仓库（README 自述「everything-is-a-plugin」，基于 Cordis；开发者预览，明示会有破坏性变更），其中**技能子系统与插件架构并存**——仓库 `docs/subsystems/skills.md` 定义技能能力族（本机文件系统 provider 等），发现根含 `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、`<dshHome>/skills`、`<agentsHome>/skills` 等，接受目录包 `<名称>/SKILL.md` 与扁平 `<名称>.md`。故原判断「可能是插件而非 SKILL.md 技能」**不完全成立**：它既以插件 / 预设为分发容器，又把 SKILL.md 形态技能作为一等子系统。详见 6.3 补记第 3 条。
8. **与内部规范的差异与可映射性初判**：**不适用**（无宿主侧格式）。降级路径的判断依赖 6.3 的待确认项。**更正（2026-10-16）**：dsh 具备宿主侧技能格式（SKILL.md 目录包 / 扁平 Markdown，kebab-case 名称，frontmatter 含 `disable-model-invocation` 与 `user-invocable`），故「不适用」需复议——见 6.3 补记第 4 条待裁决项 ③。

### 2.7 事实卡 G：通用 AGENTS.md

1. **机制形态结论**：**确认有开放格式约定**，属「指令文件」而非「技能文件」[已查证]。**更正**：需求文档 9.3.6 表把 AGENTS.md 记为「Anthropic 推的通用标准」，事实不支持——AGENTS.md 由 **Agentic AI Foundation（Linux Foundation）治理**，其形成来自 OpenAI Codex、Amp、Jules（Google）、Cursor、Factory 等生态协作；**Anthropic 推出的跨工具标准是 Agent Skills（agentskills.io），不是 AGENTS.md** [已查证]。
2. **官方规范引用**：`https://agents.md/`（格式站点，含治理说明与支持清单）[已查证]。
3. **格式规范细节** [已查证]：
   - **无必需字段，纯 Markdown**，标题与结构自由，agent 直接解析文本；
   - 位置：仓库根目录；**支持嵌套**——在子目录放置 AGENTS.md 时，**离被编辑文件最近的一份生效**（就近优先），显式用户提示优先级最高；
   - 站点明确「AGENTS.md 是给 agent 的 README」：承载构建 / 测试命令、代码风格、测试与 PR 规范、部署与安全注意事项等；
   - 站点声明其被 6 万+ 开源项目使用，并给出支持该格式的 agent 清单。
4. **加载目录与发现规则**：由各宿主自行实现发现（根目录 / 嵌套就近）；本机 Codex 的全局指引位于 `~/.codex/AGENTS.md` [已查证·本机实测]。
5. **能力边界**：无元数据、无字段校验、无渐进披露、无技能身份概念——它是**指令文本的通用载体**，不具备技能的选择性加载与结构校验能力。
6. **本机可观测证据**：`C:\Users\HW\.codex\AGENTS.md` 存在（全局指引）；项目侧未发现 `AGENTS.md`（本仓库未使用该格式）[已查证·本机实测]。
7. **与内部规范的差异与可映射性初判**：**不存在字段级映射**——只能把技能的名称、描述与正文**降级渲染为条目段落**（见 4.4）。写入共享文件（仓库根或子目录的既有 AGENTS.md）涉及「不覆盖用户既有内容」，属需求文档 9.3.6 已声明的写入安全约束。

---

## 3. 通用 AGENTS.md 专项：与各宿主兼容度

| 宿主 | 是否支持 AGENTS.md | 证据等级 | 备注 |
|---|---|---|---|
| Codex | 支持 | [已查证]（格式站点支持清单列首位；本机存在全局 `~/.codex/AGENTS.md`） | 全局与仓库级并存；嵌套就近优先 |
| Cursor | 支持 | [已查证] | 项目根与子目录均支持；文档建议「想用纯 Markdown 就用 AGENTS.md 而非 `.cursor/rules` 下的 `.md`」 |
| Claude（Claude Code） | **未在格式站点清单中**；Claude Code 的等价机制是 `CLAUDE.md` 与技能 | [已查证]（Claude Code 文档侧未见 AGENTS.md 作为加载来源） | 不要把 AGENTS.md 当作 Claude 的适配目标 |
| 豆包 | 未查到 | [待确认] | — |
| DeepSeek | 不适用（无宿主侧加载） | [已查证] | — |
| 其他（清单内） | 支持 | [已查证]（格式站点清单） | 含 Amp、Jules（Google）、Factory、Aider、goose、opencode、Zed、Warp、VS Code、Devin、Junie、RooCode、Gemini CLI、Kilo Code、Windsurf、Augment Code、GitHub Copilot、Ona、UiPath、Semgrep、Phoenix 等 |

**兼容度结论**：AGENTS.md 是**跨宿主覆盖率最高的降级载体**（覆盖面广、无格式门槛），但它的语义是「项目指令」而非「可发现的能力单元」——降级到 AGENTS.md 意味着**放弃技能的自动发现与按需加载**，能力差异必须在登记与输出中显式声明（对应需求文档 M5-R5）。

---

## 4. 格式映射可行性初判

### 4.1 本项目的内部规范（宿主可见面）

来源：[`docs/specification/skill-meta-spec.md`](../specification/skill-meta-spec.md)、[`docs/requirements.md`](../requirements.md) 第 4.1 节与第 4.2 节 [已查证·仓库文档]。

| 内部资产 | 内容 | 宿主可见性 |
|---|---|---|
| `SKILL.md` | 元数据块（名称 / 描述 / 许可证 / 兼容性 / 允许工具 / 扩展元数据）+ 指令正文 | **宿主直接消费**（即本次调研的映射对象） |
| `skill_meta.yaml` | 管理器元文件：`id`、`name`、`version`、`description`、`author`、`license`、`status`、`path`、`trigger_keywords`、`dependencies{skills, runtime}`、`source`、`targets[{target, scope, path, mode, enabled, file_map}]` | **宿主不消费**（管理器侧事实源） |
| 落位副本 | 落位根 `.<目标标识>/skills`，副本目录 `<落位根>/<Skill 标识>`；禁用方式为「副本内元数据文件改名（带禁用后缀）」 | 宿主按既有发现规则识别 / 不识别 |
| 逐文件落位 | `file_map` 缺省整目录复制，提供时按映射逐文件落位 | 宿主无对应概念，不影响宿主格式 |

### 4.2 内部字段 → Agent Skills 字段对照

| 内部字段 | Agent Skills 字段 | 可映射性 |
|---|---|---|
| 名称（`id` / 目录名） | `name` | **直接映射**（命名规则近似：小写、连字符、与目录名一致；须核对连续连字符与长度上限等细则） |
| 描述 | `description` | **直接映射**（注意 1024 字符上限；Claude Code 列表展示还会在 1536 字符处截断） |
| 许可证 | `license` | **直接映射** |
| 兼容性 | `compatibility` | **直接映射**（注意 500 字符上限） |
| 扩展元数据映射 | `metadata` | **直接映射**（标准要求字符串键值；列表类值需降级为字符串） |
| 扩展元数据.版本 / 作者 / 主页 / 标签 | `metadata.version` / `metadata.author` / `metadata.homepage` / `metadata.tags` | **可映射**（标签列表需转字符串；`version` 建议加引号以免 YAML 解析歧义） |
| 扩展元数据.依赖声明（Skill 依赖 + 运行时依赖） | `metadata.*` 与 `compatibility` | **可映射但需拆分**：运行时依赖可读性上更适合 `compatibility` 文本；Skill 依赖无标准字段，落入 `metadata` |
| 允许工具 | `allowed-tools` | **可映射但实验性**：标准标注为 experimental，各实现支持度不一（Claude Code 支持；Cursor 文档未列出） |
| `trigger_keywords` | **无对应字段** | **需降级**：并入 `description`（受长度上限约束）或作为宿主扩展字段（仅 Claude Code 有 `when_to_use`） |
| `status` / `path` / `targets` / `source` | **无对应字段** | 不进入宿主格式（管理器侧概念） |

### 4.3 各宿主的可映射 / 宿主特有 / 需降级清单

| 宿主 | 可映射字段 | 宿主特有字段（渲染时可选，默认不发） | 需降级或不支持 |
|---|---|---|---|
| Claude Code | `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools` | `when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`disallowed-tools`、`model`、`effort`、`context`、`agent`、`background`、`hooks`、`paths`、`shell` | `trigger_keywords` → 并入 `description`；**跨平台分发必须收敛为 6 字段**（claude.ai / Skills API 会硬失败） |
| Codex | 同上 6 字段（本机实测一致） | 技能级 `agents/<名称>.yaml` 界面声明；插件级 `plugin.json` 的 `interface.*` | 插件级字段不属 M5（M5 只做内置适配器）；标准外字段的接受度**待确认** |
| Cursor（skills 路径） | `name`、`description` | `paths`（`globs` 兼容）、`icon`、`color` | `allowed-tools` 未在文档中出现 → 视为不支持并登记；`trigger_keywords` → 并入 `description` 或 `paths` |
| Cursor（规则路径） | 无字段对应；渲染为 `.mdc` 正文 + `description` / `globs` / `alwaysApply` 三要素 | — | 需新设计「技能 → 规则条目」的呈现规则；且 `.mdc` 与 `.md` 语义不同 |
| 通用 AGENTS.md | 无字段对应 | — | **整段降级**：名称 + 描述 + 正文折叠为条目段落；共享文件须不覆盖写入 |
| 豆包 | 无法初判 | — | 待确认 |
| DeepSeek | 不适用 | — | 无宿主侧加载；降级路径待确认（见 6.3） |

### 4.4 降级路径建议（供设计阶段参考，非定稿）

1. **有 Agent Skills 机制的宿主**（Claude / Codex / Cursor-skills）→ 渲染标准 `SKILL.md` 到该宿主的技能根；
2. **仅有规则机制的宿主** → 渲染为规则条目（Cursor 用 `.mdc`；通用情形用 `AGENTS.md` 条目），并在登记与输出中声明能力差异（无自动发现、无按需加载、无工具预授权）；
3. **无任何机制的宿主** → 登记为「不支持」，或经用户显式选择后降级为 `AGENTS.md` 条目；不得静默落位到宿主不读取的位置；
4. **降级不得静默丢弃字段**：被丢弃或改写的字段（如 `trigger_keywords`）必须进输出与登记（对应 M5-R5）。

### 4.5 落位根与「一次落位、多宿主可见」的观察

1. Cursor **兼容读取** `.claude/skills/`、`.codex/skills/`、`~/.claude/skills/`、`~/.codex/skills/` [已查证]；
2. 本项目的落位根为 `.<目标标识>/skills`，标识为 `claude` 时即 `.claude/skills/` —— **与 Cursor 的兼容读取路径重叠**；
3. 由此产生两项设计议题（本次只登记，不裁决）：**（a）** 同一次落位是否被多个宿主重复识别、是否需要在注册表中标注「该落位根被哪些宿主消费」；**（b）** 若某宿主同时存在自身根（如 `.cursor/skills/`）与兼容根，渲染产物应写入哪一个，需明确定义以避免同一技能被识别两次；
4. 该项与需求文档 M5-R3（落位扩展）直接相关，建议在适配器设计阶段作为首个裁决点。

---

## 5. 风险清单

| 编号 | 风险 | 影响 | 应对 / 待确认动作 |
|---|---|---|---|
| HR-01 | **宿主规范演进**：Agent Skills 规范未标版本且持续演进；Claude Code 的 frontmatter 表随版本变化（文档中存在明确的行为版本节点）；Cursor / Codex 的技能机制均属新近加入 | 适配器产出过期、字段被静默忽略而不自知 | 注册表登记「规范来源 + 访问日期 + 观察到的版本节点」；把「字段被忽略」纳入格式合规校验；规范变化只改适配器与注册表 |
| HR-02 | **Codex 官方规范不可取证**（自本环境命令行侧 403） | Codex 适配器的字段全集、目录优先级、跨平台字段限制无权威依据 | **已解除（2026-10-16）**：经浏览器会话取证成功（页面重定向到 `learn.chatgpt.com/docs/build-skills`），规范要点见 6.3 补记第 1 条；**残余**：官方 USER 根（`$HOME/.agents/skills`）与本机实测的 `~/.codex/skills` 不一致，作为待裁决项登记（补记第 4 条 ①） |
| HR-03 | **豆包机制无公开证据** | 无法判断是否可做适配器；需求文档 9.3.6 的「豆包 = SKILL.md 体系」前提未获支持 | 按 6.3 的确认方法取证；在取得一手证据前，豆包不得进入首批适配器名单 |
| HR-04 | **DeepSeek 的身份错位**：它是模型提供方，不是技能宿主；其 Harness / 插件线索未经一手确认 | 把它当技能宿主会产出无效适配器 | 在需求侧澄清 M5 的适配对象定义（宿主 = 可展示技能的 agent 产品）；DeepSeek 归入「不适用或降级」并登记理由 |
| HR-05 | **跨产品字段限制**：Claude 的 claude.ai / Skills API 路径只接受 6 个字段且**硬失败** | 一旦未来发布到平台侧，含扩展字段的技能会被拒 | 渲染层提供「标准 6 字段模式」，默认产物即符合跨产品约束 |
| HR-06 | **多宿主重复识别**：Cursor 兼容读取 Claude / Codex 技能根（见 4.5） | 同一技能被同一宿主识别两次，或用户误以为需要多份副本 | 注册表增加「落位根被哪些宿主消费」声明；落位根选择策略在设计阶段裁决 |
| HR-07 | **共享文件写入风险**：AGENTS.md 与 `.mdc` 可能是用户既有文件或团队共享文件 | 覆盖用户内容、冲突丢失 | 沿用需求文档 9.3.6 的写入安全约束：合并策略未定义前不得覆盖写入；降级产物必须可逆 |
| HR-08 | **降级形态的能力落差被低估**：规则文件无自动发现、无按需加载、无工具预授权 | 用户以为「已适配」，实际行为与技能形态差异明显 | 能力差异必须在登记与输出中显式声明（M5-R5）；验收时以「差异可见」为判定条件 |

---

## 6. 调研结论对 M5 范围的影响

### 6.1 首批适配器名单建议（基于事实）

| 建议批次 | 宿主 | 依据 | 映射复杂度 |
|---|---|---|---|
| 首批（机制确认、可映射性高） | **Claude Code** | 官方文档完整、与内部规范同构、字段表可引用 | 低 |
| 首批 | **Codex** | 本机实测结构确认 + Agent Skills 官方清单收录（规范细节待补） | 中 |
| 首批 | **Cursor** | 官方文档完整；skills 路径与 Claude/Codex 同构 | 低（skills）/ 中（降级为规则） |
| 首批 | **通用 AGENTS.md（降级载体）** | 覆盖宿主最多，但属降级形态 | 中 |
| 次批（需先补证据） | 豆包 | 机制未查到 | 未知 |
| 不纳入本里程碑 | DeepSeek | 确认无技能机制；身份为模型提供方（可再评估其 Harness 线索） | 未知 |

与需求文档 9.3.6 的对照：首批名单中的 **Claude / Cursor / 通用 AGENTS.md 与 9.3.6 一致**；**Codex 由「视调研结论」上调为「可入首批」**（9.3.6 假定 Codex 机制未知，事实已确认有机制）；**豆包由「机制确定者」下调为「待补证据」**（9.3.6 假定其机制与 Claude 同源，本次未获证据）。**DeepSeek 建议从「宿主适配」候选移至「不适用 / 模型提供方」类别**。

> **补记（2026-10-15）**：上表为「补记前的证据状态」。豆包已由补记（2.5）补齐一手证据（本环境实测），**最终首批名单以 6.2 裁决登记为准**。

### 6.2 与需求文档 9.3.6 的冲突点（建议回对齐需求后再进设计）

以下四条为**事实与文档假设冲突**，按约定不自行改写需求文档，列出待裁决：

1. **结构假设**：9.3.6 的范围框架把宿主分为「支持 skill 格式」与「仅支持规则文件」两类，并据此设置能力降级。事实是 **Cursor 同时具备两类机制**，且部分宿主的技能根会被**其他宿主兼容读取**（4.5），二元分类不足；建议增加「技能根是否被他宿主消费」一维。
2. **名单**：如上 6.1 所述，Codex 与豆包的位置需要调整。
3. **通用层的表述**：「Agent Skills（Anthropic 推出、已开放为跨工具标准）」才是技能形态层面的通用标准；「AGENTS.md」是**指令文件**层面的通用载体，由 Agentic AI Foundation 治理。9.3.6 表与 9.5 的表述建议按此更正，以免二者被混为一谈。
4. **`--target` 语义扩展的边界**：既然「无技能机制的宿主」可能只支持规则文件，`--target` 的取值就不仅是「宿主标识」，还隐含「该宿主的哪条落位路径（技能根 / 规则路径）」。这会影响指令契约登记的内容范围，建议在登记该项语义前先定这条路径粒度。

**裁决登记（2026-10-15，由需求侧裁决，回写落点见右列）**

| # | 冲突 | 裁决 | 回写落点 |
|---|---|---|---|
| 1 | 宿主分类二元不足 | 接受**三维分类**：支持 skill 机制 / 仅规则文件 / 落位根被其他宿主消费。「落位根重叠」**定性为特性而非冲突**（一次落位服务多宿主，即可适配性的收益）；设计阶段处理「是否显式声明重叠」，需求层只记录该特性 | 需求文档 9.3.6（注册表字段、M5-R1、M5-R3、M5-R8）、9.2.5 收益、9.5 排除项说明 |
| 2 | 首批名单 | 修订为 **Claude / Codex / Cursor / 豆包** + 通用降级载体（AGENTS.md 形态）；**DeepSeek 移出**，标注「不适用 / 模型提供方」（无技能机制，官方定位模型提供方） | 需求文档 9.3.6（范围「M5b 首批适配器」、M5-R4、边界与排除项第 9 条）、9.5 第 9 项 |
| 3 | AGENTS.md 归属 | 更正：AGENTS.md 由 **Agentic AI Foundation（Linux Foundation）** 治理，非 Anthropic 标准；Anthropic 的跨工具标准是 **Agent Skills（agentskills.io）**。两层概念不得混用 | 需求文档 9.3.6（宿主机制现状表「通用」两行、边界与排除项第 7 条） |
| 4 | `--target` 路径粒度 | 取值语义扩展为区分「**技能根**」与「**规则路径**」两级；指令契约的登记内容范围按该粒度写明（取值空间、绑定关系、未登记取值的错误处理），实施前登记，指令数 16 不变、不新增选项 | 需求文档 9.3.6（范围「落位扩展」、M5-R3、新增 M5-R9、约束第 1 条）、9.6.2「契约粒度约束」 |

**结论变更说明**：本次裁决未推翻任何一条事实结论（第 5 节的九项风险全部保留，其中 HR-04 关于 DeepSeek 身份错位的判断被采纳为裁决依据）；变更的是**基于事实的范围判断**——豆包由「待补证据」转为「首批纳入（本环境实测依据）」，Codex 由「可入首批（建议）」转为「首批纳入」。

### 6.3 待确认清单与确认方法

| 编号 | 待确认事实点 | 确认方法 |
|---|---|---|
| Q-01 | Codex 官方技能规范全文（字段全集、目录优先级、项目级技能目录、跨平台字段限制、插件与技能的关系） | 在可访问 `developers.openai.com` 的网络环境取证 `/codex/skills/`（及插件相关页面），记录访问日期 |
| Q-02 | 豆包是否存在技能 / 插件机制；若有，其格式与加载目录 | （a）官方帮助中心 / 开放平台文档检索；（b）**客户端实测**：在候选目录放置符合规范的技能目录，观察是否被识别（可结合客户端日志）；（c）向用户索取其一手依据——需求文档 9.3.6 表称豆包为「SKILL.md 体系、与 Claude 同源」，该结论需要有据可查的来源 |
| Q-03 | DeepSeek Harness（DSH）是否构成正式插件机制，及其与技能形态的关系 | 一手访问 `github.com/deepseek-ai/deepseek-harness`（本次不可达）与其官方文档；确认后再判断是否属 M5 适配对象 |
| Q-04 | 「本仓库运行于豆包环境」这一前提 | 本次调研所在环境为 Codex 桌面应用（观测到的技能根、插件缓存均属 Codex）；请用户确认豆包侧读取的具体目录与实测方式，否则该前提无法进入设计依据 |
| Q-05 | Cursor 是否接受 `allowed-tools` 等标准外字段；Codex 是否同样 | 分别以「含扩展字段」与「仅标准 6 字段」的技能做客户端实测，记录识别结果 |
| Q-06 | 各宿主对「副本内元数据文件改名」这一禁用表达是否仍然生效 | 在 Claude Code / Codex / Cursor 三端对同一技能做禁用 / 启用实测（对应 9.3.6 的里程碑验收标准第 3 条） |

**补记（2026-10-15）**

| 编号 | 状态 | 说明 |
|---|---|---|
| Q-02 | **已关闭** | 豆包机制已由本环境实测确认（见 2.5 补记）：agent 模式工作区 `.skills/<技能标识>/SKILL.md`，证据等级 [已查证-本环境实测]；公开规范缺位不阻塞适配，但不得据公开规范之外的信息虚构字段约束 |
| Q-04 | **已关闭** | 「本仓库运行于豆包 agent 模式」的前提由需求侧确认，且本机实测到该 agent 模式工作区的技能根；原调研所在会话观测到的 Codex 技能根与之并存（两套宿主机制同机共存，互不影响） |
| Q-07 | **已关闭（2026-10-15，T0）** | 两级技能根**都被扫描**；用户技能落位根 = `.user_skills/`（用户可写、当前为空）；`.skills/` 为平台持有只读、**禁止写入**。证据构成：运行期技能根列表（用户提供）+ 目录权限属性（用户提供）+ 本机机械实测（T0，含现场恢复）。残留人工确认项：「进入会话可用清单」 |
| Q-08 | **新增，开放** | `.agents/skills/` 是否为豆包也扫描的第三个根：本机工作区内不存在该目录；若成立，则与 Cursor 的 `.agents/skills/`（项目级 / 用户级）同路径，构成跨宿主共享落位根（M5-R8 场景）。确认方法：创建该目录并放置测试技能后观察是否被扫描，或从运行期技能根列表的实现侧确认根集合 |
| Q-01 / Q-03 / Q-05 / Q-06 | 开放 | 分别为 Codex 官方规范细节（403）、DeepSeek Harness 线索、标准外字段接受度、禁用表达跨宿主实测 |

**补记（2026-10-16，浏览器一手取证）**

取证方式：经浏览器会话（用户已登录的浏览器，可访问外网）直接读取官方页面及其 `.md` / `raw` 纯文本形态；证据等级 **[已查证·浏览器一手]**。原「403 / 不可达」只描述 2026-10-15 的**命令行侧**访问限制，不代表性事实。本次关闭 Q-01 与 Q-03，并对 Q-05 的 Cursor 侧做字段表更新。

| 项 | 结论 |
|---|---|
| Q-01（Codex 官方规范） | **已关闭**：`https://developers.openai.com/codex/skills/` 现可达并重定向到 `https://learn.chatgpt.com/docs/build-skills`（`.md` 形态可取全文） |
| Q-03（DeepSeek Harness） | **已关闭，结论为「机制存在且含技能子系统」**：见下文第 3 条 |
| Q-05（Cursor 侧） | **部分更新**：官方 frontmatter 字段表较原记录**多出 `disable-model-invocation` 与 `metadata`**；「标准外字段被忽略还是报错」官方文档未述（HD-01 保持开放） |

1. **Codex 官方规范要点**（`build-skills` 页 + 配置参考页）：
   - 必需字段：`SKILL.md` **必须包含 `name` 与 `description`**；其余按开放标准（Agent Skills）执行，官方页面**未另列** SKILL.md 的扩展字段表；
   - 可选元数据：`agents/openai.yaml`（本机实测为 `agents/<名称>.yaml`）——`interface{display_name, short_description, icon_small, icon_large, brand_color, default_prompt}`、`policy.allow_implicit_invocation`（默认 `true`；`false` 时不做隐式调用、显式调用仍可用）、`dependencies.tools[]`（MCP 依赖声明）；
   - 加载位置（官方表）：REPO `$CWD/.agents/skills`、`$CWD/../.agents/skills`、`$REPO_ROOT/.agents/skills`（自当前工作目录逐级向上扫到仓库根）；USER `$HOME/.agents/skills`；ADMIN `/etc/codex/skills`；SYSTEM 随 Codex 分发；**支持符号链接并跟随目标**；
   - 重名行为：同名技能**不合并**，两者都可出现在技能选择器；
   - 禁用表达：`~/.codex/config.toml` 的 `[[skills.config]]`（`path` = 含 `SKILL.md` 的目录、`enabled = false`），改后需重启 Codex；配置参考另有 `skills.max_context_tokens`（默认占模型上下文 2%，显式值上限 10000 tokens，仅约束初始技能清单）；
   - **差异（待裁决）**：官方 USER 根为 `$HOME/.agents/skills`，而本机实测 Codex 桌面应用把技能放在 `~/.codex/skills`（含 `.system`）且该目录被实际读取；官方文档未提 `~/.codex/skills`，配置参考亦无对应目录键。→ 见第 4 条待裁决项 ①。
2. **Cursor 官方字段表**（`cursor.com/docs/context/skills`）：`name`（必填；须与父文件夹同名）、`description`（必填）、`paths`（可选；glob）、**`disable-model-invocation`（可选；`true` 时仅 `/skill-name` 显式调用）**、`icon`（可选）、`color`（可选；枚举）、`metadata`（可选）。其中后两项中的 `disable-model-invocation` 与 `metadata` 为**原记录所无**；「标准外字段被忽略还是报错」**文档未述**，HD-01 保持开放。
3. **DeepSeek Harness（`dsh`）**：
   - 性质：DeepSeek AI **官方开源 agent harness**（`deepseek-ai/deepseek-harness`，公开仓库、master 分支、README 自述「everything is a plugin」、基于 Cordis；**开发者预览，明示会有破坏性变更**）；
   - **技能是一等子系统**：仓库含 `docs/subsystems/skills.md`（技能能力族：服务定义 `dsh-skill`、本机文件系统 provider `dsh-skill-filesystem`、消费者 `dsh-tool-skill` 等）；仓库自身以 `.agents/skills/<名称>/SKILL.md` 组织技能，并在 `packages/preset/agent-preset/skills/` 内**随包分发**技能（抽样技能 frontmatter 为 `name` + `description`）；
   - 发现根与优先级（官方子系统文档表，数字小者优先）：`<projectRoot>/.dsh/skills`（100）→ `<projectRoot>/.agents/skills`（200）→ `Config.customSkillDirs`（300）→ `<dshHome>/skills`（400）→ `<agentsHome>/skills`（500）→ `Config.bundledSkillDir`（600）；项目根取最近的含 `.git` 的祖先目录；
   - 身份与形态：技能名 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）；接受目录包 `<名称>/SKILL.md` 与**扁平** `<名称>.md`；**不支持嵌套递归 `**/SKILL.md` 发现**；
   - 调用策略：frontmatter 精确读取 `disable-model-invocation` 与 `user-invocable`，缺省视为 `true`，归一化为 `{ modelInvocable, userInvocable }`；
   - 影响：需求 / 设计把 DeepSeek 登记为「不适用 / 模型提供方（无技能机制）」**不再成立**——DeepSeek 侧确有含技能子系统的官方宿主载体；但它是**开发者预览的 harness**（非消费级产品，且明示破坏性变更）。→ 见第 4 条待裁决项 ③。
4. **由此产生的待裁决项**（本次**不改任何实现与需求**，仅登记）：

| # | 事项 | 现状 | 待裁决内容 |
|---|---|---|---|
| ① | Codex 分发落位根 | 注册项用 `~/.codex/skills`（本机实测应用读取该目录） | 是否改为 / 追加官方 USER 根 `$HOME/.agents/skills`（该根同时是 Cursor 与 `dsh` 的 `agents` 根，可「一次落位、多宿主可见」），或两者并存并在注册表声明消费关系 |
| ② | `disable-model-invocation` 透传（DP-04 / D-02） | 设计裁决为「全宿主禁止透传」（理由：语义不明、本机 12 处全为 `false`） | 现有三处独立证据（Claude 本机实测、Cursor 官方字段表、`dsh` 官方子系统文档）语义一致（`true` = 排除模型自动调用）；是否解除禁止、改为按宿主白名单透传并登记语义 |
| ③ | DeepSeek 分类 | 登记 `not_applicable`（模型提供方） | 是否按 `dsh` 存在技能子系统改判（新增 `dsh` 注册项 / 标 `pending_evidence`），以及是否纳入后续适配批次 |
| ④ | Cursor 标准外字段行为（HD-01） | 保守裁剪（透传白名单为空） | 官方文档未述「标准外字段被忽略还是报错」；仍需 Cursor 环境实测或官方答复 |

5. **取证方法备注**：本次来源全部经浏览器会话读取（命令行侧的 403 不构成事实结论）；`learn.chatgpt.com/<页面>.md` 与 `raw.githubusercontent.com/<仓库>/<分支>/<路径>` 可直取全文，后续调研建议优先使用这两种形态。

### 6.4 对 9.3.6 的范围与边界的影响

1. **无需改动**：M5 的目标、统一管理要求、可适配性要求、边界与排除项（不做宿主运行时与加载器、格式映射以官方规范为准、不做双向同步、不覆盖用户既有内容、不做第三方可加载适配器）均与本次事实一致，无需调整；
2. **需要补充**：4.5 的「落位根被他宿主消费」议题建议纳入「落位扩展」范围；4.4 的「规则文件降级」需要新增一条呈现规则（技能 → 规则条目）的需求描述；
3. **建议收敛**：把「豆包 + DeepSeek」从首批交付的承诺面中移出，或明确标注为「证据不足，待补调研」，以免里程碑验收时无法判定。

**补记（2026-10-15，裁决后的实际处置）**

1. 「无需改动」一条成立——M5 的目标、统一管理要求、可适配性要求与主要边界均未调整；
2. 「需要补充」一条已落实：落位根消费关系登记为 M5-R8，路径粒度与契约登记为 M5-R9，降级呈现规则仍在设计阶段产出；
3. 「建议收敛」一条**未按原文执行**：豆包经本环境实测取得一手证据后**保留在首批**（不再属于「证据不足」）；DeepSeek 按裁决**移出首批**并登记为「不适用 / 模型提供方」。故原文的「移出豆包」表述不再代表最终范围。

---

## 附录：来源清单（2026-10-15 访问）

| 编号 | 来源 | 类型 / 证据等级 | 链接 | 访问结果 |
|---|---|---|---|---|
| S-01 | Agent Skills 概览 | 官方标准站 [已查证] | https://agentskills.io/ | 200 |
| S-02 | Agent Skills 规范 | 官方标准站 [已查证] | https://agentskills.io/specification | 200（Markdown 形态可取全文） |
| S-03 | Agent Skills 客户端清单 | 官方标准站 [已查证] | https://agentskills.io/clients | 200 |
| S-04 | Agent Skills 文档索引 | 官方标准站 | https://agentskills.io/llms.txt | 200 |
| S-05 | Claude Code skills（含 frontmatter 全表与加载目录） | 官方文档 [已查证] | https://docs.claude.com/en/docs/claude-code/skills | 200（Markdown 形态可取全文） |
| S-06 | Claude 平台 Agent Skills 概览 | 官方文档 [待确认] | https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview | 区域受限（空壳页） |
| S-07 | Codex 技能文档（官方） | 官方文档 [**已查证**（2026-10-16）] | https://developers.openai.com/codex/skills/ → `learn.chatgpt.com/docs/build-skills` | 2026-10-15 命令行侧 403；**2026-10-16 浏览器会话可达**（`.md` 形态取全文） |
| S-08 | Cursor Skills | 官方文档 [已查证] | https://cursor.com/docs/context/skills | 200 |
| S-09 | Cursor Rules | 官方文档 [已查证] | https://cursor.com/docs/context/rules | 200 |
| S-10 | AGENTS.md 格式站点（含治理与支持清单） | 官方格式站点 [已查证] | https://agents.md/ | 200 |
| S-11 | DeepSeek API 文档与 sitemap | 官方文档 [已查证] | https://api-docs.deepseek.com/ | 200 |
| S-12 | DeepSeek × Codex 集成（Agent Integrations 示例） | 官方文档 [已查证] | https://api-docs.deepseek.com/quick_start/agent_integrations/codex | 200 |
| S-13 | 豆包官网 / 应用页 | 官方站点 [待确认] | https://www.doubao.com/ | 200（前端渲染，正文不可提取） |
| S-14 | DeepSeek Harness 仓库 | **官方开源仓库 [已查证**（2026-10-16）] | https://github.com/deepseek-ai/deepseek-harness | 2026-10-15 不可达；**2026-10-16 浏览器会话可达**（公开仓库，README 与 `docs/subsystems/skills.md` 取全文） |
| S-15 | 应用内自带文档（Skill 与 Plugin 的界面定义） | 本机实测 [已查证] | `~/.codex/skills/.system/openai-docs/references/codex-self-knowledge.md` | 已读 |
| S-16 | 本机 Codex 技能与插件包结构 | 本机实测 [已查证] | `~/.codex/skills`、`~/.codex/plugins/cache/**` | 已读 |
| S-17 | 本机 Claude 用户目录（无 skills 子目录） | 本机实测 [已查证] | `~/.claude` | 已读 |
| S-18 | 本机豆包客户端（存在 MCP 辅助组件，无技能目录） | 本机实测 [已查证] | `%APPDATA%\Doubao`、`%LOCALAPPDATA%\Doubao` | 已读 |

**附录补记（2026-10-16 新增来源，浏览器会话访问）**

| 编号 | 来源 | 类型 / 证据等级 | 链接 | 访问结果 |
|---|---|---|---|---|
| S-19 | Codex 技能文档（Markdown 形态全文） | 官方文档 [已查证] | https://learn.chatgpt.com/docs/build-skills.md | 200（全文可读：必需字段、可选元数据、加载位置、重名、禁用表达、上下文预算） |
| S-20 | Codex 配置参考（`skills.*` 键） | 官方文档 [已查证] | https://learn.chatgpt.com/docs/config-file/config-reference.md | 200（`skills.config[].path` / `enabled`、`skills.max_context_tokens`） |
| S-21 | Cursor Skills（Frontmatter 字段表，中文站） | 官方文档 [已查证] | https://cursor.com/docs/context/skills | 200（字段表含 `disable-model-invocation`、`metadata`） |
| S-22 | dsh 仓库 README | 官方开源仓库 [已查证] | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md | 200 |
| S-23 | dsh 技能子系统文档 | 官方文档（仓库内）[已查证] | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/skills.md | 200（发现根优先级表、身份规则、调用策略键） |
| S-24 | dsh 仓库内技能样例 | 官方开源仓库 [已查证] | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/preset/agent-preset/skills/agent-experience/SKILL.md | 200（frontmatter 为 `name` + `description`） |

---

**调研结束**。本文档只记录事实与可行性初判，不含任何实现；结论可追溯至上述来源与证据等级，「待确认」项见 6.3。
