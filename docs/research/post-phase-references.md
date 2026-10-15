# 后续阶段（M1–M4）参考实现与工具登记

| 项目 | 内容 |
|---|---|
| 文档名称 | 后续阶段参考实现与工具登记（M1 CI / M2 跨平台 / M3 压测 / M4 能力扩展） |
| 文档路径 | `docs/research/post-phase-references.md` |
| 文档状态 | 登记快照（2026-10-15；来源：用户提供的引用清单 + 本机可达性核验） |
| 用途 | 把外部参考线索登记在册，供各里程碑的设计 / 实现阶段取用；**登记不等于采纳** |
| 关联文档 | [`docs/requirements.md`](../requirements.md) 第 9 章；[`docs/research/skill-plugin-manager-research.md`](skill-plugin-manager-research.md)（2026-10-12 一期同类项目调研快照）；[`docs/research/host-mechanisms.md`](host-mechanisms.md)（M5 宿主机制调研） |

> 本文档只登记参考线索与可达性核验结果，**不含任何实现**，也不代表对任一参考的采纳决定。采纳与否由对应里程碑的设计 / 计划阶段裁定并另行登记。

---

## 0. 说明与证据纪律

1. **证据等级**：本文件使用三档标注——**[已收录·快照]**（一期调研快照已有元数据与结论）、**[新增·未核验]**（快照未收录，内容未经核验）、**[可达性已核验]**（本机实测的访问结果）；
2. **可达性核验结果（本机实测，2026-10-15）**：`https://github.com/`、各具体仓库页面与 `https://api.github.com/...` 自本环境**全部不可达**（HTTP 000，瞬时失败，未返回任何内容）。因此本文件内**所有 GitHub 链接的内容、许可、活跃度与时效均未经核验**，一律按「待核验」处理；
3. **不臆断**：链接指向不明、疑似错链或未给出具体仓库的条目，只登记问题、不作推断（见第 3 节）；
4. 本文件按快照维护：网络条件具备后的核验结果以**补记**追加，不就地改写既有条目。

---

## 1. 去重结论（与一期调研快照的关系）

一期调研快照（[`skill-plugin-manager-research.md`](skill-plugin-manager-research.md)，2026-10-12）已收录本清单中的多数仓库，并给出语言 / 许可 / 星数 / 调研日期等元数据。**这些条目不重复调研**，直接沿用快照结论：

| 本清单条目 | 快照中的位置与结论 | 本次处置 |
|---|---|---|
| `cchao123/skills-manager` | A8：TypeScript + Tauri，MIT，125 star，桌面 App | [已收录·快照]；M1 / M2 / M3 参考 |
| `EfanWang/skills-manager` | A6：Python，MIT，30 star，脚本 CLI（本身是 skill） | [已收录·快照]；M3 脚手架参考 |
| `buzhangsan/skill-manager` | A9：JavaScript，未声明许可，321 star，agent 驱动 | [已收录·快照]；索引与安装体验参考 |
| `awesome-skills/agent-skills-manager` | 边缘参考：仅 6 star、无许可证、纯 Shell；其「symlink 无 fallback」已被登记为风险（快照第 1564 行） | [已收录·快照]；**仅作对照**（与一期「默认副本」决议冲突，见第 3 节） |
| `agentskills/agentskills` | B1：Agent Skills 开放规范 + `skills-ref` 参考实现（Apache-2.0 / 文档 CC-BY-4.0，26,062 star） | [已收录·快照]；**M4b 元信息层首选参考** |
| `microsoft/skills-for-copilot-studio` | 快照第 60 行：绑定微软生态，不算通用管理器，**仅作边缘参考** | [已收录·快照] |
| `aktsmm/vscode-agent-skill-ninja` | 排他清单：VS Code 扩展，属 IDE 插件系统层，超出本项目边界 | [已收录·快照]；只作 UX 对照 |
| `electron-builder`、`electron-react-boilerplate`、`Squirrel.Windows`、`nuts`、`k6`、`actions/*` | 快照中**无**对应条目 | [新增·未核验] |

