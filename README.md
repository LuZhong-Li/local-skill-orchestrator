# skill-manager

Skill 元信息管理器：统一管理环境内已安装 Skill 的元数据，负责登记、索引、安装、卸载、启用、禁用、更新、校验、依赖检查与备份导入导出。

**边界**：只管理 Skill 的元信息与文件编排，不执行、不解释、不介入任何被管理 Skill 的业务逻辑。

## 当前状态

处于**一期实现阶段**。文档基线已完成并冻结，仓库骨架已建立，内核已落地存储层、元数据模型、
生命周期编排、校验引擎、依赖分析、备份与导入导出，**一期指令清单的 15 条指令全部可用**。

尚未落地的部分：`schemas/` 下的 JSON Schema、以及 Electron 桌面外壳。

## 仓库结构

| 目录       | 内容                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| `docs/`    | 需求、架构、界面设计与四份契约规范，另有调研与评审记录                   |
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
npm run build         # 构建内核与桌面外壳
```

内核为 TypeScript，可直接以 Node 运行，例如 `node kernel/entry/cli.ts scan --workspace <路径>`。

## 文档入口

- [需求规格](docs/requirements.md)
- [系统架构](docs/architecture.md)
- [界面设计](docs/ui-design.md)
- [契约规范](docs/specification/)
- [文档阶段小结](docs/reviews/2026-10-13-documentation-milestone.md)

## 许可证

[MIT](LICENSE)
