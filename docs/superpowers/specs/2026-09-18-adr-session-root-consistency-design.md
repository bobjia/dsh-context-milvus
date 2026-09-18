---
title: adr-session-root-consistency
type: spec
created: 2026-09-18
status: draft
id: SPEC-2026-09-18-adr-session-root-consistency
related_decisions: []
---

# ADR 锚点索引的会话根一致性

## 概要

DSH 适配器里，ADR 相关的**三个**状态对象（`AdrService`、`AdrAnchorIndex`、`HashTracker`）应该都绑定到**同一个根**——当前会话的工作区。但实际只有 `AdrService` 是会话级的，另外两个仍是**启动时**按 `config.indexRoot` 建的。

而 `config.indexRoot` 的默认值是 `process.cwd()`（`config.ts:257`），即 **DSH 服务进程的 cwd**，不是会话工作区。于是当服务从 `~` 启动、会话工作区是某个仓库时：

- 锚点索引里的锚点来自 **A 根**（`~/docs/decisions`）
- 校验时却按 **B 根**（会话工作区）解析路径

结果 `check_adr_consistency` 报告 **100% 假失效**——本次实测 41 条全部如此。

## 背景与约束

### 实测证据

| 事实 | 值 |
|---|---|
| `check_adr_consistency` 报告 | 41 条失效锚点 |
| `~/.milvus-index/anchors-decisions-cb1e1b14f68c2848.json` 的条目数 | **41**（逐条对应，5 个 `src/plugins` + 36 个 `crates`） |
| `cb1e1b14f68c2848` 对应的路径 | **`/mnt/home/bobjia/docs/decisions`**（穷举哈希扫描确认；该目录**当前为空**） |
| 本仓库自己的锚点索引 | `anchors-decisions-669de7e8e854e3fd.json`（97 条，`crates` 条目 **0**） |
| `669de7e8e854e3fd` 对应的路径 | `<本仓库>/docs/decisions` |

被报告的 41 条里，36 条属于 **pipixia-rs**（`crates/...`，ADR id 如 `ADR-0004-agent-router-four-tier-routing`），与本仓库的 `ADR-0004-import-resolver-cross-file-resolution` **编号撞车但内容无关**。

### 根因

```ts
// adr-bundle.ts:53 —— 锚点索引按 config.indexRoot 建
const adrRoot = path.resolve(config.indexRoot, config.adrRoot || 'docs/decisions')
const anchorIndex = new AdrAnchorIndex(deriveAnchorIndexPath(adrRoot))

// adr-tools.ts:104 —— 但路径按会话根解析
function resolveEffectiveIndexRoot(resolveConfig, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  return sessionCwd || config.indexRoot || process.cwd()
}
```

`serviceForExec`（`adr-tools.ts:119-129`）已经把 `AdrService` 按会话根重建了，**却没有重建 `anchorIndex`**。同样的"只重建 service"逻辑在 `constraint-injector.ts:141-147` 又被复制了一遍。

### 锚点的基准

锚点来自 frontmatter 的 `code_anchors[].file`，生成时按 **codebase root（工作区根）** 解析（`adr-anchor-generator.ts:92`），索引里存的是相对工作区根的路径。所以**解析基准（会话工作区根）是对的，错的是索引本身**。这一点决定了修法：要让**索引**对齐会话根，而不是把解析基准改回 `config.indexRoot`。

### 约束

- `packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`；不得调用 `console.log/warn/info`。
- `packages/dsh/test/public-surface.spec.ts` 钉住 13 个工具名与 27 个 `Config` 键，必须零改动通过。
- **Codex 适配器不受影响**：`workspace-services.ts:26` 用 `getConfig({ indexRoot: root })` 按工作区建 bundle，两个根天然一致。**不要改动 codex 的根解析**。
- `constraint-injector` 的 `tools/result` 回调是**同步**的（`anchorIndex.getAdrsForFile()` 无 await 可用），而它的系统提示段回调是**异步**的。设计必须容纳这个差异。

## 非目标

