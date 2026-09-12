# Codex 端 ADR 决策记忆移植 — 设计文档

- 日期：2026-09-12
- 分支：`feat/codex-adr-port`（从 `main` 切出）
- 前置：`docs/superpowers/specs/2026-09-06-codex-mcp-port-design.md`（三包 workspace 已落地）
- 状态：已获批准，待 writing-plans

## 1. 背景与目标

`codex-context-milvus` 目前只暴露 5 个检索工具（`search_code`、`index_code`、`index_status`、`find_callers`、`trace_call_chain`），刻意不含 ADR 决策记忆。DSH 插件端有完整的 8 个 ADR 工具，Codex 用户因此看不到代码背后的设计原因，也无法在 Codex 会话里沉淀决策。

目标：把这 8 个 ADR 能力搬到 Codex 端，并且让两端共用同一份 ADR 状态与同一个 `adr_embeddings` 集合 —— 在 DSH 里建的 ADR，Codex 里直接能查，反之亦然。

## 2. 非目标

- ADR 工具的 MCP resources / prompts 化
- 约束注入的模拟器（Codex 无对应钩子，只做被动提醒，见 §5.4）
- ADR 状态文件路径自定义（`ADR_TRACKER_FILE` / `ADR_INDEX_FILE` 之类开关）
- 多 ADR root、多集合路由
- Windows 适配与验证
- 运行时热开关工具集（MCP 无 `tools/list_changed` 需求，改配置就重启）

## 3. 现状事实

这些是设计的前提，已实测确认：

- ADR 引擎的 6 个模块共 **1171 行**，位于 `packages/dsh/src/plugins/dsh-context-milvus/`，导入只有 `node:*` / `js-yaml` / `dsh-context-milvus-core` —— **零 DSH 框架耦合**：

  | 模块 | 行数 | 公共出口 |
  |---|---|---|
  | `adr-frontmatter.ts` | 67 | `parseFrontmatter` |
  | `adr-chunker.ts` | 107 | `chunkAdrFile` |
  | `adr-anchor-index.ts` | 114 | `AdrAnchorIndex`（`getAdrsForFile` / `getFilesForAdr` / `setAdr` / `removeAdr` / `getStats`） |
  | `adr-anchor-generator.ts` | 310 | `generateSpecFrontmatter`、`previewFrontmatter`、`findCandidateFiles`、`detectCodeReferences` |
  | `adr-service.ts` | 343 | `AdrService`（`findMaxSerial` / `createAdr` / `updateAdr` / `listAdrs` / `loadAdr` / `getActiveConstraints` / `getAllAdrFiles`） |
  | `adr-indexer.ts` | 230 | `runAdrIndex`、`getAdrIndexStatus` |

- 真正绑定 Cordis 的只有 `adr-tools.ts`（`defineTool` 声明层）与 `constraint-injector.ts`（Cordis 钩子）。
- core 里有 ADR **类型**（`types.ts` 中 16 处 `Adr*`），没有 ADR 实现。
- `getConfig()` 有 20+ 个环境变量回退，但**没有任何 ADR 相关 env**：`adrEnabled` / `adrRoot` / `adrCollection` 只能从 Cordis config 传入。所以 MCP 端目前根本没有开启 ADR 的通路。
- DSH 端用字符串替换派生 ADR 状态文件路径：

  ```ts
  new AdrAnchorIndex(deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors'))
  new HashTracker(deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle'))
  ```

- `runAdrIndex(config, milvus, tracker, anchorIndex, options)` 只有 `mode` / `progress`，**没有 `logger` 选项**（`runIndex` 有）。
- `runAdrIndex` 在 `!config.adrEnabled` 时返回全零结果而不报错。
- `check_adr_consistency(fix=true)` 会重写 ADR frontmatter（`tmp` + `rename` 原子写）；`index_specs(dry_run=false)` 会往规格文档回写 frontmatter；`create_adr` / `update_adr` 总是写文件。
- codex 现有源码 722 行 / 9 文件；`WorkspaceServiceCache` 目前只装配 config + EmbeddingClient + MilvusService + HashTracker + ImportResolver。

## 4. 方案选择

