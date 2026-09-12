# Codex ADR 决策记忆移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DSH 插件里的 8 个 ADR 决策记忆工具搬到 `codex-context-milvus`，两端共用同一份 ADR 状态文件与同一个 `adr_embeddings` 集合。

**Architecture:** ADR 引擎（6 个模块 / 1171 行）从 `packages/dsh` 机械提升到 `packages/core`，core 新增状态路径助手、`ADR_*` 环境变量回退与 `createAdrBundle()` 装配函数；DSH 切到 bundle 且行为零变化；codex 在 `ADR_ENABLED` 门控下注册 8 个 ADR 工具，写类工具默认由 `CONTEXT_MILVUS_ADR_WRITE` 关闭，并把约束注入降级为 `search_code` 的被动提醒。

**Tech Stack:** TypeScript (ESM / NodeNext / strict)、Jest 29 + ts-jest ESM、`@modelcontextprotocol/sdk`、`zod`、`js-yaml`、Milvus (`@zilliz/milvus2-sdk-node`)。

**Spec:** `docs/superpowers/specs/2026-09-12-codex-adr-port-design.md` —— 本计划论证自该 spec，执行时两份一起读。

## Global Constraints

每个任务的隐含要求，值逐字取自 spec：

- 仓库根目录是 `/home/bobjia/projects/dsh-context-milvus`（不是 spec 里出现过的外部路径）
- `packages/core/src/**` 禁止 import `@deepseek-ai/`、`@modelcontextprotocol/`、`zod`，禁止 `console.log|warn|info(`（`logger.ts` 除外）—— 由 `packages/core/test/core-boundary.spec.ts` 强制
- DSH 对外契约冻结：13 个工具名、27 个 `Config` 字段、`main: dist/plugins/dsh-context-milvus/index.js`；`packages/dsh/test/public-surface.spec.ts` 必须**不被修改**就一直绿
- MCP 端 stdout 只允许 JSON-RPC，一切日志走 stderr
- ADR 状态文件路径必须与历史表达式 `deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors')` / `.replace('merkle', 'adr-merkle')` **逐字节相同**
- 安装：`npm_config_cache=.npm-cache npm install --legacy-peer-deps`（既有 peer 冲突，与本次改动无关）
- 全量测试：`npm test`；单文件测试：`node --experimental-vm-modules node_modules/.bin/jest <path>`（`npx jest <file>` 会报 `Cannot use import statement outside a module`）
- 代码风格：无分号、单引号、2 空格缩进、`type` 导入用 `import type`
- 版本终值：core `0.2.0`、codex `0.2.0`、dsh `0.6.7`；两个适配器对 core 的依赖写 `^0.2.0`
- 每个任务结束时 `npm test` 必须全绿，并且**只有一次 commit**

**基线（任务 1 开始前必须实测确认）：** `Test Suites: 23 passed`，`Tests: 286 passed`。任何任务结束时低于这个数字都说明做错了。

## 与 spec §7 的对应

spec 把交付写成 6 步，本计划拆成 9 个任务，拆分理由是每个任务结束都能独立跑测试：spec 步骤 1 → 任务 1；步骤 2 → 任务 2 + 3 + 4；步骤 3 → 任务 5；步骤 4 → 任务 6；步骤 5 → 任务 7；步骤 6 → 任务 8 + 9。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/core/src/adr-frontmatter.ts` | 迁入 | frontmatter 解析 |
| `packages/core/src/adr-chunker.ts` | 迁入 | Markdown 章节分块 |
| `packages/core/src/adr-anchor-index.ts` | 迁入 | code_anchors 双向索引（本地 JSON） |
| `packages/core/src/adr-anchor-generator.ts` | 迁入 | 规格文档锚点生成 / 预览 |
| `packages/core/src/adr-service.ts` | 迁入 | ACR CRUD + 状态 + 约束抽取 |
| `packages/core/src/adr-indexer.ts` | 迁入 + 改 | ADR 索引管道（新增 `logger` 选项） |
| `packages/core/src/adr-bundle.ts` | 新建 | 一个工作区的 ADR 服务装配（含标题缓存） |
| `packages/core/src/config.ts` | 改 | 两个路径助手 + `ADR_*` env 回退 |
| `packages/core/src/index.ts` | 改 | barrel 导出 ADR 公共面 |
| `packages/core/test/adr-path-derivation.spec.ts` | 新建 | 路径助手 ≡ 历史表达式 |
| `packages/core/test/config.spec.ts` | 新建 | `ADR_*` env 回退与优先级 |
| `packages/core/test/adr-bundle.spec.ts` | 新建 | 装配语义（不联网 / 不建目录 / 标题缓存） |
| `packages/core/test/adr-*.spec.ts`（7 个） | 迁入 | 随模块搬迁 |
| `packages/dsh/src/plugins/dsh-context-milvus/index.ts` | 改 | 切到 `createAdrBundle` |
| `packages/dsh/src/plugins/dsh-context-milvus/{tools,adr-tools,constraint-injector}.ts` | 改 | import 改走包名 |
| `packages/dsh/test/adr-tools.spec.ts` | 改 | mock 目标改指 core 源文件 |
| `packages/codex/src/adr-handlers.ts` | 新建 | 8 个 ADR 工具 handler（框架无关） |
| `packages/codex/src/adr-gate.ts` | 新建 | 写门控与 ADR 启用判定 |
| `packages/codex/src/schemas.ts` | 改 | 8 个 zod schema |
| `packages/codex/src/result-format.ts` | 改 | 2 个错误码 + 5 个 ADR formatter + hint 拼接 |
| `packages/codex/src/workspace-services.ts` | 改 | 按 `adrEnabled` 装配 bundle |
| `packages/codex/src/handlers.ts` | 改 | `AdrPort` + `search_code` 被动提醒 |
| `packages/codex/src/server.ts` | 改 | 门控注册 8 个工具 |
| `packages/codex/test/{adr-handlers,adr-write-gate,search-code-adr-hint}.spec.ts` | 新建 | 见各任务 |
| `packages/codex/test/mcp-smoke.spec.ts` | 改 | 门控两分支（5 / 13） |
| `.mcp.json` / `SKILL.md` / `README*` / `CLAUDE.md` / 3 × `package.json` | 改 | 文档与版本 |

---

### Task 1: 把 ADR 引擎与测试迁进 core

**Files:**
- Move: `packages/dsh/src/plugins/dsh-context-milvus/adr-{frontmatter,chunker,anchor-index,anchor-generator,service,indexer}.ts` → `packages/core/src/`
- Move: `packages/dsh/test/adr-{frontmatter,chunker,anchor-index,anchor-generator,service,indexer,types}.spec.ts` → `packages/core/test/`
- Modify: `packages/core/src/index.ts`（barrel）
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts`、`tools.ts`、`adr-tools.ts`、`constraint-injector.ts`（import 改包名）
- Modify: `packages/dsh/test/adr-tools.spec.ts`（mock 目标）
- Test: 既有测试集本身即验收

**Interfaces:**
- Consumes: `packages/core/src/{types,merkle,embedding,milvus-service,config}.ts`（已存在）
- Produces: `dsh-context-milvus-core` 导出 `parseFrontmatter`、`chunkAdrFile`、`AdrAnchorIndex`、`AdrService`、`runAdrIndex`、`getAdrIndexStatus`、`findCandidateFiles`、`detectCodeReferences`、`generateSpecFrontmatter`、`previewFrontmatter`，以及类型 `ScanRoot`、`AdrIndexResult`、`DetectedRef`、`GenerateResult`

- [ ] **Step 1: 确认基线并留档**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: `Test Suites: 23 passed, 23 total` / `Tests: 286 passed, 286 total`

把这两个数字记在临时笔记里，Step 8 要比对。

- [ ] **Step 2: git mv 6 个模块**

```bash
cd /home/bobjia/projects/dsh-context-milvus
for m in adr-frontmatter adr-chunker adr-anchor-index adr-anchor-generator adr-service adr-indexer; do
  git mv "packages/dsh/src/plugins/dsh-context-milvus/$m.ts" "packages/core/src/$m.ts"
done
git status --short | head -20
```

Expected: 6 行 `R` 开头的 rename（git 认得出纯移动）。

- [ ] **Step 3: git mv 7 个 spec**

`adr-types.spec.ts` 一起走：它测的是 core 的 `getConfig` 与 ADR 类型，本来就不属于 dsh。`adr-tools.spec.ts` 与 `constraint-injector.spec.ts` **留在 dsh**（被测对象没迁）。

```bash
cd /home/bobjia/projects/dsh-context-milvus
for s in adr-frontmatter adr-chunker adr-anchor-index adr-anchor-generator adr-service adr-indexer adr-types; do
  git mv "packages/dsh/test/$s.spec.ts" "packages/core/test/$s.spec.ts"
done
ls packages/dsh/test/
```

Expected: `packages/dsh/test/` 只剩 `adr-tools.spec.ts`、`constraint-injector.spec.ts`、`public-surface.spec.ts` 与 `.mjs` 脚本。

- [ ] **Step 4: 改掉迁入模块对包名的自引用**

迁进 core 的文件**不能**再 `from 'dsh-context-milvus-core'`（那是自引用 barrel，会绕回自己）。逐文件按下表替换，不要一把梭：

| 文件:行 | 原文 | 改为 |
|---|---|---|
| `adr-frontmatter.ts:2` | `import type { AdrFrontmatter, AdrCodeAnchor, AdrTrigger } from 'dsh-context-milvus-core'` | `... from './types.js'` |
| `adr-chunker.ts:2` | `import type { AdrChunk } from 'dsh-context-milvus-core'` | `... from './types.js'` |
| `adr-anchor-index.ts:4` | `import type { AnchorIndexStats } from 'dsh-context-milvus-core'` | `... from './types.js'` |
| `adr-anchor-generator.ts:8` | `import type { AdrFrontmatter, AdrCodeAnchor } from 'dsh-context-milvus-core'` | `... from './types.js'` |
| `adr-service.ts:5-8` | `import type {⏎ ...⏎} from 'dsh-context-milvus-core'` | `} from './types.js'` |
| `adr-indexer.ts:4` | `import { HashTracker } from 'dsh-context-milvus-core'` | `from './merkle.js'` |
| `adr-indexer.ts:5` | `import { EmbeddingClient } from 'dsh-context-milvus-core'` | `from './embedding.js'` |
| `adr-indexer.ts:8` | `import type { MilvusService } from 'dsh-context-milvus-core'` | `from './milvus-service.js'` |
| `adr-indexer.ts:9` | `import type { PluginConfig } from 'dsh-context-milvus-core'` | `from './config.js'` |
| `adr-indexer.ts:10` | `import type { AdrIndexStatus } from 'dsh-context-milvus-core'` | `from './types.js'` |

注意 `adr-indexer.ts` 里 `HashTracker` 与 `EmbeddingClient` 是**值导入**，必须指到具体源文件；类型导入指到 `./types.js` 或 `./config.js`。

- [ ] **Step 5: 验证 core 内部再无包名自引用**

Run: `grep -rn "dsh-context-milvus-core" packages/core/src/ || echo CLEAN`
Expected: `CLEAN`（core 源码里一处都不该有；测试文件里有是允许的）

- [ ] **Step 6: barrel 导出 ADR 公共面**

在 `packages/core/src/index.ts` 末尾追加（紧跟 `export { consoleLogger, silentLogger } from './logger.js'` 之后）：

```ts
export { parseFrontmatter } from './adr-frontmatter.js'
export { chunkAdrFile } from './adr-chunker.js'
export { AdrAnchorIndex } from './adr-anchor-index.js'
export { AdrService } from './adr-service.js'
export { runAdrIndex, getAdrIndexStatus } from './adr-indexer.js'
export type { ScanRoot, AdrIndexResult } from './adr-indexer.js'
export {
  findCandidateFiles, detectCodeReferences,
  generateSpecFrontmatter, previewFrontmatter,
} from './adr-anchor-generator.js'
export type { DetectedRef, GenerateResult } from './adr-anchor-generator.js'
```

- [ ] **Step 7: 迁入的 spec 改路径**

```bash
cd /home/bobjia/projects/dsh-context-milvus/packages/core/test
sed -i "s#\.\./src/plugins/dsh-context-milvus/#../src/#g" \
  adr-frontmatter.spec.ts adr-chunker.spec.ts adr-anchor-index.spec.ts \
  adr-anchor-generator.spec.ts adr-service.spec.ts adr-indexer.spec.ts
sed -i "s#\.\./\.\./core/src/#../src/#g" adr-types.spec.ts
grep -n "src/plugins" *.spec.ts || echo CLEAN
```

Expected: `CLEAN`。`adr-indexer.spec.ts` 里 `await import('dsh-context-milvus-core')` 取 `MilvusService` / `HashTracker` 的写法保留不动（jest 已把包名映射到 core barrel，且该 spec 已桩掉 SDK）。

- [ ] **Step 8: dsh 侧 import 改走包名**

```bash
cd /home/bobjia/projects/dsh-context-milvus/packages/dsh/src/plugins/dsh-context-milvus
sed -i "s#from './adr-\([a-z-]*\)\.js'#from 'dsh-context-milvus-core'#g" \
  index.ts tools.ts adr-tools.ts constraint-injector.ts
grep -rn "from './adr-" . || echo CLEAN
```

Expected: `CLEAN`。留下的多条 `from 'dsh-context-milvus-core'` 重复 import 是合法的，不要顺手合并。

`adr-tools.spec.ts`（留在 dsh）mock 的是已迁走的路径，必须改指 core 源文件 —— jest 会把包名 barrel 与源文件解析到同一模块，所以 mock 源文件仍然拦得住：

```bash
cd /home/bobjia/projects/dsh-context-milvus/packages/dsh/test
sed -i "s#'../src/plugins/dsh-context-milvus/adr-indexer.js'#'../../core/src/adr-indexer.js'#" adr-tools.spec.ts
grep -n "adr-indexer" adr-tools.spec.ts
```

Expected: 一行 `jest.unstable_mockModule('../../core/src/adr-indexer.js', ...)`。

