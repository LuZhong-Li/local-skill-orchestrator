# 桌面外壳（gui）

Electron 视图层。它只做三件事：把用户操作翻译成一次内核调用、把内核结果如实呈现、
把写操作交给「预览 → 确认 → 执行」的统一流程。

## 边界

- 渲染层不接触 Node，也不读写工作区的任何文件；数据源只有内核的标准输出。
- 渲染层不得引用内核内部模块（`kernel/dispatch`、`kernel/core`、`kernel/store`、`kernel/entry`），
  这条由 `npm run check:layer` 强制校验。
- 哪些指令需要确认由**内核**的策略层判定，界面不复制该规则：桥接器不预设写操作清单，
  内核因缺少跳过选项而拒绝时，界面转入预览与确认流程。

## 目录

| 目录         | 内容                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `main/`      | 主进程：窗口、生命周期、把渲染层请求转成内核调用；`updates/` 承载更新检查、设置与运行期调度 |
| `bridge/`    | G-02 内核桥接器：子进程调用、结果解析、十七条指令的门面（纯 Node，可独立测试）              |
| `preload/`   | 预加载脚本：`contextBridge` 暴露内核四方法与更新检查白名单，构建为 CommonJS                 |
| `renderer/`  | Vue 3 视图层：仪表盘、详情、安装、校验报告、全机盘点与动作确认、更新检查                    |
| `packaging/` | electron-builder 配置（Windows：安装包 + 免安装单文件，产物输出到仓库根 `build/desktop`）   |

## 常用命令

```bash
npm run dev -w @skill-manager/gui        # 开发模式（electron-vite dev）
npm run build -w @skill-manager/gui      # 构建三端产物到 gui/out
npm run typecheck -w @skill-manager/gui  # vue-tsc 类型检查
npm run pack:win -w @skill-manager/gui   # 构建并打包 Windows 目标
npm run smoke:gui                        # 启动应用并经调试协议校验界面（需要图形会话）
```

## 内核路径

默认在开发模式下用 `node` 运行仓库内的 `kernel/entry/cli.ts`，打包后调用
`resources/kernel/` 下的独立可执行文件（由 `npm run build:kernel` 生成，
打包时自动随应用复制）。三者都可用环境变量覆盖：

| 环境变量                       | 用途                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `SKILL_MANAGER_WORKSPACE`      | 工作区根目录；未设置时取 `SKILL_MANAGER_HOME`，再退到用户主目录下的 `.skill-manager` |
| `SKILL_MANAGER_KERNEL_COMMAND` | 内核启动命令                                                                         |
| `SKILL_MANAGER_KERNEL_ENTRY`   | 内核入口参数，多个参数以空格分隔                                                     |
| `SKILL_MANAGER_USER_DATA_DIR`  | 覆盖 Electron `userData` 目录；用于 GUI 冒烟隔离，正常使用无需设置                   |

## 更新检查

- 手动入口在顶部工具栏；检查只读，结果按「可更新 / 已是最新 / 不可检查 / 检查失败」分组。
- 执行更新仍走既有的「预览 → 确认 → `update <id> --ref <tag> --yes`」链路；取消不会调用执行通道。
- 定期与即时检查默认关闭。设置写入 Electron `userData/settings.json`，只有切换开关时才写入；
  定期检查固定 6 小时、仅在应用运行期间存在，只提示不执行。应用不注册系统计划任务、登录项或启动项。
- `updates:report` 仅在没有用户操作时推送提示；有可更新项才点亮角标，无更新不打扰。

## 全机盘点与动作

- 空工作区与已初始化工作区都可进入「全机盘点」；`scan --inventory` 始终只读。
- 副本明细按分类给出推荐动作：untracked → 采纳，drift → 修复 / 接受，missing → 修复 / 不再跟踪，
  orphaned → 修复或采纳 / 清理，损坏 → 修复 / 清理，not_distributed → 修复。
- 点击动作只生成 `reconcile` 预览；对话框展示写入项、账本变化、备份、执行后分类与共享根全部消费宿主。
  只有显式确认才附带 `--apply --yes`；接受与清理另有破坏性二次确认。
- 插件 `x-` 宿主只允许 track / repair / clean / forget；adopt / accept 禁用。
- 写动作只对 `root_role=user` 副本开放；未纳管清单只列 user 副本，system / platform / project 在角色分组只读展示并标注「由对应工具管理」。
- 「导出」把当前盘点 JSON 交给主进程，经保存对话框写入用户显式选择的文件；取消零写入，不修改工作区 / settings / 宿主。
- 不提供一键全修 / 全删，clean 不提供分类批量；执行后自动重新盘点。

## 依赖安装说明

Electron 的运行时二进制在部分网络环境下无法从默认地址下载。此时可指定镜像后重新安装：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm install
```
