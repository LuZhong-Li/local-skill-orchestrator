# 插件格式规范

| 项目 | 内容 |
|---|---|
| 文档名称 | 插件格式规范（声明式 host-profile 插件） |
| 文档路径 | `docs/specification/plugin-format.md` |
| 规范版本 | `1` |
| 契约角色 | 第六份契约规范：定义 `plugin.json` manifest、`plugin_index.yaml`、第三方宿主命名空间与声明式插件生命周期 |
| 依据 | 需求 9.3.5（M4b-R1 ~ R5）、9.5（不做插件代码沙箱/托管）、9.3.6（M5 内置注册表边界）；`docs/design/m4b-plugin-ecosystem.md`、`docs/plan/m4b-plugin-ecosystem.md` |
| 边界 | 本规范只允许声明式插件；**不加载、不执行、不托管任何第三方代码**。插件不是 Skill，不进入 Skill 索引、Skill 卡片或 M4a 更新检查。 |

---

## 1. 目的与不可变约束

本规范解决三件事：

1. 用一个独立 manifest 描述第三方宿主 profile，使新宿主可以只靠数据声明；
2. 用独立 `plugin_index.yaml` 登记插件的状态、来源审计与校验结论；
3. 用机械可验证的命名空间把第三方能力与 M5 内置宿主彻底隔离。

不可变约束：

| # | 约束 |
|---|---|
| P-01 | 插件是能力扩展载体，不是被管理 Skill；插件记录不得写入 `skill_index.yaml`。 |
| P-02 | 插件包只允许 manifest 与静态资源；禁止 JS、原生库、可执行文件与任何代码入口。 |
| P-03 | 第三方宿主 canonical id 必须以 `x-` 开头，且与内置 7 个宿主 id 不相交。 |
| P-04 | 内置宿主注册表、`FORM_BY_HOST`、`HostAdapter` 与 `host.*` 配置均为内核资产，插件不得覆盖、伪装或写入。 |
| P-05 | 插件默认 `disabled`；安装/登记不等于启用。 |
| P-06 | 第三方 manifest 不得声明安全控制字段；出现即整插件拒绝。 |
| P-07 | 本规范不新增指令；插件能力通过既有指令的 `--kind plugin` 消费面承载。 |

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| 插件 | 一个声明式包，包含 `plugin.json` 与静态资源；可贡献若干 host profile。 |
| host profile | 一个第三方宿主的目录/文件落位声明，复用 `skill` / `rules` / `entry` 三种形态。 |
| canonical host id | 插件 host profile 在合并视图中的唯一标识：`x-<plugin_id>-<host_key>`。 |
| 插件索引 | `<workspace>/plugin_index.yaml`，插件状态的唯一事实源。 |
| 内置注册表 | `kernel/core/hosts/registry-data.ts`，M5 随内核交付的冻结宿主注册表。 |

---

## 3. `plugin.json` manifest

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `manifest_version` | 字符串 | 是 | manifest 格式版本；当前仅 `"1"` |
| `plugin_id` | 字符串 | 是 | 插件标识；小写短横线，1 ~ 64 字符，且与目录名一致 |
| `name` | 字符串 | 是 | 展示名称；1 ~ 128 字符 |
| `version` | 字符串 | 是 | 插件版本；semver 正式版，不接受 prerelease |
| `description` | 字符串 | 否 | 展示说明 |
| `author` | 字符串 | 否 | 作者/发布者展示信息；不构成可信身份 |
| `license` | 字符串 | 否 | 许可证标识 |
| `compatibility` | 对象 | 是 | 工具与插件 API 兼容声明；见 3.1.1 |
| `capabilities` | 数组 | 是 | 本期只能是 `["host_profile"]` |
| `hosts` | 数组 | 是 | 1 ~ 8 个 host profile；见 3.2 |
| `source` | 对象 | 否 | 来源审计信息；**不得用于隐式网络获取** |

#### 3.1.1 `compatibility`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `skill_manager` | 字符串 | 是 | 合法 semver 范围；当前工具版本必须满足 |
| `plugin_api` | 字符串 | 是 | 插件 API 版本；当前仅 `"1"`（本规范简称 apiVersion） |

`compatibility` 只允许上述两个字段。版本范围非法、当前工具不满足或 API 版本不支持时，插件不得加载。

#### 3.1.2 `source`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | 字符串 | 是 | `local` / `git` / `archive`；仅用于审计展示 |
| `url` | 字符串 | 否 | 远端地址；仅记录，不由 manifest 触发获取 |
| `ref` | 字符串 | 否 | 远端引用；仅记录 |
| `location` | 字符串 | 否 | 本地位置；仅记录 |

安装来源以 CLI 位置参数为准；manifest 内的 `source` 不参与来源解析、不发起网络请求。

