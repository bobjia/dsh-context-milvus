---
id: ADR-0008-codex-adr-port-shared-bundle
type: decision-record
status: active
created: 2026-09-12
updated: 2026-09-12
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/core/src/adr-bundle.ts
    symbols:
      - createAdrBundle
      - AdrBundle
      - AdrTitle
    lines: [1, 81]
    git_commit: 53a11a6
  - file: packages/core/src/config.ts
    symbols:
      - deriveAnchorIndexPath
      - deriveAdrTrackerPath
      - getConfig
    lines: [204, 212]
    git_commit: ee43852
  - file: packages/codex/src/adr-gate.ts
    symbols:
      - ADR_WRITE_ENV
      - AdrError
      - writesEnabled
      - assertWritesEnabled
      - requireExistingAdr
    lines: [1, 40]
    git_commit: e545d01
  - file: packages/codex/src/adr-handlers.ts
    symbols:
      - handleSearchAdr
      - handleSearchAdrByFile
      - handleListAdrs
      - handleLoadConstraints
      - handleCreateAdr
      - handleUpdateAdr
      - handleCheckAdrConsistency
      - handleIndexSpecs
    lines: [1, 220]
    git_commit: 59af98a
  - file: packages/codex/src/server.ts
    symbols:
      - createServer
    lines: [52, 195]
    git_commit: 59af98a
  - file: packages/codex/src/workspace-services.ts
    symbols:
      - WorkspaceServiceCache
    lines: [17, 60]
    git_commit: d51409a
  - file: packages/codex/src/result-format.ts
    symbols:
      - appendAdrHints
    lines: [179, 189]
    git_commit: c335127
trigger:
  task_id: null
  requirement_summary: "把 DSH 侧的 8 个 ADR 工具移植到 Codex（MCP）端，让两端共用同一份 ADR 状态与同一个 adr_embeddings 集合，同时解决 DSH 与 MCP 配置通路差异（ADR_* env 缺失）与架构分层问题（ADR 引擎位于 dsh 包内，无法被 codex 复用）。"
  change_type: architecture
related_decisions:
  - ADR-0001-milvus-collection-separation
  - ADR-0002-code-anchors-reverse-index
  - ADR-0003-constraint-reinjection
auto_generated: false
---

## 决策目标

把 DSH 插件端的 8 个 ADR 决策记忆工具移植到 Codex 端（`codex-context-milvus` MCP 服务器），并让两端共用**同一份** ADR 状态（anchor index / ADR hash tracker）与**同一个** `adr_embeddings` Milvus 集合——在 DSH 里创建的 ADR，在 Codex 里可直接查询，反之亦然。移植过程中解决两个前置结构问题：

1. **配置通路缺失**：`getConfig()` 有 20+ 个环境变量回退，但 `adrEnabled` / `adrRoot` / `adrCollection` 只能从 Cordis config 传入，MCP 端（无 Cordis）没有开启 ADR 的通路。
2. **分层缺陷**：ADR 引擎的 6 个模块（共 1171 行）位于 dsh 包内，虽零 DSH 框架耦合，但 codex 无法依赖 dsh（会违反"适配器互不依赖"与 core 边界规则），必须下沉到 core。

## 约束条件

- 状态文件路径**逐字节不变**：`deriveAnchorIndexPath(r) === deriveMerkleFilePath(r).replace('merkle', 'anchors')`，`deriveAdrTrackerPath(r) === deriveMerkleFilePath(r).replace('merkle', 'adr-merkle')`。老用户 `~/.milvus-index/` 下已有状态文件，路径漂移等于丢弃全部 ADR 索引状态并触发无谓全量重建
- core 边界规则继续成立：迁入 core 的 ADR 模块不 import `@deepseek-ai/*` / `@modelcontextprotocol/*` / `zod`，不调用 `console.*`（日志走注入的 `Logger`）
- DSH 侧行为零变化：`public-surface.spec.ts`（13 工具名 + 27 配置字段）不修改即通过
- `createAdrBundle` 全程不产生网络请求（保证冒烟测试可在无 Milvus 机器上跑）
- `ADR_ENABLED=false`（默认）时 `tools/list` 恰好返回 5 个工具，与移植前完全一致
- ADR 目录缺失时**不抛、不擅自建目录**（`createWhenMissing` 默认 false；DSH 传 true 保持历史行为）

## 候选方案与权衡