- 不改 `config.indexRoot` 的默认值（`process.cwd()` 对索引工具是合理默认；问题是 ADR 侧没有跟随会话根）。
- 不改锚点的存储格式（仍是相对工作区根）。
- 不引入跨工作区 ADR 搜索。
- 不清理 `~/docs/decisions` 的孤儿索引文件（那是数据清理，不是代码修复；在"后续"里提一句即可）。
- 不改 `runAdrIndex` 的签名或 core 侧逻辑。

## 设计

### 1. 新模块 `packages/dsh/src/plugins/dsh-context-milvus/adr-runtime.ts`

把三处重复的"会话根解析 + 重建"收敛成一处：

```ts
/** 会话级 ADR 运行时：三者同根，缺一不可。 */
export interface AdrRuntime {
  root: string
  service: AdrService
  anchorIndex: AdrAnchorIndex
  tracker: HashTracker
}

/** 会话根解析：会话 cwd 优先，否则回落到 config 根。 */
export function resolveAdrRootForSession(
  config: PluginConfig,
  sessionCwd?: string,
): string {
  const adrRoot = config.adrRoot || 'docs/decisions'
  return sessionCwd
    ? path.resolve(sessionCwd, adrRoot)
    : path.resolve(config.indexRoot, adrRoot)
}

export interface AdrRuntimeResolver {
  /** 启动/配置根的运行时。配置变更时**原地**更新字段（工具持有同一对象）。 */
  readonly startup: AdrRuntime
  /** 取该会话的运行时；按 root 缓存，首次加载状态文件。 */
  forExec(exec?: any): Promise<AdrRuntime>
  /** 同步尽力而为：命中缓存则返回，否则返回 startup（供同步钩子使用）。 */
  peek(exec?: any): AdrRuntime
}

export function createAdrRuntimeResolver(opts: {
  resolveConfig: () => PluginConfig
  startup: AdrRuntime
}): AdrRuntimeResolver
```

要点：

- `forExec` 用 `Map<root, AdrRuntime>` 缓存；命中即返回（已加载）。
- 未命中时 `new AdrService(root, { createWhenMissing: true })`、`new AdrAnchorIndex(deriveAnchorIndexPath(root))`、`new HashTracker(deriveAdrTrackerPath(root))`，各自 `load().catch(() => {})`（与 `createAdrBundle` 一致的容错），再入缓存。
- `root === startup.root` 时直接返回 `startup`（避免重复加载，且保持配置变更的原地语义）。
- `peek` 只读缓存 + 根比对，**不做 IO**，绝不抛错。

### 2. 替换 `serviceForExec`

`serviceForExec` 删除，改由 `runtime.forExec(exec)` 取 `{service, anchorIndex, tracker}`。四个使用点全部改为使用**同一个** runtime 的三个字段：

| 位置 | 现在 | 改为 |
|---|---|---|
| `check_adr_consistency`（`adr-tools.ts:458`） | `anchorIndex.getAll()` | `rt.anchorIndex.getAll()` |
| `search_adr_by_file`（`adr-tools.ts:207`） | `anchorIndex.getAdrsForFile()` | `rt.anchorIndex.getAdrsForFile()` |
| `index_specs` / `create_adr` / `update_adr` 的 `runAdrIndex`（262/302/671） | `adrOptions.anchorIndex` | `rt.anchorIndex`（tracker 同理用 `rt.tracker`） |
| `index_code` 的 `runAdrIndex`（`tools.ts:399`） | `adrOptions.anchorIndex` | 同会话 runtime 的字段 |
| `constraint-injector`（198） | `anchorIndex.getAdrsForFile()` | `runtime.peek(exec).anchorIndex.getAdrsForFile()` |

### 3. `check_adr_consistency` 的解析基准

`effectiveIndexRoot` 改为直接取该会话 runtime 的**工作区根**，与索引同源：

```ts
const rt = await runtime.forExec(exec)
const effectiveIndexRoot = workspaceRootForExec(resolveConfig, exec)  // = sessionCwd || config.indexRoot
```