### 3.2 host profile 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_key` | 字符串 | 是 | 插件内局部宿主键；1 ~ 32 字符，小写短横线，同一插件内唯一 |
| `display_name` | 字符串 | 是 | 展示名称；1 ~ 128 字符 |
| `form` | 字符串 | 是 | 仅 `skill` / `rules` / `entry`；一个 profile 只声明一种形态 |
| `roots` | 数组 | 是 | 1 ~ 4 个落位根；见 3.3 |
| `capability` | 对象 | 否 | 仅允许 `auto_discovery`、`strict_filename` 两个布尔字段 |
| `render_policy` | 对象 | 是 | 仅允许 `field_mode: "standard6"` 与可选 `degrade_form`；见 3.4 |

profile 不得声明 `adapter_ref`、`host_id`、`security_control_evidence`、`allowed_extensions` 或任何未登记字段。未知字段一律拒绝。

### 3.3 `roots[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | 字符串 | 是 | `skill` 或 `rules`；必须与 `form` 匹配 |
| `path_template` | 字符串 | 是 | 目标路径模板；见下方展开规则 |
| `scope` | 字符串 | 是 | `project` 或 `global` |
| `platform` | 字符串 | 否 | `any` / `darwin` / `linux` / `win32`；省略按 `any` |

`form` 与 `kind` 的唯一合法组合：

| form | root.kind | 展开语义 |
|---|---|---|
| `skill` | `skill` | `path_template` 是技能目录；产物为其中的 `SKILL.md` |
| `rules` | `rules` | `path_template` 是规则文件路径；产物写入该文件 |
| `entry` | `rules` | 只产出待合并片段，**不落盘**；路径仅作展示 |

`path_template` 约束：

1. 必须是相对路径，使用 `/` 分隔；禁止绝对路径、盘符、反斜杠、空字节与 `..`；
2. 只允许一个受控占位符 `<skill_id>`；`skill` / `rules` 形态必须恰好出现一次，`entry` 可省略；
3. 不得包含未知占位符；长度不超过 512 字符；
4. `scope: project` 相对工作区展开；`scope: global` 必须由 `plugin.<plugin_id>.<host_key>.root` / `.rules_root` 显式提供宿主根，不得默认写到用户主目录；
5. 外部根写入沿用既有确认机制，且不得借模板越出已解析的根。

### 3.4 `render_policy`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `field_mode` | 字符串 | 是 | 本期仅 `standard6` |
| `degrade_form` | 字符串 | 否 | `none` / `rule_file`；默认 `none` |

`render_policy` 只允许上述字段。第三方不得声明 `host_declared`、扩展字段白名单、安全控制字段或任何自定义渲染函数。

### 3.5 manifest 资源上限

| 项目 | 上限 |
|---|---|
| manifest 文件大小 | 256 KiB |
| host profile 数量 | 8 |
| 单个 profile 的 roots 数量 | 4 |
| plugin_id | 64 字符 |
| host_key | 32 字符 |
| path_template | 512 字符 |

---

## 4. `plugin_index.yaml`

### 4.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | 字符串 | 是 | 当前 `"1"`；不支持时拒绝读取 |
| `tool_version` | 字符串 | 是 | 写入该索引的工具版本 |
| `generated_at` | 字符串 | 是 | 最近一次写入时间（UTC，秒级） |
| `config` | 对象 | 是 | 插件专用配置；只允许 `plugin.<plugin_id>.<host_key>.root` / `.rules_root` |
| `plugins` | 数组 | 是 | 插件记录；见 4.2 |

`plugin_index.yaml` 是**插件类型的唯一事实源**，与 `skill_index.yaml` 物理分离。两者各自原子写、各自加锁，不建立跨索引事务。

### 4.2 插件记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 字符串 | 是 | 插件标识；与 manifest 一致 |
| `kind` | 字符串 | 是 | 固定 `plugin` |
| `name` | 字符串 | 是 | 展示名称 |
| `version` | 字符串 | 是 | 插件版本 |
| `description` | 字符串 | 否 | 展示说明 |
| `author` | 字符串 | 否 | 作者/发布者 |
| `license` | 字符串 | 否 | 许可证 |
| `capabilities` | 数组 | 是 | 本期 `["host_profile"]` |
| `compatibility` | 对象 | 是 | 与 manifest 的兼容声明一致 |
| `source_url` | 字符串 | 否 | 来源审计 |
| `source_ref` | 字符串 | 否 | 来源引用审计 |
| `manifest_path` | 字符串 | 是 | 相对工作区：`./plugins/<id>/plugin.json` |
| `manifest_hash` | 字符串 | 是 | `sha256:` + 64 位小写十六进制 |
| `hosts` | 数组 | 是 | 合并前的 canonical host 记录；见 4.3 |
| `state` | 字符串 | 是 | `disabled` / `enabled` / `invalid`；新登记默认 `disabled` |
| `validation` | 对象 | 是 | 最近一次校验结论；见 4.4 |
| `installed_at` | 字符串 | 是 | 首次登记时间 |
| `updated_at` | 字符串 | 是 | 最近一次记录变更时间 |