| 方案 | 说明 | 结论 |
|---|---|---|
| **1. ADR 引擎整体提进 core，两端共用装配** | 6 模块机械进 core，加路径助手 / env 回退 / `createAdrBundle()` | **采用** |
| 2. 新建第 4 个包 `packages/adr` | 分层更纯，但发布面 3→4，版本联动，ADR 与检索本就共用 `PluginConfig` 与 Milvus 连接 | 否：收益不抵成本 |
| 3. ADR 留在 dsh，codex 依赖 dsh | 最省事 | **排除**：codex 会被动拖进 `@deepseek-ai/*`，违反 core 边界规则与"适配器互不依赖" |

## 5. 设计

### 5.1 core 层

**迁入**：上表 6 个模块 `git mv` 到 `packages/core/src/`，改 import 为包内相对路径，`index.ts` barrel 导出其公共出口。留在 dsh 的是 `adr-tools.ts` 与 `constraint-injector.ts`。

**新增三样东西**：

1. `deriveAnchorIndexPath(root)` / `deriveAdrTrackerPath(root)`（放 `config.ts`）。输出必须与现有 `.replace()` 表达式**逐字节相同**：

   ```
   deriveAnchorIndexPath(r) === deriveMerkleFilePath(r).replace('merkle', 'anchors')
   deriveAdrTrackerPath(r)  === deriveMerkleFilePath(r).replace('merkle', 'adr-merkle')
   ```

   理由：老用户 `~/.milvus-index/` 下已有 `anchors-*.json` 与 `adr-merkle-*.json`，路径漂移等于丢掉全部 ADR 索引状态并触发一次无谓全量重建。这条约束用测试钉死（§6）。

2. `ADR_*` 环境变量回退，只加 MCP 端真正需要的三个：`ADR_ENABLED`、`ADR_ROOT`、`ADR_COLLECTION`。`adrConstraintReinjectEvery` / `adrSystemPrompt` 是 DSH 注入专属，不加。优先级仍是 overrides > env > 默认，因此 DSH 既有行为只有一种情况会变：进程环境里恰好设了 `ADR_ENABLED`。这一点写进 README。

3. `createAdrBundle(config)`：把"解析 `adrRoot`（相对 `indexRoot`）→ 构造 `AdrService` + `AdrAnchorIndex` + `adrTracker` 并 `load()`"收进一个函数，返回 `{ service, anchorIndex, adrTracker, adrRoot }`，两个适配器同调。它同时是消掉 `.replace()` 把戏的位置，也让两端天然共用同一份状态文件。

**连带**：照 `runIndex` 的先例给 `runAdrIndex` 补 `options.logger?: Logger`（`progress` 缺省时走注入 logger）。否则 MCP 端 ADR 索引进度会打到 stdout，污染 JSON-RPC。

### 5.2 DSH 侧（目标：行为零变化）

改动只有两类：

1. `packages/dsh` 内 `./adr-*.js` 的 import 改为 `'dsh-context-milvus-core'`（机械替换，与 workspace 拆分那次同法）。
2. `index.ts` 中手写 ADR 装配段（`path.resolve(indexRoot, adrRoot)` + 两次 `.replace()` + 三次构造 + `adrTracker.load()`）换成 `const adr = await createAdrBundle(resolved)`。返回对象形状保持兼容，下游 `adrOptions = { service, anchorIndex, adrTracker }` 一字不改。

刻意不动的地方：DSH 侧 `console.log('[dsh-context-milvus] ADR 决策记忆已加载 (...)')` 保留原样（core 边界只扫 `packages/core/src`，适配器有权用 console）；`tools.ts` / `adr-tools.ts` / `constraint-injector.ts` 逻辑零改动。

契约防线补强：`public-surface.spec.ts` 锁得住 13 个工具名与 27 个配置字段，但**锁不住状态文件路径**，而这次最危险的正是路径漂移 —— 所以主要防线是 §5.1 的等式断言。

版本：core `0.1.0 → 0.2.0`，codex `0.1.0 → 0.2.0`，dsh `0.6.6 → 0.6.7`；dsh 与 codex 对 core 的依赖范围写 `^0.2.0`。

### 5.3 Codex 的 8 个 ADR 工具

**参数改名对照**（只改 codex 侧，DSH 一字不动）。DSH 的 `search_adr` 里 `path` 表示"Milvus pathPrefix 过滤范围"，而 codex 全部工具的 `path` 已定义为"工作区根目录"，同名不同义，必须拆开：

