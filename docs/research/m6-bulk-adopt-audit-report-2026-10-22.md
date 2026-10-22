# M6 批量采纳与审计报告导出技术调研

| 项目 | 内容 |
|---|---|
| 调研日期 | 2026-10-22 |
| 需求基线 | `docs/requirements.md` 9.3.10 M6（R20–R35） |
| 调研性质 | 只读调研；不实现代码、不定稿 API、不改变契约 |
| 当前状态 | 调研 1 完成；frontmatter 漂移字段集与 SARIF 映射待继续 |

## 1. dogfood 重名冲突边界

### 1.1 证据与统计口径

输入附件：

```text
C:\Users\HW\Downloads\skill-inventory.json
size:   558,479 bytes
sha256: 8778AA6B59732F833ECFB9AA666926EF17BA5523FD270DA896988E6090A5B400
```

盘点快照：

| 指标 | 数值 |
|---|---:|
| `copies` | 166 |
| `corrupt` | 0 |
| `missing` | 0 |
| `managed_consistent` | 1 |
| `untracked` | 165 |
| host 数 | 5（实际有副本的宿主为 codex / doubao） |
| role 分布 | user 20 / system 5 / platform 141 |

统计方法：

1. 按 inventory 的 `skill_id`（目录名）分组；
2. 读取每条副本的 `SKILL.md` frontmatter，再按归一化后的 `name` 分组；
3. 在同名组内比较 `name`、`description`、`version`；
4. 可采纳项取 `reconciliation.untracked_candidate=true`；当前共 165 条；
5. 现有 workspace 的 managed 集合从 inventory 的 `managed_consistent` 记录取得，当前仅 `agent-skill-creator`；
6. 额外检查 adopt 的真实标识来源。现有实现使用 frontmatter 归一化后的 `name` 作为 `skillId`，不是直接使用目录名。`[代码] kernel/dispatch/reconcile/adopt-source.ts:148-174`

### 1.2 重名结果

| 分组口径 | 唯一组数 | 跨 host 重名组 | 跨 role 重名组 | 重复副本额外数 |
|---|---:|---:|---:|---:|
| 目录名 `skill_id` | 166 | 0 | 0 | 0 |
| frontmatter `name` | 166 | 0 | 0 | 0 |

frontmatter 解析结果：

- 166/166 个副本的 `SKILL.md` frontmatter 均可解析；
- 166/166 的 `name` 合法；
- 166/166 的 `name` 与目录名一致；
- `description` 166/166 存在；
- 顶层 `version` 仅 25/166 存在，141 条缺失；
- 本附件没有同名多副本，因此“同名副本之间 name/description/version 是否一致”在当前样本中为 **N/A**，不能据此推断多副本漂移不会出现。

### 1.3 批量采纳冲突预估

| 选择范围 | 候选副本 | 当前 workspace 已占用 | 批内重名落败项 | 预计冲突/跳过 |
|---|---:|---:|---:|---:|
| 全部未纳管 | 165 | 0 | 0 | **0** |
| 仅 `--role user` | 19 | 0 | 0 | **0** |

说明：

- 当前 managed 标识 `agent-skill-creator` 没有对应的未纳管副本，因此不会命中“workspace 已存在同 ID”；
- 165 个未纳管副本的目录 ID 与 frontmatter name 均唯一，因此不会命中批内先到先得冲突；
- system 5 条、platform 141 条是否可被批量 adopt 仍受角色写保护与 R26 `--role` 语义约束，但本附件中它们同样不产生重名冲突。

### 1.4 对 R22 的结论与风险

1. 当前 dogfood 语料**没有覆盖任何重名冲突路径**；零冲突不能作为简化 R22 的充分证据。
2. R22 的 `skip + warning`、`--rename`、`--force` 必须用合成夹具验证，至少覆盖：
   - 同一 frontmatter name 出现在多个 host；
   - 同一 frontmatter name 出现在多个 role；
   - workspace 已有相同 ID 且内容一致；
   - workspace 已有相同 ID 但内容不同；
   - `--rename` 的稳定命名规则；
   - `--force` 是否仅允许覆盖中心库，是否仍受宿主写保护。
