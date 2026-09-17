# 大工作区/大规格库索引降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当工作区或规格库超过阈值时，DSH 的 `index_code` / `index_specs` 只做扫描统计并返回提示，由用户在终端单独运行随插件分发的索引脚本完成 Embedding 与 Milvus 上传。

**Architecture:** 阈值判定与探针放 core（`probeWorkspace` / `probeSpecCorpus`），`runIndex` 通过 opt-in 的 `deferLargeWorkspace` 选项在单次 walk 内早退；DSH 工具在降级时把解析后的有效配置落盘到 `~/.milvus-index/run-config-*.json`，并渲染一条可直接粘贴的命令；命令指向 `packages/dsh/bin/index.js`，该脚本把 CLI 逻辑委托给 core 的 `runIndexCli`（IO 注入以满足 core 边界）。Codex 适配器不受影响。

**Tech Stack:** TypeScript（ESM / NodeNext / strict）、jest（`unstable_mockModule` + 顶层 `await import`）、`@zilliz/milvus2-sdk-node`（测试中必须 stub）、纯 JS bin（ESM + 顶层 await）。

## Global Constraints

- 阈值常量：代码侧 `LARGE_WORKSPACE_FILE_LIMIT = 1000`、`LARGE_WORKSPACE_BYTE_LIMIT = 500 * 1024`；规格侧 `LARGE_SPEC_FILE_LIMIT = 100`、`LARGE_SPEC_BYTE_LIMIT = 200 * 1024`；`DEFAULT_CHECKPOINT_EVERY = 50`。判定一律**严格大于**（`>`）。
- 规格侧测量对象是 `specRoot` + `planRoot` **全量**文档（**不含** `adrRoot`），且沿用 `SPEC_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/`、`PLAN_FILE_RE = /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/` 与**非递归** `readdir` 口径。
- 阈值可注入：`LargeWorkspaceLimits { files?: number; bytes?: number }` 定义在 `packages/core/src/types.ts`，生产调用不传（走常量），测试传小数值。
- **core 边界**：`packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，且除 `logger.ts` 外不得出现 `console.log/warn/info`。CLI 的 IO 必须注入。
- **冻结契约**：`packages/dsh/test/public-surface.spec.ts` 零改动（13 工具名 / 27 config 键不变）。`packages/dsh/package.json` 的 `main` 不变。
- **仅改 DSH 行为**：`packages/codex` 不传 `deferLargeWorkspace`、不改动任何文件。
- `run-config.json` 权限 `0o600`（含 Milvus token 与 embedding API key），路径 `~/.milvus-index/run-config-<safeName>-<hash16>.json`。
- 测试命令：`node --experimental-vm-modules node_modules/.bin/jest <path>`（`npx jest` 在本仓库不可用）。全量：`npm test`；类型检查：`npm run typecheck`；构建：`npm run build`。
- 任何导入 core barrel 或其传递依赖 `milvus-service.js` 的 spec，**必须**先 `jest.unstable_mockModule('@zilliz/milvus2-sdk-node', ...)`。
- 提交信息用仓库既有的 conventional-commit 风格（`feat(core):` / `feat(dsh):` / `test(...)` / `docs(...)`）。

---

### Task 1: 代码侧探针 `probeWorkspace` + `exceedsLargeWorkspace`

**Files:**
- Modify: `packages/core/src/types.ts`（新增 `LargeWorkspaceLimits`）
- Modify: `packages/core/src/indexer.ts`（常量、`WorkspaceProbe`、`exceedsLargeWorkspace`、`probeWorkspace`；`walkDirectory` 返回字节统计；`runIndex` 改用它）
- Modify: `packages/core/src/index.ts`（barrel 导出）
- Test: `packages/core/test/workspace-probe.spec.ts`（新建）

**Interfaces:**
- Consumes: 既有 `IgnoreMatcher`、`DEFAULT_IGNORE_PATTERNS`、`findIgnoreFiles`、`readIgnoreFile`、`loadGlobalIgnoreFile`（都在 `indexer.ts` 内或已导入）。
- Produces: `LARGE_WORKSPACE_FILE_LIMIT: 1000`、`LARGE_WORKSPACE_BYTE_LIMIT: 512000`、`DEFAULT_CHECKPOINT_EVERY: 50`、`interface WorkspaceProbe { files: Map<string,string>; fileCount: number; totalBytes: number; exceedsLargeWorkspace: boolean }`、`exceedsLargeWorkspace(fileCount, totalBytes, limits?): boolean`、`probeWorkspace(config, options?): Promise<WorkspaceProbe>`。Task 2/3/6 依赖这些。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/workspace-probe.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// indexer.ts → milvus-service.ts → @zilliz/milvus2-sdk-node, which cannot be
// loaded under Jest's ESM runtime. Stub it before importing anything.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { probeWorkspace, exceedsLargeWorkspace, LARGE_WORKSPACE_FILE_LIMIT, LARGE_WORKSPACE_BYTE_LIMIT } =
  await import('../src/indexer.js')
const { getConfig } = await import('../src/config.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'probe-ws-'))
  // Keep the global ignore file and any HOME-derived default out of the real home.
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

function tsConfig() {
  return { ...getConfig({}), indexRoot: tmp, indexExtensions: ['.ts'] }
}

describe('exceedsLargeWorkspace', () => {
  it('uses the production constants by default', () => {
    expect(LARGE_WORKSPACE_FILE_LIMIT).toBe(1000)
    expect(LARGE_WORKSPACE_BYTE_LIMIT).toBe(500 * 1024)
  })

  it('does not trigger at exactly the limit and triggers above it', () => {
    expect(exceedsLargeWorkspace(1000, 0)).toBe(false)
    expect(exceedsLargeWorkspace(1001, 0)).toBe(true)
    expect(exceedsLargeWorkspace(0, 512000)).toBe(false)
    expect(exceedsLargeWorkspace(0, 512001)).toBe(true)
  })

  it('honours injected limits', () => {
    expect(exceedsLargeWorkspace(2, 0, { files: 2 })).toBe(false)
    expect(exceedsLargeWorkspace(3, 0, { files: 2 })).toBe(true)
    expect(exceedsLargeWorkspace(0, 10, { bytes: 10 })).toBe(false)
    expect(exceedsLargeWorkspace(0, 11, { bytes: 10 })).toBe(true)
  })
})

describe('probeWorkspace', () => {
  it('counts indexable files and their UTF-8 byte length', async () => {
    await write('a.ts', 'const a = 1')
    await write('b.ts', 'const bb = 22')
    await write('notes.md', 'not an indexable extension')

    const probe = await probeWorkspace(tsConfig())

    expect(probe.fileCount).toBe(2)
    expect(probe.files.size).toBe(2)
    expect(probe.totalBytes).toBe(
      Buffer.byteLength('const a = 1', 'utf-8') + Buffer.byteLength('const bb = 22', 'utf-8'),
    )
    expect(probe.exceedsLargeWorkspace).toBe(false)
  })

  it('measures multi-byte content in UTF-8 bytes, not characters', async () => {
    const content = 'const 中文变量 = 1'
    await write('cn.ts', content)

    const probe = await probeWorkspace(tsConfig())

    expect(probe.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(probe.totalBytes).toBeGreaterThan(content.length)
  })

  it('walks nested directories and skips ignored ones', async () => {
    await write('src/deep/a.ts', 'const a = 1')
    await write('node_modules/pkg/b.ts', 'const b = 2')

    const probe = await probeWorkspace(tsConfig())

    expect(probe.fileCount).toBe(1)
    expect([...probe.files.keys()][0]).toContain('src/deep/a.ts')
  })

  it('flags an over-threshold directory when limits are injected', async () => {
    await write('a.ts', 'x')

    expect((await probeWorkspace(tsConfig(), { limits: { files: 5 } })).exceedsLargeWorkspace).toBe(false)
    expect((await probeWorkspace(tsConfig(), { limits: { files: 0 } })).exceedsLargeWorkspace).toBe(true)
  })

  it('reports per-file progress through onFileProgress', async () => {
    await write('a.ts', 'x')
    await write('b.ts', 'y')
    const seen: string[] = []

    await probeWorkspace(tsConfig(), { onFileProgress: (p) => seen.push(p) })

    expect(seen).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/workspace-probe.spec.ts`
Expected: FAIL —— `probeWorkspace is not a function` / `exceedsLargeWorkspace is not a function`（导出尚不存在）。

- [ ] **Step 3: 在 `types.ts` 加共享类型**

在 `packages/core/src/types.ts` 末尾追加：

```ts
/**
 * 可注入的规模阈值。生产调用不传，走各模块的默认常量；
 * 测试传小数值即可用很小的目录覆盖超阈分支。
 */
export interface LargeWorkspaceLimits {
  files?: number
  bytes?: number
}
```

- [ ] **Step 4: 改造 `walkDirectory` 并新增探针（`indexer.ts`）**

在 `packages/core/src/indexer.ts` 顶部 import 里补 `type LargeWorkspaceLimits`：

```ts
import { type PluginConfig, DEFAULT_IGNORE_PATTERNS, type LargeWorkspaceLimits } from './config.js'
```

> 注意：`LargeWorkspaceLimits` 定义在 `types.ts`，而 `PluginConfig` 在 `config.ts`。`config.ts` 已经 re-export 了 `types.js` 的类型则沿用现有 import 行；否则新增一行 `import type { LargeWorkspaceLimits } from './types.js'`。以 `npm run typecheck` 为准。

在 `IndexResult` 定义之后、`walkDirectory` 之前插入：

```ts
/** 超过该可索引文件数即视为大工作区。 */
export const LARGE_WORKSPACE_FILE_LIMIT = 1000
/** 超过该源码文本字节数（UTF-8）即视为大工作区。 */
export const LARGE_WORKSPACE_BYTE_LIMIT = 500 * 1024
/** 每成功处理这么多个文件落盘一次 Merkle 状态。 */
export const DEFAULT_CHECKPOINT_EVERY = 50

/** 一次工作区扫描的结果：文件哈希 + 规模统计。 */
export interface WorkspaceProbe {
  files: Map<string, string>
  fileCount: number
  totalBytes: number
  exceedsLargeWorkspace: boolean
}

/** 纯判定：严格大于任一阈值即超阈。 */
export function exceedsLargeWorkspace(
  fileCount: number,
  totalBytes: number,
  limits?: LargeWorkspaceLimits,
): boolean {
  const fileLimit = limits?.files ?? LARGE_WORKSPACE_FILE_LIMIT
  const byteLimit = limits?.bytes ?? LARGE_WORKSPACE_BYTE_LIMIT
  return fileCount > fileLimit || totalBytes > byteLimit
}
```