| codex 参数 | 对应 DSH 参数 | 理由 |
|---|---|---|
| `pathPrefix` | `search_adr.path` | 对齐 codex `search_code.pathPrefix` 既有语义 |
| `path` | （DSH 无） | 统一工作区根目录入参，走 `resolveWorkspaceRoot()` |
| `scanPath` | `index_specs.path` | 区分"扫描哪个目录"与"工作区是哪个" |
| `filePath` / `file_path` | `search_adr_by_file.file_path`、`check_adr_consistency.file_path` | 相对路径按工作区根 `path.resolve()`，与已上线的 `find_callers.sourceFile` 一致 |

其余参数与 DSH 同名同义，但**统一改用 camelCase**（`topK` / `maxResults` / `sourceFile` / `pathPrefix` 已是 codex 既有约定，DSH 的 snake_case 是 Cordis 侧习惯）：`search_adr(query, status, topK, pathPrefix)`、`search_adr_by_file(filePath, status)`、`list_adrs(status, changeType, limit)`、`load_constraints(format, adrIds)`、`create_adr(title, requirement, changeType, supersedes, content)`、`update_adr(adrId, content, status, supersededBy, merge)`、`check_adr_consistency(filePath, fix)`、`index_specs(scanPath, dryRun)`。

**`scanPath` 的落点**（实现约束）：`runAdrIndex` 内部的 `scanRoots` 固定由 `config.adrRoot` / `config.specRoot` / `config.planRoot` 派生，不接受外部覆盖。codex 侧不改 `runAdrIndex` 签名，而是照 DSH 现有的 `index_specs` 做法传入派生 config。DSH 的实际语义是（`adr-tools.ts` 第 489–493 行）：给了 `path` 时 `specRoot = path`、**`planRoot = ''`（即跳过 plans）**，不是两个根都指过去：

```ts
const specRoot = args.scanPath ? resolve(root, args.scanPath) : resolve(root, config.specRoot)
const planRoot = args.scanPath ? '' : resolve(root, config.planRoot)
// 扫描候选文件用上面两个根；随后的 runAdrIndex 收到 {...config, adrRoot, specRoot, planRoot}
```

注意一个实现意外：`runAdrIndex` 对 `scanRoots` **没有 falsy guard**，空串靠的是 `scanDirectory('')` 抛错后返回 `null`、再被 `filter` 掉才等于"跳过"。codex 沿用同一行为（保持两端一致），但必须补一条回归测试：**传 `scanPath` 时绝不能退化成全仓扫描**（断言候选文件数来自 `scanPath` 之内）。若哪天 `scanDirectory('')` 改成返回 cwd 内容，这条测试会立刻炸。

**写门控按"实际写意图"判定，不按工具名**：

| 工具 | 写盘条件 | 未开 `CONTEXT_MILVUS_ADR_WRITE=true` 时 |
|---|---|---|
| `search_adr` / `search_adr_by_file` / `list_adrs` / `load_constraints` | 从不写 | 正常可用 |
| `check_adr_consistency` | 仅 `fix=true` | `fix` 缺省或 false 照常可用；`fix=true` → `E_ADR_WRITE_DISABLED` |
| `index_specs` | 仅 `dryRun=false` | `dryRun=true` 照常可用 |
| `create_adr` / `update_adr` | 总是写 | `E_ADR_WRITE_DISABLED` |

默认状态下 agent 仍能用 `index_specs(dryRun:true)` 看锚点、用 `check_adr_consistency(fix:false)` 看漂移，只读洞察力不损失，只有真落盘被挡。

**新增错误码**（进 `result-format.ts` 的 `ErrorCode` 联合 + README 表）：

- `E_ADR_WRITE_DISABLED` — 建议语："这是写操作，需要设 `CONTEXT_MILVUS_ADR_WRITE=true` 后重启 Codex"
- `E_ADR_NOT_INITIALIZED` — ADR bundle 不可用（`adrRoot` 不存在或不可读），建议检查 `ADR_ROOT`

**ADR bundle 不进 `WorkspaceServiceCache` 的构造路径**：ADR 服务按工作区缓存，但只在 `ADR_ENABLED=true` 时装配，且装配过程禁止连接 Milvus（`ensureAdrCollection()` 留给真正用到它的 handler）。

### 5.4 约束提醒（替代 DSH 的 constraint-injector）

Codex 没有 DSH 的三个注入钩子，只降级为**被动提醒**：`search_code` 命中文件被 ADR 覆盖时，在文本**末尾**追加一行：