### 4.3 插件记录中的 host 项

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `host_id` | 字符串 | 是 | canonical id：`x-<plugin_id>-<host_key>` |
| `host_key` | 字符串 | 是 | manifest 中的局部键 |
| `display_name` | 字符串 | 是 | 展示名称 |
| `form` | 字符串 | 是 | `skill` / `rules` / `entry` |
| `roots` | 数组 | 是 | 与 manifest 一致的 roots 副本 |
| `capability` | 对象 | 否 | 与 manifest 一致 |
| `render_policy` | 对象 | 是 | 与 manifest 一致 |

### 4.4 `validation`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | 字符串 | 是 | `ok` / `invalid` |
| `errors` | 数组 | 是 | 问题码列表；`invalid` 时不得为空 |
| `last_scan_at` | 字符串 | 否 | 最近一次插件扫描时间 |

### 4.5 插件索引示例

```yaml
schema_version: "1"
tool_version: 0.2.0
generated_at: 2026-10-17T00:00:00Z
config:
  plugin.acme-tools.zed.root: /home/user/.zed/skills
plugins:
  - id: acme-tools
    kind: plugin
    name: Acme Tools
    version: 1.0.0
    capabilities:
      - host_profile
    compatibility:
      skill_manager: ">=0.2.0 <1.0.0"
      plugin_api: "1"
    manifest_path: ./plugins/acme-tools/plugin.json
    manifest_hash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    hosts:
      - host_id: x-acme-tools-zed
        host_key: zed
        display_name: Zed
        form: rules
        roots:
          - kind: rules
            path_template: .zed/rules/<skill_id>.md
            scope: project
        render_policy:
          field_mode: standard6
    state: disabled
    validation:
      status: ok
      errors: []
      last_scan_at: 2026-10-17T00:00:00Z
    installed_at: 2026-10-17T00:00:00Z
    updated_at: 2026-10-17T00:00:00Z
```

---

## 5. 发现、命名与生命周期

### 5.1 存放与发现

1. 插件根固定为 `<workspace>/plugins/<plugin_id>/`，manifest 固定为其中的 `plugin.json`；
2. 目录名必须与 `plugin_id` 一致；符号链接、越界路径与多级嵌套均拒绝；
3. 发现只读取一层插件目录；插件登记必须由 `install --kind plugin` 显式触发；
4. `scan --kind plugin` 只核对已登记插件并报告未登记候选，不自动登记、不自动启用；
5. 插件目录递归检查不得出现代码扩展名：`.js`、`.mjs`、`.cjs`、`.node`、`.exe`、`.dll`、`.dylib`、`.so`。

### 5.2 canonical 命名

| 对象 | 规则 |
|---|---|
| canonical host id | `x-<plugin_id>-<host_key>` |
| 前缀 | 必须为 `x-`；内置宿主 id 不得以 `x-` 开头 |
| 冲突 | 与内置 id 冲突、与其它插件 canonical id 冲突时，整插件拒绝，不部分加载 |
| 配置键 | `plugin.<plugin_id>.<host_key>.root` / `.rules_root`；禁止写 `host.<id>.*` |

### 5.3 状态机

| 当前状态 | 事件 | 结果 |
|---|---|---|
| 无记录 | `install --kind plugin` 成功 | `disabled`（默认不信任） |
| `disabled` | `enable --kind plugin` 校验通过 | `enabled` |
| `enabled` | `disable --kind plugin` | `disabled`；不删除任何宿主文件 |
| 任意 | `scan --kind plugin` 发现 manifest 失效 | `invalid`，不加载 |
| `invalid` | 修复后重新 `enable` | `enabled`（校验通过时） |
| 任意 | `uninstall --kind plugin` | 删除记录与插件包；不触碰 Skill 索引 |

插件停用或删除后，已落在第三方宿主根中的副本**保留**；本期不建立宿主落位账本，不自动删除、不回滚。

---

## 6. 安全约束

