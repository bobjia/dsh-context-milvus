---
id: ADR-0010-adr-session-root-consistency
type: decision-record
status: active
created: 2026-09-18
updated: 2026-09-18
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/dsh/src/plugins/dsh-context-milvus/adr-runtime.ts
    symbols:
      - AdrRuntime
      - AdrRuntimeResolver
      - createAdrRuntimeResolver
      - resolveAdrRootForSession
      - workspaceRootForExec
  - file: packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - registerAdrTools
  - file: packages/dsh/src/plugins/dsh-context-milvus/constraint-injector.ts
    symbols:
      - setupConstraintInjection
  - file: packages/dsh/src/plugins/dsh-context-milvus/index.ts
    symbols:
      - applyAdrConfig
      - toggleAdr
  - file: packages/dsh/src/plugins/dsh-context-milvus/tools.ts
    symbols:
      - registerTools
trigger:
  task_id: null
  requirement_summary: "DSH 的 ADR 锚点索引与 tracker 固定在启动根（config.indexRoot 默认 process.cwd()，即 DSH 服务进程 cwd），而路径校验按会话工作区根解析，导致 check_adr_consistency 100% 报假失效（本机实测 41 条，36 条来自另一个仓库）。"
  change_type: bugfix
related_decisions: [ADR-0002-code-anchors-reverse-index, ADR-0006-adr-runtime-toggle]
auto_generated: false
---

# ADR 锚点索引的会话根一致性

## 背景

DSH 插件启动时按 `config.indexRoot` 建出 ADR bundle。`config.indexRoot` 的默认值是 `process.cwd()`（`config.ts:257`）——**DSH 服务进程**的 cwd，不是会话工作区。

工具执行却发生在会话工作区里。修复前只有 `AdrService` 会按 `exec.agent.session.header.cwd` 重建，`AdrAnchorIndex` 与 `HashTracker` 仍固定在启动根。于是 `check_adr_consistency` 读**启动根**的锚点索引、却按**会话根** `path.resolve` 相对路径。

### 实测证据

| 事实 | 值 |
|---|---|
| 工具报告 | 41 条失效锚点 |
| `anchors-decisions-cb1e1b14f68c2848.json` 条目数 | **41**（逐条对应：5 个 `src/plugins` + 36 个 `crates`） |
| 该哈希对应路径 | `/mnt/home/bobjia/docs/decisions`（穷举哈希扫描确认，目录当前为空） |
| 本仓库自己的索引 | `anchors-decisions-669de7e8e854e3fd.json`（97 条，`crates` **0**） |

被报告的 36 条属于另一个仓库（`crates/...`，ADR id 如 `ADR-0004-agent-router-four-tier-routing`），与本仓库 `ADR-0004-import-resolver-cross-file-resolution` **编号撞车、内容无关**。本仓库自己的 9 个 ADR 从未出现在报告里。

同一段"解析会话根 + 只重建 service"的逻辑被**复制了三份**（`adr-tools.ts` 的 `serviceForExec` 与 `resolveEffectiveIndexRoot`、`constraint-injector.ts` 的内联版本），所以三处都漏了索引与 tracker。

## 决策

**把会话根解析收敛到一处，让 `AdrService` / `AdrAnchorIndex` / `HashTracker` 三者同根。**

新增 `packages/dsh/src/plugins/dsh-context-milvus/adr-runtime.ts`：

- `AdrRuntime = { root, service, anchorIndex, tracker }`，`root` 是 **ADR 目录**（`<ws>/docs/decisions`）。
- `resolveAdrRootForSession(config, sessionCwd?)`：会话 cwd 优先，否则回落 `config.indexRoot`。
- `workspaceRootForExec(resolveConfig, exec)`：锚点路径的**解析基准**（工作区根）。
- `createAdrRuntimeResolver({ resolveConfig, startup })`：`forExec(exec)` 按 root 缓存并懒加载状态文件；`peek(exec)` 同步、无 IO、绝不抛错。

