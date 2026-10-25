# Bug 报告：install 崩溃 0xC0000409（Node cpSync × 中文源路径）

> 状态：**待处理（上游 Node 运行时 bug，skill-manager 需绕行）**
> 报告日期：2026-10-26 · 首次发现：2026-10-25
> 环境：Windows 10.0.26300 · Node v24.14.1（`C:\Users\HW\AppData\Local\Programs\nodejs\node.exe`）· skill-manager 0.7.0（源码运行）
> 标签：`runtime` · `windows` · `fs.cpSync` · `非 ASCII 路径`

## 现象

```powershell
node kernel/entry/cli.ts install "D:\树根\vibe-knowledge-video-skill" --host doubao --workspace "C:\Users\HW\.skill-manager" --yes
```

进程崩溃，退出码 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN），**无 JS 异常、无堆栈可捕获**。
`--library-only` 同样崩溃；`--dry-run` 正常（校验/计划阶段不崩）。

崩溃后中心库目录 `skills/<id>/` 已被创建但内容为空（`mkdirSync` 先执行、复制中断），
残留空目录会使后续 `scan` 登记一个空 skill。

## 根因（已最小复现，非 skill-manager 业务代码缺陷）

崩溃发生在 **Node `fs.cpSync({recursive:true})` 复制源路径含非 ASCII（中文）字符的目录**时。
最小复现完全不经过 skill-manager：

```powershell
$env:Path = "C:\Users\HW\AppData\Local\Programs\nodejs;" + $env:Path
New-Item -ItemType Directory -Path "C:\Users\HW\中文源测试" -Force
Set-Content -Path "C:\Users\HW\中文源测试\a.txt" -Value "x"
node -e "const {cpSync}=require('node:fs'); cpSync('C:/Users/HW/中文源测试','C:/Users/HW/zh-dst',{recursive:true,force:true});"
# → 进程崩溃 0xC0000409；zh-dst 可能已创建但内容为空
```

### 证据矩阵（8 组对照实测，2026-10-25）

| # | 源路径 | 目标路径 | 文件 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 中文 `D:\树根\vibe-knowledge-video-skill`（413 文件 / 47.5MB） | 英文 | 全量 | 💥 崩溃 |
| 2 | 中文 `...\templates\tools` | 英文 | 40 个小文本 | 💥 崩溃 |
| 3 | 中文 `C:\Users\HW\中文源测试` | 英文 | 1 个 | 💥 崩溃 |
| 4 | 英文（同内容，601 文件） | 英文 | 全量 | ✅ 正常 |
| 5 | 英文 | 中文目录名 | 1 个 | ✅ 正常 |
| 6 | 英文（含中文**文件名**） | 英文 | 2 个 | ✅ 正常 |
| 7 | 英文（D 盘） | 英文（D 盘） | 50 个 | ✅ 正常 |
| 8 | 中文源，**逐文件 `copyFileSync`** | 英文 | 413 个 | ✅ 正常 |

**触发规律**：仅「源路径含中文 + `cpSync` 递归」组合触发；
目标路径中文、文件名中文、文件规模、盘符均无关；逐文件复制完全不触发。

**排除项**：不是参数非法（`{recursive,force}` 为标准用法）；不是路径非法（`copyFileSync`
复制同路径成功）；不是 skill-manager 逻辑（裸脚本独立复现）；不是大文件/并发。

**崩溃层**：进程级原生崩溃（0xC0000409），位于 Node 运行时内部链路
（`node:fs` JS 包装 → libuv → Windows 文件系统 API）。应用层无法 try/catch。
是否 Node JS 层或更底层 API 触发，需 Node 官方调试栈确认（2026-10-25 检索无公开记录）。

## 影响

1. **skill-manager**：`install` / `update` / `reconcile --action accept` 等所有走
   `copyTree()` / `replaceTree()`（内部 `cpSync`）的路径，遇到中文路径 skill 全部崩溃。
2. **更广**：任何在 Windows + Node v24 上用 `cpSync` 递归复制中文路径的工具
   （npm / 构建脚本 / 备份工具）同样受影响。

## 修复建议（skill-manager 侧绕行）

崩溃不抛 JS 异常，`try/catch` 捕获不到，**必须替换实现**：

- **首选**：`kernel/store/library-fs/index.ts` 的 `copyTree()` / `replaceTree()`
  改为 `readdirSync` + `copyFileSync` 逐文件实现（证据 #8 已验证 413 文件中文源正常）。
  `deliverFiles()` 的逐文件分支已有同思路代码可复用。
- 备选：源路径含非 ASCII 字符时切换逐文件分支（需自行实现 ASCII 检测）。
- 收尾：`builtin-skills.ts` 用 `import.meta.url` 定位内置技能目录，
  编译成 CJS/SEA 后 `import.meta` 为空导致 `ERR_INVALID_URL`（`build/kernel/skill-manager.exe`
  0.1.0 同因崩溃）——若未来要做单文件产物，需改为编译期注入路径。
  另：ESM bundle 被 `yaml` 的动态 `require('process')` 挡住（"Dynamic require is not supported"）。

## 复现与回归

- 复现：上面最小复现命令（1 文件即可，无需 skill 内容）。
- 回归验证：用中文路径 skill 跑通 `install` 全流程（中心库 + 宿主落位 + 账本写入），
  再对英文路径 skill 回归一遍。

## 临时绕过（本次已用，待修复后移除）

手动落位三处副本（中心库 / 工作区目标 / 宿主真实根）+ `scan` 登记 + 手动补 `host_landings.yaml` 账本，
`validate` 通过。链路本身工作正常，仅 `install` 的复制步骤受上游 bug 阻塞。