| 项目 | 规则 |
|---|---|
| 代码 | 不加载、不执行、不托管；不调用 `import()` / `require()` / `eval()` / `new Function()` |
| 安全控制字段 | 任意层级出现 `security_control_evidence`、`disable-model-invocation`、`allowed-tools`、`permissions`、`requires` 即整插件拒绝 |
| 路径 | 模板与插件目录均做 containment 校验；禁止绝对路径、`..`、符号链接与未知占位符 |
| 来源 | 安装来源只由 CLI 参数决定；manifest `source` 仅审计，不触发网络 |
| 资源 | manifest 256 KiB、8 个 profile、4 个 roots/profile；超出整插件拒绝 |
| 隔离 | 插件失败只影响自身；内置注册表、`FORM_BY_HOST` 与其它插件不受影响 |

---

## 7. 问题码与退出码

### 7.1 新增编号

| 问题码 | 级别 | 类别 | 触发条件 | 退出码派生结果 |
|---|---|---|---|---|
| `E-ID-004` | 错误 | ID | 插件标识不符合命名规范，或与所在目录名不一致 | `1` |
| `E-ID-005` | 错误 | ID | 插件标识在插件登记中重复 | `1` |
| `E-VER-002` | 错误 | VER | manifest 版本、插件 API 版本或工具兼容范围不受支持 | `3`（对象为插件 manifest/配置文件） |
| `E-CONFLICT-004` | 错误 | CONFLICT | canonical 宿主命名空间与内置或其它插件冲突 | `1` |

### 7.2 复用编号

| 问题码 | 类别 | 触发条件 | 退出码派生结果 |
|---|---|---|---|
| `E-FIELD-001` | FIELD | manifest 必填字段缺失 | `1` |
| `E-FIELD-002` | FIELD | 字段取值不在允许范围（含禁止字段） | `1` |
| `E-FIELD-003` | FIELD | 字段长度超限 | `1` |
| `E-FIELD-005` | FIELD | 字段类型不符 | `1` |
| `E-PATH-001` | PATH | 路径越界、绝对路径或不可达 | `1` |
| `E-INPUT-002` | INPUT | `--kind` 或宿主取值非法、重复给出 | `2` |
| `E-SRC-001` ~ `E-SRC-010` | SRC | 插件来源获取失败（沿用既有来源口径） | `4` |
| `E-YAML-001` | YAML | 插件索引无法解析 | `3`（索引/配置文件） |
| `E-VER-001` | VER | 插件索引 `schema_version` 不受支持 | `3` |
| `E-ENV-002` | ENV | 工作区/插件索引不完整 | `1` |
| `E-IO-001` / `E-IO-002` | IO | 插件文件读写/原子写失败 | `5` |
| `E-LOCK-001` | LOCK | 插件索引锁失败 | `5` |

不新增退出码，不改变既有 0 ~ 6 的语义。`E-VER-002` 的对象限定为插件 manifest/配置文件，因此命中结果规范第 5.2 节第 3 步。

---

## 8. 兼容与版本策略

1. `manifest_version` 只接受 `"1"`；未来新版本必须新增规范版本与迁移说明；
2. `compatibility.plugin_api` 只接受 `"1"`；API 主版本变化时拒绝加载；
3. `compatibility.skill_manager` 必须是合法 semver 范围，当前 `TOOL_VERSION` 必须满足；
4. 插件版本只接受 semver 正式版；prerelease 不进入本期登记；
5. 不支持版本的插件保留为 `invalid` 记录供查看，不加载 profile、不删除插件包。

---

## 9. 最小合法 manifest 示例

```json
{
  "manifest_version": "1",
  "plugin_id": "acme-tools",
  "name": "Acme Tools",
  "version": "1.0.0",
  "compatibility": {
    "skill_manager": ">=0.2.0 <1.0.0",
    "plugin_api": "1"
  },
  "capabilities": ["host_profile"],
  "hosts": [
    {
      "host_key": "zed",
      "display_name": "Zed",
      "form": "rules",
      "roots": [
        {
          "kind": "rules",
          "path_template": ".zed/rules/<skill_id>.md",
          "scope": "project"
        }
      ],
      "render_policy": {
        "field_mode": "standard6"
      }
    }
  ]
}
```

---

## 10. 明确不做

| 项 | 状态 |
|---|---|
| 代码插件（ESM / 原生 / 外部可执行） | 不做 |
| 全局插件目录 | 不做；仅工作区级 |
| 插件更新检查 | 不做；手动 `uninstall` + `install` |
| 第三方安全控制字段 | 禁止 |
| 新渲染算法 / 新来源 / 新校验 / 新指令 | 不做 |
| 插件市场、在线检索、自动分发 | 不做 |

---

## 11. 变更记录

| # | 日期 | 变更 |
|---|---|---|
| 1 | 2026-10-17 | 建立第六份契约规范：定义声明式 host-profile 插件 manifest、独立 `plugin_index.yaml`、canonical `x-` 命名空间、生命周期、安全约束与问题码；新增 `schemas/plugin_manifest.schema.json` 与 `schemas/plugin_index.schema.json` |