所有 ADR 读写点（`check_adr_consistency`、`search_adr_by_file`、`list_adrs`、`load_constraints`、`index_specs`、`create_adr`/`update_adr` 的 `runAdrIndex`、`index_code`/`index_status` 的 ADR 写入、`constraint-injector`）统一从同一个 runtime 取三者。

## 隐性约束

- **`runtime.root` 是 ADR 目录，锚点基准是工作区根 —— 两者必须成对出现但绝不相等。** `code_anchors[].file` 在生成时就按 codebase root 解析（`adr-anchor-generator.ts`），索引里存的是相对**工作区根**的路径。把解析基准改成 `runtime.root` 会立刻退回原 bug（索引来自 A 根、解析按 B 根）。代码里已就地写明。
- **`tools/result` 钩子是同步的**，只能走 `peek`。因此缓存由**异步的** `agent/pre-step` 钩子预热；预热必须在 `reinjectEvery` 守卫**之外**，因为该配置默认 `0`（关闭），否则同步钩子会永久停留在启动索引上。未命中回落 `startup` 是**可接受的降级**（该钩子只产生一条提示），已注明。
- **`sessionCwd` 缺失时必须与改动前逐字节一致**：`resolveAdrRootForSession` 回落 `config.indexRoot`，`forExec` 直接返回 `startup`。
- **配置变更的原地语义必须保留**：`applyAdrConfig` 原地改 `startup` 的字段，因为已注册的工具/钩子持有同一对象引用。
- **codex 适配器不受影响也不得改动**：`workspace-services.ts` 用 `getConfig({ indexRoot: root })` 按工作区建 bundle，两个根天然一致。
- `packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`。运行时收敛在 dsh 包内，状态对象的构造与路径推导仍来自 core。

## 被否决的方案

- **把锚点解析基准改回 `config.indexRoot`**：能让 `check_adr_consistency` 自洽（不再报假失效），但它会**永远检查错误的语料**——本仓库的 ADR 根本不在启动根的索引里。这是把 bug 藏起来，不是修好。
- **只修 `check_adr_consistency` 一处**：`search_adr_by_file` 仍读错索引、`runAdrIndex` 仍写错根、`constraint-injector` 仍提示错 ADR。四处必须同源。
- **在 core 里实现运行时**：需要读 `exec.agent.session.header.cwd`（DSH 会话形状），属适配器知识；core 也不允许 import `@deepseek-ai/*`。
- **改 `config.indexRoot` 的默认值**：`process.cwd()` 对索引工具是合理默认，问题不在默认值，而在 ADR 侧没有跟随会话根。
- **让同步钩子改走异步**：Cordis `tools/result` 回调为同步签名，改成异步会波及既有钩子契约，收益不抵风险。

## 后果

- `check_adr_consistency` 恢复检查**本仓库自己的**锚点集：实测失效锚点由「41 条外来噪音」变为「25 条本仓库历史遗留」（12 条裸 `src/plugins/...` + 13 条绝对路径），`crates` 污染归零。
- 那 25 条是**索引陈旧**而非 ADR 记录写错：`docs/decisions/ADR-0001.md` 的 frontmatter 已写 `packages/core/src/milvus-service.ts`，而锚点索引仍停在拆分前的 `src/plugins/...`。重跑一次 ADR 索引即可刷新（不在本次范围）。
- ADR id 撞车（本仓库与另一仓库都有 `ADR-0004`、`ADR-0005`…）不再造成串读，因为每个工作区只读自己的索引；若将来引入跨工作区 ADR 检索，需要重新设计 id 命名空间。
- **线上生效需要重载插件**：DSH 服务进程仍持有修复前的模块。已在本机用真实磁盘数据独立验证修复后的根解析（startup 41 条 / 36 crates → session 97 条 / 0 crates，8 项断言全过）。