3. 现有冲突检查同时覆盖中心库目录、索引记录与目标副本；批量策略应复用这套判定，而不是只看 inventory 的目录名。`[代码] kernel/dispatch/reconcile/adopt-source.ts:267-313`

### 1.5 对 R33 的观察

当前快照有 141/166 条副本缺少顶层 `version`。如果 R33 把“缺失”无条件视为 `version_drift`，未来只要同一 skill 出现多宿主副本，就可能产生大量版本漂移噪声。

待设计裁决：

- 全部副本都缺 version：算 `insufficient`、`not_applicable`，还是 `version_drift`；
- 部分副本缺 version：是否仅对缺失项报 drift；
- 是否先读取 `metadata.version` 并与顶层 version 合并后再比较；
- `version` 相同但 `source_ref` 不同是否属于版本漂移，还是另一个来源字段。

## 2. Frontmatter 漂移字段集

> MainAgent 调研结论，来源：agentskills.io 规范 + Anthropic Claude Code Skills 文档。
> 官方规范：https://agentskills.io/specification
> Anthropic 文档：https://docs.anthropic.com/en/docs/claude-code/skills

### 2.1 现状事实

1. Agent Skills 规范定义的 `SKILL.md` 顶层 frontmatter 字段为：
   `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`。
   `name` / `description` 必需，其余可选。
2. 官方示例把 `author` 与 `version` 放在 `metadata` 内；顶层 `version` 是本项目为兼容既有工作区契约增加的归一化字段，不属于 Agent Skills 官方顶层字段。
3. `metadata` 是任意字符串键值映射，客户端可保存规范外属性；私有 key 不应被解释成宿主能力或业务字段。
4. `allowed-tools` 表明预批准工具，官方标记为实验性；它仍属于 Skill 行为契约，跨宿主副本不应静默分叉。
5. 当前 dogfood 的 166 个副本中，`name` / `description` 均为 166/166 存在，顶层 `version` 只有 25/166；因此“全部副本都缺 version”必须按元数据不完整处理，不能批量误报 drift。
6. 现有 inventory 的 `skill_id` 来自目录名；adopt 使用 frontmatter `name` 作为工作区 ID。R32 的分组键应固定为 audit 行的 `skill_id`，`name` 作为组内字段参与比较。

### 2.2 字段分类表（9 行）

| # | 字段 | 官方语义 / 本项目映射 | 多副本时应一致 | 判定 |
|---:|---|---|---|---|
| 1 | `name` | 官方必需；必须匹配父目录名 | 是 | 不一致报 `frontmatter_drift` |
| 2 | `description` | 官方必需；描述能力与使用时机 | 是 | 不一致报 `frontmatter_drift` |
| 3 | `license` | 官方可选；许可证名称或许可证文件引用 | 是 | 不一致报 `frontmatter_drift` |
| 4 | `compatibility` | 官方可选；运行环境要求 | 是 | 不一致报 `frontmatter_drift` |
| 5 | `allowed-tools` | 官方可选、实验性；预批准工具集合 | 是 | 不一致报 `frontmatter_drift` |
| 6 | `metadata.version` | 官方示例中的版本元数据 | 是 | 经回退链得到有效版本后参与 `version_drift` |
| 7 | 顶层 `version` | 本项目既有兼容字段；优先级高于 `metadata.version` | 是 | 参与 `version_drift`，且不能抹掉原 metadata |
| 8 | `metadata.author` | 官方示例中的来源/作者信息 | 否 | provenance 元数据，不参与 drift |
| 9 | `metadata.*` 私有键 | 官方允许的任意附加元数据 | 否 | 原样保留；不参与 drift，不解释语义 |

