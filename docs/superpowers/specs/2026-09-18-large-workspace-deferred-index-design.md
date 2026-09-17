---
title: large-workspace-deferred-index
type: spec
created: 2026-09-18
status: draft
id: SPEC-2026-09-18-large-workspace-deferred-index
related_decisions: []
---

# 大工作区索引降级与独立索引脚本（dsh-context-milvus）

## 概要

`index_code` 目前把「扫描 → 分块 → Embedding → 写入 Milvus」压在**一次工具调用**里。大仓库下这会长时间阻塞会话、可能触发工具超时，并且在用户没意识到的情况下产生大量 embedding 费用。

本次改造：当工作区规模超过阈值（**可索引文件数 > 1000** 或 **源码文本总量 > 500 KiB**）时，DSH 的 `index_code` **只做扫描统计**，随即返回一条提示，要求用户在终端**单独运行随插件分发的索引脚本**完成 Embedding 与上传。脚本是独立进程，不受会话超时约束，可中断续传。

Codex 适配器行为不变。阈值判定、run-config 落盘、CLI 实现放在 core（框架无关、可单测），DSH 只负责传开关、渲染提示与暴露 bin。

## 背景与约束

### 现状

- `packages/core/src/indexer.ts` 的 `runIndex()` 顺序为 `ensureCollection → walkDirectory → delta → delete → (read → chunk → embed → insert)* → save`。
- `walkDirectory()` 已经对每个命中扩展名的文件 `readFile` 以计算 SHA-256，因此**文件数与字节数是顺带可得的**，不需要额外 IO。
- `IndexResult` 为纯数字结构：`filesIndexed / chunksIndexed / filesRemoved / chunksRemoved / filesSkipped / durationMs`。
- DSH 的 `index_code` 输出 schema 是 `additionalProperties: false` 的纯 number 对象；`adr-tools.spec.ts` 只断言特定键的存在性，因此**新增可选字段是兼容的**。
- `HashTracker.save()` 只在 `runIndex` 末尾调用一次（`indexer.ts:302`），中途中断会丢掉全部进度。
- 工作区状态文件按绝对路径哈希隔离：`deriveMerkleFilePath()` → `~/.milvus-index/merkle-<safeName>-<hash16>.json`。
- `packages/dsh` 目前**没有 `bin` 字段**，`files` 白名单也不含 `bin/`；`packages/codex` 已有 CLI 先例（`bin/cli.js`，纯 JS + 顶层 await）。

### 硬约束

1. **core 边界**：`packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，且除 `logger.ts` 外**不得直接调用 `console.log/warn/info`**（`packages/core/test/core-boundary.spec.ts` 强制）。→ CLI 的 stdout/stderr 必须**注入**。
2. **冻结公共契约**：`packages/dsh/test/public-surface.spec.ts` 钉住 13 个工具名与 27 个 Config 键。本次**不改动**这两者。
3. **依赖单向**：`dsh → core`，`codex → core`；适配器之间不互相 import。
4. **配置优先级**：适配器配置 > 环境变量 > 默认值（`core/src/config.ts` 的 `getConfig()`）。

### 已确认决策（与用户逐条确认）

| 议题 | 决策 |
|------|------|
| 超阈时 `index_code` 行为 | 只扫描 + 提示；不做 chunk/embed/上传 |
| 「单独做」的形态 | 随插件分发的**独立脚本**，用户在终端自己运行（**不是** agent 工具） |
| 脚本配置来源 | `index_code` 把**解析后的有效配置**落盘，脚本读它（保证与插件 100% 一致） |
| 脚本落地 | CLI 逻辑放 **core**，`dsh` 包暴露 bin（Codex 以后可零成本复用） |
| 阈值口径 | 文件数 > 1000（仅可索引文件）或 文本 > **500 KiB（UTF-8 字节）** |
| 生效范围 | **仅 DSH**；Codex 的 `index_code` 行为不变 |
| 实现方案 | 阈值判定放进 `runIndex`（opt-in 开关），**单次 walk**，不重复扫描 |
| 中断保护 | 每 50 个文件 `tracker.save()` 一次 |

## 非目标

- 不改 Codex 适配器（不加 bin、不改 `index_code` 行为）。
- 不做后台任务、不做索引进度回传 DSH 会话。
- 不做跨进程并发锁（文档提示「不要与插件同时跑」）。
- 不新增 config key（阈值走常量），不改变 27 键契约。
- 不做 embedding 费用预估（`--dry-run` 只给文件数与分块数）。
- 不重构 ADR 索引流程（脚本复用现有 `runAdrIndex`）。

## 设计

### 1. 阈值判定（`packages/core/src/indexer.ts`）

新增导出常量：

```ts
export const LARGE_WORKSPACE_FILE_LIMIT = 1000
export const LARGE_WORKSPACE_BYTE_LIMIT = 500 * 1024   // 500 KiB
export const DEFAULT_CHECKPOINT_EVERY = 50
```

`walkDirectory()` 由「返回 `Map<path, hash>`」改为返回带统计的结构（仍为模块私有），并新增一个**导出的**探针函数把「构建忽略规则 + 扫描」这段共用逻辑收口，使 `runIndex`、CLI 的 `--dry-run`、测试三处使用**完全相同的忽略语义**（否则 dry-run 给出的规模会与真实索引不一致）：

```ts
export interface WorkspaceProbe {
  files: Map<string, string>   // 绝对路径 → 内容 SHA-256
  fileCount: number
  totalBytes: number           // 所有命中文件的 UTF-8 字节总和
  exceedsLargeWorkspace: boolean
}