---

## 2. 逐里程碑参考（用途、与项目的关系、核验状态）

### 2.1 M1 CI 接入

| 参考 | 类型 | 用途 | 与项目的关系 | 核验状态 |
|---|---|---|---|---|
| `cchao123/skills-manager`（自带 `build.yml`） | 真实 CI 样本 | 参考 workflow 的组织方式与步骤拆分 | 同为桌面 + CLI 形态项目，可比性高 | [已收录·快照] |
| `electron-userland/electron-builder` | 打包 / CI 集成文档 | 参考 CI 中的构建与产物上传组织 | **本项目外壳即使用 electron-builder**（`gui/package.json`，^26.15.3） | [新增·未核验] |
| `actions/checkout`、`actions/cache`、`actions/upload-artifact` | 官方组件 | 检出、缓存、产物上传的直接可用组件 | 与需求 9.3.1 的缓存策略、产物上传条目一一对应 | [新增·未核验] |
| GitHub Actions marketplace | 模板库 | 补充模板与最佳实践 | 仅作检索入口 | [新增·未核验] |

**本项目技术栈提示**：外壳为 **Electron**（electron-vite + electron-builder），**不是 Tauri**；当前打包脚本只有 `pack:win`，M2 需要补 macOS / Linux 目标。因此 CI 与打包类参考的**顺位以 Electron 生态为主，Tauri 仅作对照**。

### 2.2 M2 跨平台打包验证

| 参考 | 类型 | 用途 | 与项目的关系 | 核验状态 |
|---|---|---|---|---|
| `electron-userland/electron-builder` | 打包工具（本项目已用） | 跨平台目标、产物类型、权限与可执行位等注意点 | **直接适用**（现成依赖） | [新增·未核验] |
| `electron-react-boilerplate/electron-react-boilerplate` | 示例工程 | 构建 / 发布组织方式 | 本项目界面为 Vue + electron-vite，借鉴的是**工程组织**而非技术栈 | [新增·未核验] |
| `cchao123/skills-manager` | 同类项目的 Releases 实践 | 参考发布产物与 release 流程 | 同为技能管理器形态 | [已收录·快照] |
| `tauri-apps/tauri` | 另一套打包工具链 | 仅作**对照**（其跨平台注意事项有可读性） | 工具链不适用本项目 | [已收录·快照（技术栈对比）] |

**范围提示**：M2 的产物形态与验收口径已由需求 9.3.2 与 9.4.2 定死（三种启动方式、允许的配置差异、差异逐条登记），参考只影响**实现方式**，不改变验收标准。

### 2.3 M3 性能与规模压测

| 参考 | 类型 | 用途 | 与项目的关系 | 核验状态 |
|---|---|---|---|---|
| `EfanWang/skills-manager` | 脚本脚手架 | 参考真实操作路径（inventory / check / update）驱动小规模批次 | 可作为 N 较小的压测路径参照 | [已收录·快照] |
| `cchao123/skills-manager` | 桌面端真实场景 | 端到端性能对照（大量技能加载、导出 / 备份） | 对照价值大于复用价值 | [已收录·快照] |
| `grafana/k6` | 负载测试工具 | 并发驱动与度量方式（若需要自动化驱动） | **适配成本需评估**：本项目压测对象是本地指令与文件系统，不是 HTTP 服务 | [新增·未核验] |
| 通用 benchmark 仓库（清单中未给出具体仓库名） | 基准参考 | — | **无法登记**（未给出可核验仓库，见第 3 节） | 未登记 |

**约束提示**：需求 9.3.3 明确「不含并发或多进程架构调整」，9.6.2 有「不引入新的运行时依赖」约束；因此 k6 一类工具只能作为**外部驱动 / 度量手段**评估，不得演变成新的运行时依赖或架构改造。

### 2.4 M4a 自动更新