- [ ] **Step 9: 跑全量测试**

Run: `npm test 2>&1 | tail -20`
Expected: 全绿，且 **suites = 23、tests = 286 与 Step 1 完全一致**（纯搬迁，用例数既不减也不增）。若 suite 数变了，说明有 spec 被 jest 漏掉 —— 用 `npm test -- --listTests | grep adr` 排查。

Run: `npm run build && npm run typecheck`
Expected: 均退出码 0

- [ ] **Step 10: Commit**

```bash
cd /home/bobjia/projects/dsh-context-milvus
git add -A
git commit -m "refactor(core): move the ADR engine out of the DSH plugin

ADR 引擎的六个模块只依赖 node/js-yaml/core，与 Cordis 无关。把它们提到
packages/core，为 Codex 端复用做准备。纯搬迁：模块数、用例数均不变。"
```

---

### Task 2: core 的 ADR 状态路径助手

**Files:**
- Modify: `packages/core/src/config.ts`（在 `deriveImportMapFilePath` 之后插入）
- Test: `packages/core/test/adr-path-derivation.spec.ts`（新建）

**Interfaces:**
- Consumes: `deriveMerkleFilePath(indexRoot: string): string`（已存在，`config.ts:170`）
- Produces: `deriveAnchorIndexPath(adrRoot: string): string`、`deriveAdrTrackerPath(adrRoot: string): string`（Task 4 的 `createAdrBundle` 使用）

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/adr-path-derivation.spec.ts`：

```ts
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { deriveMerkleFilePath, deriveAnchorIndexPath, deriveAdrTrackerPath } from '../src/config.js'

/**
 * The legacy DSH wiring derived ADR state paths by string-replacing the merkle
 * path. Existing users already have those files on disk under ~/.milvus-index,
 * so the new helpers must produce byte-identical results. The legacy formula is
 * recomputed here independently: if someone edits the helper bodies, this breaks.
 */
function legacyAnchorPath(root: string): string {
  return deriveMerkleFilePath(root).replace('merkle', 'anchors')
}
function legacyTrackerPath(root: string): string {
  return deriveMerkleFilePath(root).replace('merkle', 'adr-merkle')
}