### 方案 1：ADR 引擎整体提进 core，两端共用装配（✅ 选用）
- **描述**：6 个 ADR 模块 `git mv` 进 `packages/core/src/`，barrel 导出；core 新增路径助手（`deriveAnchorIndexPath` / `deriveAdrTrackerPath`）、`ADR_*` 环境变量回退、`createAdrBundle()` 统一装配点；codex 新增 8 个 ADR 工具（camelCase 参数）+ 写门控 + 启动时门控
- **优点**：两端天然共用同一份状态与集合；分层清晰；ADR 与检索本就共用 `PluginConfig` 与 Milvus 连接，无新增基础设施
- **缺点**：core barrel 变大（增量可忽略，ADR 模块无重依赖，`js-yaml` 已是 core 依赖）
- **选择原因**：唯一的架构正确解，且实现成本已被"模块零框架耦合"这一既有事实摊薄

### 方案 2：新建第 4 个包 `packages/adr`（❌ 放弃）
- **描述**：分层更纯，ADR 独立成包
- **优点**：依赖边界最干净
- **缺点**：发布面 3→4，版本联动复杂；ADR 与检索共用 `PluginConfig` 与 Milvus 连接，拆分收益不抵成本
- **放弃原因**：收益不抵成本（YAGNI）

### 方案 3：ADR 留在 dsh，codex 依赖 dsh（❌ 排除）
- **描述**：最省事，codex 直接复用 dsh 的 ADR 模块
- **缺点**：codex 会被动拖进 `@deepseek-ai/*` 依赖，违反 core 边界规则与"适配器互不依赖"
- **排除原因**：违反既有架构约束

## 关键设计细节与隐性约束

### 隐性约束1：`ADR_*` env 回退只加 MCP 真正需要的三个
- **内容**：`ADR_ENABLED` / `ADR_ROOT` / `ADR_COLLECTION` 走 overrides > env > 默认的既有优先级；`adrConstraintReinjectEvery` / `adrSystemPrompt` 是 DSH 注入专属，**不加** env。DSH 既有行为只有一种情况会变：进程环境里恰好设了 `ADR_ENABLED`
- **原因**：MCP 无 Cordis config，env 是唯一配置通路；DSH 注入参数对 Codex 无意义（Codex 无注入钩子）
- **如果破坏会怎样**：为 DSH 注入专属参数加 env 会在 Codex 端形成假配置通路，用户设了却无效果

### 隐性约束2：写门控按"实际写意图"判定，不按工具名
- **内容**：`check_adr_consistency` 仅 `fix=true` 时写盘；`index_specs` 仅 `dryRun=false` 时写盘；`create_adr` / `update_adr` 总是写。未设 `CONTEXT_MILVUS_ADR_WRITE=true` 时，只有真落盘的动作被拒（`E_ADR_WRITE_DISABLED`），只读洞察力（`fix:false` / `dryRun:true`）不损失
- **原因**：Codex agent 是自主运行的，不应在无显式开关时擅自创建/改写文档；按意图判定比按工具名更精确
- **如果破坏会怎样**：要么只读工具被误伤（按工具名一刀切），要么写工具绕过门禁（按工具名漏判）

### 隐性约束3：工具暴露时机是"启动时门控"，非"始终暴露 + 调用时报错"
- **内容**：`ADR_ENABLED` 决定 `server.ts` 是否注册 ADR 工具；`ADR_ENABLED=false` 时 `tools/list` 恰好 5 个工具
- **原因**：MCP 无法在会话中途增长工具列表（无 `tools/list_changed` 需求），改配置就重启；与 DSH 的运行时动态切换（ADR-0006）形成对比
- **如果破坏会怎样**：Codex 客户端会看到不可用的工具，或与 DSH 行为语义混淆

### 隐性约束4：`createAdrBundle` 不产生网络请求
- **内容**：装配只读磁盘状态文件（anchor index / ADR hash tracker），`ensureAdrCollection()` 留给真正用到它的 handler
- **原因**：冒烟测试（`mcp-smoke.spec.ts`）必须在无 Milvus 机器上跑；bundle 装配不该有副作用
- **如果破坏会怎样**：冒烟测试变成需要真 Milvus，或 `ADR_ENABLED=true` 时启动即挂

### 隐性约束5：约束注入的降级——被动提醒
- **内容**：Codex 没有 DSH 的 `systemPrompt` / `agent/pre-step` / `tools/result` 三个钩子，只降级为被动提醒：`search_code` 命中 ADR 覆盖文件时，在文本末尾追加 `相关决策: ADR-XXXX ... (active)` 一行；`structuredContent` 同步加 `relatedAdrs`。ADR 未启用时 `search_code` 输出**逐字节不变**
- **原因**：Codex 无 hook 能写进会话，提醒是唯一可行的约束可见性通道
- **如果破坏会怎样**：未启用时输出变化会污染检索结果（有测试钉死）

