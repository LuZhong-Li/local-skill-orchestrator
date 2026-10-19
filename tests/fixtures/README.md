# 测试夹具

通用构造器位于 `tests/helpers/`：

- `temp.ts`：自动清理的临时目录；
- `skill.ts`：Skill 正文与元文件；
- `host.ts`：宿主根、启用 / 禁用副本；
- `plugin.ts`：插件 manifest 与目录；
- `backup.ts`：真实备份载体；
- `git-daemon.ts`：回环 git daemon 与 Windows 进程树收尾。

归档安全样本、bench N=5000 大夹具等特殊构造继续保留在对应测试文件内，但临时目录统一经 `makeTempDir`。测试文件不得直接调用 `mkdtemp`；`npm run check:test-fixtures` 负责反回潮。