把 `walkDirectory` 的返回类型由 `Promise<Map<string, string>>` 改为带统计的结构：

```ts
interface WalkResult {
  files: Map<string, string>
  totalBytes: number
}

async function walkDirectory(
  rootDir: string,
  extensions: string[],
  ignoreMatcher: IgnoreMatcher,
  progress?: (filePath: string) => void,
): Promise<WalkResult> {
  const extSet = new Set(extensions)
  const files = new Map<string, string>()
  let totalBytes = 0
  // …（函数体不变，仅两处改动）
```

函数体内两处改动：

```ts
          try {
            const content = await readFile(fullPath, 'utf-8')
            const hash = HashTracker.hashContent(content)
            files.set(fullPath, hash)
            // The content is already in memory for hashing — size comes for free.
            totalBytes += Buffer.byteLength(content, 'utf-8')
          } catch {
            // Skip files we can't read
          }
```

```ts
  await walk(rootDir)
  return { files, totalBytes }
}
```

在 `loadGlobalIgnoreFile` 之后、`runIndex` 之前插入导出的探针：

```ts
/**
 * Scan a workspace and report its size.
 *
 * Shares the ignore-rule construction with runIndex so the standalone CLI's
 * --dry-run numbers match what a real index run would see.
 */
export async function probeWorkspace(
  config: PluginConfig,
  options?: { onFileProgress?: (filePath: string) => void; limits?: LargeWorkspaceLimits },
): Promise<WorkspaceProbe> {
  const ignoreMatcher = new IgnoreMatcher([
    ...DEFAULT_IGNORE_PATTERNS,
    ...config.ignorePatterns,
  ])

  // Load codebase-specific ignore files
  const ignoreFiles = await findIgnoreFiles(config.indexRoot)
  for (const ignoreFile of ignoreFiles) {
    const patterns = await readIgnoreFile(ignoreFile)
    ignoreMatcher.addPatterns(patterns)
  }

  // Load global ignore file
  ignoreMatcher.addPatterns(await loadGlobalIgnoreFile())

  const { files, totalBytes } = await walkDirectory(
    config.indexRoot,
    config.indexExtensions,
    ignoreMatcher,
    options?.onFileProgress,
  )

  const fileCount = files.size
  return {
    files,
    fileCount,
    totalBytes,
    exceedsLargeWorkspace: exceedsLargeWorkspace(fileCount, totalBytes, options?.limits),
  }
}
```

- [ ] **Step 5: 让 `runIndex` 复用探针（去掉重复的忽略规则构建）**

在 `runIndex` 中，把「构建 ignoreMatcher + `findIgnoreFiles` + `loadGlobalIgnoreFile` + `walkDirectory`」这一整段（原 `indexer.ts:170-192`）替换为：

```ts
  // 2. Walk directory — also yields the size stats the large-workspace check needs
  progress('扫描代码仓库...')
  const probe = await probeWorkspace(config, { onFileProgress })
  const currentFiles = probe.files
```

此时 `runIndex` 的其余部分不变（本任务**不加**早退逻辑，那是 Task 2）。

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/workspace-probe.spec.ts`
Expected: PASS（9 个用例）。

- [ ] **Step 7: 确认没有回归**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts`
Expected: PASS（`runIndex` 行为未变）。

- [ ] **Step 8: 更新 barrel**

在 `packages/core/src/index.ts` 把 `runIndex` 那一行改为：

```ts
export { runIndex, getIndexStatus, probeWorkspace, exceedsLargeWorkspace,
         LARGE_WORKSPACE_FILE_LIMIT, LARGE_WORKSPACE_BYTE_LIMIT, DEFAULT_CHECKPOINT_EVERY } from './indexer.js'
export type { IndexResult, WorkspaceProbe } from './indexer.js'
```

`LargeWorkspaceLimits` 通过既有的 `export * from './types.js'` 自动导出。

- [ ] **Step 9: 类型检查并提交**

Run: `npm run typecheck`
Expected: 退出 0。

```bash
git add packages/core/src/types.ts packages/core/src/indexer.ts packages/core/src/index.ts packages/core/test/workspace-probe.spec.ts
git commit -m "feat(core): add probeWorkspace and the large-workspace predicate"
```

---

### Task 2: `runIndex` 超阈早退

**Files:**
- Modify: `packages/core/src/indexer.ts`（`IndexResult` 可选字段、`deferLargeWorkspace` 选项、早退分支、`ensureCollection` 后移）
- Test: `packages/core/test/index-defer.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `probeWorkspace`、`exceedsLargeWorkspace`、`WorkspaceProbe`、`LargeWorkspaceLimits`。
- Produces: `runIndex(..., { deferLargeWorkspace?: boolean | LargeWorkspaceLimits })`；`IndexResult.deferred?/workspaceFiles?/workspaceBytes?`。Task 8 依赖这些字段。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/index-defer.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockEnsureCollection = jest.fn(async () => {})
const mockEnsureAdrCollection = jest.fn(async () => {})
const mockInsertChunks = jest.fn(async () => 1)
const mockDeleteByFilePaths = jest.fn(async () => 0)
const mockDeleteByFilePath = jest.fn(async () => 0)

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { runIndex } = await import('../src/indexer.js')
const { HashTracker } = await import('../src/merkle.js')
const { getConfig } = await import('../src/config.js')

/** Structural stand-in for MilvusService — only the methods runIndex calls. */
function fakeMilvus(): any {
  return {
    ensureCollection: mockEnsureCollection,
    ensureAdrCollection: mockEnsureAdrCollection,
    insertChunks: mockInsertChunks,
    deleteByFilePaths: mockDeleteByFilePaths,
    deleteByFilePath: mockDeleteByFilePath,
  }
}

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'defer-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

function cfg() {
  return { ...getConfig({}), indexRoot: tmp, indexExtensions: ['.ts'] }
}

describe('runIndex large-workspace deferral', () => {
  it('defers without touching Milvus, embeddings or the tracker', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    await write('b.ts', 'export function beta() { return 2 }\n')
    const fetchSpy = jest.fn()
    globalThis.fetch = fetchSpy as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const merklePath = path.join(tmp, 'merkle.json')

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'full',
      deferLargeWorkspace: { files: 1 },
    })

    expect(result.deferred).toBe(true)
    expect(result.workspaceFiles).toBe(2)
    expect(result.workspaceBytes).toBeGreaterThan(0)
    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(result.filesSkipped).toBe(2)

    expect(mockEnsureCollection).not.toHaveBeenCalled()
    expect(mockInsertChunks).not.toHaveBeenCalled()
    expect(mockDeleteByFilePaths).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(merklePath)).toBe(false)
  })

  it('does not defer when the workspace is under the injected limit', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    globalThis.fetch = jest.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        }),
      }
    }) as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'full',
      deferLargeWorkspace: { files: 10 },
    })

    expect(result.deferred).toBeUndefined()
    expect(mockEnsureCollection).toHaveBeenCalled()
  })

  it('runs the full pipeline when deferLargeWorkspace is not set (Codex path)', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    globalThis.fetch = jest.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        }),
      }
    }) as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    const result = await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full' })

    expect(result.deferred).toBeUndefined()
    expect(mockEnsureCollection).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/index-defer.spec.ts`
Expected: FAIL —— 第一个用例 `result.deferred` 是 `undefined`（早退逻辑不存在），且 `mockEnsureCollection` 被调用了。

- [ ] **Step 3: 扩展 `IndexResult`**

在 `packages/core/src/indexer.ts` 的 `IndexResult` 中追加三个可选字段：

```ts
  durationMs: number
  /** true = 工作区超阈，本次未做分块 / Embedding / 写入。 */
  deferred?: boolean
  /** 可索引文件数（仅 deferred 时返回）。 */
  workspaceFiles?: number
  /** 源码文本 UTF-8 字节总量（仅 deferred 时返回）。 */
  workspaceBytes?: number
}
```

- [ ] **Step 4: 加选项并实现早退**

在 `runIndex` 的 `options` 类型里追加：

```ts
    importResolver?: ImportResolver  // Optional, for import map building
    logger?: Logger  // Used for progress output when no progress callback is given
    /** 超阈时只扫描统计并早退；默认 false。传对象可覆盖阈值（测试用）。 */
    deferLargeWorkspace?: boolean | LargeWorkspaceLimits
    /** 每处理 N 个文件落盘一次 Merkle 状态；0 表示只在结束时落盘。默认 50。 */
    checkpointEvery?: number
  },
```

在 `runIndex` 函数体开头（`const startTime = Date.now()` 之后）解析选项：

```ts
  const defer = options?.deferLargeWorkspace
  const deferLimits = typeof defer === 'object' ? defer : undefined
```

把原来的第 1 步（`progress('检查 Milvus 集合...')` + `await milvus.ensureCollection()`）**从 walk 之前移到早退判定之后**，最终顺序为：

```ts
  const startTime = Date.now()
  const defer = options?.deferLargeWorkspace
  const deferLimits = typeof defer === 'object' ? defer : undefined

  // 1. Walk directory — also yields the size stats the large-workspace check needs
  progress('扫描代码仓库...')
  const probe = await probeWorkspace(config, { onFileProgress, limits: deferLimits })
  const currentFiles = probe.files

  // 2. Large workspace: stop before any Milvus connection, chunking or embedding.
  if (defer && probe.exceedsLargeWorkspace) {
    return {
      filesIndexed: 0,
      chunksIndexed: 0,
      filesRemoved: 0,
      chunksRemoved: 0,
      filesSkipped: probe.fileCount,
      durationMs: Date.now() - startTime,
      deferred: true,
      workspaceFiles: probe.fileCount,
      workspaceBytes: probe.totalBytes,
    }
  }

  // 3. Ensure Milvus collection exists
  progress('检查 Milvus 集合...')
  await milvus.ensureCollection()

  // 4. Compute delta
  // …（后续步骤编号顺延，逻辑不变）
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/index-defer.spec.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 6: 确认无回归 + 类型检查**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts && npm run typecheck`
Expected: PASS 且退出 0。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/indexer.ts packages/core/test/index-defer.spec.ts
git commit -m "feat(core): let runIndex defer large workspaces before touching Milvus"
```

---

### Task 3: `checkpointEvery` 定期落盘

**Files:**
- Modify: `packages/core/src/indexer.ts`（逐文件循环内定期 `tracker.save()`）
- Test: `packages/core/test/index-checkpoint.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `checkpointEvery` 选项、`DEFAULT_CHECKPOINT_EVERY`。
- Produces: 无新导出；行为保证「中断后重跑不重复 embedding」。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/index-checkpoint.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockEnsureCollection = jest.fn(async () => {})
const mockEnsureAdrCollection = jest.fn(async () => {})
const mockInsertChunks = jest.fn(async () => 1)
const mockDeleteByFilePaths = jest.fn(async () => 0)
const mockDeleteByFilePath = jest.fn(async () => 0)

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { runIndex } = await import('../src/indexer.js')
const { HashTracker } = await import('../src/merkle.js')
const { getConfig } = await import('../src/config.js')