describe('ADR state path helpers', () => {
  const cases: Array<[string, string]> = [
    ['plain', '/home/dev/work/webhook-service'],
    ['spaces', '/home/dev/My Projects/retail api'],
    ['non-ascii', '/home/dev/工作/中文项目'],
    ['nested', '/a/b/c/d/e/f/g/deep-root-name'],
  ]

  it.each(cases)('anchor path matches the legacy formula (%s)', (_name, root) => {
    expect(deriveAnchorIndexPath(root)).toBe(legacyAnchorPath(root))
  })

  it.each(cases)('tracker path matches the legacy formula (%s)', (_name, root) => {
    expect(deriveAdrTrackerPath(root)).toBe(legacyTrackerPath(root))
  })

  it('names the files anchors-* and adr-merkle-*, next to the merkle state', () => {
    const root = '/home/dev/work/api'
    const dir = path.dirname(deriveMerkleFilePath(root))
    expect(path.dirname(deriveAnchorIndexPath(root))).toBe(dir)
    expect(path.basename(deriveAnchorIndexPath(root))).toMatch(/^anchors-.+-[0-9a-f]{16}\.json$/)
    expect(path.basename(deriveAdrTrackerPath(root))).toMatch(/^adr-merkle-.+-[0-9a-f]{16}\.json$/)
  })

  it('isolates two workspaces with the same directory name', () => {
    const a = deriveAnchorIndexPath('/one/app')
    const b = deriveAnchorIndexPath('/two/app')
    expect(a).not.toBe(b)
  })

  it('does not collide anchor and tracker paths for one root', () => {
    const root = '/home/dev/work/api'
    expect(deriveAnchorIndexPath(root)).not.toBe(deriveAdrTrackerPath(root))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/adr-path-derivation.spec.ts 2>&1 | tail -15`
Expected: FAIL，报 `deriveAnchorIndexPath is not a function`（或 TS 编译期 `has no exported member`）

- [ ] **Step 3: 实现两个助手**

在 `packages/core/src/config.ts` 的 `deriveImportMapFilePath` 函数之后插入：

```ts
/**
 * Derive the ADR anchor-index file path for an ADR root.
 *
 * Byte-identical to the historical expression
 * `deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors')` that the DSH
 * plugin used inline. Users already have these files on disk, so a different
 * result would silently orphan every existing anchor index and force a full
 * ADR re-index. Pinned by packages/core/test/adr-path-derivation.spec.ts.
 */
export function deriveAnchorIndexPath(adrRoot: string): string {
  return deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors')
}

/**
 * Derive the ADR hash-tracker state file path for an ADR root.
 * Byte-identical to `deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle')`.
 */
export function deriveAdrTrackerPath(adrRoot: string): string {
  return deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/adr-path-derivation.spec.ts 2>&1 | tail -8`
Expected: `Tests: 11 passed`（4 + 4 + 3 个用例，`it.each` 各展开 4 条）

- [ ] **Step 5: 跑全量测试**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: `24 passed` suites，`297 passed` tests（286 + 11）

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/adr-path-derivation.spec.ts
git commit -m "feat(core): add ADR state path derivation helpers

取代 DSH 里 deriveMerkleFilePath(x).replace('merkle', ...) 的字符串把戏。
测试独立复算旧公式，把一次性兼容约束钉死：路径漂移等于丢掉全部 ADR 索引状态。"
```

---

### Task 3: core 的 `ADR_*` 环境变量回退

**Files:**
- Modify: `packages/core/src/config.ts:264-266`
- Test: `packages/core/test/config.spec.ts`（**新建** —— core 目前没有 config 的 spec，配置测试一直窝在 dsh 的 `dsh-context-remdb.spec.ts` 里）

**Interfaces:**
- Consumes: `getConfig(overrides?: CordisConfig): PluginConfig`
- Produces: `getConfig()` 在无 overrides 时读取 `ADR_ENABLED`（`1|true|yes|on`，大小写不敏感）、`ADR_ROOT`、`ADR_COLLECTION`

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/config.spec.ts`：

```ts
import { getConfig } from '../src/config.js'

const KEYS = ['ADR_ENABLED', 'ADR_ROOT', 'ADR_COLLECTION']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('ADR config resolution', () => {
  it('defaults ADR off with stock paths when nothing is configured', () => {
    const c = getConfig()
    expect(c.adrEnabled).toBe(false)
    expect(c.adrRoot).toBe('docs/decisions')
    expect(c.adrCollection).toBe('adr_embeddings')
  })

  it.each([['1'], ['true'], ['TRUE'], ['yes'], ['on']])('reads ADR_ENABLED=%s as enabled', (raw) => {
    process.env.ADR_ENABLED = raw
    expect(getConfig().adrEnabled).toBe(true)
  })

  it.each([['0'], ['false'], ['off'], ['']])('reads ADR_ENABLED=%s as disabled', (raw) => {
    process.env.ADR_ENABLED = raw
    expect(getConfig().adrEnabled).toBe(false)
  })

  it('reads ADR_ROOT and ADR_COLLECTION from the environment', () => {
    process.env.ADR_ROOT = 'adr'
    process.env.ADR_COLLECTION = 'team_adr_embeddings'
    const c = getConfig()
    expect(c.adrRoot).toBe('adr')
    expect(c.adrCollection).toBe('team_adr_embeddings')
  })

  it('lets explicit overrides win over the environment', () => {
    process.env.ADR_ENABLED = 'true'
    process.env.ADR_ROOT = 'from-env'
    const c = getConfig({ adrEnabled: false, adrRoot: 'from-overrides' })
    expect(c.adrEnabled).toBe(false)
    expect(c.adrRoot).toBe('from-overrides')
  })

  it('keeps DSH behaviour untouched: an absent env var is not a value', () => {
    // DSH passes a config object without ADR fields; nothing must change there.
    expect(getConfig({ indexRoot: '/tmp/x' }).adrEnabled).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/config.spec.ts 2>&1 | tail -20`
Expected: FAIL —— `defaults` 与 `overrides win` 两条会过，`ADR_ENABLED=1` 与 env 读取那几条全部失败

- [ ] **Step 3: 实现 env 回退**

在 `packages/core/src/config.ts` 里，`deriveAdrTrackerPath` 之后加一个内部助手（**不要 export**，只此一处用）：

```ts
/** Parse a tri-state env flag: undefined means "not configured". */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return /^(1|true|yes|on)$/i.test(value.trim())
}
```

然后把 `getConfig` 里这三行（现 `config.ts:264-266`）：

```ts
    adrEnabled: overrides?.adrEnabled ?? false,
    adrRoot: overrides?.adrRoot ?? 'docs/decisions',
    adrCollection: overrides?.adrCollection ?? 'adr_embeddings',
```

改为：

```ts
    adrEnabled: overrides?.adrEnabled ?? parseBoolEnv(process.env.ADR_ENABLED) ?? false,
    adrRoot: overrides?.adrRoot ?? process.env.ADR_ROOT ?? 'docs/decisions',
    adrCollection: overrides?.adrCollection ?? process.env.ADR_COLLECTION ?? 'adr_embeddings',
```

`adrConstraintReinjectEvery` 与 `adrSystemPrompt` **不动** —— 它们是 DSH 约束注入专属，加 env 是噪音（spec §5.1）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/config.spec.ts 2>&1 | tail -8`
Expected: `Tests: 13 passed`（1 默认 + `it.each` 5 + `it.each` 4 + env 读取 1 + overrides 优先 1 + DSH 不受影响 1）

- [ ] **Step 5: 跑全量测试**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: `25 passed` suites，`310 passed` tests（297 + 13）

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.spec.ts
git commit -m "feat(core): resolve ADR settings from ADR_* env vars

MCP 端没有 Cordis config，之前根本没法开 ADR。只加 MCP 需要的三个变量；
优先级仍是 overrides > env > 默认，DSH 侧行为不变。
顺带补上 core 一直缺失的 config.spec.ts。"
```

---

### Task 4: core 的 `createAdrBundle` 与 `runAdrIndex` 的 logger

**Files:**
- Create: `packages/core/src/adr-bundle.ts`
- Modify: `packages/core/src/index.ts`（导出）
- Modify: `packages/core/src/adr-indexer.ts:69-76`（`options.logger`）
- Test: `packages/core/test/adr-bundle.spec.ts`（新建）

**Interfaces:**
- Consumes: `AdrService`、`AdrAnchorIndex`、`HashTracker`、`deriveAnchorIndexPath`、`deriveAdrTrackerPath`（Task 2）
- Produces:

```ts
export interface AdrTitle { title: string; status: string }
export interface AdrBundle {
  adrRoot: string
  exists: boolean
  service: AdrService
  anchorIndex: AdrAnchorIndex
  tracker: HashTracker
  titles(): Promise<Map<string, AdrTitle>>
}
export async function createAdrBundle(
  config: PluginConfig, logger?: Logger,
): Promise<AdrBundle>
```

`runAdrIndex` 的 options 变为 `{ mode?: 'full' | 'incremental'; progress?: (msg: string) => void; logger?: Logger }`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/adr-bundle.spec.ts`：

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'

// The core barrel loads the Milvus SDK, which cannot load under Jest's ESM
// runtime — stub it. The mock must be registered BEFORE the module graph is
// imported, hence the dynamic import below instead of a top-level static one.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {},
  DataType: { Int64: 5, VarChar: 21, FloatVector: 101, Float: 10, JSON: 23 },
  MetricType: { COSINE: 'COSINE' },
  ContentType: { Text: 0 },
}))

const { getConfig, createAdrBundle } = await import('../src/index.js')

const fetchSpy = jest.fn()
beforeAll(() => { (globalThis as any).fetch = fetchSpy })
afterEach(() => { fetchSpy.mockClear() })

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'adr-bundle-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('createAdrBundle', () => {
  it('resolves adrRoot relative to indexRoot', async () => {
    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    expect(b.adrRoot).toBe(path.join(root, 'docs', 'decisions'))
    expect(b.exists).toBe(false)
  })

  it('never touches the network while assembling', async () => {
    await mkdir(path.join(root, 'docs', 'decisions'), { recursive: true })
    await createAdrBundle(getConfig({ indexRoot: root }))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not create the ADR directory when it is missing', async () => {
    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    expect(b.exists).toBe(false)
    expect(existsSync(path.join(root, 'docs'))).toBe(false)
  })

  it('reports exists once the directory is there', async () => {
    await mkdir(path.join(root, 'adr'), { recursive: true })
    const b = await createAdrBundle(getConfig({ indexRoot: root, adrRoot: 'adr' }))
    expect(b.exists).toBe(true)
  })

  it('caches titles across calls', async () => {
    const adrDir = path.join(root, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })
    const body = `---
id: ADR-0001-retry-queue
type: adr
status: active
created: 2026-09-01
updated: 2026-09-01
author: t
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  change_type: architecture
related_decisions: []
auto_generated: false
---

# 使用重试队列隔离下游故障

正文
`
    await writeFile(path.join(adrDir, 'ADR-0001-retry-queue.md'), body, 'utf-8')

    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    const first = await b.titles()
    expect(first.get('ADR-0001-retry-queue')).toEqual({
      title: '使用重试队列隔离下游故障', status: 'active',
    })

    // A second read must come from the cache: adding a file changes nothing
    // until titles() is called on a fresh bundle.
    await writeFile(path.join(adrDir, 'ADR-0002-x.md'), body.replace('0001-retry-queue', '0002-x'), 'utf-8')
    const second = await b.titles()
    expect(second.size).toBe(1)
    expect(second).toBe(first)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/adr-bundle.spec.ts 2>&1 | tail -15`
Expected: FAIL —— `createAdrBundle is not a function`

- [ ] **Step 3: 实现 bundle**

新建 `packages/core/src/adr-bundle.ts`：

```ts
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { AdrAnchorIndex } from './adr-anchor-index.js'
import { AdrService } from './adr-service.js'
import { HashTracker } from './merkle.js'
import { deriveAdrTrackerPath, deriveAnchorIndexPath } from './config.js'
import type { Logger } from './logger.js'
import type { PluginConfig } from './config.js'

export interface AdrTitle {
  title: string
  status: string
}

/**
 * Everything one workspace needs to work with ADR decision records.
 *
 * Both adapters build their bundle through this function so the ADR root
 * resolution and the state file locations cannot drift apart between DSH and
 * the MCP server: an ADR created in one is readable in the other.
 */
export interface AdrBundle {
  /** Absolute path of the ADR directory. */
  adrRoot: string
  /** Whether that directory exists. Never created implicitly. */
  exists: boolean
  service: AdrService
  anchorIndex: AdrAnchorIndex
  tracker: HashTracker
  /** adrId → title/status, read once and cached for this bundle. */
  titles(): Promise<Map<string, AdrTitle>>
}

/**
 * Assemble the ADR services for one workspace.
 *
 * Deliberately free of any network call: state files are read from disk and
 * the Milvus ADR collection is only ensured by the callers that need it. That
 * keeps tool discovery testable without a live Milvus.
 *
 * Logging is opt-in (no console default) so wiring an ADR bundle never adds
 * output a caller did not ask for.
 */
export async function createAdrBundle(
  config: PluginConfig,
  logger?: Logger,
): Promise<AdrBundle> {
  const adrRoot = path.resolve(config.indexRoot, config.adrRoot || 'docs/decisions')

  const anchorIndex = new AdrAnchorIndex(deriveAnchorIndexPath(adrRoot))
  await anchorIndex.load().catch(() => {})

  const service = new AdrService(adrRoot)

  const tracker = new HashTracker(deriveAdrTrackerPath(adrRoot))
  await tracker.load().catch(() => {})

  let cached: Map<string, AdrTitle> | null = null
  const titles = async (): Promise<Map<string, AdrTitle>> => {
    if (cached) return cached
    const map = new Map<string, AdrTitle>()
    try {
      for (const item of await service.listAdrs({ status: 'all', limit: 10000 })) {
        map.set(item.id, { title: item.summary, status: item.status })
      }
    } catch (err) {
      logger?.debug('ADR titles unavailable', { adrRoot, error: String(err) })
    }
    cached = map
    return map
  }

  const bundle: AdrBundle = { adrRoot, exists: existsSync(adrRoot), service, anchorIndex, tracker, titles }
  logger?.debug('ADR bundle ready', { adrRoot, exists: bundle.exists })
  return bundle
}
```

在 `packages/core/src/index.ts` 追加：

```ts
export { createAdrBundle } from './adr-bundle.js'
export type { AdrBundle, AdrTitle } from './adr-bundle.js'
```

- [ ] **Step 4: 给 `runAdrIndex` 加 logger，且不改变 DSH 的安静默认**

`packages/core/src/adr-indexer.ts` 现在第 69-76 行是：

```ts
export async function runAdrIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  anchorIndex: AdrAnchorIndex,
  options?: { mode?: 'full' | 'incremental'; progress?: (msg: string) => void },
): Promise<AdrIndexResult> {
  const mode = options?.mode ?? 'incremental'
  const progress = options?.progress ?? (() => {})
```

改为（注意默认仍是 no-op，**不像 `runIndex` 那样默认 consoleLogger** —— DSH 不传 logger 时必须保持今天的安静，否则插件的周期 ADR 索引会突然往 stdout 打进度）：

```ts
export async function runAdrIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  anchorIndex: AdrAnchorIndex,
  options?: { mode?: 'full' | 'incremental'; progress?: (msg: string) => void; logger?: Logger },
): Promise<AdrIndexResult> {
  const mode = options?.mode ?? 'incremental'
  const log = options?.logger
  const progress = options?.progress ?? ((msg: string) => { if (log) log.info(msg) })
```

并在文件顶部的 type 导入里加上 `Logger`：把 `import type { PluginConfig } from './config.js'` 改成两行：

```ts
import type { PluginConfig } from './config.js'
import type { Logger } from './logger.js'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/adr-bundle.spec.ts packages/core/test/adr-indexer.spec.ts 2>&1 | tail -8`
Expected: 两个 suite 全绿

- [ ] **Step 6: 跑全量测试 + 构建 + 类型**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: `26 passed` suites，tests = 310 + adr-bundle 的 5 条 = `315 passed`

Run: `npm run build && npm run typecheck && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/adr-bundle.ts packages/core/src/index.ts packages/core/src/adr-indexer.ts packages/core/test/adr-bundle.spec.ts
git commit -m "feat(core): add createAdrBundle workspace assembly

一个函数收拢 adrRoot 解析与两个状态文件位置，两个适配器同调，
DSH 与 Codex 因此共用同一份 ADR 索引状态。
装配全程不联网、不建目录；runAdrIndex 加 logger 但默认仍静默。"
```

---

### Task 5: DSH 切到 `createAdrBundle`（行为零变化）

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts:36-37`（import）、`:293-310`（装配段）

**Interfaces:**
- Consumes: `createAdrBundle(config, logger?) → AdrBundle`（Task 4），形状 `{ adrRoot, exists, service, anchorIndex, tracker, titles }`
- Produces: 对下游一字不变的 `adrOptions = { service, anchorIndex, adrTracker }`

- [ ] **Step 1: 记下当前装配段**

Run: `sed -n '293,318p' packages/dsh/src/plugins/dsh-context-milvus/index.ts`
Expected: 看到 `const adrRoot = path.resolve(...)` 开头、`const adrOptions = { service: adrService, anchorIndex, adrTracker }` 结尾的一段，其中两次出现 `.replace('merkle', ...)`

- [ ] **Step 2: 替换装配段**

把 `packages/dsh/src/plugins/dsh-context-milvus/index.ts` 中这一段（Step 1 看到的那段，第 296-310 行）：

```ts
  const adrRoot = path.resolve(resolved.indexRoot, resolved.adrRoot)

  const anchorIndex = new AdrAnchorIndex(
    deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors'),
  )
  await anchorIndex.load().catch(() => {})

  const adrService = new AdrService(adrRoot)

  const adrTracker = new HashTracker(
    deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle'),
  )
  await adrTracker.load().catch(() => {})

  const adrOptions = { service: adrService, anchorIndex, adrTracker }
```

替换为：

```ts
  const adr = await createAdrBundle(resolved)
  const { service: adrService, anchorIndex, tracker: adrTracker } = adr
  const adrOptions = { service: adrService, anchorIndex, adrTracker }
```

不传 logger：core 的 bundle 默认静默，DSH 保留它自己下面那行 `console.log('[dsh-context-milvus] ADR 决策记忆已加载 (...)')`，输出与今天逐字一致。

- [ ] **Step 3: 清掉两个失效 import**

`AdrAnchorIndex` 与 `AdrService` 在 `index.ts` 里只被刚删掉的那段用到（已核实：全文仅第 298、303 行两处引用）。把这两行 import 删掉：

```ts
import { AdrAnchorIndex } from 'dsh-context-milvus-core'
import { AdrService } from 'dsh-context-milvus-core'
```

并在文件已有的 `from 'dsh-context-milvus-core'` 那一组 import 里加上 `createAdrBundle`。`HashTracker` 与 `deriveMerkleFilePath` **保留** —— 代码索引那条链还在用。

- [ ] **Step 4: 确认脆弱的字符串把戏已彻底消失**

Run: `grep -rn "\.replace('merkle'" packages/dsh/src/ || echo CLEAN`
Expected: `CLEAN`

Run: `grep -rn "\.replace('merkle'" packages/core/src/ | grep -v adr-bundle || echo CLEAN`
Expected: 只剩 `config.ts` 里助手自身与 `adr-bundle.ts` 的注释；没有别处再手写这个公式

- [ ] **Step 5: 全量测试 + 契约测试重点确认**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)|public-surface|FAIL"`
Expected: 全绿，`26 passed` suites / `316 passed` tests 不变

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/public-surface.spec.ts 2>&1 | tail -5`
Expected: `Tests: 2 passed` —— **这个文件一行都没改过**就是 DSH 契约没被动过的证据

Run: `git diff --stat HEAD -- packages/dsh/test/public-surface.spec.ts`
Expected: 空输出

- [ ] **Step 6: Commit**

```bash
git add packages/dsh/src/plugins/dsh-context-milvus/index.ts
git commit -m "refactor(dsh): assemble ADR services through createAdrBundle

去掉 deriveMerkleFilePath(...).replace('merkle', ...) 的字符串把戏，
路径改由 core 的派生助手给出，与 Codex 端同源。DSH 行为与输出不变。"
```

---

### Task 6: Codex 的 4 个只读 ADR 工具 + 启动门控

**Files:**
- Create: `packages/codex/src/adr-handlers.ts`
- Modify: `packages/codex/src/workspace-services.ts`
- Modify: `packages/codex/src/handlers.ts`（`MilvusPort` 加可选 ADR 方法、`HandlerServices` 加 `adr?`）
- Modify: `packages/codex/src/schemas.ts`
- Modify: `packages/codex/src/result-format.ts`
- Modify: `packages/codex/src/server.ts`
- Test: `packages/codex/test/adr-handlers.spec.ts`（新建）、`packages/codex/test/mcp-smoke.spec.ts`（改）

**Interfaces:**
- Consumes: `createAdrBundle`、`AdrBundle`、`AdrSearchResult`、`AdrListItem`、`ConstraintSummary`（core）；`milvus.ensureAdrCollection()`、`milvus.searchAdr(query, topK, filters)`（core `MilvusService:520,642`）；`AdrService.loadAdr/listAdrs/getActiveConstraints`；`AdrAnchorIndex.getAdrsForFile`
- Produces:
  - `AdrPort = AdrBundle`（`handlers.ts` 导出，Task 7/8 复用）
  - `handleSearchAdr` / `handleSearchAdrByFile` / `handleListAdrs` / `handleLoadConstraints`（`adr-handlers.ts`）
  - `formatAdrSearch / formatAdrByFile / formatAdrList / formatConstraints`（`result-format.ts`）
  - MCP 工具名 `search_adr`、`search_adr_by_file`、`list_adrs`、`load_constraints`（仅当 `ADR_ENABLED` 为真时出现在 `tools/list`）

- [ ] **Step 1: 服务装配加 ADR bundle**

`packages/codex/src/workspace-services.ts`：

在 import 里加上 `createAdrBundle` 与 `type AdrBundle`；接口加一个字段：

```ts
export interface WorkspaceServices {
  root: string
  config: PluginConfig
  milvus: MilvusService
  tracker: HashTracker
  importResolver: ImportResolver
  /** Present only when ADR_ENABLED is on. Never connects to Milvus. */
  adr?: AdrBundle
}
```

在 `const services: WorkspaceServices = {...}` 之前插入，并把 `adr` 放进对象：

```ts
    // ADR is opt-in per server process. Assembly reads local state files only,
    // so a missing Milvus never breaks tool discovery.
    const adr = config.adrEnabled ? await createAdrBundle(config, this.logger) : undefined

    const services: WorkspaceServices = { root, config, milvus, tracker, importResolver, adr }
```

- [ ] **Step 2: `handlers.ts` 的端口放宽**

`packages/codex/src/handlers.ts`：`MilvusPort` 加两个**可选**方法（可选是为了不动既有测试里的假对象），并导出 `AdrPort`：

```ts
import type { ..., AdrBundle, AdrSearchResult } from 'dsh-context-milvus-core'

export interface MilvusPort {
  ensureCollection(): Promise<void>
  search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]>
  /** Only needed by the ADR tools. */
  ensureAdrCollection?(): Promise<void>
  searchAdr?(query: string, topK: number, filters?: { status?: string; pathPrefix?: string }): Promise<AdrSearchResult[]>
}

export interface HandlerServices {
  root: string
  config: PluginConfig
  milvus: MilvusPort
  tracker: HashTracker
  importResolver: ImportResolver
  adr?: AdrPort
}

/** Structural alias so ADR handlers stay unit-testable with a literal object. */
export type AdrPort = AdrBundle
```

- [ ] **Step 3: 写失败的 handler 测试**

新建 `packages/codex/test/adr-handlers.spec.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const { handleSearchAdr, handleSearchAdrByFile, handleListAdrs, handleLoadConstraints } =
  await import('../src/adr-handlers.js')
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
const cwdBefore = process.cwd()
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-adr-')) })
afterEach(async () => { process.chdir(cwdBefore); await rm(root, { recursive: true, force: true }) })

const SEARCH_HIT = [{
  adrId: 'ADR-0003-retry-queue', docType: 'adr', filePath: 'docs/decisions/ADR-0003.md',
  status: 'active', section: '决策', content: '用重试队列隔离下游故障',
  score: 0.8123, triggerType: 'architecture', codeAnchors: ['src/queue.ts'],
}]

function makeServices(over: Partial<HandlerServices> = {}): HandlerServices {
  return {
    root,
    config: getConfig({ indexRoot: root }),
    milvus: {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(async () => []),
      ensureAdrCollection: jest.fn(async () => {}),
      searchAdr: jest.fn(async () => SEARCH_HIT),
    } as any,
    tracker: { getStats: () => ({ totalFiles: 0, totalChunks: 0 }) } as any,
    importResolver: {} as any,
    adr: {
      adrRoot: path.join(root, 'docs', 'decisions'),
      exists: true,
      anchorIndex: { getAdrsForFile: jest.fn(() => ['ADR-0003-retry-queue']), getAll: () => new Map() },
      service: {
        loadAdr: jest.fn(async (id: string) => ({
          frontmatter: { id, status: 'active' },
          sections: { 决策: '用重试队列隔离下游故障，避免雪崩。' },
          rawContent: '', filePath: path.join(root, 'docs', 'decisions', `${id}.md`),
        })),
        listAdrs: jest.fn(async () => ([{
          id: 'ADR-0003-retry-queue', filePath: '/x', status: 'active',
          created: '2026-09-01', updated: '2026-09-01', anchorCount: 1,
          summary: '使用重试队列隔离下游故障', changeType: 'architecture',
        }])),
        getActiveConstraints: jest.fn(async () => ([{
          adrId: 'ADR-0003-retry-queue', adrTitle: '使用重试队列隔离下游故障',
          constraints: ['不得同步调用下游'],
          hiddenConstraints: [{ name: '退避上限', content: '≤ 30s', consequence: '雪崩' }],
          rejectedPatterns: ['无限重试'], status: 'active',
        }])),
      },
      tracker: {}, titles: async () => new Map(),
    } as any,
    ...over,
  }
}

describe('handleSearchAdr', () => {
  it('ensures the ADR collection and defaults to five hits', async () => {
    const s = makeServices()
    const out = await handleSearchAdr(async () => s, silentLogger, { query: '重试', path: root })
    expect(s.milvus.ensureAdrCollection).toHaveBeenCalled()
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('重试', 5, undefined)
    expect(out.results).toHaveLength(1)
  })

  it('maps status and pathPrefix into the Milvus filter', async () => {
    const s = makeServices()
    await handleSearchAdr(async () => s, silentLogger,
      { query: 'q', status: 'active', topK: 9, pathPrefix: 'docs/decisions', path: root })
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('q', 9, { status: 'active', pathPrefix: 'docs/decisions' })
  })

  it('treats status=all as no filter', async () => {
    const s = makeServices()
    await handleSearchAdr(async () => s, silentLogger, { query: 'q', status: 'all', path: root })
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('q', 5, undefined)
  })
})

describe('handleSearchAdrByFile', () => {
  it('resolves a relative file path against the workspace root', async () => {
    const s = makeServices()
    const out = await handleSearchAdrByFile(async () => s, silentLogger,
      { filePath: 'src/queue.ts', path: root })
    // The anchor index stores paths relative to the workspace root.
    expect(s.adr!.anchorIndex.getAdrsForFile).toHaveBeenCalledWith('src/queue.ts')
    expect(out.adrs[0]).toMatchObject({ adrId: 'ADR-0003-retry-queue', status: 'active' })
  })

  it('filters by status', async () => {
    const s = makeServices()
    const out = await handleSearchAdrByFile(async () => s, silentLogger,
      { filePath: 'src/queue.ts', status: 'deprecated', path: root })
    expect(out.adrs).toEqual([])
  })

  it('returns an empty list when no ADR covers the file', async () => {
    const s = makeServices()
    ;(s.adr!.anchorIndex.getAdrsForFile as jest.Mock).mockReturnValue([])
    const out = await handleSearchAdrByFile(async () => s, silentLogger, { filePath: 'src/x.ts', path: root })
    expect(out.adrs).toEqual([])
  })
})

describe('handleListAdrs', () => {
  it('defaults to active with a limit of 100', async () => {
    const s = makeServices()
    const out = await handleListAdrs(async () => s, silentLogger, { path: root })
    expect(s.adr!.service.listAdrs).toHaveBeenCalledWith({ status: 'active', changeType: undefined, limit: 100 })
    expect(out.adrs).toHaveLength(1)
  })

  it('passes changeType and limit through', async () => {
    const s = makeServices()
    await handleListAdrs(async () => s, silentLogger, { status: 'all', changeType: 'refactor', limit: 3, path: root })
    expect(s.adr!.service.listAdrs).toHaveBeenCalledWith({ status: 'all', changeType: 'refactor', limit: 3 })
  })
})

describe('handleLoadConstraints', () => {
  it('omits hidden constraints in summary format', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { path: root })
    expect(out.constraints[0].hiddenConstraints).toBeUndefined()
    expect(out.constraints[0].constraints).toEqual(['不得同步调用下游'])
  })

  it('includes hidden constraints in full format', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { format: 'full', path: root })
    expect(out.constraints[0].hiddenConstraints).toHaveLength(1)
  })

  it('filters by a comma separated adrIds list', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { adrIds: 'ADR-9999-x', path: root })
    expect(out.constraints).toEqual([])
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-handlers.spec.ts 2>&1 | tail -12`
Expected: FAIL —— `Cannot find module '../src/adr-handlers.js'`

- [ ] **Step 5: 实现 4 个只读 handler**

新建 `packages/codex/src/adr-handlers.ts`：

```ts
import * as path from 'node:path'
import type {
  AdrSearchResult, AdrListItem, ConstraintSummary, Logger,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'
import type { ServiceProvider, AdrPort } from './handlers.js'

/** ADR tools always need a bundle; the server only registers them when enabled. */
function needAdr(services: { adr?: AdrPort }): AdrPort {
  if (!services.adr) throw new Error('ADR 决策记忆未启用：设 ADR_ENABLED=true 后重启 Codex')
  return services.adr
}

export interface SearchAdrArgs {
  query: string
  status?: string
  topK?: number
  pathPrefix?: string
  path?: string
}

export async function handleSearchAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchAdrArgs,
): Promise<{ root: string; source: WorkspaceSource; results: AdrSearchResult[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  needAdr(services)
  if (!services.milvus.ensureAdrCollection || !services.milvus.searchAdr) {
    throw new Error('Milvus 服务不支持 ADR 检索')
  }
  await services.milvus.ensureAdrCollection()

  const filters: { status?: string; pathPrefix?: string } = {}
  if (args.status && args.status !== 'all') filters.status = args.status
  if (args.pathPrefix) filters.pathPrefix = args.pathPrefix

  const topK = args.topK ?? 5
  const results = await services.milvus.searchAdr(args.query, topK, Object.keys(filters).length ? filters : undefined)
  logger.debug('search_adr done', { root, topK, count: results.length })
  return { root, source, results }
}

export interface SearchAdrByFileArgs {
  filePath: string
  status?: string
  path?: string
}

export interface AdrByFileEntry {
  adrId: string
  filePath: string
  status: string
  summary: string
}

export async function handleSearchAdrByFile(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchAdrByFileArgs,
): Promise<{ root: string; source: WorkspaceSource; adrs: AdrByFileEntry[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)

  // The anchor index keys are relative to the workspace root, exactly like
  // find_callers' sourceFile handling — accept either form from the caller.
  const relative = path.isAbsolute(args.filePath)
    ? path.relative(root, args.filePath)
    : args.filePath

  const ids = adr.anchorIndex.getAdrsForFile(relative)
  const adrs: AdrByFileEntry[] = []
  for (const id of ids) {
    const doc = await adr.service.loadAdr(id)
    if (!doc) continue
    if (args.status && args.status !== 'all' && doc.frontmatter.status !== args.status) continue
    const firstSection = Object.values(doc.sections)[0] || ''
    adrs.push({
      adrId: doc.frontmatter.id,
      filePath: doc.filePath,
      status: doc.frontmatter.status,
      summary: firstSection.slice(0, 200),
    })
  }
  logger.debug('search_adr_by_file done', { root, relative, count: adrs.length })
  return { root, source, adrs }
}

export interface ListAdrsArgs {
  status?: string
  changeType?: string
  limit?: number
  path?: string
}

export async function handleListAdrs(
  provider: ServiceProvider,
  logger: Logger,
  args: ListAdrsArgs,
): Promise<{ root: string; source: WorkspaceSource; adrs: AdrListItem[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)
  const adrs = await adr.service.listAdrs({
    status: args.status ?? 'active',
    changeType: args.changeType,
    limit: args.limit ?? 100,
  })
  logger.debug('list_adrs done', { root, count: adrs.length })
  return { root, source, adrs }
}

export interface LoadConstraintsArgs {
  format?: 'summary' | 'full'
  adrIds?: string
  path?: string
}

export interface ConstraintPayload {
  adrId: string
  adrTitle: string
  constraints: string[]
  rejectedPatterns: string[]
  hiddenConstraints?: ConstraintSummary['hiddenConstraints']
}

export async function handleLoadConstraints(
  provider: ServiceProvider,
  logger: Logger,
  args: LoadConstraintsArgs,
): Promise<{ root: string; source: WorkspaceSource; constraints: ConstraintPayload[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)
  const all = await adr.service.getActiveConstraints()

  let picked = all
  if (args.adrIds) {
    const ids = args.adrIds.split(',').map((s) => s.trim()).filter(Boolean)
    picked = all.filter((c) => ids.includes(c.adrId))
  }
  const full = (args.format ?? 'summary') === 'full'
  const constraints: ConstraintPayload[] = picked.map((c) => ({
    adrId: c.adrId,
    adrTitle: c.adrTitle,
    constraints: c.constraints,
    rejectedPatterns: c.rejectedPatterns,
    ...(full ? { hiddenConstraints: c.hiddenConstraints } : {}),
  }))
  logger.debug('load_constraints done', { root, count: constraints.length, format: full ? 'full' : 'summary' })
  return { root, source, constraints }
}
```

- [ ] **Step 6: schema 与 formatter**

`packages/codex/src/schemas.ts` 追加：

```ts
const adrStatus = z.enum(['active', 'superseded', 'deprecated', 'all']).optional()

export const searchAdrSchema = {
  query: z.string().describe('自然语言查询，如"为什么用了重试队列"'),
  status: adrStatus.describe('过滤状态，默认不过滤'),
  topK: z.number().int().positive().optional().describe('返回结果数，默认 5'),
  pathPrefix: z.string().optional().describe('限定 ADR 子目录（相对工作区根）'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const searchAdrByFileSchema = {
  filePath: z.string().describe('代码文件路径，相对或绝对'),
  status: adrStatus.describe('过滤状态'),
  path: z.string().optional(),
}

export const listAdrsSchema = {
  status: adrStatus.describe('默认 active'),
  changeType: z.enum(['new_feature', 'refactor', 'bugfix', 'optimization', 'architecture']).optional(),
  limit: z.number().int().positive().optional().describe('默认 100'),
  path: z.string().optional(),
}

export const loadConstraintsSchema = {
  format: z.enum(['summary', 'full']).optional().describe('full 含隐性约束详情，默认 summary'),
  adrIds: z.string().optional().describe('逗号分隔的 ADR id，默认全部 active'),
  path: z.string().optional(),
}
```

`packages/codex/src/result-format.ts`：在 import 里补上 `AdrSearchResult`、`type` 引入 `../src/adr-handlers.js` 的 `AdrByFileEntry` / `ConstraintPayload` 与 `../src/handlers.js` 无关，改为直接从 core 取 `AdrListItem`。追加四个 formatter（文本骨架与 DSH 的 render 保持同一可读结构，便于两端输出对齐）：

```ts
export function formatAdrSearch(results: AdrSearchResult[]): string {
  if (results.length === 0) return '未找到匹配的 ADR 决策记录。'
  return results.map((item, i) => {
    const typeLabel = item.docType === 'spec' ? ', spec' : item.docType === 'plan' ? ', plan' : ''
    return [
      `[结果 ${i + 1}] ADR: ${item.adrId} (${item.status}${typeLabel}), 章节: ${item.section}`,
      `文件: ${item.filePath}`,
      `相关度: ${item.score.toFixed(4)}`,
      '内容:',
      item.content,
    ].join('\n')
  }).join('\n---\n')
}

export function formatAdrByFile(adrs: Array<{ adrId: string; status: string; summary: string }>): string {
  if (adrs.length === 0) return '未找到关联的 ADR 决策记录。'
  const body = adrs.map((v) => `- ${v.adrId} (${v.status}): ${v.summary.slice(0, 100)}`).join('\n')
  return `关联的 ADR 决策记录:\n${body}`
}

export function formatAdrList(adrs: AdrListItem[]): string {
  if (adrs.length === 0) return '没有找到匹配的 ADR。'
  const body = adrs.map((v) => `${v.id} [${v.status}] ${v.changeType} — ${v.summary.slice(0, 60)}`).join('\n')
  return `共 ${adrs.length} 条 ADR 记录\n${body}`
}

export function formatConstraints(items: Array<{
  adrId: string; adrTitle: string; constraints: string[]
  rejectedPatterns: string[]; hiddenConstraints?: Array<{ name: string; content: string; consequence: string }>
}>): string {
  if (items.length === 0) return '没有 active 的约束。'
  return items.map((v) => {
    const lines = [`## ${v.adrId}: ${v.adrTitle}`]
    if (v.constraints.length) lines.push('约束:', ...v.constraints.map((c) => `  - ${c}`))
    if (v.hiddenConstraints?.length) {
      lines.push('隐性约束:')
      for (const h of v.hiddenConstraints) {
        lines.push(`  - ${h.name}`)
        if (h.content) lines.push(`    内容: ${h.content}`)
        if (h.consequence) lines.push(`    后果: ${h.consequence}`)
      }
    }
    if (v.rejectedPatterns.length) {
      lines.push('被否决的反模式:', ...v.rejectedPatterns.map((p) => `  ❌ ${p}`))
    }
    return lines.join('\n')
  }).join('\n\n')
}
```

- [ ] **Step 7: 门控注册**

`packages/codex/src/server.ts`：import 补 `getConfig`（来自 `dsh-context-milvus-core`）、4 个 schema、4 个 handler、4 个 formatter。在 `createServer` 里，`const server = new McpServer(...)` 之后加一行门控判定，并把四个 `registerTool` 包进 `if`:

```ts
  // ADR tools only appear when the server is started with ADR_ENABLED. MCP has
  // no way to grow its tool list mid-session, so this is decided once at boot.
  const adrEnabled = getConfig().adrEnabled
  logger.debug('ADR tools', { enabled: adrEnabled })

  if (adrEnabled) {
    server.registerTool('search_adr', {
      description: '在 ADR 决策记录中做语义搜索。需要知道一段代码"为什么这样写"时使用。',
      inputSchema: searchAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleSearchAdr(resolveServices, logger, args)
      return { payload: { root: out.root, results: out.results }, text: formatAdrSearch(out.results) }
    }))

    server.registerTool('search_adr_by_file', {
      description: '按代码文件路径查关联的 ADR 决策记录（基于 code_anchors 的确定性关联）。',
      inputSchema: searchAdrByFileSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleSearchAdrByFile(resolveServices, logger, args)
      return { payload: { root: out.root, adrs: out.adrs }, text: formatAdrByFile(out.adrs) }
    }))

    server.registerTool('list_adrs', {
      description: '列出 ADR 决策记录，可按状态与变更类型过滤。',
      inputSchema: listAdrsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleListAdrs(resolveServices, logger, args)
      return { payload: { root: out.root, adrs: out.adrs }, text: formatAdrList(out.adrs) }
    }))

    server.registerTool('load_constraints', {
      description: '加载 active ADR 的约束、隐性约束与被否决的反模式。',
      inputSchema: loadConstraintsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleLoadConstraints(resolveServices, logger, args)
      return { payload: { root: out.root, constraints: out.constraints }, text: formatConstraints(out.constraints) }
    }))
  }
```

- [ ] **Step 8: 冒烟测试改两分支**

把 `packages/codex/test/mcp-smoke.spec.ts` 的用例改造成一个可复用函数 + 两个断言（`ADR_ENABLED` 关→恰好 5；开→恰好 9）。整文件替换为：

```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/mcp.js')

function rpc(child: any, id: number, method: string, params: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
}

async function listToolNames(env: Record<string, string>): Promise<string[]> {
  const child = spawn(process.execPath, [BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const lines: string[] = []
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
  })
  const deadline = Date.now() + 15000

  rpc(child, 1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' },
  })
  while (!lines.some((l) => l.includes('"id":1')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const init = JSON.parse(lines.find((l) => l.includes('"id":1'))!)
  expect(init.result.serverInfo.name).toBe('codex-context-milvus')

  rpc(child, 2, 'notifications/initialized', {})
  rpc(child, 3, 'tools/list', {})
  while (!lines.some((l) => l.includes('"id":3')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const list = JSON.parse(lines.find((l) => l.includes('"id":3'))!)

  child.kill()
  await once(child, 'exit').catch(() => {})
  return list.result.tools.map((t: any) => t.name).sort()
}

const CORE_TOOLS = ['find_callers', 'index_code', 'index_status', 'search_code', 'trace_call_chain']

describe('mcp stdio smoke', () => {
  it('lists the five core tools when ADR is off', async () => {
    expect(await listToolNames({ ADR_ENABLED: '' })).toEqual(CORE_TOOLS)
  }, 20000)

  it('lists the ADR tools once ADR_ENABLED is set', async () => {
    expect(await listToolNames({ ADR_ENABLED: 'true' })).toEqual([
      ...CORE_TOOLS, 'list_adrs', 'load_constraints', 'search_adr', 'search_adr_by_file',
    ].sort())
  }, 20000)
})
```

第二个分支能在没有 Milvus 的机器上跑，正因为 Task 4 定了 `createAdrBundle` 不联网 —— 这条依赖写在这里，别在实现时偷偷加网络调用。

- [ ] **Step 9: 跑测试**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-handlers.spec.ts packages/codex/test/mcp-smoke.spec.ts 2>&1 | tail -10`
Expected: 全绿（`mcp-smoke` 需先 `npm run build`；它是真起子进程）

Run: `npm run build && npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: 全绿，suites = 27，tests = 315 + 11（adr-handlers）+ 1（smoke 拆两条，净增 1）= `327 passed`

- [ ] **Step 10: Commit**

```bash
git add packages/codex/src packages/codex/test
git commit -m "feat(codex): add the four read-only ADR tools

search_adr / search_adr_by_file / list_adrs / load_constraints，
由 ADR_ENABLED 在启动时门控（MCP 无法中途扩工具表）。
DSH 的 path 参数在 codex 侧改叫 pathPrefix，避免与工作区根目录 path 撞名。"
```

---

### Task 7: Codex 的 4 个写类 ADR 工具与写门控

**Files:**
- Create: `packages/codex/src/adr-gate.ts`
- Create/Modify: `packages/codex/src/adr-handlers.ts`（追加 4 个 handler）
- Modify: `packages/codex/src/schemas.ts`、`packages/codex/src/result-format.ts`、`packages/codex/src/server.ts`
- Test: `packages/codex/test/adr-write-gate.spec.ts`（新建）、`packages/codex/test/adr-handlers.spec.ts`（追加）

**Interfaces:**
- Consumes: `AdrService.createAdr(params: CreateAdrParams)` / `updateAdr(id, params: UpdateAdrParams)`、`AdrAnchorIndex.getAll()`、`runAdrIndex(config, milvus, tracker, anchorIndex, options)`、`findCandidateFiles/previewFrontmatter/generateSpecFrontmatter`（core）
- Produces:
  - `AdrErrorCode = 'E_ADR_WRITE_DISABLED' | 'E_ADR_NOT_INITIALIZED'` 与 `class AdrError extends Error { code: AdrErrorCode }`（`adr-gate.ts`）
  - `writesEnabled(): boolean`、`assertWritesEnabled(): void`、`requireExistingAdr(adr?: AdrPort): AdrPort`
  - `handleCreateAdr` / `handleUpdateAdr` / `handleCheckAdrConsistency` / `handleIndexSpecs`
  - MCP 工具 `create_adr`、`update_adr`、`check_adr_consistency`、`index_specs`

- [ ] **Step 1: 写门控与错误类型（先测）**

新建 `packages/codex/test/adr-write-gate.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvus-sdk-mockExports)

const { AdrError, writesEnabled, assertWritesEnabled, requireExistingAdr } =
  await import('../src/adr-gate.js')

const KEY = 'CONTEXT_MILVUS_ADR_WRITE'
const saved = process.env[KEY]
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe('ADR write gate', () => {
  it('is closed by default', () => {
    delete process.env[KEY]
    expect(writesEnabled()).toBe(false)
    expect(() => assertWritesEnabled('create_adr')).toThrow(AdrError)
    try { assertWritesEnabled('create_adr') } catch (e) {
      expect((e as AdrError).code).toBe('E_ADR_WRITE_DISABLED')
      // The message must name the switch: an agent can only self-report if it
      // can see exactly what to change.
      expect((e as Error).message).toContain(KEY)
    }
  })

  it.each([['1'], ['true'], ['TRUE'], ['yes'], ['on']])('opens for %s', (raw) => {
    process.env[KEY] = raw
    expect(writesEnabled()).toBe(true)
    expect(() => assertWritesEnabled('create_adr')).not.toThrow()
  })

  it.each([['0'], ['false'], ['no'], ['']])('stays closed for %s', (raw) => {
    process.env[KEY] = raw
    expect(writesEnabled()).toBe(false)
  })
})

describe('requireExistingAdr', () => {
  it('rejects a bundle whose ADR directory is absent', () => {
    expect(() => requireExistingAdr({ exists: false } as any)).toThrow(AdrError)
    try { requireExistingAdr({ exists: false } as any) } catch (e) {
      expect((e as AdrError).code).toBe('E_ADR_NOT_INITIALIZED')
      expect((e as Error).message).toContain('ADR_ROOT')
    }
  })

  it('never creates the directory as a side effect', () => {
    expect(() => requireExistingAdr(undefined)).toThrow(AdrError)
  })

  it('passes a usable bundle through', () => {
    const bundle = { exists: true, adrRoot: '/x' } as any
    expect(requireExistingAdr(bundle)).toBe(bundle)
  })
})
```

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-write-gate.spec.ts 2>&1 | tail -8`
Expected: FAIL —— `Cannot find module '../src/adr-gate.js'`

- [ ] **Step 2: 实现门控**

新建 `packages/codex/src/adr-gate.ts`：

```ts
import type { AdrPort } from './handlers.js'

export const ADR_WRITE_ENV = 'CONTEXT_MILVUS_ADR_WRITE'

export type AdrErrorCode = 'E_ADR_WRITE_DISABLED' | 'E_ADR_NOT_INITIALIZED'

export class AdrError extends Error {
  constructor(public readonly code: AdrErrorCode, message: string) {
    super(message)
    this.name = 'AdrError'
  }
}

/** Write tools are opt-in: an autonomous agent must not create documents by surprise. */
export function writesEnabled(): boolean {
  const raw = process.env[ADR_WRITE_ENV] ?? ''
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

export function assertWritesEnabled(action: string): void {
  if (writesEnabled()) return
  throw new AdrError(
    'E_ADR_WRITE_DISABLED',
    `${action} 需要写盘，当前已禁用。设环境变量 ${ADR_WRITE_ENV}=true 并重启 Codex 后可用。`,
  )
}

/**
 * A missing ADR directory is reported, never created: silently growing a
 * docs/decisions tree inside the user's repository is worse than refusing.
 */
export function requireExistingAdr(adr?: AdrPort): AdrPort {
  if (!adr || !adr.exists) {
    throw new AdrError(
      'E_ADR_NOT_INITIALIZED',
      'ADR 目录不存在或不可读，检查 ADR_ROOT（默认 docs/decisions）。',
    )
  }
  return adr
}
```

`packages/codex/src/result-format.ts` 的 `ErrorCode` 联合加两项：

```ts
export type ErrorCode =
  | 'E_WORKSPACE_NOT_FOUND' | 'E_MILVUS_UNREACHABLE' | 'E_COLLECTION_INIT'
  | 'E_EMBEDDING_FAILED' | 'E_EMBEDDING_DIM_MISMATCH' | 'E_INDEX_ROOT_UNREADABLE'
  | 'E_IMPORT_MAP_MISSING' | 'E_ADR_WRITE_DISABLED' | 'E_ADR_NOT_INITIALIZED' | 'E_INTERNAL'
```

`packages/codex/src/server.ts` 的 `classify()` 在 workspace 分支之后插入：

```ts
  if (err && typeof err === 'object' && (err as any).code === 'E_ADR_WRITE_DISABLED') {
    return errorResult('E_ADR_WRITE_DISABLED', message, `设 ${ADR_WRITE_ENV}=true 后重启 Codex`)
  }
  if (err && typeof err === 'object' && (err as any).code === 'E_ADR_NOT_INITIALIZED') {
    return errorResult('E_ADR_NOT_INITIALIZED', message, '检查 ADR_ROOT 指向的目录是否存在')
  }
```

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-write-gate.spec.ts 2>&1 | tail -6`
Expected: `Tests: 13 passed`

- [ ] **Step 3: 写 handler 的失败测试**

在 `packages/codex/test/adr-handlers.spec.ts` 末尾追加（顶部 `await import('../src/adr-handlers.js')` 那行补上四个新 handler 的名字，并把 `const WRITE = 'CONTEXT_MILVUS_ADR_WRITE'` 加在文件顶部）：

```ts
afterEach(() => { delete process.env[WRITE] })

describe('handleCreateAdr', () => {
  it('refuses to write unless the write switch is on', async () => {
    const s = makeServices()
    const before = (s.adr!.service.createAdr as jest.Mock).mock.calls.length
    await expect(handleCreateAdr(async () => s, silentLogger, { title: 'x', path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
    expect((s.adr!.service.createAdr as jest.Mock).mock.calls.length).toBe(before)
  })

  it('creates and re-indexes once the switch is on', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr!.service.createAdr as jest.Mock).mockResolvedValue({ id: 'ADR-0004-x', filePath: '/x/ADR-0004-x.md' })
    const out = await handleCreateAdr(async () => s, silentLogger,
      { title: 'x', requirement: 'r', changeType: 'refactor', path: root })
    expect(s.adr!.service.createAdr).toHaveBeenCalledWith({
      title: 'x', requirement: 'r', changeType: 'refactor', supersedes: undefined, content: undefined,
    })
    expect(out.adr.adrId).toBe('ADR-0004-x')
  })

  it('refuses when the ADR directory is missing', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr as any).exists = false
    await expect(handleCreateAdr(async () => s, silentLogger, { title: 'x', path: root }))
      .rejects.toThrow(/ADR_ROOT/)
  })
})

describe('handleUpdateAdr', () => {
  it('is gated the same way as create', async () => {
    const s = makeServices()
    await expect(handleUpdateAdr(async () => s, silentLogger, { adrId: 'ADR-0003-retry-queue', path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
  })

  it('maps camelCase args onto UpdateAdrParams', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr!.service.updateAdr as jest.Mock).mockResolvedValue({ id: 'ADR-0003-retry-queue', filePath: '/x' })
    await handleUpdateAdr(async () => s, silentLogger,
      { adrId: 'ADR-0003-retry-queue', status: 'superseded', supersededBy: 'ADR-0009-y', merge: true, path: root })
    expect(s.adr!.service.updateAdr).toHaveBeenCalledWith('ADR-0003-retry-queue', {
      content: undefined, status: 'superseded', supersededBy: 'ADR-0009-y', merge: true,
    })
  })
})

describe('handleCheckAdrConsistency', () => {
  function withAnchors(s: HandlerServices, entries: Array<[string, string[]]>) {
    ;(s.adr as any).anchorIndex.getAll = () => new Map(entries)
  }

  it('reports a missing file as a stale anchor without writing', async () => {
    const s = makeServices()
    withAnchors(s, [['src/gone.ts', ['ADR-0003-retry-queue']]])
    const out = await handleCheckAdrConsistency(async () => s, silentLogger, { path: root })
    expect(out.report.staleAnchors).toEqual([
      { adrId: 'ADR-0003-retry-queue', file: 'src/gone.ts', issue: '文件已不存在' },
    ])
    expect(out.report.fixedAnchors).toEqual([])
  })

  it('does not write even when fix is requested, unless the switch is on', async () => {
    const s = makeServices()
    withAnchors(s, [['src/gone.ts', ['ADR-0003-retry-queue']]])
    await expect(handleCheckAdrConsistency(async () => s, silentLogger, { fix: true, path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
  })

  it('flags an untracked file as uncovered', async () => {
    const s = makeServices()
    withAnchors(s, [['src/a.ts', ['ADR-0003-retry-queue']]])
    const out = await handleCheckAdrConsistency(async () => s, silentLogger,
      { filePath: 'src/other.ts', path: root })
    expect(out.report.uncoveredChanges).toEqual([
      { adrId: 'N/A', file: 'src/other.ts', status: 'uncovered' },
    ])
  })
})

describe('handleIndexSpecs', () => {
  it('is safe by default: a missing scan root yields an empty preview', async () => {
    const s = makeServices()
    const out = await handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'no-such-dir', dryRun: true, path: root })
    expect(out.result.filesProcessed).toBe(0)
    expect(out.result.dryRun).toBe(true)
  })

  it('refuses a real write unless the switch is on', async () => {
    await mkdir(path.join(root, 'specs'), { recursive: true })
    const s = makeServices()
    await expect(handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'specs', dryRun: false, path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
  })

  it('scans only scanPath and never the whole repository', async () => {
    // Regression guard: an explicit scanPath sets planRoot to '', and "skip
    // plans" currently works only because scanDirectory('') fails and is
    // filtered out. If that ever starts returning the cwd instead, this test
    // is what stops a Codex tool from indexing a user's entire repo.
    await mkdir(path.join(root, 'specs'), { recursive: true })
    await mkdir(path.join(root, 'elsewhere'), { recursive: true })
    const design = (n: string) => `---\ntitle: ${n}\n---\n\n# ${n}\n\n引用 src/queue.ts 里的 push\n`
    await writeFile(path.join(root, 'specs', '2026-09-01-a-design.md'), design('a'), 'utf-8')
    await writeFile(path.join(root, 'elsewhere', '2026-09-02-b-design.md'), design('b'), 'utf-8')

    const s = makeServices()
    const out = await handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'specs', dryRun: true, path: root })

    expect(out.result.filesProcessed).toBe(1)
    const files = (out.result.preview as Array<{ filePath: string }>).map((p) => p.filePath)
    expect(files.every((f) => f.includes(`${path.sep}specs${path.sep}`))).toBe(true)
    expect(files.some((f) => f.includes('elsewhere'))).toBe(false)
  })
})
```

顶部还要补上 `mkdir` / `writeFile` 的引入（该文件已从 `node:fs/promises` 引 `mkdtemp, rm`，扩成 `mkdtemp, rm, mkdir, writeFile`），并把共享工厂 `makeServices` 的 `adr.service` 字面量扩成写类工具也要用的三个方法：

```ts
      service: {
        loadAdr: /* 保持原样 */,
        listAdrs: /* 保持原样 */,
        getActiveConstraints: /* 保持原样 */,
        createAdr: jest.fn(async () => ({ id: 'ADR-0001-x', filePath: '/x' })),
        updateAdr: jest.fn(async (id: string) => ({ id, filePath: '/x' })),
        removeAnchorsForFile: jest.fn(async () => false),
      },
```

同文件顶部的 `await import('../src/adr-handlers.js')` 那行解构补上 `handleCreateAdr, handleUpdateAdr, handleCheckAdrConsistency, handleIndexSpecs`，并在 `afterEach` 里清掉写开关：

```ts
const WRITE = 'CONTEXT_MILVUS_ADR_WRITE'
afterEach(() => { delete process.env[WRITE] })
```

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-handlers.spec.ts 2>&1 | tail -12`
Expected: FAIL —— `handleCreateAdr is not a function`

- [ ] **Step 4: 实现 4 个写类 handler**

在 `packages/codex/src/adr-handlers.ts` 追加。顶部 import 补：

```ts
import { access } from 'node:fs/promises'
import type { AdrIndexResult } from 'dsh-context-milvus-core'
import { findCandidateFiles, previewFrontmatter, generateSpecFrontmatter } from 'dsh-context-milvus-core'
import { assertWritesEnabled, requireExistingAdr } from './adr-gate.js'
```

`ServiceProvider` 提供的 `services.milvus` 在写类路径上还要 `insertAdrChunks` 等能力，索引那步统一按 core 的真实签名调用并把端口断言写清楚（沿用 `handlers.ts` 里 `runIndex` 已有的 `as any` 惯例）：

```ts
export interface CreateAdrArgs {
  title: string
  requirement?: string
  changeType?: string
  supersedes?: string
  content?: string
  path?: string
}

export async function handleCreateAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: CreateAdrArgs,
): Promise<{ root: string; adr: { adrId: string; filePath: string } }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)
  assertWritesEnabled('create_adr')

  const created = await adr.service.createAdr({
    title: args.title,
    requirement: args.requirement,
    changeType: args.changeType,
    supersedes: args.supersedes,
    content: args.content,
  })
  await reindex(logger, root, services)
  logger.info('create_adr done', { root, adrId: created.id })
  return { root, adr: { adrId: created.id, filePath: created.filePath } }
}

export interface UpdateAdrArgs {
  adrId: string
  content?: string
  status?: string
  supersededBy?: string
  merge?: boolean
  path?: string
}

export async function handleUpdateAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: UpdateAdrArgs,
): Promise<{ root: string; adr: { adrId: string; filePath: string } }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)
  assertWritesEnabled('update_adr')

  const updated = await adr.service.updateAdr(args.adrId, {
    content: args.content,
    status: args.status,
    supersededBy: args.supersededBy,
    merge: args.merge,
  })
  await reindex(logger, root, services)
  logger.info('update_adr done', { root, adrId: updated.id })
  return { root, adr: { adrId: updated.id, filePath: updated.filePath } }
}

/** Incremental ADR re-index; progress goes to the injected logger (stderr). */
async function reindex(logger: Logger, root: string, services: Awaited<ReturnType<ServiceProvider>>) {
  const { runAdrIndex } = await import('dsh-context-milvus-core')
  await runAdrIndex(
    services.config, services.milvus as any, services.adr!.tracker, services.adr!.anchorIndex,
    { mode: 'incremental', logger },
  )
}

export interface CheckAdrConsistencyArgs {
  filePath?: string
  fix?: boolean
  path?: string
}

export interface AdrConsistencyReport {
  staleAnchors: Array<{ adrId: string; file: string; issue: string }>
  uncoveredChanges: Array<{ adrId: string; file: string; status: string }>
  fixedAnchors: Array<{ adrId: string; file: string }>
}

export async function handleCheckAdrConsistency(
  provider: ServiceProvider,
  logger: Logger,
  args: CheckAdrConsistencyArgs,
): Promise<{ root: string; report: AdrConsistencyReport }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)
  // fix is the only write in this tool; the read-only report stays available.
  if (args.fix) assertWritesEnabled('check_adr_consistency(fix)')

  const relative = args.filePath
    ? (path.isAbsolute(args.filePath) ? path.relative(root, args.filePath) : args.filePath)
    : undefined

  const report: AdrConsistencyReport = { staleAnchors: [], uncoveredChanges: [], fixedAnchors: [] }
  const all = adr.anchorIndex.getAll()

  for (const [file, ids] of all) {
    if (relative && file !== relative) continue
    try {
      await access(path.resolve(root, file))
    } catch {
      report.staleAnchors.push({ adrId: ids.join(', '), file, issue: '文件已不存在' })
    }
  }

  if (relative && !all.has(relative)) {
    report.uncoveredChanges.push({ adrId: 'N/A', file: relative, status: 'uncovered' })
  }

  if (args.fix && report.staleAnchors.length > 0) {
    for (const anchor of report.staleAnchors) {
      for (const id of anchor.adrId.split(', ').filter(Boolean)) {
        const removed = await stripAnchor(adr, id, anchor.file, logger)
        if (removed) report.fixedAnchors.push({ adrId: id, file: anchor.file })
      }
    }
  }

  logger.info('check_adr_consistency done', {
    root, stale: report.staleAnchors.length, fixed: report.fixedAnchors.length,
  })
  return { root, report }
}
```

`stripAnchor` 是把 DSH `adr-tools.ts:440-478` 那段"重写 frontmatter 里的 code_anchors"搬过来 —— **它现在没有 core 等价物，必须提成 core 函数**，否则同一份 YAML 重写逻辑要在两端各写一遍。在 `packages/core/src/adr-service.ts` 的 `AdrService` 类里加一个方法：

```ts
  /**
   * Remove every code anchor pointing at `file`. Returns false when nothing
   * changed. Written atomically (tmp + rename) because spec documents are
   * hand-maintained files.
   */
  async removeAnchorsForFile(adrId: string, file: string): Promise<boolean> {
    const doc = await this.loadAdr(adrId)
    if (!doc) return false

    const content = await readFile(doc.filePath, 'utf-8')
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/)
    if (!fmMatch) return false

    const parsed = yamlLoad(fmMatch[1]) as Record<string, unknown>
    if (!Array.isArray(parsed.code_anchors)) return false

    const before = parsed.code_anchors.length
    parsed.code_anchors = (parsed.code_anchors as Array<Record<string, unknown>>)
      .filter((a) => a?.file !== file)
    if (parsed.code_anchors.length === before) return false

    const next = yamlDump(parsed, { lineWidth: 120, noRefs: true, sortKeys: false })
    const tmpPath = `${doc.filePath}.tmp`
    await writeFile(tmpPath, content.replace(fmMatch[0], `---\n${next}---\n`), 'utf-8')
    await rename(tmpPath, doc.filePath)
    return true
  }
```

`AdrService` 已 import 了 `readFile` / `writeFile` / `rename`（`node:fs/promises`），无需再加；只缺 YAML，在文件顶部补一行：

```ts
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
```

codex 侧的 `stripAnchor` 就退化成薄封装：

```ts
async function stripAnchor(
  adr: AdrPort, adrId: string, file: string, logger: Logger,
): Promise<boolean> {
  try {
    return await adr.service.removeAnchorsForFile(adrId, file)
  } catch (err) {
    logger.warn('strip anchor failed', { adrId, file, error: String(err) })
    return false
  }
}
```

`index_specs`（`scanPath` 语义严格照 DSH：给了就只扫它、`planRoot` 置空跳过 plans）：

```ts
export interface IndexSpecsArgs {
  scanPath?: string
  dryRun?: boolean
  path?: string
}

export interface SpecPreview {
  filePath: string
  adrId: string
  detectedRefs: Array<{ file: string; symbols: string[]; lines: number[] }>
}

export interface IndexSpecsResult extends AdrIndexResult {
  filesProcessed: number
  anchorsGenerated: number
  dryRun: boolean
  preview: SpecPreview[]
}

export async function handleIndexSpecs(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexSpecsArgs,
): Promise<{ root: string; result: IndexSpecsResult }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)

  const dryRun = args.dryRun ?? true
  if (!dryRun) assertWritesEnabled('index_specs')

  const specRoot = args.scanPath
    ? path.resolve(root, args.scanPath)
    : path.resolve(root, services.config.specRoot || 'docs/superpowers/specs')
  // Mirrors the DSH tool: an explicit scan path replaces both roots, and an
  // empty plan root means "skip plans".
  const planRoot = args.scanPath
    ? ''
    : path.resolve(root, services.config.planRoot || 'docs/superpowers/plans')

  const candidates: string[] = [...await findCandidateFiles(specRoot, /^\d{4}-\d{2}-\d{2}-.+-design\.md$/)]
  if (planRoot) {
    candidates.push(...await findCandidateFiles(planRoot, /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/))
  }

  const preview: SpecPreview[] = []
  let anchorsGenerated = 0
  for (const filePath of candidates) {
    const result = dryRun
      ? await previewFrontmatter(filePath, root)
      : await generateSpecFrontmatter(filePath, root)
    if (!result) continue
    preview.push({ filePath, adrId: result.adrId, detectedRefs: result.detectedRefs })
    anchorsGenerated += result.detectedRefs.length
  }

  let indexed: AdrIndexResult = {
    filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 0,
  }
  if (!dryRun && candidates.length > 0) {
    const { runAdrIndex } = await import('dsh-context-milvus-core')
    indexed = await runAdrIndex(
      { ...services.config, adrRoot: adr.adrRoot, specRoot, planRoot },
      services.milvus as any, adr.tracker, adr.anchorIndex,
      { mode: 'incremental', logger },
    )
  }

  logger.info('index_specs done', { root, dryRun, filesProcessed: candidates.length })
  return {
    root,
    result: { ...indexed, filesProcessed: candidates.length, anchorsGenerated, dryRun, preview },
  }
}
```

- [ ] **Step 5: 补 core 侧 `removeAnchorsForFile` 的测试**

在 `packages/core/test/adr-service.spec.ts` 末尾追加（该文件已有建 ADR 的辅助流程，照它的写法用 `createAdr` 造一份带 anchor 的记录）：

```ts
describe('AdrService.removeAnchorsForFile', () => {
  it('drops only the anchors for the given file and keeps the rest', async () => {
    const { AdrService } = await import('../src/adr-service.js')
    const dir = await mkdtemp(path.join(tmpdir(), 'adr-strip-'))
    const svc = new AdrService(dir)
    const { id } = await svc.createAdr({ title: 'strip-me', requirement: 'r' })

    const doc = await svc.loadAdr(id)
    const body = `---
id: ${id}
type: adr
status: active
created: 2026-09-01
updated: 2026-09-01
author: t
supersedes: null
superseded_by: null
code_anchors:
  - file: src/keep.ts
    symbols: [keep]
  - file: src/gone.ts
    symbols: [gone]
trigger:
  change_type: refactor
related_decisions: []
auto_generated: false
---

# 标题

正文
`
    await writeFile(doc!.filePath, body, 'utf-8')

    expect(await svc.removeAnchorsForFile(id, 'src/gone.ts')).toBe(true)

    const after = await readFile(doc!.filePath, 'utf-8')
    expect(after).toContain('src/keep.ts')
    expect(after).not.toContain('src/gone.ts')
    expect(after.startsWith('---\n')).toBe(true)
    expect(after).toContain('# 标题')
  })

  it('returns false when no anchor matches', async () => {
    const { AdrService } = await import('../src/adr-service.js')
    const dir = await mkdtemp(path.join(tmpdir(), 'adr-strip2-'))
    const svc = new AdrService(dir)
    const { id } = await svc.createAdr({ title: 'no-anchor', requirement: 'r' })
    expect(await svc.removeAnchorsForFile(id, 'src/never-indexed.ts')).toBe(false)
  })

  it('returns false for an unknown id', async () => {
    const { AdrService } = await import('../src/adr-service.js')
    const dir = await mkdtemp(path.join(tmpdir(), 'adr-strip3-'))
    const svc = new AdrService(dir)
    expect(await svc.removeAnchorsForFile('ADR-9999-nope', 'src/x.ts')).toBe(false)
  })

  it('leaves no .tmp file behind', async () => {
    const { AdrService } = await import('../src/adr-service.js')
    const dir = await mkdtemp(path.join(tmpdir(), 'adr-strip4-'))
    const svc = new AdrService(dir)
    const { id, filePath } = await svc.createAdr({ title: 'tmp-check', requirement: 'r' })
    await svc.removeAnchorsForFile(id, 'src/x.ts')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })
})
```

在该 spec 顶部补齐用到的 API：`import { mkdtemp, writeFile, readFile } from 'node:fs/promises'`、`import { existsSync } from 'node:fs'`、`import { tmpdir } from 'node:os'`。

- [ ] **Step 6: schema、formatter 与注册**

`packages/codex/src/schemas.ts` 追加：

```ts
export const createAdrSchema = {
  title: z.string().describe('kebab-case 简短描述，如 webhook-dead-letter-queue'),
  requirement: z.string().optional().describe('触发需求/变更描述'),
  changeType: z.enum(['new_feature', 'refactor', 'bugfix', 'optimization', 'architecture']).optional(),
  supersedes: z.string().optional().describe('被替代的 ADR id'),
  content: z.string().optional().describe('自定义正文，留空则用模板生成'),
  path: z.string().optional(),
}

export const updateAdrSchema = {
  adrId: z.string().describe('ADR id，如 ADR-0001-test'),
  content: z.string().optional().describe('替换正文'),
  status: z.enum(['active', 'superseded', 'deprecated']).optional(),
  supersededBy: z.string().optional().describe('标记被谁替代'),
  merge: z.boolean().optional().describe('true 则合并，保留未传字段'),
  path: z.string().optional(),
}

export const checkAdrConsistencySchema = {
  filePath: z.string().optional().describe('只查这一个文件（相对工作区根）'),
  fix: z.boolean().optional().describe('从 ADR frontmatter 移除失效锚点；默认只报告'),
  path: z.string().optional(),
}

export const indexSpecsSchema = {
  scanPath: z.string().optional().describe('只扫这个目录（相对工作区根）'),
  dryRun: z.boolean().optional().describe('默认 true，只预览不落盘'),
  path: z.string().optional(),
}
```

`packages/codex/src/result-format.ts` 追加一个 formatter：

```ts
export function formatAdrConsistency(r: {
  staleAnchors: Array<{ adrId: string; file: string; issue: string }>
  uncoveredChanges: Array<{ adrId: string; file: string; status: string }>
  fixedAnchors: Array<{ adrId: string; file: string }>
}): string {
  const parts: string[] = ['## ADR 一致性检查结果']
  if (r.staleAnchors.length) {
    parts.push(`\n### 失效锚点 (${r.staleAnchors.length})`,
      ...r.staleAnchors.map((a) => `  - ${a.adrId}: ${a.file} — ${a.issue}`))
  }
  if (r.fixedAnchors.length) {
    parts.push(`\n### 已修复锚点 (${r.fixedAnchors.length})`,
      ...r.fixedAnchors.map((a) => `  - ${a.adrId}: ${a.file} — 已从 ADR frontmatter 中移除`))
  }
  if (r.uncoveredChanges.length) {
    parts.push(`\n### 未覆盖变更 (${r.uncoveredChanges.length})`,
      ...r.uncoveredChanges.map((a) => `  - ${a.adrId}: ${a.file} — ${a.status}`))
  }
  if (!r.staleAnchors.length && !r.uncoveredChanges.length) {
    parts.push('\n✅ 未发现问题，所有 ADR 与代码一致。')
  }
  return parts.join('\n')
}
```

`packages/codex/src/server.ts` 的 `if (adrEnabled)` 块内追加四个注册（形状与 Task 6 的四个一致）：

```ts
    server.registerTool('create_adr', {
      description: '创建 ADR 决策记录。做出新设计决策、引入新依赖或架构变更时使用。写盘操作，需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: createAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleCreateAdr(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.adr },
               text: `✅ ADR 已创建: ${out.adr.adrId}\n路径: ${out.adr.filePath}` }
    }))

    server.registerTool('update_adr', {
      description: '更新已有 ADR：改约束、换状态、补内容。写盘操作，需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: updateAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleUpdateAdr(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.adr }, text: `✅ ADR 已更新: ${out.adr.adrId}` }
    }))

    server.registerTool('check_adr_consistency', {
      description: '检查 ADR 的 code_anchors 是否仍有效、变更是否未被覆盖。默认只报告，fix 才写盘。',
      inputSchema: checkAdrConsistencySchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleCheckAdrConsistency(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.report }, text: formatAdrConsistency(out.report) }
    }))

    server.registerTool('index_specs', {
      description: '扫描规格文档、生成 code_anchors 并索引。默认 dryRun 只预览；真正落盘需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: indexSpecsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleIndexSpecs(resolveServices, logger, args)
      const r = out.result
      const lines = [
        `文件处理: ${r.filesProcessed}`,
        `锚点生成: ${r.anchorsGenerated}`,
        r.dryRun ? '模式: 预览（未写入文件）'
                 : `文件索引: ${r.filesIndexed}\n分块索引: ${r.chunksIndexed}`,
      ]
      if (r.preview.length) {
        lines.push('')
        for (const p of r.preview) {
          lines.push(`  ${p.adrId}: ${p.filePath}`)
          for (const ref of p.detectedRefs) lines.push(`    引用: ${ref.file}${ref.symbols.length ? ` (${ref.symbols.join(', ')})` : ''}`)
        }
      }
      return { payload: { root: out.root, ...r }, text: lines.join('\n') }
    }))