### 隐性约束6：`scanPath` 不得退化成全仓扫描
- **内容**：`runAdrIndex` 的 `scanRoots` 固定由 `config.adrRoot` / `config.specRoot` / `config.planRoot` 派生；codex 的 `index_specs` 传 `scanPath` 时 `specRoot = scanPath`、`planRoot = ''`（跳过 plans），沿用 DSH 现有语义。`scanDirectory('')` 当前靠"抛错→null→被 filter 掉"实现跳过，是隐式行为，必须补回归测试断言传 `scanPath` 时候选文件只来自该目录
- **原因**：保持两端行为一致；防止 `scanDirectory('')` 语义变化导致意外全仓扫描
- **如果破坏会怎样**：`index_specs(scanPath)` 扫到 scanPath 之外的整个仓库，索引范围失控

### 隐性约束7：codex 参数统一 camelCase，与 DSH 的 snake_case 区分
- **内容**：`pathPrefix`（对应 DSH `search_adr.path`，避免与 codex 既有的"工作区根目录" `path` 语义冲突）、`scanPath`、`filePath`、`topK` / `maxResults` 等
- **原因**：`path` 在 codex 全部工具中已定义为工作区根目录，同名不同义必须拆开
- **如果破坏会怎样**：`search_adr(path=...)` 被误解为工作区根，过滤范围错误

## 被否决的模式/反模式

- ❌ 新建第 4 个包 `packages/adr` —— 发布面 3→4，版本联动，收益不抵成本
- ❌ codex 依赖 dsh 复用 ADR 模块 —— 违反 core 边界规则与"适配器互不依赖"
- ❌ 用 `ADR_TRACKER_FILE` / `ADR_INDEX_FILE` 之类开关自定义状态路径 —— 状态路径可配置不做（YAGNI），只加派生助手
- ❌ 运行时热开关工具集 —— MCP 无 `tools/list_changed` 需求，改配置就重启
- ❌ 写门控按工具名一刀切 —— 只读工具被误伤或写工具漏判，必须按实际写意图（`fix` / `dryRun`）判定

## 相关测试

- `core/test/adr-path-derivation.spec.ts`（新）：路径助手 ≡ 旧 `.replace()` 表达式；含空格/中文/深层路径同样成立
- `core/test/adr-bundle.spec.ts`（新）：`adrRoot` 相对 `indexRoot` 解析；装配全程不碰网络（断言 fetch 与 SDK 未被调用）；目录缺失不抛、不建目录
- `core/test/config.spec.ts`（新建）：`ADR_ENABLED` / `ADR_ROOT` / `ADR_COLLECTION` env 回退；overrides 仍优先于 env
- `codex/test/adr-handlers.spec.ts`（新）：8 个 happy path + 写门控 6 例（4 拒 2 放）+ `scanPath` 回归
- `codex/test/mcp-smoke.spec.ts`（改）：`ADR_ENABLED` 关 → 恰好 5 个工具；开 → 恰好 13 个；真子进程各跑一遍
- `codex/test/search-code-adr-hint.spec.ts`（新）：未启用时输出逐字节不变；启用且命中时追加"相关决策:"行 + `relatedAdrs`
- `dsh/test/public-surface.spec.ts`（不动）：必须始终绿——"DSH 契约未被动过"的证据

## 变更边界

- ADR 引擎（`adr-frontmatter` / `adr-chunker` / `adr-anchor-index` / `adr-anchor-generator` / `adr-service` / `adr-indexer`）现位于 `packages/core/src/`，任何改动需保持 core 边界规则
- 新增 ADR 工具时：codex 侧必须同时补 `schemas.ts`（zod）、`adr-handlers.ts`（handler）、`result-format.ts`（格式化 + 错误码）、`server.ts`（启动门控注册）、README 工具表
- 若未来 DSH 与 codex 的 ADR 参数语义再次分叉，以 `pathPrefix` / `scanPath` 的拆分先例为准，不要复用同名异义参数
- `runAdrIndex` 增加 `options.logger`（照 `runIndex` 先例）：MCP 端 ADR 索引进度必须走 stderr（logger），不能污染 JSON-RPC stdout
- 2026-09-12: 初始记录。版本联动 core `0.1.0→0.2.0`、codex `0.1.0→0.2.0`、dsh `0.6.6→0.6.7`，dsh 与 codex 对 core 依赖写 `^0.2.0`