/** 阈值可注入：生产调用不传，走常量；测试传小数值即可用小目录覆盖边界。 */
export interface LargeWorkspaceLimits {
  files?: number
  bytes?: number
}

/** 扫描工作区：构建 IgnoreMatcher（默认 + 自定义 + .gitignore + 全局）+ walk。 */
export async function probeWorkspace(
  config: PluginConfig,
  options?: { onFileProgress?: (filePath: string) => void; limits?: LargeWorkspaceLimits },
): Promise<WorkspaceProbe>
```

`totalBytes` 在已读取的 `content` 上累加 `Buffer.byteLength(content, 'utf-8')`，无额外 IO。

阈值判定本身是纯函数，便于边界单测：

```ts
export function exceedsLargeWorkspace(
  fileCount: number,
  totalBytes: number,
  limits?: LargeWorkspaceLimits,
): boolean
```

`runIndex` 内部的「构建忽略规则 → walk」改为调用 `probeWorkspace()`，因此**仍然只 walk 一次**。

`runIndex()` 选项扩展（全部可选，向后兼容）：

```ts
options?: {
  mode?: 'full' | 'incremental'
  progress?: (msg: string) => void
  logger?: Logger
  onFileProgress?: (filePath: string) => void
  importResolver?: ImportResolver
  /** 超阈时只扫描统计并早退；默认 false（Codex 与现有调用不受影响）。
   *  传对象可覆盖阈值（测试用）；DSH 传 true 走常量。 */
  deferLargeWorkspace?: boolean | LargeWorkspaceLimits
  /** 每处理 N 个文件落盘一次 Merkle 状态；0 表示只在结束时落盘。默认 50。 */
  checkpointEvery?: number
}
```

**执行顺序调整**：`walk → 阈值判定 → ensureCollection → delta → …`。

理由：超阈早退时**完全不触碰 Milvus**（不建连接、不建集合），这正是「不产生费用、不产生副作用」的关键。把 `ensureCollection` 从 walk 之前移到阈值判定之后，对未超阈路径无行为差异（集合仍在使用前确保存在）。

判定与早退：

```ts
const probe = await probeWorkspace(config, { onFileProgress, limits })
const { files: currentFiles, fileCount, totalBytes } = probe