```

- [ ] **Step 7: 门控两分支加写工具**

`packages/codex/test/mcp-smoke.spec.ts` 里 `ADR_ENABLED=true` 那条用例的期望数组补成 13 个（`sorted`）：

```ts
    expect(await listToolNames({ ADR_ENABLED: 'true' })).toEqual([
      ...CORE_TOOLS,
      'check_adr_consistency', 'create_adr', 'index_specs', 'list_adrs',
      'load_constraints', 'search_adr', 'search_adr_by_file', 'update_adr',
    ].sort())
```

- [ ] **Step 8: 全量验证**

Run: `npm run build && npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: 全绿；suites = 28，tests = 327 + 13（adr-write-gate）+ 11（adr-handlers 追加）+ 4（adr-service 追加）= `355 passed`

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/adr-write-gate.spec.ts 2>&1 | tail -5`
Expected: 全绿 —— 这条是"默认不许写盘"的唯一硬证据

- [ ] **Step 9: Commit**

```bash
git add packages/codex/src packages/codex/test packages/core/src packages/core/test
git commit -m "feat(codex): add the four write-capable ADR tools behind a write gate

create_adr / update_adr / check_adr_consistency / index_specs。门控按实际写意图判：
index_specs(dryRun) 与 check_adr_consistency(fix=false) 默认可用，只有真落盘
才要 CONTEXT_MILVUS_ADR_WRITE=true。ADR 目录缺失一律报 E_ADR_NOT_INITIALIZED，
绝不代建。锚点剥离逻辑提到 AdrService.removeAnchorsForFile，两端共用。"
```

---

### Task 8: `search_code` 的 ADR 被动提醒

**Files:**
- Modify: `packages/codex/src/handlers.ts:41-55`（`handleSearchCode`）
- Modify: `packages/codex/src/result-format.ts`
- Modify: `packages/codex/src/server.ts:43-50`
- Test: `packages/codex/test/search-code-adr-hint.spec.ts`（新建）

**Interfaces:**
- Consumes: `AdrPort.anchorIndex.getAdrsForFile()`、`AdrPort.titles()`（Task 4/6）
- Produces: `handleSearchCode` 返回值多一个 `relatedAdrs: RelatedAdr[]`；`appendAdrHints(text, relatedAdrs): string`

- [ ] **Step 1: 写失败的测试**

新建 `packages/codex/test/search-code-adr-hint.spec.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const { handleSearchCode } = await import('../src/handlers.js')
const { appendAdrHints } = await import('../src/result-format.js')
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-hint-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const HIT = {
  filePath: path.join(root, 'src', 'queue.ts'), content: 'code', score: 0.5,
  language: 'typescript', startLine: 1, endLine: 2, name: 'push', chunkType: 'function',
}