/** Structural stand-in for MilvusService — only the methods runIndex calls. */
function fakeMilvus(): any {
  return {
    ensureCollection: mockEnsureCollection,
    ensureAdrCollection: mockEnsureAdrCollection,
    insertChunks: mockInsertChunks,
    deleteByFilePaths: mockDeleteByFilePaths,
    deleteByFilePath: mockDeleteByFilePath,
  }
}

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'checkpoint-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

function cfg() {
  return { ...getConfig({}), indexRoot: tmp, indexExtensions: ['.ts'] }
}

function mockEmbeddings(): void {
  globalThis.fetch = jest.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body))
    return {
      ok: true,
      json: async () => ({
        data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
      }),
    }
  }) as any
}

describe('runIndex checkpointing', () => {
  const FILES = [
    ['a.ts', 'export function alpha() { return 1 }\n'],
    ['b.ts', 'export function beta() { return 2 }\n'],
    ['c.ts', 'export function gamma() { return 3 }\n'],
    ['d.ts', 'export function delta() { return 4 }\n'],
  ] as const

  it('saves once at the end when checkpointEvery is 0', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full', checkpointEvery: 0 })

    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('saves periodically while processing, not only at the end', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full', checkpointEvery: 1 })

    // One save per file plus the final save — the final save alone would be 1.
    expect(saveSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('defaults to checkpointing every DEFAULT_CHECKPOINT_EVERY files', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    // 4 files < 50, so only the final save happens — proving the default is
    // applied without error and does not save on every file.
    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full' })

    expect(saveSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/index-checkpoint.spec.ts`
Expected: 第二个用例 FAIL（`saveSpy` 只被调用 1 次 —— 定期落盘尚不存在）。

- [ ] **Step 3: 在循环内定期落盘**

在 `runIndex` 的逐文件循环中，`tracker.updateRecord(filePath, hash, inserted)` 与 `filesIndexed++` 之后追加：

```ts
        const inserted = await milvus.insertChunks(chunksWithVectors)
        tracker.updateRecord(filePath, hash, inserted)

        filesIndexed++
        chunksIndexed += inserted

        // Checkpoint periodically: an interrupted long run must not pay for the
        // same embeddings twice. Vectors already inserted are recorded as
        // unchanged, so a re-run skips them.
        if (checkpointEvery > 0 && filesIndexed % checkpointEvery === 0) {
          await tracker.save()
        }
```

并在 `runIndex` 函数体开头解析该选项（与 `defer`/`deferLimits` 放在一起）：

```ts
  const checkpointEvery = options?.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/index-checkpoint.spec.ts`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/indexer.ts packages/core/test/index-checkpoint.spec.ts
git commit -m "feat(core): checkpoint the Merkle tracker every N files"
```

---

### Task 4: 规格侧探针 `probeSpecCorpus`

**Files:**
- Modify: `packages/core/src/adr-indexer.ts`（常量、`SpecCorpusProbe`、`exceedsLargeSpecCorpus`、`probeSpecCorpus`）
- Modify: `packages/core/src/index.ts`（barrel）
- Test: `packages/core/test/spec-corpus-probe.spec.ts`（新建）

**Interfaces:**
- Consumes: `SPEC_FILE_RE`、`PLAN_FILE_RE`、`ScanRoot`（均已在 `adr-indexer.ts` 内）、`LargeWorkspaceLimits`（Task 1）。
- Produces: `LARGE_SPEC_FILE_LIMIT: 100`、`LARGE_SPEC_BYTE_LIMIT: 204800`、`interface SpecCorpusProbe { files: string[]; fileCount: number; totalBytes: number; exceedsLargeSpecCorpus: boolean }`、`exceedsLargeSpecCorpus(fileCount, totalBytes, limits?)`、`probeSpecCorpus(config, options?)`。Task 9 依赖这些。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/spec-corpus-probe.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { probeSpecCorpus, exceedsLargeSpecCorpus, LARGE_SPEC_FILE_LIMIT, LARGE_SPEC_BYTE_LIMIT } =
  await import('../src/adr-indexer.js')
const { getConfig } = await import('../src/config.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'spec-probe-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

function specCfg() {
  return {
    ...getConfig({}),
    indexRoot: tmp,
    adrRoot: 'docs/decisions',
    specRoot: 'docs/superpowers/specs',
    planRoot: 'docs/superpowers/plans',
  }
}

describe('exceedsLargeSpecCorpus', () => {
  it('uses the production constants by default', () => {
    expect(LARGE_SPEC_FILE_LIMIT).toBe(100)
    expect(LARGE_SPEC_BYTE_LIMIT).toBe(200 * 1024)
  })

  it('does not trigger at exactly the limit and triggers above it', () => {
    expect(exceedsLargeSpecCorpus(100, 0)).toBe(false)
    expect(exceedsLargeSpecCorpus(101, 0)).toBe(true)
    expect(exceedsLargeSpecCorpus(0, 204800)).toBe(false)
    expect(exceedsLargeSpecCorpus(0, 204801)).toBe(true)
  })
})

describe('probeSpecCorpus', () => {
  it('counts spec and plan documents, ignoring everything else', async () => {
    await write('docs/superpowers/specs/2026-01-01-alpha-design.md', 'A')
    await write('docs/superpowers/specs/notes.md', 'not a spec name')
    await write('docs/superpowers/plans/2026-01-02-alpha.md', 'BB')
    await write('docs/superpowers/plans/2026-01-03-beta-design.md', 'not a plan name')
    await write('docs/decisions/ADR-0001-x.md', 'not counted')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(2)
    expect(probe.totalBytes).toBe(3) // 'A' + 'BB'
    expect(probe.files.some((f) => f.endsWith('2026-01-01-alpha-design.md'))).toBe(true)
    expect(probe.files.some((f) => f.endsWith('2026-01-02-alpha.md'))).toBe(true)
  })

  it('does not recurse into subdirectories (matches runAdrIndex scan)', async () => {
    await write('docs/superpowers/specs/nested/2026-01-01-deep-design.md', 'X')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(0)
  })

  it('does not count the ADR directory', async () => {
    await write('docs/decisions/ADR-0001-x.md', 'XXXX')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(0)
    expect(probe.totalBytes).toBe(0)
  })

  it('flags a small corpus when limits are injected', async () => {
    await write('docs/superpowers/specs/2026-01-01-a-design.md', 'X')

    expect((await probeSpecCorpus(specCfg(), { limits: { files: 5 } })).exceedsLargeSpecCorpus).toBe(false)
    expect((await probeSpecCorpus(specCfg(), { limits: { files: 0 } })).exceedsLargeSpecCorpus).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/spec-corpus-probe.spec.ts`
Expected: FAIL —— `probeSpecCorpus is not a function`。

- [ ] **Step 3: 实现探针**

在 `packages/core/src/adr-indexer.ts` 的 `PLAN_FILE_RE` 之后追加：

```ts
/** 规格/计划文档规模阈值（比代码侧小：规格文档远少于代码文件）。 */
export const LARGE_SPEC_FILE_LIMIT = 100
export const LARGE_SPEC_BYTE_LIMIT = 200 * 1024

/** 一次规格库扫描的结果。 */
export interface SpecCorpusProbe {
  files: string[]
  fileCount: number
  totalBytes: number
  exceedsLargeSpecCorpus: boolean
}

/** 纯判定：严格大于任一阈值即超阈。 */
export function exceedsLargeSpecCorpus(
  fileCount: number,
  totalBytes: number,
  limits?: LargeWorkspaceLimits,
): boolean {
  const fileLimit = limits?.files ?? LARGE_SPEC_FILE_LIMIT
  const byteLimit = limits?.bytes ?? LARGE_SPEC_BYTE_LIMIT
  return fileCount > fileLimit || totalBytes > byteLimit
}

/**
 * Scan the spec + plan corpus and report its size.
 *
 * Deliberately uses the same regexes and the same non-recursive readdir as
 * runAdrIndex's scanDirectory, so the numbers describe what an index run
 * would actually touch. The ADR root is excluded — index_specs never
 * processes it.
 */
export async function probeSpecCorpus(
  config: PluginConfig,
  options?: { limits?: LargeWorkspaceLimits },
): Promise<SpecCorpusProbe> {
  const roots: ScanRoot[] = [
    { path: config.specRoot, fileRe: SPEC_FILE_RE, label: 'spec' },
    { path: config.planRoot, fileRe: PLAN_FILE_RE, label: 'plan' },
  ]

  const files: string[] = []
  let totalBytes = 0

  for (const root of roots) {
    if (!root.path) continue
    let names: string[]
    try {
      names = (await readdir(root.path)).filter((f) => root.fileRe.test(f))
    } catch {
      continue // Missing directory — contributes nothing
    }
    for (const name of names) {
      const fullPath = path.join(root.path, name)
      try {
        const content = await readFile(fullPath, 'utf-8')
        files.push(fullPath)
        totalBytes += Buffer.byteLength(content, 'utf-8')
      } catch {
        // Skip unreadable files
      }
    }
  }

  const fileCount = files.length
  return {
    files,
    fileCount,
    totalBytes,
    exceedsLargeSpecCorpus: exceedsLargeSpecCorpus(fileCount, totalBytes, options?.limits),
  }
}
```

补 import（若尚不存在）：`import type { LargeWorkspaceLimits } from './types.js'`；确认 `readFile`、`readdir`、`path` 已导入（`scanDirectory` 已用 `readdir`，读取内容处已用 `readFile`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/spec-corpus-probe.spec.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 更新 barrel 并类型检查**

在 `packages/core/src/index.ts` 把 `runAdrIndex` 那一行改为：

```ts
export { runAdrIndex, getAdrIndexStatus, probeSpecCorpus, exceedsLargeSpecCorpus,
         LARGE_SPEC_FILE_LIMIT, LARGE_SPEC_BYTE_LIMIT } from './adr-indexer.js'
export type { ScanRoot, AdrIndexResult, SpecCorpusProbe } from './adr-indexer.js'
```

Run: `npm run typecheck`
Expected: 退出 0。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/adr-indexer.ts packages/core/src/index.ts packages/core/test/spec-corpus-probe.spec.ts
git commit -m "feat(core): add probeSpecCorpus for the spec/plan corpus"
```

---

### Task 5: `run-config.json` 路径与读写

**Files:**
- Modify: `packages/core/src/config.ts`（`deriveRunConfigPath`）
- Create: `packages/core/src/run-config.ts`
- Modify: `packages/core/src/index.ts`（barrel）
- Test: `packages/core/test/run-config.spec.ts`（新建）

**Interfaces:**
- Consumes: `PluginConfig`、`deriveMerkleFilePath` 的命名/哈希规则（`config.ts`）。
- Produces: `deriveRunConfigPath(indexRoot): string`、`interface RunConfigFile { version: 1; generatedAt: string; config: PluginConfig }`、`writeRunConfig(config): Promise<string>`、`readRunConfig(filePath): Promise<RunConfigFile | null>`。Task 6/8/9 依赖这些。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/run-config.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// run-config.ts only touches fs + config, but importing the barrel would pull in
// milvus-service → the SDK. Import the source modules directly instead.
const { deriveRunConfigPath } = await import('../src/config.js')
const { writeRunConfig, readRunConfig } = await import('../src/run-config.js')
const { getConfig } = await import('../src/config.js')

let tmpHome: string
let savedHome: string | undefined

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'runcfg-home-'))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmpHome, { recursive: true, force: true })
})

describe('deriveRunConfigPath', () => {
  it('lives next to the merkle state, with the same name/hash scheme', () => {
    const root = '/home/dev/work/api'
    const dir = path.dirname(deriveRunConfigPath(root))
    expect(dir).toBe(path.join(tmpHome, '.milvus-index'))
    expect(path.basename(deriveRunConfigPath(root))).toMatch(/^run-config-api-[0-9a-f]{16}\.json$/)
  })

  it('isolates two workspaces that share a directory name', () => {
    expect(deriveRunConfigPath('/one/app')).not.toBe(deriveRunConfigPath('/two/app'))
  })
})

describe('writeRunConfig / readRunConfig', () => {
  it('round-trips the resolved config and writes it 0600', async () => {
    const root = path.join(tmpHome, 'proj')
    await mkdir(root, { recursive: true })
    const config = { ...getConfig({}), indexRoot: root }

    const filePath = await writeRunConfig(config)

    expect(filePath).toBe(deriveRunConfigPath(root))
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)

    const back = await readRunConfig(filePath)
    expect(back?.version).toBe(1)
    expect(back?.config.indexRoot).toBe(root)
    expect(back?.config.milvusAddress).toBe(config.milvusAddress)
    expect(typeof back?.generatedAt).toBe('string')
  })

  it('tightens permissions when the file already exists with looser mode', async () => {
    const root = path.join(tmpHome, 'proj2')
    await mkdir(root, { recursive: true })
    const config = { ...getConfig({}), indexRoot: root }
    const filePath = deriveRunConfigPath(root)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{}', 'utf-8')
    await chmod(filePath, 0o644)

    await writeRunConfig(config)

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it('returns null for a missing, corrupt or wrong-version file', async () => {
    const missing = path.join(tmpHome, 'nope.json')
    expect(await readRunConfig(missing)).toBeNull()

    const corrupt = path.join(tmpHome, 'corrupt.json')
    await writeFile(corrupt, '{ not json', 'utf-8')
    expect(await readRunConfig(corrupt)).toBeNull()

    const wrongVersion = path.join(tmpHome, 'v2.json')
    await writeFile(wrongVersion, JSON.stringify({ version: 2, config: { indexRoot: '/x' } }), 'utf-8')
    expect(await readRunConfig(wrongVersion)).toBeNull()

    const noConfig = path.join(tmpHome, 'noconfig.json')
    await writeFile(noConfig, JSON.stringify({ version: 1 }), 'utf-8')
    expect(await readRunConfig(noConfig)).toBeNull()
  })

  it('does not store anything but JSON (no secrets leak into the path name)', async () => {
    const root = path.join(tmpHome, 'proj3')
    await mkdir(root, { recursive: true })
    const filePath = await writeRunConfig({ ...getConfig({}), indexRoot: root })

    const raw = await readFile(filePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(path.basename(filePath)).not.toContain('token')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/run-config.spec.ts`
Expected: FAIL —— `Cannot find module '../src/run-config.js'`。

- [ ] **Step 3: 实现 `deriveRunConfigPath`（`config.ts`）**

紧跟 `deriveMerkleFilePath` 之后追加：

```ts
/**
 * Path of the per-workspace run-config that index_code writes when it defers a
 * large workspace. Same hashing/naming scheme as the Merkle state so the two
 * files sit side by side and cannot collide across workspaces.
 */
export function deriveRunConfigPath(indexRoot: string): string {
  const normalizedPath = path.resolve(indexRoot)
  const hash = createHash('sha256').update(normalizedPath, 'utf-8').digest('hex').slice(0, 16)
  const dirName = path.basename(normalizedPath) || 'root'
  const safeName = dirName.replace(/[^a-zA-Z0-9_\-]/g, '_')

  return process.env.HOME
    ? `${process.env.HOME}/.milvus-index/run-config-${safeName}-${hash}.json`
    : `.milvus-run-config-${safeName}-${hash}.json`
}
```

- [ ] **Step 4: 新建 `packages/core/src/run-config.ts`**

```ts
/**
 * Per-workspace run-config written by the DSH plugin when index_code or
 * index_specs defers a large corpus, and read by the standalone index CLI.
 *
 * It carries the *resolved* PluginConfig so the script uses exactly the same
 * Milvus/embedding settings as the running plugin, instead of re-deriving them
 * from environment variables and risking a mismatch.
 *
 * The payload includes the Milvus token and the embedding API key, so the file
 * is written 0600.
 */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import * as path from 'node:path'
import { deriveRunConfigPath, type PluginConfig } from './config.js'

export interface RunConfigFile {
  version: 1
  generatedAt: string
  config: PluginConfig
}

const CURRENT_VERSION = 1

/** Write the resolved config next to the workspace's Merkle state. Returns the path. */
export async function writeRunConfig(config: PluginConfig): Promise<string> {
  const filePath = deriveRunConfigPath(config.indexRoot)
  await mkdir(path.dirname(filePath), { recursive: true })

  const payload: RunConfigFile = {
    version: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    config,
  }

  await writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // writeFile only applies `mode` when creating; tighten a pre-existing file too.
  await chmod(filePath, 0o600)
  return filePath
}

/** Read a run-config. Returns null when missing, corrupt or of another version. */
export async function readRunConfig(filePath: string): Promise<RunConfigFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as RunConfigFile
    if (parsed?.version !== CURRENT_VERSION) return null
    if (!parsed.config || typeof parsed.config.indexRoot !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/run-config.spec.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 6: 更新 barrel 并类型检查**

在 `packages/core/src/index.ts` 的 config 导出行追加 `deriveRunConfigPath`：

```ts
export { getConfig, deriveMerkleFilePath, deriveImportMapFilePath, deriveRunConfigPath,
         DEFAULT_EXTENSIONS, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PATTERNS } from './config.js'
```

并新增一行：

```ts
export { writeRunConfig, readRunConfig } from './run-config.js'
export type { RunConfigFile } from './run-config.js'
```

Run: `npm run typecheck`
Expected: 退出 0。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/config.ts packages/core/src/run-config.ts packages/core/src/index.ts packages/core/test/run-config.spec.ts
git commit -m "feat(core): persist the resolved config for the standalone index script"
```

---

### Task 6: CLI `runIndexCli`（core）

**Files:**
- Create: `packages/core/src/cli.ts`
- Modify: `packages/core/src/index.ts`（barrel）
- Test: `packages/core/test/cli.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `probeWorkspace`、Task 2 `runIndex`、Task 3 checkpoint、Task 4 `probeSpecCorpus`（仅间接）、Task 5 `readRunConfig`/`deriveRunConfigPath`；既有 `createAdrBundle`、`runAdrIndex`、`findCandidateFiles`、`generateSpecFrontmatter`、`chunkCode`。
- Produces: `interface CliIo { out(line: string): void; err(line: string): void }`、`CLI_USAGE: string`、`parseCliArgs(argv): { args: CliArgs } | { error: string }`、`runIndexCli(argv, io): Promise<number>`。Task 7 的 bin 依赖 `runIndexCli`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/cli.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockMilvusClient = jest.fn(() => ({
  connectPromise: Promise.resolve(),
  hasCollection: jest.fn(async () => true),
  createCollection: jest.fn(async () => ({})),
  createIndex: jest.fn(async () => ({})),
  loadCollectionSync: jest.fn(async () => ({})),
  insert: jest.fn(async () => ({ insertCnt: 0 })),
  delete: jest.fn(async () => ({ deleteCnt: 0 })),
  search: jest.fn(async () => ({ results: [] })),
  query: jest.fn(async () => ({ data: [] })),
}))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: mockMilvusClient,
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const mockProbeWorkspace = jest.fn()
const mockRunIndex = jest.fn()
jest.unstable_mockModule('../src/indexer.js', () => ({
  probeWorkspace: mockProbeWorkspace,
  runIndex: mockRunIndex,
}))

const { runIndexCli, CLI_USAGE } = await import('../src/cli.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'cli-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err }
}

describe('runIndexCli argument handling', () => {
  it('prints usage and returns 0 for --help', async () => {
    const c = capture()
    expect(await runIndexCli(['--help'], c.io)).toBe(0)
    expect(c.out.join('\n')).toContain('用法')
    expect(c.out.join('\n')).toContain('--specs-only')
  })

  it('returns 2 for an unknown flag', async () => {
    const c = capture()
    expect(await runIndexCli(['--nope'], c.io)).toBe(2)
    expect(c.err.join('\n')).toContain('未知参数')
    expect(c.err.join('\n')).toContain(CLI_USAGE.split('\n')[0])
  })

  it('returns 2 when --mode gets an invalid value', async () => {
    const c = capture()
    expect(await runIndexCli(['--mode', 'sideways'], c.io)).toBe(2)
    expect(c.err.join('\n')).toContain('--mode')
  })
})

describe('runIndexCli --dry-run', () => {
  it('probes and reports without constructing Milvus or running an index', async () => {
    mockProbeWorkspace.mockResolvedValue({
      files: new Map(), fileCount: 0, totalBytes: 0, exceedsLargeWorkspace: false,
    })
    const c = capture()

    const code = await runIndexCli(['--root', tmp, '--dry-run'], c.io)

    expect(code).toBe(0)
    expect(c.out.join('\n')).toContain('[dry-run]')
    expect(mockRunIndex).not.toHaveBeenCalled()
    expect(mockMilvusClient).not.toHaveBeenCalled()
  })
})

describe('runIndexCli config resolution', () => {
  it('warns and falls back to env defaults when no run-config exists', async () => {
    mockProbeWorkspace.mockResolvedValue({
      files: new Map(), fileCount: 0, totalBytes: 0, exceedsLargeWorkspace: false,
    })
    const c = capture()

    const code = await runIndexCli(['--root', tmp, '--dry-run'], c.io)

    expect(code).toBe(0)
    expect(c.err.join('\n')).toContain('未找到可用的 run-config')
    expect(c.err.join('\n')).toContain('回退')
  })
})

describe('runIndexCli --specs-only', () => {
  it('refuses when adrEnabled is false', async () => {
    const root = path.join(tmp, 'proj')
    await mkdir(root, { recursive: true })
    const c = capture()

    const code = await runIndexCli(['--root', root, '--specs-only'], c.io)

    expect(code).toBe(1)
    expect(c.err.join('\n')).toContain('adrEnabled')
    expect(mockRunIndex).not.toHaveBeenCalled()
  })
})

describe('runIndexCli full run', () => {
  it('reports the summary and returns 0', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 3, chunksIndexed: 7, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1, durationMs: 1234,
    })
    const root = path.join(tmp, 'proj2')
    await mkdir(root, { recursive: true })
    const c = capture()

    const code = await runIndexCli(['--root', root], c.io)

    expect(code).toBe(0)
    expect(c.out.join('\n')).toContain('3 个文件')
    expect(c.out.join('\n')).toContain('7 个代码块')
  })
})
```

> 说明：`--specs-only` 与 full run 两个用例依赖 `adrEnabled` 为 false（`getConfig({})` 的默认值）。若默认值将来改变，这两个用例需显式写一份 run-config；实现时以实际默认值为准。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/cli.spec.ts`
Expected: FAIL —— `Cannot find module '../src/cli.js'`。

- [ ] **Step 3: 实现 `packages/core/src/cli.ts`**

```ts
/**
 * Standalone indexing CLI, shared by any adapter that wants to expose it.
 *
 * The DSH plugin ships this as the `dsh-context-milvus-index` bin: index_code
 * and index_specs refuse to do heavy work inline on a large corpus and instead
 * tell the user to run this in a terminal, where no session timeout applies.
 *
 * All output goes through an injected CliIo: core must not call console.*
 * directly (see core-boundary.spec.ts).
 */
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { findCandidateFiles, generateSpecFrontmatter } from './adr-anchor-generator.js'
import { createAdrBundle } from './adr-bundle.js'
import { runAdrIndex } from './adr-indexer.js'
import { chunkCode } from './chunker.js'
import { deriveImportMapFilePath, deriveMerkleFilePath, deriveRunConfigPath, getConfig, type PluginConfig } from './config.js'
import { EmbeddingClient } from './embedding.js'
import { ImportResolver } from './import-resolver.js'
import { probeWorkspace, runIndex } from './indexer.js'
import { HashTracker } from './merkle.js'
import { MilvusService } from './milvus-service.js'
import { readRunConfig } from './run-config.js'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

interface CliArgs {
  root: string
  mode: 'full' | 'incremental'
  configPath?: string
  dryRun: boolean
  specsOnly: boolean
  noAdr: boolean
  verbose: boolean
  help: boolean
}

const SPEC_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+-design\.md$/
const PLAN_FILE_RE = /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/

export const CLI_USAGE = `用法: dsh-context-milvus-index [选项]

在终端独立完成代码库与规格文档的索引（Embedding + Milvus 上传）。
大工作区下 DSH 的 index_code / index_specs 会提示你运行本命令。

选项:
  --root <path>    工作区根目录（默认: 当前目录）
  --mode <mode>    full | incremental（默认: incremental）
  --config <path>  指定 run-config.json（默认按 --root 派生）
  --specs-only     只处理 spec/plan 文档（frontmatter 生成 + 索引）
  --no-adr         跳过 ADR 与规格索引
  --dry-run        只扫描统计，不连接 Milvus、不写入
  --verbose        打印逐文件进度
  -h, --help       显示本帮助`

export function parseCliArgs(argv: string[]): { args: CliArgs } | { error: string } {
  const args: CliArgs = {
    root: process.cwd(), mode: 'incremental', dryRun: false,
    specsOnly: false, noAdr: false, verbose: false, help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') args.help = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--specs-only') args.specsOnly = true
    else if (arg === '--no-adr') args.noAdr = true
    else if (arg === '--verbose') args.verbose = true
    else if (arg === '--root') {
      const value = argv[++i]
      if (!value) return { error: '--root 需要一个路径参数' }
      args.root = value
    } else if (arg === '--config') {
      const value = argv[++i]
      if (!value) return { error: '--config 需要一个路径参数' }
      args.configPath = value
    } else if (arg === '--mode') {
      const value = argv[++i]
      if (value !== 'full' && value !== 'incremental') {
        return { error: `--mode 只接受 full 或 incremental（收到 ${value ?? '(空)'}）` }
      }
      args.mode = value
    } else {
      return { error: `未知参数: ${arg}` }
    }
  }

  return { args }
}

/** Resolve the effective config: --config > per-workspace run-config > env + defaults. */
async function resolveConfig(root: string, args: CliArgs, io: CliIo): Promise<PluginConfig> {
  const configPath = args.configPath ? path.resolve(args.configPath) : deriveRunConfigPath(root)
  const file = await readRunConfig(configPath)

  if (file) {
    if (path.resolve(file.config.indexRoot) !== root) {
      io.err(`[index] 注意: run-config 的 indexRoot 是 ${file.config.indexRoot}，与 --root ${root} 不同；以 run-config 为准。`)
    }
    return file.config
  }

  io.err(`[index] 未找到可用的 run-config: ${configPath}`)
  io.err('[index] 回退到环境变量与默认值；先在 DSH 中运行一次 index_code 可生成与插件一致的配置。')
  return { ...getConfig({}), indexRoot: root, merkleFilePath: deriveMerkleFilePath(root) }
}

/** Scan-only mode: report scale without touching Milvus or writing anything. */
async function runDryRun(config: PluginConfig, args: CliArgs, io: CliIo): Promise<number> {
  const probe = await probeWorkspace(config, {
    onFileProgress: args.verbose ? (p) => io.out(`  ${p}`) : undefined,
  })

  let chunks = 0
  for (const filePath of probe.files.keys()) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = await chunkCode(filePath, content, path.extname(filePath).toLowerCase(), {
        contextLines: config.chunkContextLines,
      })
      chunks += parsed.length
    } catch {
      // Unreadable file — it would be skipped by a real run too
    }
  }

  io.out(`[dry-run] 工作区: ${config.indexRoot}`)
  io.out(`[dry-run] 可索引文件: ${probe.fileCount}`)
  io.out(`[dry-run] 源码字节: ${probe.totalBytes}`)
  io.out(`[dry-run] 预估代码块: ${chunks}`)
  io.out(`[dry-run] 超过大工作区阈值: ${probe.exceedsLargeWorkspace ? '是' : '否'}`)
  return 0
}

/** Generate frontmatter for spec/plan candidates, then index the ADR/spec corpus. */
async function runSpecsAndAdr(
  config: PluginConfig,
  milvus: MilvusService,
  args: CliArgs,
  io: CliIo,
): Promise<void> {
  const adrConfig: PluginConfig = {
    ...config,
    adrRoot: path.resolve(config.indexRoot, config.adrRoot || 'docs/decisions'),
    specRoot: path.resolve(config.indexRoot, config.specRoot || 'docs/superpowers/specs'),
    planRoot: path.resolve(config.indexRoot, config.planRoot || 'docs/superpowers/plans'),
  }

  const candidates = [
    ...await findCandidateFiles(adrConfig.specRoot, SPEC_FILE_RE),
    ...await findCandidateFiles(adrConfig.planRoot, PLAN_FILE_RE),
  ]

  let generated = 0
  for (const filePath of candidates) {
    try {
      if (await generateSpecFrontmatter(filePath, adrConfig.indexRoot)) generated++
    } catch (err) {
      io.err(`[specs] 生成 frontmatter 失败 ${filePath}: ${(err as Error).message}`)
    }
  }
  io.out(`[specs] frontmatter 生成: ${generated} / 候选 ${candidates.length}`)

  const bundle = await createAdrBundle(adrConfig, { createWhenMissing: true })
  const result = await runAdrIndex(adrConfig, milvus, bundle.tracker, bundle.anchorIndex, {
    mode: args.mode,
    progress: (msg) => io.out(`[adr] ${msg}`),
  })
  io.out(`[adr] 完成: ${result.filesIndexed} 个文件 / ${result.chunksIndexed} 个代码块`)
}

export async function runIndexCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv)
  if ('error' in parsed) {
    io.err(parsed.error)
    io.err(CLI_USAGE)
    return 2
  }

  const args = parsed.args
  if (args.help) {
    io.out(CLI_USAGE)
    return 0
  }

  const root = path.resolve(args.root)
  const config = await resolveConfig(root, args, io)

  if (args.dryRun) return runDryRun(config, args, io)

  const embeddingClient = new EmbeddingClient(config.embedding)
  const milvus = new MilvusService({
    address: config.milvusAddress,
    token: config.milvusToken,
    collection: config.milvusCollection,
    dim: config.milvusDim,
    embeddingClient,
    hybridMode: config.hybridMode,
    bm25RrfK: config.bm25RrfK,
    queryExpansion: config.queryExpansion,
    rerankConfig: { enabled: config.rerankEnabled, multiplier: config.rerankMultiplier },
  })

  const tracker = new HashTracker(config.merkleFilePath)
  await tracker.load().catch(() => {})
  const importResolver = new ImportResolver(deriveImportMapFilePath(config.indexRoot))
  await importResolver.load().catch(() => {})

  // Ctrl-C must not throw away the work already embedded.
  const onSigint = () => {
    void tracker.save().finally(() => process.exit(130))
  }
  process.on('SIGINT', onSigint)

  try {
    if (!args.specsOnly) {
      const result = await runIndex(config, milvus, tracker, {
        mode: args.mode,
        progress: (msg) => io.out(`[index] ${msg}`),
        onFileProgress: args.verbose ? (p) => io.out(`  ${p}`) : undefined,
        importResolver,
      })
      io.out(
        `[index] 完成: ${result.filesIndexed} 个文件 / ${result.chunksIndexed} 个代码块 ` +
        `(${(result.durationMs / 1000).toFixed(1)}s)`,
      )
      if (result.filesRemoved || result.chunksRemoved) {
        io.out(`[index] 清理: ${result.filesRemoved} 个文件 / ${result.chunksRemoved} 个代码块`)
      }
    }

    if (args.noAdr) {
      io.out('[adr] 已按 --no-adr 跳过 ADR 与规格索引')
      return 0
    }

    if (!config.adrEnabled) {
      if (args.specsOnly) {
        io.err('[specs] 规格索引属于 ADR 功能：请在 DSH 设置面板启用 adrEnabled 后重试')
        return 1
      }
      io.out('[adr] adrEnabled=false，跳过 ADR 与规格索引')
      return 0
    }

    await runSpecsAndAdr(config, milvus, args, io)
    return 0
  } catch (err) {
    io.err(`[index] 失败: ${(err as Error).message}`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
    await tracker.save().catch(() => {})
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/cli.spec.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 确认 core 边界未被破坏**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/core-boundary.spec.ts`
Expected: PASS（`cli.ts` 不出现 `console.`）。

- [ ] **Step 6: 更新 barrel 并类型检查**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { runIndexCli, parseCliArgs, CLI_USAGE } from './cli.js'
export type { CliIo } from './cli.js'
```

Run: `npm run typecheck`
Expected: 退出 0。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/cli.ts packages/core/src/index.ts packages/core/test/cli.spec.ts
git commit -m "feat(core): add the standalone index CLI"
```

---

### Task 7: dsh bin + `buildIndexCommand` + 打包

**Files:**
- Create: `packages/dsh/bin/index.js`
- Create: `packages/dsh/src/plugins/dsh-context-milvus/index-command.ts`
- Modify: `packages/dsh/package.json`（`bin`、`files`）
- Test: `packages/dsh/test/index-command.spec.ts`（新建）、`packages/dsh/test/bin-smoke.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 6 的 `runIndexCli`（bin 通过包名 `dsh-context-milvus-core` 导入）。
- Produces: `buildIndexCommand(indexRoot: string, options?: { specsOnly?: boolean }): string`。Task 8/9 依赖它。

- [ ] **Step 1: 写失败的测试**

新建 `packages/dsh/test/index-command.spec.ts`：

```ts
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const { buildIndexCommand } = await import('../src/plugins/dsh-context-milvus/index-command.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/index.js')

describe('buildIndexCommand', () => {
  it('points at this package\'s own bin when it exists', () => {
    expect(existsSync(BIN)).toBe(true) // the bin ships with this package

    const command = buildIndexCommand('/work/my repo')

    expect(command).toContain(BIN)
    expect(command).toContain('--root')
    expect(command).toContain('"/work/my repo"') // quoted for spaces
    expect(command).not.toContain('--specs-only')
  })

  it('appends --specs-only when asked', () => {
    expect(buildIndexCommand('/work/api', { specsOnly: true })).toContain('--specs-only')
  })

  it('falls back to npx for an unknown layout', () => {
    // Documented fallback branch: asserted via the npx form of the string.
    const command = buildIndexCommand('/work/api')
    expect(command.startsWith('node ') || command.startsWith('npx ')).toBe(true)
  })
})
```

新建 `packages/dsh/test/bin-smoke.spec.ts`：

```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/index.js')
// The bin imports the core *package*, whose entry is dist/index.js — so this
// spec needs `npm run build` first, exactly like packages/codex/test/mcp-smoke.spec.ts.
const CORE_BUILT = existsSync(path.resolve(HERE, '../../core/dist/cli.js'))
const maybeIt = CORE_BUILT ? it : it.skip

async function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { err += String(c) })
  const [code] = await once(child, 'exit')
  return { code, out, err }
}

describe('dsh-context-milvus-index bin', () => {
  maybeIt('prints usage and exits 0 for --help', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('用法')
    expect(out).toContain('--specs-only')
  })

  maybeIt('exits 2 for an unknown flag', async () => {
    const { code, err } = await run(['--nope'])
    expect(code).toBe(2)
    expect(err).toContain('未知参数')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-command.spec.ts`
Expected: FAIL —— `Cannot find module '../src/plugins/dsh-context-milvus/index-command.js'`。

- [ ] **Step 3: 实现 `index-command.ts`**

```ts
/**
 * Build the paste-ready command that index_code / index_specs hand to the user
 * when they defer a large corpus.
 *
 * The command points at *this* package's bin, resolved from this module's own
 * URL, so it works wherever DSH installed the plugin (profile node_modules,
 * a global install, or a checkout). src/ and dist/ sit at the same depth, so
 * one relative path covers both layouts.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BIN_RELATIVE = '../../../bin/index.js'

/** Quote a path for a shell command line (double quotes survive spaces). */
function quote(value: string): string {
  return JSON.stringify(value)
}

export function buildIndexCommand(indexRoot: string, options?: { specsOnly?: boolean }): string {
  const binPath = fileURLToPath(new URL(BIN_RELATIVE, import.meta.url))

  const parts = existsSync(binPath)
    ? ['node', quote(binPath)]
    : ['npx', '-p', 'dsh-context-milvus', 'dsh-context-milvus-index']

  parts.push('--root', quote(indexRoot))
  if (options?.specsOnly) parts.push('--specs-only')

  return parts.join(' ')
}
```

- [ ] **Step 4: 新建 `packages/dsh/bin/index.js`**

```js
#!/usr/bin/env node
/**
 * Standalone indexing entry point for dsh-context-milvus.
 *
 * The plugin never runs heavy indexing inline on a large workspace; it hands
 * the user a command that runs this script in their own terminal instead, where
 * no session timeout applies and Ctrl-C is safe (the Merkle tracker is
 * checkpointed as it goes).
 */
import { runIndexCli } from 'dsh-context-milvus-core'

process.exitCode = await runIndexCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})
```

- [ ] **Step 5: 打包配置（`packages/dsh/package.json`）**

在 `"dsh"` 之前插入 `bin`：

```json
  "bin": {
    "dsh-context-milvus-index": "bin/index.js"
  },
```

并把 `files` 改为（新增 `"bin"`）：

```json
  "files": [
    "dist",
    "bin",
    "client",
    "cordis-entry.yml",
    "cordis.patch.yml",
    "LICENSE",
    "README.md"
  ],
```

- [ ] **Step 6: 构建后运行测试**

Run: `npm run build`
Expected: 退出 0（生成 `packages/core/dist/cli.js` 等）。

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-command.spec.ts packages/dsh/test/bin-smoke.spec.ts`
Expected: PASS（`bin-smoke` 的 2 个用例此时不再 skip）。

- [ ] **Step 7: 提交**

```bash
git add packages/dsh/bin/index.js packages/dsh/src/plugins/dsh-context-milvus/index-command.ts packages/dsh/package.json packages/dsh/test/index-command.spec.ts packages/dsh/test/bin-smoke.spec.ts
git commit -m "feat(dsh): ship the standalone index script as a bin"
```

---

### Task 8: `index_code` 降级分支

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/tools.ts`（import、输出 schema、`render`、`execute`、文案格式化函数）
- Test: `packages/dsh/test/index-code-defer.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `IndexResult.deferred/workspaceFiles/workspaceBytes`、Task 5 的 `writeRunConfig`、Task 7 的 `buildIndexCommand`、Task 1 的阈值常量。
- Produces: `index_code` 新增输出字段 `deferred` / `workspaceFiles` / `workspaceBytes` / `nextCommand`。Task 9 复用同样的模式。

- [ ] **Step 1: 写失败的测试**

新建 `packages/dsh/test/index-code-defer.spec.ts`（mock 头部沿用 `adr-tools.spec.ts` 的既有做法）：

```ts
import { jest } from '@jest/globals'

const mockRegister = jest.fn(() => jest.fn())
const mockDefineTool = jest.fn((opts: any) => opts)
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({ defineTool: mockDefineTool }))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const mockRunIndex = jest.fn()
jest.unstable_mockModule('../../core/src/indexer.js', () => ({
  runIndex: mockRunIndex,
  getIndexStatus: jest.fn(),
  probeWorkspace: jest.fn(),
  exceedsLargeWorkspace: jest.fn(),
  LARGE_WORKSPACE_FILE_LIMIT: 1000,
  LARGE_WORKSPACE_BYTE_LIMIT: 500 * 1024,
  DEFAULT_CHECKPOINT_EVERY: 50,
}))

const mockRunAdrIndex = jest.fn()
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  runAdrIndex: mockRunAdrIndex,
  getAdrIndexStatus: jest.fn(),
}))

const mockWriteRunConfig = jest.fn(async () => '/tmp/run-config.json')
jest.unstable_mockModule('../../core/src/run-config.js', () => ({
  writeRunConfig: mockWriteRunConfig,
  readRunConfig: jest.fn(),
}))

const mockBuildIndexCommand = jest.fn((root: string) => `node /pkg/bin/index.js --root "${root}"`)
jest.unstable_mockModule(
  '../src/plugins/dsh-context-milvus/index-command.js',
  () => ({ buildIndexCommand: mockBuildIndexCommand }),
)

class MockHashTracker {
  constructor(_path: string) {}
  async load() {}
  async save() {}
  computeDelta() { return { toIndex: [], toRemove: [], unchanged: [] } }
  getStats() { return { totalFiles: 0, totalChunks: 0 } }
  getLastIndexedTimestamp() { return null }
}
jest.unstable_mockModule('../../core/src/merkle.js', () => ({ HashTracker: MockHashTracker }))

const { registerTools } = await import('../src/plugins/dsh-context-milvus/tools.js')

function makeCtx() {
  return { tools: { register: mockRegister } } as any
}

const baseConfig = {
  adrEnabled: false,
  indexRoot: '/workspace/test',
  adrRoot: 'docs/decisions',
  specRoot: 'docs/superpowers/specs',
  planRoot: 'docs/superpowers/plans',
  indexExtensions: ['.ts'],
  ignorePatterns: [],
  chunkContextLines: 2,
}

function indexCodeDef() {
  mockRegister.mockClear()
  registerTools(makeCtx(), () => baseConfig as any, () => ({}) as any, () => new MockHashTracker('x') as any, undefined)
  return mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]
}

describe('index_code large-workspace deferral', () => {
  it('returns the deferral payload, writes the run-config and skips ADR', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
    })

    const result = await indexCodeDef().execute({ mode: 'incremental' })

    expect(result.deferred).toBe(true)
    expect(result.workspaceFiles).toBe(1234)
    expect(result.nextCommand).toContain('--root')
    expect(mockWriteRunConfig).toHaveBeenCalledTimes(1)
    expect(mockRunAdrIndex).not.toHaveBeenCalled()
  })

  it('passes deferLargeWorkspace: true to runIndex', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 1, chunksIndexed: 1, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 0, durationMs: 5,
    })

    await indexCodeDef().execute({ mode: 'incremental' })

    expect(mockRunIndex.mock.calls[0][3]).toMatchObject({ deferLargeWorkspace: true })
  })

  it('renders the prompt with the command instead of index counts', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
    })
    const def = indexCodeDef()

    const blocks = def.output.render({}, {
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
      nextCommand: 'node /pkg/bin/index.js --root "/workspace/test"',
    })
    const text = blocks.map((b: any) => b.text).join('\n')

    expect(text).toContain('已跳过 Embedding')
    expect(text).toContain('node /pkg/bin/index.js')
    expect(text).toContain('--dry-run')
  })

  it('still writes the run-config when it fails, and still returns the command', async () => {
    mockWriteRunConfig.mockRejectedValueOnce(new Error('EACCES'))
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 10, durationMs: 3,
      deferred: true, workspaceFiles: 10, workspaceBytes: 100,
    })

    const result = await indexCodeDef().execute({ mode: 'incremental' })

    expect(result.deferred).toBe(true)
    expect(result.nextCommand).toContain('--root')
  })

  it('reloads the effective tracker so state written by the standalone script is picked up', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 0, durationMs: 1,
    })
    const tracker = new MockHashTracker('x')
    const loadSpy = jest.spyOn(tracker, 'load')

    mockRegister.mockClear()
    registerTools(
      makeCtx(), () => baseConfig as any, () => ({}) as any, () => tracker as any, undefined,
    )
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]

    await def.execute({ mode: 'incremental' })

    expect(loadSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-code-defer.spec.ts`
Expected: FAIL —— `result.nextCommand` 是 `undefined`（降级分支不存在）。

- [ ] **Step 3: 扩展输出 schema 与 render**

在 `packages/dsh/src/plugins/dsh-context-milvus/tools.ts` 的 `index_code` 定义中，把 `output.schema.properties` 改为：

```ts
          properties: {
            filesIndexed: { type: 'number' },
            chunksIndexed: { type: 'number' },
            filesRemoved: { type: 'number' },
            chunksRemoved: { type: 'number' },
            filesSkipped: { type: 'number' },
            durationMs: { type: 'number' },
            adrFilesIndexed: { type: 'number' },
            adrChunksIndexed: { type: 'number' },
            // Large-workspace deferral: nothing was indexed this call.
            deferred: { type: 'boolean' },
            workspaceFiles: { type: 'number' },
            workspaceBytes: { type: 'number' },
            nextCommand: { type: 'string' },
          },
```

把 `render` 改为：

```ts
        render: (_args: any, value: any) => {
          if (value.deferred) {
            return [{ type: 'text' as const, text: formatDeferredIndexResult(value) }]
          }
          return [{ type: 'text' as const, text: formatIndexResult(value) }]
        },
```

在 `tools.ts` 中 `formatIndexResult` 附近新增：

```ts
/** Message shown when index_code refused to index a large workspace inline. */
function formatDeferredIndexResult(value: any): string {
  const mib = (value.workspaceBytes / (1024 * 1024)).toFixed(1)
  return [
    `⚠️ 工作区较大（${value.workspaceFiles} 个文件 / ${mib} MiB 源码；` +
    `阈值 ${LARGE_WORKSPACE_FILE_LIMIT} 文件 / ${LARGE_WORKSPACE_BYTE_LIMIT / 1024} KiB），` +
    '已跳过 Embedding 与 Milvus 上传。',
    '本次未做任何向量化，不产生 embedding 费用，索引也未更新。',
    '',
    '请在终端单独运行以下命令完成索引：',
    `  ${value.nextCommand}`,
    '',
    '可先加 --dry-run 查看规模；Ctrl-C 可中断，重跑会自动续传。',
    '若命令报错找不到配置，请先在 DSH 中重跑 index_code 生成配置，或改用环境变量运行。',
    '完成后 search_code / find_callers 才能检索到这个工作区。',
  ].join('\n')
}
```

在 `tools.ts` 的 core import 中补上 `writeRunConfig`、`LARGE_WORKSPACE_FILE_LIMIT`、`LARGE_WORKSPACE_BYTE_LIMIT`，并新增：

```ts
import { buildIndexCommand } from './index-command.js'
```

- [ ] **Step 4: 加降级分支 + 重载 tracker**

在 `index_code.execute` 中，先在 `createTrackerForPath` 之后重载一次 Merkle 状态（`createTrackerForPath` 在无 `path` 覆盖时直接返回默认 tracker、不会重新读盘，而独立脚本可能在另一个进程里更新过该文件）：

```ts
        const effectiveTracker = await createTrackerForPath(config, overridePath, resolveTracker())

        // The standalone script writes this same Merkle file from another
        // process; reload so its progress is visible here (load() replaces the
        // in-memory state wholesale and save() is a no-op unless dirty).
        await effectiveTracker.load().catch(() => {
          // Missing or unreadable state file — treat as a fresh start
        })
```

然后把 `runIndex` 调用改为传入开关，并在其后插入降级分支：

```ts
        const milvus = resolveMilvus()
        const codeResult = await runIndex(effectiveConfig, milvus, effectiveTracker, {
          mode,
          progress,
          importResolver: effectiveImportResolver,
          deferLargeWorkspace: true,
        })

        // Large workspace: nothing was chunked, embedded or written. Persist the
        // resolved config (so the script runs with identical settings) and hand
        // the user a paste-ready command instead.
        if (codeResult.deferred) {
          try {
            await writeRunConfig(effectiveConfig)
          } catch (err) {
            console.warn(
              `[dsh-context-milvus] run-config 落盘失败: ${(err as Error).message}`,
            )
          }

          telemetry.log({
            ts: new Date().toISOString(),
            tool: 'index_code',
            mode,
            path: effectiveConfig.indexRoot,
            filesIndexed: 0,
            chunksIndexed: 0,
            filesSkipped: codeResult.filesSkipped,
            durationMs: codeResult.durationMs,
            deferred: true,
          })

          return {
            ...codeResult,
            nextCommand: buildIndexCommand(effectiveConfig.indexRoot),
          }
        }
```

（后续 ADR 索引与既有 telemetry 调用保持不变。）

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-code-defer.spec.ts packages/dsh/test/adr-tools.spec.ts`
Expected: PASS（新用例通过，`adr-tools.spec.ts` 的既有断言不受新增字段影响）。

- [ ] **Step 6: 确认冻结面未动**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/public-surface.spec.ts`
Expected: PASS，且 `git diff --stat packages/dsh/test/public-surface.spec.ts` 为空。

- [ ] **Step 7: 提交**

```bash
git add packages/dsh/src/plugins/dsh-context-milvus/tools.ts packages/dsh/test/index-code-defer.spec.ts
git commit -m "feat(dsh): defer index_code on large workspaces"
```

---

### Task 9: `index_specs` 降级分支

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts`（import、输出 schema、`render`、`execute`、文案格式化函数）
- Test: `packages/dsh/test/index-specs-defer.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `probeSpecCorpus`/`LARGE_SPEC_FILE_LIMIT`/`LARGE_SPEC_BYTE_LIMIT`、Task 5 的 `writeRunConfig`、Task 7 的 `buildIndexCommand`。
- Produces: `index_specs` 新增输出字段 `deferred` / `specFiles` / `specBytes` / `nextCommand`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/dsh/test/index-specs-defer.spec.ts`：

```ts
import { jest } from '@jest/globals'

const mockRegister = jest.fn(() => jest.fn())
const mockDefineTool = jest.fn((opts: any) => opts)
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({ defineTool: mockDefineTool }))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const mockProbeSpecCorpus = jest.fn()
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  runAdrIndex: jest.fn(),
  getAdrIndexStatus: jest.fn(),
  probeSpecCorpus: mockProbeSpecCorpus,
  exceedsLargeSpecCorpus: jest.fn(),
  LARGE_SPEC_FILE_LIMIT: 100,
  LARGE_SPEC_BYTE_LIMIT: 200 * 1024,
}))

const mockFindCandidateFiles = jest.fn(async () => [])
const mockGenerateSpecFrontmatter = jest.fn()
jest.unstable_mockModule('../../core/src/adr-anchor-generator.js', () => ({
  findCandidateFiles: mockFindCandidateFiles,
  previewFrontmatter: jest.fn(),
  generateSpecFrontmatter: mockGenerateSpecFrontmatter,
  detectCodeReferences: jest.fn(),
}))

const mockWriteRunConfig = jest.fn(async () => '/tmp/run-config.json')
jest.unstable_mockModule('../../core/src/run-config.js', () => ({
  writeRunConfig: mockWriteRunConfig,
  readRunConfig: jest.fn(),
}))

const mockBuildIndexCommand = jest.fn((root: string, opts?: any) =>
  `node /pkg/bin/index.js --root "${root}"${opts?.specsOnly ? ' --specs-only' : ''}`)
jest.unstable_mockModule(
  '../src/plugins/dsh-context-milvus/index-command.js',
  () => ({ buildIndexCommand: mockBuildIndexCommand }),
)

const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

const config = {
  adrEnabled: true,
  indexRoot: '/workspace/test',
  adrRoot: 'docs/decisions',
  specRoot: 'docs/superpowers/specs',
  planRoot: 'docs/superpowers/plans',
}

function indexSpecsDef() {
  mockRegister.mockClear()
  const ctx = { tools: { register: mockRegister } } as any
  registerAdrTools(ctx, () => config as any, () => ({}) as any, {} as any, {} as any)
  return mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]
}

describe('index_specs large-corpus deferral', () => {
  it('defers without generating frontmatter or indexing', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 143, totalBytes: 320_000, exceedsLargeSpecCorpus: true,
    })

    const result = await indexSpecsDef().execute({})

    expect(result.deferred).toBe(true)
    expect(result.specFiles).toBe(143)
    expect(result.nextCommand).toContain('--specs-only')
    expect(mockGenerateSpecFrontmatter).not.toHaveBeenCalled()
    expect(mockFindCandidateFiles).not.toHaveBeenCalled()
    expect(mockWriteRunConfig).toHaveBeenCalledTimes(1)
  })

  it('does not defer a dry_run preview even when over the limit', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 143, totalBytes: 320_000, exceedsLargeSpecCorpus: true,
    })

    const result = await indexSpecsDef().execute({ dry_run: true })

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
  })

  it('keeps the normal path when under the limit', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 2, totalBytes: 100, exceedsLargeSpecCorpus: false,
    })

    const result = await indexSpecsDef().execute({})

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-specs-defer.spec.ts`
Expected: FAIL —— `result.deferred` 是 `undefined`。

- [ ] **Step 3: 扩展输出 schema 与 render**

在 `packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts` 的 `index_specs` 定义中，向 `output.schema.properties` 追加：

```ts
          // Large-corpus deferral: nothing was written or indexed this call.
          deferred: { type: 'boolean' },
          specFiles: { type: 'number' },
          specBytes: { type: 'number' },
          nextCommand: { type: 'string' },