```
相关决策: ADR-0003 使用重试队列隔离下游故障 (active) · ADR-0007 索引状态按工作区隔离 (active)
```

- `structuredContent` 同步加 `relatedAdrs: [{ adrId, title, status }]`
- 反查走 `anchorIndex.getAdrsForFile()`（本地 JSON，零网络）
- 标题来自 `AdrService.listAdrs({ status: 'all' })`，在 bundle 内**懒加载并缓存一次**，避免每次搜索扫目录
- ADR 未启用时，`search_code` 输出必须**逐字节不变**

### 5.5 边界行为

- `ADR_ENABLED=true` 但 `adrRoot` 目录不存在：bundle 装配**不抛**、**不擅自建目录**；`list_adrs` / `search_adr_by_file` 返回空结果；`create_adr` 返回 `E_ADR_NOT_INITIALIZED`。
- `createAdrBundle` 全程不产生网络请求（保证 §6 的冒烟测试可在无 Milvus 机器上跑）。
- `ADR_ENABLED=false`（默认）时 `tools/list` 恰好返回 5 个工具，与今天完全一致。

### 5.6 连带改动

- `tools/list`：5 → 13（启用时）
- `.mcp.json` 的 `env_vars` 补 `ADR_ENABLED`、`ADR_ROOT`、`ADR_COLLECTION`、`CONTEXT_MILVUS_ADR_WRITE`
- `packages/codex/README.md` 的**环境变量表补 `SPEC_ROOT` / `PLAN_ROOT`** —— 这两个 core 早就支持、`index_specs` 直接依赖，但 codex README 现在一行都没提（实测 `grep -c` 为 0），移植后就是必须补的洞；同时工具表补 8 行、错误码表补 2 行
- `skills/context-milvus/SKILL.md` 补 ADR 使用规则（改代码前查 ADR、做完决策写 ADR、写类工具需 env 开关）
- `CLAUDE.md` 必须改：现在写着"Codex 刻意只有 5 个工具、不含 ADR"，与实现将不符
- 根 `README.md` / `README.zh.md` 的 Codex 章节与架构图，把"第一版有意不含 ADR 工具"改掉

## 6. 测试策略

先写测试看 RED，再实现。基线 **23 suites / 286 tests**，只增不减，预计落在 ~330。

| spec | 断言 |
|---|---|
| `core/test/adr-path-derivation.spec.ts`（新） | 新助手 ≡ 旧 `.replace()` 表达式；含空格 / 中文 / 深层路径的 `adrRoot` 同样成立 |
| `core/test/adr-bundle.spec.ts`（新） | `adrRoot` 相对 `indexRoot` 解析；装配全程不碰网络（断言 fetch 与 SDK 未被调用）；目录缺失不抛、不建目录 |
| `core/test/config.spec.ts`（**新建**） | `ADR_ENABLED` / `ADR_ROOT` / `ADR_COLLECTION` env 回退；overrides 仍优先于 env。注意：core 目前**没有** config 的 spec（`core/test` 只有 7 个文件），config 的测试一直窝在 dsh 的 `dsh-context-remdb.spec.ts` 里，所以这是新建而非补充 |
| `core/test/adr-*.spec.ts`（**7 个迁移**） | `adr-frontmatter` / `adr-chunker` / `adr-anchor-index` / `adr-anchor-generator` / `adr-service` / `adr-indexer` / `adr-types` 随模块 `git mv`，只改 mock 路径；用例数不变。`adr-tools.spec.ts` 与 `constraint-injector.spec.ts` **留在 dsh**（被测对象没迁） |
| `codex/test/adr-handlers.spec.ts`（新） | 8 个 happy path + 写门控 6 例（4 拒 2 放）+ **`scanPath` 回归**：传 `scanPath` 时候选文件只来自该目录，不退化为全仓扫描 |
| `codex/test/mcp-smoke.spec.ts`（改） | `ADR_ENABLED` 关 → 恰好 5 个工具；开 → 恰好 13 个；真子进程各跑一遍 |
| `codex/test/search-code-adr-hint.spec.ts`（新） | 未启用时输出逐字节不变；启用且命中时追加"相关决策:"行 + `relatedAdrs` |
| `dsh/test/public-surface.spec.ts`（不动） | 必须始终绿 —— 它是"DSH 契约未被动过"的证据 |

