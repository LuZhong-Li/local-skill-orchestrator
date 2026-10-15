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

| 目录         | 内容                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| `main/`      | 主进程：窗口、生命周期、把渲染层请求转成内核调用                                          |
| `bridge/`    | G-02 内核桥接器：子进程调用、结果解析、十五条指令的门面（纯 Node，可独立测试）            |
| `preload/`   | 预加载脚本：`contextBridge` 暴露四个方法的最小白名单，构建为 CommonJS                     |
| `renderer/`  | Vue 3 视图层：仪表盘、详情、安装、校验报告、确认弹窗                                      |
| `packaging/` | electron-builder 配置（Windows：安装包 + 免安装单文件，产物输出到仓库根 `build/desktop`） |

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
`resources/kernel/` 下的独立可执行文件。三者都可用环境变量覆盖：

| 环境变量                       | 用途                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `SKILL_MANAGER_WORKSPACE`      | 工作区根目录；未设置时取 `SKILL_MANAGER_HOME`，再退到用户主目录下的 `.skill-manager` |
| `SKILL_MANAGER_KERNEL_COMMAND` | 内核启动命令                                                                         |
| `SKILL_MANAGER_KERNEL_ENTRY`   | 内核入口参数，多个参数以空格分隔                                                     |

## 依赖安装说明

Electron 的运行时二进制在部分网络环境下无法从默认地址下载。此时可指定镜像后重新安装：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm install
```