| 参考 | 类型 | 用途 | 与项目的关系 | 核验状态 |
|---|---|---|---|---|
| `electron-userland/electron-builder`（含 autoUpdate / electron-updater） | 更新方案 | 参考与 Releases 的集成方式 | **本项目外壳的天然路径** | [新增·未核验] |
| `tauri-apps/tauri`（updater） | 更新方案 | 对照其检查 / 签名 / 校验流程 | 工具链不适用，流程可借鉴 | [已收录·快照（技术栈对比）] |
| `Squirrel/Squirrel.Windows`、`nuts` | 历史模型 | 理解传统 auto-update 模型 | 仅作模型参考 | [新增·未核验]（其中 `nuts` 链接疑似有误，见第 3 节） |

> **边界提醒（重要）**：`electron-builder` 的 autoUpdate 是**自动下载并安装**，而本项目 M4a 已收敛为「手动检查 + 提示 + 确认后复用既有更新路径」（需求 9.3.4 的范围收敛声明、9.5 第 1 项排除项、9.4.4 的只读要求）。参考实现**不得把范围带偏**：检查阶段只读、不落盘，不做后台静默下载或替换。

### 2.5 M4b 插件生态

| 参考 | 类型 | 用途 | 与项目的关系 | 核验状态 |
|---|---|---|---|---|
| `agentskills/agentskills` | 规范仓库 | 插件 / 技能元数据契约草案与示例（元信息层首选参考） | 与 M5 已采用的技能形态标准同源 | [已收录·快照] |
| `microsoft/skills-for-copilot-studio` | 成品样例 | YAML schema、author / test / publish 流程的借鉴 | 生态绑定，仅边缘参考 | [已收录·快照] |
| `aktsmm/vscode-agent-skill-ninja` | VS Code 扩展 | 发现 / 安装 / 管理的 UX 参考 | 属 IDE 插件层，超出本项目边界（一期已列排除） | [已收录·快照] |

**范围提示**：M4b 在本阶段**只定高层需求与边界**；本清单中任何**运行时 / 沙箱 / 执行**类能力明确不采纳（需求 9.5 第 2 项），契约层设计须单独立项。

### 2.6 M5 宿主适配层

M5 的参考清单与本文件 M1–M4 部分**高度重叠**（同一批仓库），因此不另建文件，按用途重新标注如下：

| 参考 | 在 M5 中的用途 | 关系与差异 | 核验状态 |
|---|---|---|---|
| `agentskills/agentskills` | 元数据契约起点（中心标准输入）；映射可行性初判的基准 | 与 M5 已采用的技能形态标准同源；本项目的 `SKILL.md` 字段集与其规范同构 | [已收录·快照] |
| `EfanWang/skills-manager` | 渲染 / 落位 / registry 层的实践参考（sources.json、install、update、atomic-swap） | 与本项目「可推导布局 + 逐文件落位」可对照；其 atomic-swap 思路与既有原子写入一致 | [已收录·快照] |
| `cchao123/skills-manager` | 落位 / 分发与推导布局的实现方式参考 | 同为技能管理器形态，可比性高 | [已收录·快照] |
| `buzhangsan/skill-manager` | 大规模索引与批量分发场景参考 | 索引层参考 | [已收录·快照] |
| `awesome-skills/agent-skills-manager` | 「单一原件 + symlink」的落位 / 启用策略参考 | **与一期 R-04「默认副本、链接方式推迟」冲突**：只能作对照，且其「symlink 无 fallback」已被快照登记为风险 | [已收录·快照] |
| `microsoft/skills-for-copilot-studio` | YAML schema 与 author / test / publish 流程的校验与合规报告参考 | 生态绑定，仅边缘参考（快照结论） | [已收录·快照] |
| `aktsmm/vscode-agent-skill-ninja` | 宿主侧发现 / 渲染 / 安装的 UX 参考（含规则文件输出） | 属 IDE 插件层，超出本项目边界，仅对照 | [已收录·快照] |
| `tauri-apps/tauri`、`electron-userland/electron-builder` | 与 M2 产物分发相关，**与渲染 / 落位无直接关系** | 本项目外壳为 Electron，以 electron-builder 为主 | [新增·未核验] |