沿用本仓已建立的两条测试约定：真 Milvus SDK 在 Jest ESM 下不可加载，凡运行时 import core barrel 的 spec 必须先 `jest.unstable_mockModule` 桩掉 SDK；被 mock 的引擎模块打源文件路径（`../../core/src/adr-service.js`）而非包名。

## 7. 交付拆分

每个任务一次 commit；任务 3 可单独 revert 而不影响前两步。

1. `git mv` 6 个 ADR 模块 + 7 个 spec 进 core，改 import；路径等式测试先 RED 后 GREEN
2. core：路径助手 + `ADR_*` env 回退 + `createAdrBundle()` + `runAdrIndex` 的 `logger`
3. dsh：`index.ts` 切到 `createAdrBundle`，行为零变化，`public-surface` 仍绿
4. codex：4 个只读 ADR 工具（`search_adr` / `search_adr_by_file` / `list_adrs` / `load_constraints`）
5. codex：4 个写类工具 + 写门控 + 2 个新错误码
6. codex：启动门控 + `search_code` 被动提醒 + SKILL / manifest / README / CLAUDE.md 文档同步 + 版本三连跳

## 8. 风险

| 风险 | 应对 |
|---|---|
| 状态路径漂移导致老用户 ADR 索引全量重建 | §5.1 等式断言 + 任务 1 先写测试 |
| core barrel 变大，拖慢只用检索的适配器 | ADR 模块本身 1171 行，无重依赖（`js-yaml` 已是 core 依赖）；barrel 已一次性加载全部，增量可忽略 |
| 冒烟测试变成需要真 Milvus | 硬性规定 `createAdrBundle` 不产生网络请求，并为此写断言 |
| `ADR_ENABLED` env 回退改变 DSH 行为 | 仅当进程环境显式设置时生效；README 记录；DSH 测试全绿为门槛 |
| Codex agent 自主写文件 | 写门控默认关闭 + 按写意图判定 + 错误信息告知开关名 |
| 被动提醒污染检索输出 | 未启用时逐字节不变；启用时仅在命中时追加一行；均有测试 |
| `scanDirectory('')` 当前"抛错→null→被过滤"才等于跳过 plans，是隐式行为 | codex 沿用两端一致；加回归测试断言 `scanPath` 不会全仓扫描，`scanDirectory` 语义变了会立刻暴露 |

## 9. 验收标准

1. `npm test` 全绿，且 tests 数 > 286
2. `npm run build` 与 `npm run typecheck` 退出码 0
3. `ADR_ENABLED` 未设时，`tools/list` 返回恰好 5 个工具；设 `ADR_ENABLED=true` 时返回恰好 13 个
4. `ADR_ENABLED=true` 且未设 `CONTEXT_MILVUS_ADR_WRITE` 时，`create_adr` / `update_adr` / `check_adr_consistency(fix=true)` / `index_specs(dryRun=false)` 均返回 `E_ADR_WRITE_DISABLED`，且**磁盘上没有任何文件变化**
5. `search_code` 在 ADR 未启用时的输出与本设计实施前逐字节一致
6. core 边界测试仍绿：迁入 core 的 ADR 模块不 import `@deepseek-ai/*` / `@modelcontextprotocol/*` / `zod`，不调用 `console.*`
7. DSH 侧 `public-surface.spec.ts` 未修改即通过（13 工具名 + 27 配置字段）
8. MCP stdio 的 stdout 在 ADR 索引过程中仍只出现 JSON-RPC（进度走 stderr）
9. 同一仓库同一 `adrRoot` 下，DSH 建的 ADR 状态文件与 Codex 读到的完全同一份（路径助手同源，已由等式断言保证）

## 10. 决策记录

| 决策 | 选择 |
|---|---|
| 方案 | 方案 1：ADR 引擎提进 core，两端共用装配 |
| 写权限 | 8 个工具全部暴露，4 个写类默认关，`CONTEXT_MILVUS_ADR_WRITE=true` 放开 |
| 工具暴露时机 | 启动时门控（`ADR_ENABLED`），非"始终暴露 + 调用时报错" |
| 约束注入补偿 | 被动提醒：仅命中 ADR 覆盖文件时追加一行，否则逐字节不变 |
| 状态路径可配置 | 不做，只加派生助手（YAGNI） |
| 写门控粒度 | 按实际写意图（`fix` / `dryRun`），不按工具名 |
