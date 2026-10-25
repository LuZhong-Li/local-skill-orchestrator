## M0-M4 完整文档流水线引擎

### 里程碑完成情况
- ✅ **M0**: 领域模型 + 问题分类 + 流水线规划
- ✅ **M1**: IntelligenceProvider 抽象 + Meta-Skill 注册表 + Pipeline Runner
- ✅ **M2**: 需求追问状态机 + 决策记录 + 收敛门
- ✅ **M3**: 文档包交付层 + CLI 接线 + Pilot e2e
- ✅ **M4**: LLM Provider 支持（OpenAI 兼容 / Doubao / Claude）

### 主要功能
1. 问题智能分类（new-feature/refactor/bugfix/docs/research）
2. 自动化流水线规划
3. 追问状态机（收敛前先问问题）
4. 多 LLM Provider 支持（Stub/Doubao/Claude/OpenAI）
5. Markdown 文档包输出（含 INDEX.md）
6. 完整 CLI 支持

### 使用示例
```bash
# 使用 Stub provider（默认）
skill-manager pipeline run --problem "产品需求" --output-dir ./out --answers q1=a --answers q2=b --answers q3=c

# 使用 Doubao provider
skill-manager pipeline run --problem "产品需求" --output-dir ./out --answers q1=a --answers q2=b --answers q3=c --llm-provider doubao --llm-api-key "your-key"
```

### 提交历史
- `2389ed6` feat(core): M0 基础框架
- `1efce20` feat(core): M1 pipeline runner
- `951fe12` feat(core): M2 追问状态机
- `906e3f1` feat(core): M3 文档包输出
- `0384b7c` feat(core): M4 LLM provider 支持

### 检查清单
- [x] 所有测试通过
- [x] Typecheck 通过
- [x] Lint 通过
- [x] 复杂度检查通过
- [x] 架构图已更新