补充排除项：

- `targets` 属于工作区 `skill_meta` 契约，不是 Agent Skills 官方 `SKILL.md` frontmatter；不参与 frontmatter drift。
- `mcp-server` 没有 Agent Skills 官方定义；不得据此新增字段语义。
- `name` 在分组时若与目录 `skill_id` 不一致，应同时作为 frontmatter drift / 格式问题呈现；不能静默改 ID。

### 2.3 判定规则

1. 以 audit 行的 `skill_id` 聚合副本；少于 2 个副本时不比较任何字段，也不报 drift。
2. `name` / `description` / `license` / `compatibility` / `allowed-tools` 中任一字段，在组内出现两个或以上有效值，或将“有一个值 / 缺失”视为两个不同状态时，报 `frontmatter_drift`。
3. 某个 frontmatter 关键字段在全部副本中均缺失时，不报 drift；若需要提示，使用 note 级“元数据不完整”。
4. `version` 解析顺序固定为：顶层 `version` → `metadata.version` → missing。
5. 多副本组内有效 version 值不一致，或有值 / 缺失并存时，报 `version_drift`；全部副本均 missing 时只给 note，不报 drift。
6. 单副本即使缺少 `version`、`license` 等可选字段，也不产生 drift finding。

## 3. SARIF 2.1.0 映射

> MainAgent 调研结论，来源：GitHub SARIF 文档 + SARIF 2.1.0 schema。
> GitHub 文档：https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
> SARIF schema：https://json.schemastore.org/sarif-2.1.0.json
> OASIS SARIF 2.1.0：https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html

### 3.1 必需字段校准

SARIF 2.1.0 schema 中 `result` 的硬必需字段只有 `message`；`ruleId`、`level`、`locations` 在 schema 层是可选。为了让 GitHub Code Scanning 形成可筛选、可定位、跨运行稳定的 alert，建议每条审计 result 都提供：

| 字段 | 写法 | 理由 |
|---|---|---|
| `ruleId` | 本表 7 个稳定 ID 之一 | GitHub 用 ruleId 过滤和稳定跨 run 的告警 |
| `level` | `error` / `warning` / `note` | GitHub 用 level 过滤严重度 |
| `message.text` | 单句英文或中英资源化报告文案 | Code Scanning 将其作为告警标题 |
| `locations[]` | 至少一个 `physicalLocation.artifactLocation.uri` | 形成可定位的文件告警；缺失副本使用声明目标路径 |
| `partialFingerprints` | 自定义稳定键，如 `skillManagerAudit/v1` | 避免同一问题每次审计生成新告警 |

### 3.2 7 条 ruleId / level

| 审计状态 | ruleId | level | 说明 |
|---|---|---|---|
| `missing` | `W-MISSING-001` | `error` | targets 声明了宿主，但账本无 active 记录 |
| `undeclared` | `W-MISSING-002` | `note` | 副本存在，但不在 targets[] |
| `visibility_mismatch` | `W-MISSING-003` | `warning` | 账本 active，但可见性与 targets / 账本不符 |
| `unmapped` / `insufficient` | `W-MISSING-004` | `note` | 证据不足或 target 无法映射；message 区分具体原因 |
| `checksum_drift` | `W-DRIFT-001` | `warning` | 内容摘要漂移 |
| `frontmatter_drift` | `W-DRIFT-002` | `warning` | 多副本关键 frontmatter 字段不一致 |
| `version_drift` | `W-DRIFT-003` | `warning` | 多副本有效 version 不一致或有值/缺失并存 |

`distributed` 和 `workspace_only` 默认不生成 SARIF result；前者无问题，后者不是宿主分发期望。

`W-MISSING-*` / `W-DRIFT-002` / `W-DRIFT-003` 当前是 SARIF 报告规则标识，不等同于新增产品 finding code；若设计决定复用全局问题码，必须先登记问题码与结果契约。

