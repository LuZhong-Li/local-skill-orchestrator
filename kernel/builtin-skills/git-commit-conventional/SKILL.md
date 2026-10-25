# Conventional Commits 提交规范

## 概述

标准化 Git 提交信息格式，便于自动生成 CHANGELOG 和版本管理。

## 提交格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Type 类型

| Type     | 说明                   |
| -------- | ---------------------- |
| feat     | 新功能                 |
| fix      | 修复 bug               |
| docs     | 文档变更               |
| style    | 代码格式（不影响功能） |
| refactor | 重构                   |
| perf     | 性能优化               |
| test     | 测试相关               |
| chore    | 构建/工具变更          |

## 示例

```
feat(auth): add SSO login support

- support Google OAuth
- support GitHub OAuth
- fallback to email login

Closes #123
```

## 注意事项

- subject 不超过 50 字符
- body 每行不超过 72 字符
- 使用祈使句（"add" 不是 "added"）
- footer 写关闭的 issue 号