注意：runtime 的 `root` 是 ADR 目录（`<ws>/docs/decisions`），而锚点相对**工作区根**，所以解析基准取 `sessionCwd || config.indexRoot`，**不是** `rt.root`。这两个值必须成对出现——这是本 bug 的核心，务必在代码注释里写明。

### 4. `constraint-injector` 的同步钩子

- 异步的系统提示段回调（`constraint-injector.ts:128-152`）：把内联的 `new AdrService(effectiveRoot)` 替换为 `await runtime.forExec({ agent })`，**顺带把缓存填上**。
- 同步的 `tools/result` 回调（198）：改用 `runtime.peek(exec)`。首次命中前可能拿不到会话索引而回落到 startup——这是**可接受的降级**（该钩子只产生一条提示），但必须在注释里写明这是 best-effort，不是保证。

## 错误处理

- 状态文件缺失/损坏：`load().catch(() => {})`，与 `createAdrBundle` 一致，退化为空索引，**不抛错**。
- `exec` 无 `session.header.cwd`：回落到 `config.indexRoot`（即今日行为），保持向后兼容。
- `peek` 永不抛错；未命中返回 startup。
- 根目录不存在：`createWhenMissing: true` 沿用 DSH 既有行为（core 的 bundle 默认不建目录，DSH 显式建）。

## 测试

### 回归测试（核心）

1. **根不一致场景**：构造 `config.indexRoot = /A`、`exec.session.header.cwd = /B`，在 `/B/docs/decisions` 与 `/A/docs/decisions` 各放一份**不同的**锚点索引（临时目录）。断言：
   - `check_adr_consistency` 读到的是 **/B** 的锚点（不再报告 /A 的锚点失效）；
   - `search_adr_by_file` 返回 /B 索引里的 ADR。
2. **根一致场景**：`sessionCwd` 缺失 → 回落 `config.indexRoot`，行为与今日一致（防止回归）。
3. **`forExec` 缓存**：同 root 连续调用只加载一次（对 `load` 计数或断言同一对象引用）。
4. **`peek`**：未命中返回 `startup`；命中返回缓存的会话 runtime。
5. **写入路径**：`index_specs`（或 `runAdrIndex` 的桩）在会话根下写入时，断言写的是**会话根**的 `anchors-*.json`，而不是 config 根的。

### 现有测试

- `packages/dsh/test/{adr-tools,index-specs-defer,index-command,public-surface}.spec.ts` 必须继续通过；`public-surface.spec.ts` **零改动**。
- `packages/core/test/adr-*.spec.ts` 不受影响（core 未改）。

## 验收标准

1. 在 `config.indexRoot ≠ sessionCwd` 的场景下，`check_adr_consistency` 读到的锚点索引与会话工作区一致，不再报告另一个根的锚点。
2. `search_adr_by_file`、`index_specs`、`index_code` 的 ADR 写入、`constraint-injector` 的提示，四者与 `check_adr_consistency` 使用**同一个根**。
3. `sessionCwd` 缺失时行为与改动前**逐字节一致**（向后兼容）。
4. codex 适配器的根解析**零改动**。
5. `npm test` 全绿、`npm run typecheck` 与 `npm run build` exit 0；`public-surface.spec.ts` 零改动通过。
6. 复现验证：在本仓库会话中重跑 `check_adr_consistency`，报告的失效锚点应变为**本仓库自己的**锚点集（而不是那 41 条 `crates/...`）。

## 后续（不在本次范围）

- `~/docs/decisions` 是空目录，其 `anchors-decisions-cb1e1b14f68c2848.json` / `adr-merkle-decisions-cb1e1b14f68c2848.json` 是孤儿状态文件，可手工删除。
- ADR id 撞车（本仓库与 pipixia-rs 都有 `ADR-0004`、`ADR-0005`…）：本次修复后每个工作区只读自己的索引，撞车不再造成串读；但若将来引入跨工作区 ADR 检索，需要重新设计 id 命名空间。