### 3.3 artifactUri 与 PII

1. URI 使用 `/` 分隔并做 percent-encoding；不得输出反斜杠路径。
2. 副本位于仓库/工作区内时，优先输出相对 `artifactLocation.uri`，并使用 `uriBaseId: "%SRCROOT%"`；这是 GitHub Code Scanning 最容易建立文件关联的形态。
3. 宿主副本位于工作区外（dogfood 常见）时，不直接写含用户名的绝对 `file:///C:/Users/...` 路径；使用稳定的逻辑 URI，如 `hosts/<host_id>/skills/<skill_id>/SKILL.md`，配合 `uriBaseId: "SKILL_MANAGER_AUDIT"`。
4. `missing` 没有物理副本时，用 targets 声明的目标路径生成同一个逻辑 URI，并在 message 中标记 `target_path`。
5. 报告元信息中的 workspace 路径要做 home 前缀脱敏，例如 `~/workspace` 或 `<workspace>`；R30 的“不含用户名等 PII”优先于绝对路径可点击性。
6. 若要求所有 alert 都能在 GitHub 页面直接定位到真实仓库文件，则扫描目标必须限定在仓库根内；工作区外宿主副本只能保证 SARIF 结构可消费，不能保证 GitHub 文件内注释。

### 3.4 最小可用 SARIF 示例

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "skill-manager",
          "version": "0.6.0",
          "rules": [
            {
              "id": "W-DRIFT-002",
              "shortDescription": { "text": "Skill frontmatter drift" }
            }
          ]
        }
      },
      "originalUriBaseIds": {
        "SKILL_MANAGER_AUDIT": { "uri": "skill-manager://audit/" }
      },
      "results": [
        {
          "ruleId": "W-DRIFT-002",
          "level": "warning",
          "message": {
            "text": "Skill example is installed on claude and codex with inconsistent description."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "hosts/codex/skills/example/SKILL.md",
                  "uriBaseId": "SKILL_MANAGER_AUDIT"
                },
                "region": { "startLine": 1 }
              }
            }
          ],
          "partialFingerprints": {
            "skillManagerAudit/v1": "skill:example|host:codex|status:frontmatter_drift"
          }
        }
      ]
    }
  ]
}
```

校验：以上示例已使用 `ajv` + SARIF 2.1.0 JSON Schema 实测通过（`valid=true`）。

## 4. 合成夹具需求

dogfood 的 166 个副本中目录 ID、frontmatter name 均为唯一值，无法覆盖 R22 冲突路径；以下夹具必须独立构造，不能依赖真实 dogfood 数据。

| # | 冲突场景 | 夹具条件 | 预期 |
|---:|---|---|---|
| 1 | 同 frontmatter name 跨 host | 两个 host 各有 `name: same-skill` 的未纳管副本 | 第一个成功后，第二个默认 skipped + 冲突 warning |
| 2 | 同 frontmatter name 跨 role | user 与 system / platform 出现同名副本 | 非 user 角色保持写保护；user 项按 R22 策略处理 |
| 3 | workspace 已存在同 ID、内容一致 | 中心库与目标副本摘要相同 | 默认跳过并提示改用 track 或确认策略 |
| 4 | workspace 已存在同 ID、内容不同 | 中心库与目标副本摘要不同 | warning + 默认跳过；不得覆盖中心库 |
| 5 | `--rename` / `--force` 边界 | 预置同 ID、重名目标、非法后缀、共享根 | rename 生成稳定唯一 ID；force 仅覆盖允许范围；冲突/失败不得半写账本 |

夹具还需断言：

- 每项独立事务，单条失败不污染整批；
- skip / failed / succeeded 汇总与逐项 reason 完整；
- frontmatter 归一化、metadata 原样保留和未知字段 warning 不被冲突策略绕过；
- 预览在写入前显示源路径、目标 workspace 路径、frontmatter 摘要与冲突原因。