```

在 `render` 开头插入降级分支：

```ts
      render: (_args: any, value: any) => {
        if (value.deferred) {
          return [{ type: 'text' as const, text: formatDeferredSpecsResult(value) }]
        }
        const lines: string[] = []
        // …（其余不变）
```

在 `adr-tools.ts` 的 `formatAdrSearchResults` 附近新增：

```ts
/** Message shown when index_specs refused to process a large spec corpus inline. */
function formatDeferredSpecsResult(value: any): string {
  const kib = Math.round(value.specBytes / 1024)
  return [
    `⚠️ 规格文档较多（${value.specFiles} 个文档 / ${kib} KiB；` +
    `阈值 ${LARGE_SPEC_FILE_LIMIT} 个文档 / ${LARGE_SPEC_BYTE_LIMIT / 1024} KiB），` +
    '已跳过 frontmatter 生成与索引。',
    '本次未写入任何文件，也未做向量化。',
    '',
    '请在终端单独运行以下命令：',
    `  ${value.nextCommand}`,
    '',
    '如需先预览将要生成的锚点，可继续使用 index_specs(dry_run=true)。',
  ].join('\n')
}
```

在 `adr-tools.ts` 的 core import 中补上 `probeSpecCorpus`、`LARGE_SPEC_FILE_LIMIT`、`LARGE_SPEC_BYTE_LIMIT`、`writeRunConfig`、`deriveMerkleFilePath`，并新增：

```ts
import { buildIndexCommand } from './index-command.js'
```

- [ ] **Step 4: 在 `execute` 最前面加降级判定**

在 `index_specs.execute` 中，`specRoot` / `planRoot` 解析之后、`findCandidateFiles` 之前插入：

```ts
      // Large spec corpus: stop before generating frontmatter (which writes to
      // the user's files) or indexing anything. dry_run is exempt — a preview
      // has no side effects and is how a user inspects the scale.
      const probe = await probeSpecCorpus({ ...config, specRoot, planRoot })
      if (!params.dry_run && probe.exceedsLargeSpecCorpus) {
        try {
          await writeRunConfig({ ...config, indexRoot, merkleFilePath: deriveMerkleFilePath(indexRoot) })
        } catch (err) {
          console.warn(
            `[dsh-context-milvus] run-config 落盘失败: ${(err as Error).message}`,
          )
        }

        return {
          filesProcessed: 0,
          anchorsGenerated: 0,
          filesIndexed: 0,
          chunksIndexed: 0,
          dryRun: false,
          preview: [],
          deferred: true,
          specFiles: probe.fileCount,
          specBytes: probe.totalBytes,
          nextCommand: buildIndexCommand(indexRoot, { specsOnly: true }),
        }
      }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/index-specs-defer.spec.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 6: 全量测试 + 类型检查 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部通过（既有 30 suites / 378 tests 加上本计划新增的 spec）。

- [ ] **Step 7: 提交**

```bash
git add packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts packages/dsh/test/index-specs-defer.spec.ts
git commit -m "feat(dsh): defer index_specs on large spec corpora"
```

---

### Task 10: 文档

**Files:**
- Modify: `README.md`（`index_code` 章节、`index_specs` 章节、新增「独立索引脚本」小节）
- Modify: `packages/dsh/README.md`（一句话指向脚本）

**Interfaces:**
- Consumes: 前面所有任务的最终 CLI 参数与阈值常量。
- Produces: 无代码接口。

- [ ] **Step 1: README `index_code` 章节补充降级行为**

在 `README.md` 的 `### index_code` 小节参数表之后追加：

```markdown
**大工作区降级：** 当工作区的可索引文件数 > 1000，或源码文本总量 > 500 KiB（UTF-8 字节）时，
`index_code` 只做扫描统计并立即返回，**不做分块、不调用 Embedding、不写 Milvus**，
同时给出可在终端直接运行的索引命令（见下文「独立索引脚本」）。这是为了避免大仓库把
一次工具调用拖到超时，并在用户不知情的情况下产生 embedding 费用。

未超过阈值时行为不变；Codex 的 `index_code` 不参与降级。
```

- [ ] **Step 2: README `index_specs` 章节补充降级行为**

在 `README.md` 的 `### index_specs` 小节（若不存在则紧跟 `index_status` 之后）追加：

```markdown
**大规格库降级：** 当 `specRoot` + `planRoot` 下的规格/计划文档数 > 100，或文本总量 > 200 KiB 时，
`index_specs` 只做扫描统计并立即返回，**不生成 frontmatter、不写任何文件、不索引**，
并给出带 `--specs-only` 的终端命令。

`index_specs(dry_run=true)` 不受此限制（预览无副作用），可用它先查看将要生成哪些锚点。
```

- [ ] **Step 3: README 新增「独立索引脚本」小节**

在 `README.md` 的 `## 使用` 章节末尾（`index_code` / `index_specs` 之后）追加：

```markdown
## 独立索引脚本

大工作区下插件会把重活交给你在终端独立完成。脚本随 `dsh-context-milvus` 一起发布：

```bash
# 完整索引：代码 → spec/plan frontmatter 生成 → ADR/规格索引
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace

# 只处理规格文档
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace --specs-only

# 先看规模（不连 Milvus、不写任何东西）
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace --dry-run
```

| 参数 | 说明 |
|------|------|
| `--root <path>` | 工作区根目录（默认当前目录） |
| `--mode full\|incremental` | 索引模式（默认 `incremental`） |
| `--config <path>` | 指定 run-config（默认按 `--root` 派生） |
| `--specs-only` | 只做 spec/plan 的 frontmatter 生成与索引 |
| `--no-adr` | 跳过 ADR 与规格索引 |
| `--dry-run` | 只扫描统计 |
| `--verbose` | 打印逐文件进度 |

退出码：`0` 成功、`1` 运行失败、`2` 用法错误；`Ctrl-C` 会先落盘进度再以 `130` 退出，重跑自动续传。

**配置来源：** 脚本优先读取 `~/.milvus-index/run-config-<工作区名>-<hash>.json` ——
这是 `index_code` / `index_specs` 降级时写下的**解析后有效配置**（含 Milvus 地址/token、
embedding 端点/模型等，文件权限 `0600`），因此脚本与插件使用完全一致的设置。
没有该文件时回退到环境变量与默认值，并打印警告。

**不要与插件同时运行索引**：两者不会损坏数据，但会重复劳动。
```

- [ ] **Step 4: `packages/dsh/README.md` 加一句**

在 `packages/dsh/README.md` 的工具列表之后追加：

```markdown
大工作区下 `index_code` / `index_specs` 只做扫描并提示你在终端运行
`dsh-context-milvus-index`（随本包发布的脚本），详见根 README「独立索引脚本」。
```

- [ ] **Step 5: 提交**

```bash
git add README.md packages/dsh/README.md
git commit -m "docs: document the large-corpus deferral and the standalone script"
```

---

## 收尾检查（全部任务完成后）

- [ ] `npm run typecheck` 退出 0。
- [ ] `npm run build` 退出 0。
- [ ] `npm test` 全绿。
- [ ] `git diff --stat HEAD~10 -- packages/dsh/test/public-surface.spec.ts packages/dsh/package.json` 只显示 `package.json` 的 `bin`/`files` 变化，`public-surface.spec.ts` 无变化。
- [ ] `git status --porcelain` 干净。
- [ ] 手工验证（需要真实 Milvus + 一个 >1000 文件的工作区）：`index_code` 立即返回提示；按提示命令在终端跑完后 `search_code` 能检索到该工作区。
- [ ] 手工验证（需要真实 Milvus + ADR 已启用 + 一个 >100 篇规格文档的仓库）：`index_specs` 立即返回提示且未改动任何文件（`git status` 干净）；按提示的 `--specs-only` 命令跑完后 `search_adr` 能检索到这些规格文档。