function makeServices(adr?: any): HandlerServices {
  return {
    root,
    config: getConfig({ indexRoot: root }),
    milvus: { ensureCollection: jest.fn(async () => {}), search: jest.fn(async () => [HIT]) } as any,
    tracker: { getStats: () => ({ totalFiles: 1, totalChunks: 1 }),
               getLastIndexedTimestamp: () => Date.now() } as any,
    importResolver: {} as any,
    adr,
  }
}

const coveredAdr = {
  exists: true,
  adrRoot: path.join(root, 'docs', 'decisions'),
  anchorIndex: { getAdrsForFile: (f: string) => f === 'src/queue.ts' ? ['ADR-0003-retry-queue'] : [] },
  titles: async () => new Map([['ADR-0003-retry-queue', { title: '使用重试队列隔离下游故障', status: 'active' }]]),
}

describe('search_code ADR hint', () => {
  it('reports no related ADRs when the bundle is absent', async () => {
    const s = makeServices()
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toEqual([])
  })

  it('maps hit files through the anchor index', async () => {
    const s = makeServices(coveredAdr)
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toEqual([
      { adrId: 'ADR-0003-retry-queue', title: '使用重试队列隔离下游故障', status: 'active' },
    ])
  })

  it('accepts both relative and absolute anchor index keys', async () => {
    const s = makeServices({
      ...coveredAdr,
      anchorIndex: { getAdrsForFile: (f: string) => f === path.join(root, 'src/queue.ts') ? ['ADR-0007'] : [] },
      titles: async () => new Map([['ADR-0007', { title: 't', status: 'active' }]]),
    })
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toHaveLength(1)
  })

  it('deduplicates one ADR covering several hits', async () => {
    const s = makeServices(coveredAdr)
    ;(s.milvus.search as jest.Mock).mockResolvedValue([HIT, { ...HIT }])
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toHaveLength(1)
  })

  it('leaves the text byte-identical when nothing is covered', async () => {
    const plain = makeServices()
    const out = await handleSearchCode(async () => plain, silentLogger, { path: root, query: 'q' })
    const { formatSearchResults } = await import('../src/result-format.js')
    expect(appendAdrHints(formatSearchResults(out.results), out.relatedAdrs))
      .toBe(formatSearchResults(out.results))
  })

  it('appends exactly one 相关决策 line when covered', async () => {
    const s = makeServices(coveredAdr)
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    const { formatSearchResults } = await import('../src/result-format.js')
    const text = appendAdrHints(formatSearchResults(out.results), out.relatedAdrs)
    const lines = text.split('\n')
    expect(lines[lines.length - 1]).toBe(
      '相关决策: ADR-0003-retry-queue 使用重试队列隔离下游故障 (active)',
    )
    expect(lines.filter((l) => l.startsWith('相关决策:'))).toHaveLength(1)
    expect(text).toContain('[结果 1]')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/search-code-adr-hint.spec.ts 2>&1 | tail -12`
Expected: FAIL —— `appendAdrHints is not a function` / `out.relatedAdrs` 为 `undefined`

- [ ] **Step 3: 实现**

`packages/codex/src/handlers.ts` 的 `handleSearchCode` 整体替换为：

```ts
export interface RelatedAdr {
  adrId: string
  title: string
  status: string
}

export async function handleSearchCode(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; results: SearchResult[]; relatedAdrs: RelatedAdr[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  await services.milvus.ensureCollection()

  const scope = args.pathPrefix ? path.join(root, args.pathPrefix) : root
  const topK = args.topK ?? 5
  const results = await services.milvus.search(args.query, topK, scope)
  const relatedAdrs = await relatedAdrsFor(services, root, results, logger)
  logger.debug('search_code done', { root, topK, count: results.length, adrs: relatedAdrs.length })
  return { root, source, results, relatedAdrs }
}

/**
 * Codex has no hook for injecting ADR constraints into a conversation, so the
 * reminder rides along with search results — and only for files an ADR actually
 * covers, so ordinary searches stay byte-identical to the pre-ADR output.
 */
async function relatedAdrsFor(
  services: HandlerServices,
  root: string,
  results: SearchResult[],
  logger: Logger,
): Promise<RelatedAdr[]> {
  const adr = services.adr
  if (!adr) return []

  const ids: string[] = []
  for (const hit of results) {
    const relative = path.isAbsolute(hit.filePath) ? path.relative(root, hit.filePath) : hit.filePath
    // Anchor keys are stored relative to the workspace root, but a Milvus index
    // built by another adapter may hold absolute paths; try both.
    for (const key of [relative, hit.filePath]) {
      for (const id of adr.anchorIndex.getAdrsForFile(key)) {
        if (!ids.includes(id)) ids.push(id)
      }
    }
  }
  if (ids.length === 0) return []

  const titles = await adr.titles()
  return ids.map((id) => ({
    adrId: id,
    title: titles.get(id)?.title ?? '',
    status: titles.get(id)?.status ?? 'unknown',
  }))
}
```

`packages/codex/src/result-format.ts` 追加：

```ts
/**
 * Append the ADR reminder. Returns the input untouched when no hit is covered,
 * which is what keeps the default search output stable.
 */
export function appendAdrHints(
  text: string,
  related: Array<{ adrId: string; title: string; status: string }>,
): string {
  if (related.length === 0) return text
  const body = related.map((a) => {
    const title = a.title.length > 60 ? `${a.title.slice(0, 60)}…` : a.title
    return [a.adrId, title, `(${a.status})`].filter(Boolean).join(' ')
  })
  return `${text}\n相关决策: ${body.join(' · ')}`
}
```

`packages/codex/src/server.ts` 的 `search_code` 注册改为把 payload 与文本都带上 ADR：

```ts
    const out = await handleSearchCode(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, results: out.results, relatedAdrs: out.relatedAdrs },
             text: appendAdrHints(formatSearchResults(out.results), out.relatedAdrs) }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/search-code-adr-hint.spec.ts packages/codex/test/handlers.spec.ts 2>&1 | tail -8`
Expected: 两个 suite 全绿（既有的 `handlers.spec.ts` 不传 `adr`，因此走的正是"输出不变"那条路）

- [ ] **Step 5: 全量测试**

Run: `npm test 2>&1 | grep -E "^(Test Suites|Tests)"`
Expected: 全绿，suites = 29，tests = 355 + 6 = `361 passed`

- [ ] **Step 6: Commit**

```bash
git add packages/codex/src packages/codex/test
git commit -m "feat(codex): remind about covering ADRs inside search_code

Codex 没有约束注入钩子，退而求其次：命中被 ADR 覆盖的文件时在末尾追加一行
相关决策。未覆盖时 search_code 输出逐字节不变。"
```

---

### Task 9: 文档、manifest、版本与终检

**Files:**
- Modify: `packages/core/package.json`、`packages/dsh/package.json`、`packages/codex/package.json`
- Modify: `packages/codex/.mcp.json`、`packages/codex/skills/context-milvus/SKILL.md`、`packages/codex/README.md`
- Modify: `README.md`、`README.zh.md`、`CLAUDE.md`
- Test: 无新增代码，验收以命令输出为准

**Interfaces:**
- Consumes: 前 8 个任务的全部产物
- Produces: 与实现一致的文档；版本号 core `0.2.0` / codex `0.2.0` / dsh `0.6.7`

- [ ] **Step 1: 版本号与依赖范围**

```bash
cd /home/bobjia/projects/dsh-context-milvus
sed -i 's/"version": "0.1.0"/"version": "0.2.0"/' packages/core/package.json packages/codex/package.json
sed -i 's/"version": "0.6.6"/"version": "0.6.7"/' packages/dsh/package.json
sed -i 's#"dsh-context-milvus-core": "\^0.1.0"#"dsh-context-milvus-core": "^0.2.0"#' packages/dsh/package.json packages/codex/package.json
grep -n '"version"\|dsh-context-milvus-core":' packages/*/package.json
```

Expected: core `0.2.0`、codex `0.2.0`、dsh `0.6.7`，两个适配器都依赖 `^0.2.0`。

`packages/codex/src/server.ts` 顶部 `export const VERSION = '0.1.0'` 改成 `'0.2.0'`，并同步 `packages/codex/test/mcp-smoke.spec.ts` 里若有版本号断言（当前没有，别新增）。

- [ ] **Step 2: 两份 manifest**

`packages/codex/.mcp.json` 的 `env_vars` 数组追加四项：

```json
      "env_vars": ["MILVUS_ADDRESS", "MILVUS_TOKEN", "MILVUS_COLLECTION", "MILVUS_EMBEDDING_DIM", "EMBEDDING_ENDPOINT", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "CONTEXT_MILVUS_WORKSPACE", "ADR_ENABLED", "ADR_ROOT", "ADR_COLLECTION", "CONTEXT_MILVUS_ADR_WRITE"],
```

`packages/codex/.codex-plugin/plugin.json` 的 `version` 跟 `package.json` 一起变 `0.2.0`，`interface.longDescription` 现在把工具写死成五个（"Provides search_code, index_code, index_status, find_callers and trace_call_chain over MCP."），要改成不数数的说法，否则下次加工具又会过期：

```json
    "longDescription": "Indexes the repository into Milvus with AST-aware chunking, then answers natural-language code queries over MCP: semantic search, incremental indexing, call-graph analysis, and — when ADR_ENABLED is set — the ADR decision-memory tools that explain why the code is the way it is.",
```

Run: `node -e "for (const f of ['packages/codex/.mcp.json','packages/codex/.codex-plugin/plugin.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('VALID')"`
Expected: `VALID`

- [ ] **Step 3: codex README**

`packages/codex/README.md` 三处改动：

工具表从 5 行扩到 13 行（ADR 那 8 行标注需要 `ADR_ENABLED=true`，写类再标 `CONTEXT_MILVUS_ADR_WRITE=true`）。新增行内容：

```markdown
| `search_adr` | 在 ADR 决策记录里做语义搜索，理解代码的"为什么" | `query`(必填)、`status`、`topK`、`pathPrefix`、`path` |
| `search_adr_by_file` | 按代码文件查关联 ADR（code_anchors 确定性关联） | `filePath`(必填)、`status`、`path` |
| `list_adrs` | 列出 ADR，可按状态/变更类型过滤 | `status`、`changeType`、`limit`、`path` |
| `load_constraints` | 加载 active ADR 的约束、隐性约束、被否决反模式 | `format`(`summary`/`full`)、`adrIds`、`path` |
| `create_adr` | 新建 ADR 决策记录 | `title`(必填)、`requirement`、`changeType`、`supersedes`、`content`、`path` |
| `update_adr` | 更新已有 ADR（正文/状态/替代关系） | `adrId`(必填)、`content`、`status`、`supersededBy`、`merge`、`path` |
| `check_adr_consistency` | 检查 code_anchors 是否失效、变更是否未覆盖 | `filePath`、`fix`、`path` |
| `index_specs` | 扫规格文档、生成锚点并索引 | `scanPath`、`dryRun`(默认 true)、`path` |
```

环境变量表补四行，其中 **`SPEC_ROOT` / `PLAN_ROOT` 是这次补的既有缺口**（core 早就支持，`index_specs` 直接依赖）：

```markdown
| `ADR_ENABLED` | 是否注册 8 个 ADR 工具 | `false` |
| `ADR_ROOT` | ADR 目录（相对工作区根） | `docs/decisions` |
| `ADR_COLLECTION` | ADR 向量集合名 | `adr_embeddings` |
| `CONTEXT_MILVUS_ADR_WRITE` | 允许 ADR 写盘工具落盘 | `false` |
| `SPEC_ROOT` | `index_specs` 扫的规格目录 | `docs/superpowers/specs` |
| `PLAN_ROOT` | `index_specs` 扫的计划目录 | `docs/superpowers/plans` |
```

错误码表补两行：`E_ADR_WRITE_DISABLED`（写盘被默认禁用，设 `CONTEXT_MILVUS_ADR_WRITE=true` 后重启）、`E_ADR_NOT_INITIALIZED`（`ADR_ROOT` 指向的目录不存在；server 不会代建）。

同时删掉旧的"Codex 端不提供 ADR 工具"那句，改成"ADR 工具默认不注册，设 `ADR_ENABLED=true` 后出现"，并在已知限制里写明：**Codex 侧没有约束注入**，提醒只随 `search_code` 结果附带一行。

- [ ] **Step 4: SKILL.md**

`packages/codex/skills/context-milvus/SKILL.md` 追加一节（措辞面向自主运行的 agent）：

```markdown
## ADR 决策记忆（需 ADR_ENABLED=true）

- 改代码前，先用 `search_adr_by_file` 看这个文件是否有决策记录覆盖；有则先读约束再动手。
- `search_code` 结果末尾若出现「相关决策:」一行，说明命中的文件被 ADR 覆盖，先 `load_constraints` 再改代码。
- 做出设计决策（新功能/重构/架构变更/新依赖）后，用 `create_adr` 记录原因。
- 改了被 ADR 覆盖的代码后，用 `update_adr` 更新对应记录的 code_anchors。
- 收尾前跑一次 `check_adr_consistency`（默认只报告，不写盘）。

写盘工具（`create_adr` / `update_adr` / `index_specs dryRun=false` / `check_adr_consistency fix=true`）默认被拒。
遇到 `E_ADR_WRITE_DISABLED` 不要重试，直接把需要开的开关名 `CONTEXT_MILVUS_ADR_WRITE=true` 告诉用户。
```

- [ ] **Step 5: 根 README 两份 + CLAUDE.md**

`README.md` 的 `## Codex CLI support` 段里，把"暴露 5 个检索工具"改为"暴露 5 个检索工具（`ADR_ENABLED=true` 时另加 8 个 ADR 决策记忆工具）"；架构图里那行 `no ADR tools in v1 by design` 改为 `8 ADR tools when ADR_ENABLED=true`；`packages/codex` 依赖清单补一句 ADR 引擎已在 core。`README.zh.md` 同位置做同样两处改动（中文：「第一版有意不含 ADR 工具」→「`ADR_ENABLED=true` 时另加 8 个 ADR 工具」），并核对两份文件对应段落逐条对齐。

`CLAUDE.md` 三处必须改，否则文档与实现相反：

1. 架构表里 `packages/codex ... 5 tools` → `5 tools (+8 ADR tools when ADR_ENABLED)`
2. 删掉 "The Codex surface is deliberately 5 tools: no ADR tools, ..." 整句，替换为：ADR 工具在 `ADR_ENABLED=true` 时于启动时注册，写盘工具受 `CONTEXT_MILVUS_ADR_WRITE` 保护
3. ADR 模块清单从 "The DSH adapter" 一节移到 "The core engine" 一节（文件已迁入 `packages/core/src/`），并在 core 目录列表里补上 `adr-*.ts` 七个文件与 `adr-bundle.ts`；同时在 "The Codex adapter" 文件列表里补 `adr-handlers.ts` 与 `adr-gate.ts`

Run: `grep -rn "deliberately 5 tools\|no ADR tools" README.md README.zh.md CLAUDE.md packages/codex/README.md || echo CLEAN`
Expected: `CLEAN`

- [ ] **Step 6: 终检（对照 spec §9 的 9 条验收逐条留证）**

```bash
cd /home/bobjia/projects/dsh-context-milvus
npm_config_cache=.npm-cache npm install --legacy-peer-deps  # 版本号变了，重装以刷新 workspace 链接
npm run build && npm run typecheck && echo BUILD_TYPECHECK_OK
npm test 2>&1 | grep -E "^(Test Suites|Tests)"
git diff --stat HEAD -- packages/dsh/test/public-surface.spec.ts
grep -rn "dsh-context-milvus-core" packages/core/src/ || echo CORE_CLEAN
ADR_ENABLED= node packages/codex/bin/cli.js doctor >/tmp/doctor.out 2>/tmp/doctor.err; echo "doctor stdout bytes: $(wc -c </tmp/doctor.out)"
```

Expected：

1. `BUILD_TYPECHECK_OK`
2. `npm test` 全绿且 tests **明显大于 286**
3. `public-surface.spec.ts` 的 diff 为空（DSH 契约未动）
4. `CORE_CLEAN`（core 源码无包名自引用 → 边界测试也是这么判的）
5. `doctor stdout bytes: 0`（ADR 开不开都不许污染 stdout）

再手工确认写门控的"磁盘无变化"这一条（spec §9 第 4 条）：

```bash
mkdir -p /tmp/wtest && cd /tmp/wtest && git init -q . 2>/dev/null
mkdir -p docs/decisions && printf -- '---\nid: ADR-0001-probe\ntype: adr\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-01\nauthor: t\nsupersedes: null\nsuperseded_by: null\ncode_anchors: []\ntrigger:\n  change_type: architecture\nrelated_decisions: []\nauto_generated: false\n---\n\n# probe\n' > docs/decisions/ADR-0001-probe.md
find . -type f | sort > /tmp/before.txt
node /home/bobjia/projects/dsh-context-milvus/packages/codex/bin/cli.js mcp <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_adr","arguments":{"title":"should-be-blocked","path":"/tmp/wtest"}}}
EOF
find . -type f | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "NO_DISK_CHANGE_OK"
```

Expected: 响应里含 `E_ADR_WRITE_DISABLED`，且 `NO_DISK_CHANGE_OK`（默认关闭时一个文件都不许多出来）。

若本机没有 Milvus，`create_adr` 可能在写门控之后才失败 —— 顺序本身就是证据：错误码必须是 `E_ADR_WRITE_DISABLED` 而不是 `E_MILVUS_UNREACHABLE`，因为门控发生在任何网络调用之前（`handleCreateAdr` 里 `requireExistingAdr` → `assertWritesEnabled` 都在 `reindex()` 之前）。

- [ ] **Step 7: Commit**

```bash
cd /home/bobjia/projects/dsh-context-milvus
git add -A
git commit -m "chore: document and version the Codex ADR tools

core/codex 0.2.0、dsh 0.6.7。CLAUDE.md 里"Codex 刻意只有 5 个工具"的说法
与实现相反，一并纠正；codex README 补上 index_specs 依赖的 SPEC_ROOT/PLAN_ROOT。"
```

---

## 验收对照（spec §9 → 任务）

| spec 验收条 | 由哪个任务保证 | 证据命令 |
|---|---|---|
| 1 tests 全绿且 > 286 | 全部；Task 9 Step 6 | `npm test` |
| 2 build / typecheck 退出 0 | Task 9 Step 6 | `npm run build && npm run typecheck` |
| 3 关→5 个工具，开→13 个 | Task 6 Step 8（5/9）、Task 7 Step 7（13） | `mcp-smoke.spec.ts` |
| 4 四个写工具默认拒写且磁盘无变化 | Task 7 Step 1/2/3 + Task 9 Step 6 | `adr-write-gate.spec.ts` + `diff before after` |
| 5 未启用时 `search_code` 输出逐字节不变 | Task 8 Step 1 | `search-code-adr-hint.spec.ts` |
| 6 core 边界仍绿 | Task 1 Step 4/5 + `core-boundary.spec.ts` | `npm test`（该 spec 未改） |
| 7 `public-surface.spec.ts` 未改即通过 | Task 5 Step 5 + Task 9 Step 6 | `git diff --stat` 为空 |
| 8 ADR 索引期间 stdout 只有 JSON-RPC | Task 4 Step 4（logger 默认静默）+ Task 9 Step 6 | `doctor stdout bytes: 0` |
| 9 两端共用同一份 ADR 状态文件 | Task 2 等式测试 + Task 4 bundle + Task 5 切换 | `adr-path-derivation.spec.ts` |

