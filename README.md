# skill-manager

Skill 元信息管理器：统一管理环境内已安装 Skill 的元数据，负责登记、索引、安装、卸载、启用、禁用、更新、校验、依赖检查与备份导入导出。

**边界**：只管理 Skill 的元信息与文件编排，不执行、不解释、不介入任何被管理 Skill 的业务逻辑。

## 当前状态

**一期已收官**：功能面没有已知的未实现项，交付盘点见 [一期收官盘点](docs/one-summary.md)。

| 交付面   | 内容                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 指令     | 契约清单的 16 条全部实现：环境与配置、登记与查询、生命周期、校验与依赖、备份导出导入与恢复                |
| 内核     | TypeScript，零界面依赖，编译为独立可执行文件随应用分发                                                    |
| 桌面外壳 | Electron + Vue 3：仪表盘、详情、安装、校验报告与确认流程；可打包为安装包与便携单文件                      |
| 契约     | 五份规范文档与五份 JSON Schema，字段一致性由测试守住                                                      |
| 验证     | 358 项测试（单元 242、契约 55、端到端 61）、构建期检查、界面冒烟                                          |
| 持续集成 | GitHub Actions：推送主干 / 合并请求 / 手工触发，Windows 与 Linux × 声明版本，门禁与本地同口径，产物可下载 |
| 宿主分发 | `--host <宿主>` 把 Skill 分发到宿主真实根；首批支持 Claude / Codex / Cursor / 豆包与两个通用目标          |

## 快速开始

内核为 TypeScript，可直接以 Node 运行，无需安装依赖之外的任何环境：

```bash
node kernel/entry/cli.ts init --workspace <工作区路径>   # 建立工作区与索引
node kernel/entry/cli.ts scan --workspace <工作区路径>   # 扫描并把已有 Skill 登记进索引
node kernel/entry/cli.ts list --workspace <工作区路径>   # 列出已管理的 Skill
```

写操作（安装、卸载、启用、禁用、刷新、导入、配置写入）在非交互环境下需要显式给出 `--yes`；
不确定影响范围时先用 `--dry-run` 预演。

分发到宿主真实根（`--host` 与 `--target` **正交**：前者决定分发到哪个宿主，后者决定工作区内的目标位置）：

```bash
node kernel/entry/cli.ts config set host.claude.root ~/.claude/skills   # 可选：覆盖宿主真实根
node kernel/entry/cli.ts install <来源> --host claude --yes            # 分发到 Claude 的技能根
node kernel/entry/cli.ts disable <标识> --host claude --yes            # 在宿主根内切换可见性（目录不动）
```

宿主标识取值来自宿主注册表（含按路径类分条的取值，如 `cursor-rules`）；写工作区之外属高影响操作，非终端环境必须给出 `--yes`。

桌面外壳：

```bash
npm run dev -w @skill-manager/gui    # 开发模式启动界面
npm run smoke:gui                    # 启动应用并经调试协议校验界面
npm run pack:win -w @skill-manager/gui   # 打包 Windows 安装包与便携单文件
```

## 仓库结构

| 目录       | 内容                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| `docs/`    | 需求、架构、界面设计与五份契约规范，另有调研与评审记录                   |
| `kernel/`  | 元数据内核。承载指令调度、领域服务与文件存储三层，**不依赖任何界面框架** |
| `gui/`     | Electron 桌面外壳。只承担视图职责，所有操作通过调用内核指令完成          |
| `schemas/` | JSON Schema，供校验能力与编辑器提示使用                                  |
| `scripts/` | 构建、打包与构建期强制检查脚本                                           |
| `tests/`   | 单元、契约与端到端测试                                                   |

## 常用命令

```bash
npm test              # 单元、契约与端到端测试
npm run check         # 契约校验与分层校验
npm run typecheck     # 类型检查
npm run lint          # 静态检查
npm run format        # 格式化
npm run format:check  # 格式检查
npm run build         # 构建内核可执行文件与桌面外壳
npm run smoke:kernel  # 内核侧缩减冒烟（不启动 Electron）
npm run check:node    # 版本声明守卫（与 .nvmrc 比对）
npm run smoke:gui     # 界面冒烟（需图形会话）
```

## 持续集成

每次推送到 `main` / `release/**` / `hotfix/**`、以及针对 `main` 的合并请求（打开 / 同步 / 重新打开）和手工触发时，GitHub Actions 会运行同一套门禁；同一分支的连续提交只以最新一次结论为准。

| 项目     | 内容                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| 任务矩阵 | `ubuntu-24.04` 与 `windows-latest`，Node 版本由前置任务读取 `.nvmrc` 生成并断言与声明一致      |
| 步骤     | 版本守卫 → 依赖安装 → 契约与分层校验 → 类型检查 → 代码规范 → 格式检查 → 测试 → 构建 → 缩减冒烟 |
| 产物     | 内核可执行文件与桌面构建产物，命名含平台 / 架构 / 运行标识，保留 14 天；失败时另附诊断产物     |
| 失败口径 | 任一组合失败即整次运行失败；失败可定位到具体步骤与原因，后续步骤不再执行、不产出产物           |

运行入口与产物下载都在仓库的 Actions 页：进入某次运行后可在 **Artifacts** 区下载产物，在 **Summary** 区查看各 job 的步骤耗时与失败定位；本地复现只需按上表顺序执行「常用命令」中的同名命令。

## 文档入口

- [需求规格](docs/requirements.md)
- [系统架构](docs/architecture.md)
- [界面设计](docs/ui-design.md)
- [契约规范](docs/specification/)
- [一期收官盘点](docs/one-summary.md)
- [文档阶段小结](docs/reviews/2026-10-13-documentation-milestone.md)

## 许可证

[MIT](LICENSE)