if (deferLargeWorkspace && probe.exceedsLargeWorkspace) {
  return {
    filesIndexed: 0, chunksIndexed: 0,
    filesRemoved: 0, chunksRemoved: 0,
    filesSkipped: fileCount,
    durationMs: Date.now() - startTime,
    deferred: true,
    workspaceFiles: fileCount,
    workspaceBytes: totalBytes,
  }
}
```

其中 `deferLargeWorkspace = options?.deferLargeWorkspace`，`limits = typeof deferLargeWorkspace === 'object' ? deferLargeWorkspace : undefined`（`true` → 常量阈值）。

`IndexResult` 增加三个可选字段（`deferred` 仅在早退时为 `true`；`workspaceFiles`/`workspaceBytes` 也仅在早退时返回，以保持既有路径结果形状逐字节不变）：

```ts
export interface IndexResult {
  filesIndexed: number
  chunksIndexed: number
  filesRemoved: number
  chunksRemoved: number
  filesSkipped: number
  durationMs: number
  /** true = 工作区超阈，本次未做分块/Embedding/写入。 */
  deferred?: boolean
  /** 可索引文件数（仅 deferred 时返回）。 */
  workspaceFiles?: number
  /** 源码文本 UTF-8 字节总量（仅 deferred 时返回）。 */
  workspaceBytes?: number
}
```

早退路径**不写 Merkle 状态、不删文件、不建集合**——本次运行对系统零副作用。

本次新增的公共符号需全部经 `packages/core/src/index.ts` 导出（barrel 是适配器唯一的 import 面）：`probeWorkspace`、`exceedsLargeWorkspace`、`LARGE_WORKSPACE_FILE_LIMIT`、`LARGE_WORKSPACE_BYTE_LIMIT`、`DEFAULT_CHECKPOINT_EVERY`、`deriveRunConfigPath`、`writeRunConfig`、`readRunConfig`、`runIndexCli`，以及类型 `WorkspaceProbe`、`LargeWorkspaceLimits`、`RunConfigFile`、`CliIo`。

### 2. `index_code` 行为（`packages/dsh/.../tools.ts`）

调用 `runIndex` 时传 `deferLargeWorkspace: true`；**未超阈时行为与今天完全一致**。

拿到 `deferred` 结果后：

1. 调 `writeRunConfig(effectiveConfig)` 落盘有效配置；失败只告警，不阻断提示返回。
2. **跳过 ADR 索引**（否则会出现「代码没入库、ADR 入了库」的半成品状态）。
3. 用 `buildIndexCommand(effectiveConfig.indexRoot)` 拼出可直接粘贴的命令。
4. 返回带 `deferred` 的结果；`render` 输出完整提示文案。
5. telemetry 追加 `deferred: true`（`TelemetryEntry` 已有索引签名，无需改类型）。

输出 schema 新增 4 个字段（因 `additionalProperties: false`，必须显式声明）：

```ts
deferred:       { type: 'boolean' }
workspaceFiles: { type: 'number' }
workspaceBytes: { type: 'number' }
nextCommand:    { type: 'string' }
```

命令构造（新文件 `packages/dsh/src/plugins/dsh-context-milvus/index-command.ts`，独立成文件以便单测）：

```ts
export function buildIndexCommand(indexRoot: string): string
```

- 以本模块的 `import.meta.url` 为基准解析 `../../../bin/index.js`（`src/plugins/dsh-context-milvus/` 与 `dist/plugins/dsh-context-milvus/` 到包根的层级相同，两种布局都成立）。
- 该文件存在 → `node <绝对路径> --root <indexRoot>`；这是**安装在 DSH profile 里的那份**，与当前运行的插件同源，最可靠。
- 不存在（例如源码树里跑测试）→ 回退 `npx -p dsh-context-milvus dsh-context-milvus-index --root <indexRoot>`。

`render` 文案（中文，与既有工具风格一致）：

```
⚠️ 工作区较大（1234 个文件 / 1.8 MiB 源码；阈值 1000 文件 / 500 KiB），已跳过 Embedding 与 Milvus 上传。
本次未做任何向量化，不产生 embedding 费用，索引也未更新。

请在终端单独运行以下命令完成索引：
  node /…/dsh-context-milvus/bin/index.js --root /abs/workspace