**M5 参考的使用边界**：M5 的字段映射规则、降级策略与适配器接口**已由设计文档定稿口径**（[`docs/design/m5-host-adapter.md`](../design/m5-host-adapter.md)，DP-01 ~ DP-05 已裁决），外部参考只能用于实现方式与校验做法，**不得改变已裁决的字段策略与边界**（例如把 Claude 的透传白名单从空改掉、或引入 symlink 作为默认落位方式）。

---

## 3. 需注意的问题项

| 项 | 问题 | 处置 |
|---|---|---|
| `nuts` 链接 | 清单给出的 `nuts-foundation/nuts` 指向的是卫生 / 医疗数据交换方向的标准组织，**不是** auto-update 工具；Squirrel 兼容的更新服务器另有其仓库 | 标为**疑似错链**，待核验；在核验前不得作为参考依据，也不得写进设计与计划文档 |
| 「通用 benchmark 仓库（ghanks/benchmarks 示例）」 | 未给出可核验的具体仓库 | 不登记；如需基准参考，改为登记**具体仓库**后再补 |
| Tauri 系参考 | 本项目外壳为 Electron | 已在逐里程碑表中标注为「仅对照」 |
| 参考条目元数据的时效 | 本环境不可达 GitHub，无法复核星数 / 许可 / 是否归档 | 沿用一期快照元数据（2026-10-12）；新增条目待核验 |
| `awesome-skills/agent-skills-manager` 的「单一原件 + symlink」思路 | 与一期决议冲突：需求 R-04 明确「一期默认使用副本方式，链接方式推迟」 | 仅作对照；若未来评估链接模式，走既有决策流程并先改文档 |
| `k6` 的引入 | 与 9.6.2「不引入新的运行时依赖」相邻 | 作为可选外部手段评估；引入需登记并说明理由 |

---

## 4. 参考与需求条目的映射

| 参考 | 服务的需求条目 | 说明 |
|---|---|---|
| `cchao123/skills-manager` | 9.3.1（步骤与触发）、9.3.2（产物与 Releases）、9.3.3（端到端场景） | 覆盖面最广的一个参考 |
| `actions/checkout` / `cache` / `upload-artifact` | 9.3.1（缓存、产物上传、失败门禁） | 组件级直接可用 |
| `electron-builder` | 9.3.2（跨平台产物）、9.3.4（更新衔接，仅参考） | 与本项目现有打包链路一致 |
| `electron-react-boilerplate` | 9.3.2（工程组织） | 借鉴组织方式 |
| `EfanWang/skills-manager` | 9.3.3（脚本化操作路径） | 脚手架参考 |
| `k6` | 9.3.3（并发 / 自动化驱动，可选） | 需评估适配成本 |
| `Squirrel.Windows` / `nuts` | 9.3.4（更新模型对照） | `nuts` 链接待核验 |
| `agentskills/agentskills` | 9.3.5（M4b 高层边界）、M5（技能形态标准） | 元信息层首选参考 |
| `microsoft/skills-for-copilot-studio` | 9.3.5（边缘） | 生态绑定 |
| `aktsmm/vscode-agent-skill-ninja` | 9.3.5（UX 对照） | 超出边界的对照项 |

---

## 5. 后续动作

1. **待核验**：网络条件具备时逐条核验（内容是否对应、许可、活跃度、是否归档），结果以**补记**追加到本文件，不就地改写既有条目；
2. **采纳即登记**：任一参考被采纳为设计或实现依据时，须在对应设计 / 计划文档中登记来源与采纳理由；
3. **不构成承诺**：本文件不构成任何里程碑的实现承诺，也不改变需求文档第 9 章的验收口径；
4. **边界优先**：当参考做法与需求边界冲突时（例如自动下载安装、symlink 单一原件、插件运行时执行），以**需求文档的边界与排除项为准**。

---

**登记结束**。本文件只登记参考线索与可达性结果；所有 GitHub 链接的内容核验待网络条件具备后补记。