可先加 --dry-run 查看规模；Ctrl-C 可中断，重跑会自动续传。
完成后 search_code / find_callers 才能检索到这个工作区。
```

`run-config` 落盘失败时，文案追加一句：配置未能落盘，请在终端用环境变量（`MILVUS_ADDRESS` / `EMBEDDING_ENDPOINT` / …）运行，或先重试 `index_code`。

### 3. `run-config.json` 契约（`packages/core/src/config.ts`）

路径派生与 `deriveMerkleFilePath` 同规则（同一份哈希/命名逻辑，按工作区隔离）：

```ts
export function deriveRunConfigPath(indexRoot: string): string
// HOME 存在： ~/.milvus-index/run-config-<safeName>-<hash16>.json
// 否则：     .milvus-run-config-<safeName>-<hash16>.json
```

读写：

```ts
export interface RunConfigFile {
  version: 1
  generatedAt: string          // ISO 8601
  config: PluginConfig         // 解析后的完整有效配置（含密钥）
}
export async function writeRunConfig(config: PluginConfig): Promise<string>  // 返回写入路径
export async function readRunConfig(filePath: string): Promise<RunConfigFile | null>
```

- 内容存 `getConfig()` 解析后的**完整** `PluginConfig`，因此 Milvus 地址/token、embedding 端点/模型、`indexRoot`、扩展名与忽略规则、`adr*` 等全部与插件一致。
- **权限 `0o600`**（含 `milvusToken` / `embeddingApiKey`）；目录不存在则 `mkdir -p`。
- 写入时机：**仅超阈早退时**。CLI 自身从不写此文件。
- 读取容错：文件缺失、JSON 损坏、`version !== 1` → 返回 `null`，由调用方回退。

### 4. CLI（core 实现 + dsh bin）

**core 实现** `packages/core/src/cli.ts`，经 barrel 导出：

```ts
export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}
export async function runIndexCli(argv: string[], io: CliIo): Promise<number>
```

`io` 必须注入（core 边界禁止直接 `console.*`）；无默认 console 实现，测试注入捕获式 writer。

参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `--root <path>` | `process.cwd()` | 工作区根；决定 run-config 与 merkle 状态文件 |
| `--mode <full\|incremental>` | `incremental` | 透传给 `runIndex` |
| `--config <path>` | `deriveRunConfigPath(root)` | 显式指定 run-config |
| `--dry-run` | off | 只做扫描 + 分块统计，不连 Milvus、不 embed、不写入 |
| `--no-adr` | off | 跳过 ADR 索引 |
| `--verbose` | off | 打印逐文件进度 |
| `--help` / `-h` | — | 用法说明 |

行为：

1. 解析参数（未知参数 → 用法错误，退出码 2）。
2. 读配置：`--config` > `deriveRunConfigPath(root)` > `getConfig({})`（env + 默认值，并打印一行警告说明未使用插件配置）。
3. **`--dry-run` 在此短路**：调 `probeWorkspace()` 取文件数/字节数，再逐文件 `chunkCode()` 统计分块数，打印规模预估后返回 0 —— **不构造 Milvus / Embedding 客户端，不读写任何状态**。（分块是纯 CPU 开销，大仓库下本身需要时间。）
4. 构建服务：`new EmbeddingClient(config.embedding)`、`new MilvusService({ address, token, collection, dim, embeddingClient, hybridMode, bm25RrfK, queryExpansion, rerankConfig })`（与 DSH `applyServiceConfig` 同形）、`new HashTracker(config.merkleFilePath)` + `load()`、`new ImportResolver(deriveImportMapFilePath(root))` + `load()`。
5. `runIndex(config, milvus, tracker, { mode, progress, importResolver })` —— **不设** `deferLargeWorkspace`（脚本本身就是重活路径）。
6. 若 `config.adrEnabled` 且未 `--no-adr`：`createAdrBundle(config, { createWhenMissing: true })`，把 `adrRoot`/`specRoot`/`planRoot` 相对 `indexRoot` 解析为绝对路径后调 `runAdrIndex(...)`（与 DSH `index_code` 同一调用序列）。
7. 打印摘要并返回退出码。

`--verbose` 透传为 `onFileProgress`（逐文件扫描进度）并打印阶段日志。

退出码：`0` 成功、`1` 运行失败（配置损坏、Milvus/embedding 不可达等）、`2` 用法错误。

`SIGINT` 处理：注册 handler → `await tracker.save()` → 退出 `130`；第二次 `SIGINT` 立即退出（避免卡在不可中断的 await 上）。

**dsh bin**：新增 `packages/dsh/bin/index.js`（纯 JS，ESM，带 shebang，与 `packages/codex/bin/cli.js` 同风格）：

```js
#!/usr/bin/env node
import { runIndexCli } from 'dsh-context-milvus-core'
process.exitCode = await runIndexCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
})
```

`packages/dsh/package.json`：

```json
"bin": { "dsh-context-milvus-index": "bin/index.js" },
"files": ["dist", "bin", "client", "cordis-entry.yml", "cordis.patch.yml", "LICENSE", "README.md"]
```

（`files` 必须加 `bin`，否则发布产物里没有脚本。）

### 5. checkpoint 与跨进程一致性

- **定期落盘**：`runIndex` 的逐文件循环中，每成功处理 `checkpointEvery`（默认 50）个文件执行一次 `await tracker.save()`；函数末尾的 `save()` 保留。
  - 中断后重跑时，已入库文件在 Merkle 状态里是 `unchanged` → **不重复 embedding、不重复花钱**。
  - 安全性：incremental 模式对每个文件先 `deleteByFilePath` 再 `insertChunks` 再 `updateRecord`，因此「插入成功但状态未落盘」的最坏情况只是重跑时再删再插一次，不会产生重复向量。
- **插件拾取脚本进度**：`index_code` 在调用 `runIndex` 前对 effective tracker 执行一次 `load()`，以读取脚本在另一进程写入的状态。`HashTracker.load()` 是整体替换、`save()` 仅在 dirty 时写，语义安全（最坏情况是丢弃未落盘的内存更新，而那部分本来就会被重算）。
- **并发**：不做跨进程锁。文档明确「不要与插件同时跑索引」，并说明同时运行只会造成重复劳动，不会损坏数据。

### 6. 文档更新

- `README.md`：`index_code` 章节补充「大工作区降级」行为与阈值；新增「独立索引脚本」小节（安装位置、参数、退出码、`~/.milvus-index/run-config-*.json` 的作用与 0600 权限）。
- `packages/dsh/README.md`：一句话指向脚本。
- 不新增 config key，配置表不变。

### 7. 发布与生效

`bin` 与 `files` 是**发布期**属性：只有当 `dsh-context-milvus` 重新发布并在 DSH profile 里重装后，`~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js` 才会存在，`index_code` 提示里的绝对路径命令才可执行。在发布前，源码树里的插件会走 `npx` 回退分支（见 §2）。因此本特性的验收必须包含一次「重装插件后，提示命令在终端可直接跑通」。

## 错误处理

| 场景 | 行为 |
|------|------|
| 工作区超阈 | 返回 `deferred` 结果 + 提示命令；**无 Milvus 连接、无 embedding 调用、无状态写入** |
| run-config 写入失败 | 告警日志；仍返回 `deferred` 与命令，文案追加「配置未落盘，可用环境变量运行」 |
| 脚本找不到 run-config | 回退 `getConfig({})`（env + 默认值）并打印警告；不报错退出 |
| run-config JSON 损坏 / 版本不符 | `readRunConfig` 返回 `null` → 同上回退 |
| 脚本无法连接 Milvus / embedding | 打印可操作错误（地址、集合名、端点），退出码 1 |
| 脚本被 Ctrl-C | 落盘 checkpoint 后退出 130；重跑自动续传 |
| 阈值判定自身 | 不抛错（`walkDirectory` 已有 try/catch 容错，读不到的文件跳过） |

## 测试

### core

- `probeWorkspace`：`totalBytes` 等于命中文件 UTF-8 字节之和；不可读文件不计入；忽略规则与 `runIndex` 一致。
- `exceedsLargeWorkspace()` 纯函数边界：999 / 1000 文件不触发，1001 触发；512000 字节不触发，512001 触发。
- `probeWorkspace` 真实临时目录 + 注入小阈值：小目录也能覆盖「超阈」分支，无需造 1001 个文件。
- `runIndex` 超阈早退（`deferLargeWorkspace: true`）：
  - 返回 `deferred: true` + 正确的 `workspaceFiles` / `workspaceBytes`；
  - **断言未调用** `EmbeddingClient.embed`、`milvus.insertChunks`、`milvus.ensureCollection`；
  - 未写 Merkle 状态文件。
- `deferLargeWorkspace` 未设置时，超阈工作区仍完整执行（证明 Codex 路径不受影响）。
- `checkpointEvery`：处理 N 个文件后 `tracker.save()` 被调用（mock `HashTracker` 计数）。
- `deriveRunConfigPath`：与 `deriveMerkleFilePath` 同哈希段、同 `safeName`。
- `writeRunConfig` / `readRunConfig`：往返一致；文件权限为 `0o600`；损坏 JSON → `null`。
- `runIndexCli`（注入捕获式 IO）：
  - `--help` → 退出 0 且输出用法；
  - 未知参数 → 退出 2；
  - `--dry-run` → 不构造 Milvus/Embedding（mock 断言未调用）；
  - 缺少 run-config → 走 env 回退并打印警告。

### dsh

- `index_code` 超阈 → 返回 `deferred: true`、写出 run-config、**未调用 `runAdrIndex`**。
- `index_code` 未超阈 → 现有 3 个 ADR 输出用例继续通过（新增字段不影响既有断言）。
- `buildIndexCommand`：bin 存在 → 绝对路径命令；不存在 → npx 回退。
- 冻结面：`public-surface.spec.ts` **零改动**通过（13 工具名 / 27 config 键不变）。

### 集成

- `packages/dsh/bin/index.js` 冒烟：`--help` 退出 0（真实 spawn，参考 `mcp-smoke.spec.ts` 的做法）。

## 验收标准

1. 大仓库调用 `index_code` **只做扫描即返回**（不做分块、不向量化、不写状态），返回可粘贴命令；Milvus 无任何写入、无 embedding 调用（可用 mock/日志断言）。
2. 按提示命令在终端跑完 → 数据入库 → `search_code` / `find_callers` 能检索到该工作区。
3. 小仓库（未超阈）`index_code` 行为与改造前一致，全量测试通过。
4. Codex 的 `index_code` 行为不变。
5. 脚本跑到一半 Ctrl-C，重跑时已索引文件不再 embedding。
6. `npm run typecheck`、`npm run build`、`npm test` 全绿。
