# Codex MCP 移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `dsh-context-milvus` 的代码检索内核抽取为共享 core 包，并新增 `codex-context-milvus` 包，以 stdio MCP Server 形式向 OpenAI Codex CLI 提供 5 个检索工具，同时保持现有 DSH 插件行为与发布形态不变。

**Architecture:** 根目录改为私有 npm workspace，拆成 `packages/core`（框架无关：Milvus/Embedding/AST 分块/增量索引/关系分析）、`packages/dsh`（现有 Cordis 插件，包名与 13 个工具不变）、`packages/codex`（新增 MCP 适配器 + CLI 向导 + Codex Plugin 清单）。core 发布为无 scope 公开包 `dsh-context-milvus-core`，两个适配器用 `tsc` 构建，仓库内测试通过 Jest `moduleNameMapper` 直接指向 core 源码。

**Tech Stack:** TypeScript 5.4 (ESM, NodeNext)、Node.js ≥18、Jest 29 + ts-jest (ESM)、`@modelcontextprotocol/sdk`（stdio）、`zod`、`@zilliz/milvus2-sdk-node`、tree-sitter 系列、Codex CLI 0.147+。

## Global Constraints

- 包管理器发布 3 个包：`dsh-context-milvus`（既有名，从 `packages/dsh`）、`codex-context-milvus`（新，从 `packages/codex`）、`dsh-context-milvus-core`（新，无 scope，从 `packages/core`）。
- `packages/core` **禁止** import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`。
- `packages/dsh` 对外契约冻结：包名 `dsh-context-milvus`、`main: dist/plugins/dsh-context-milvus/index.js`、`types: dist/plugins/dsh-context-milvus/index.d.ts`、`Config` 字段、13 个工具名与参数。
- DSH 的 13 个工具名冻结为：`search_code`、`index_code`、`index_status`、`find_callers`、`trace_call_chain`、`search_adr`、`search_adr_by_file`、`create_adr`、`update_adr`、`list_adrs`、`load_constraints`、`check_adr_consistency`、`index_specs`。
- Codex 第一版 MCP 工具固定 5 个：`search_code`、`index_code`、`index_status`、`find_callers`、`trace_call_chain`。
- Codex bin 名：`codex-context-milvus`（CLI）与 `codex-context-milvus-mcp`（MCP）；配置示例使用 `npx -y codex-context-milvus mcp`。
- **MCP stdio 下 stdout 只允许 JSON-RPC**；任何业务日志必须走 stderr。
- 工作区解析顺序恒为：显式 `path` → 从 cwd 向上找 `.git`（目录或文件）→ cwd 本身。
- `init` 向导默认**不写入** `MILVUS_TOKEN` 与 `EMBEDDING_API_KEY`；只写项目级 `.codex/config.toml`。
- 错误必须携带稳定错误码与修复建议，且不得回显任何 token/key 值。
- 所有代码 ESM（`"type": "module"`）、TypeScript `strict: true`、`target: ES2022`、`module/moduleResolution: NodeNext`。
- 每个任务结束必须提交一次 git commit。

## File Structure

```text
dsh-context-milvus/                      # workspace root（private）
  package.json                           # workspaces + 聚合脚本
  tsconfig.base.json
  jest.config.js                         # 单份配置，roots 指向 packages
  scripts/                               # （本计划无新增）
  packages/
    core/
      package.json                       # name: dsh-context-milvus-core
      tsconfig.json
      src/
        index.ts                         # barrel 导出
        logger.ts                        # Logger 接口 + consoleLogger
        config.ts  types.ts  embedding.ts  milvus-service.ts
        chunker.ts  indexer.ts  merkle.ts  ignore-matcher.ts
        import-resolver.ts  code-relations.ts
        query-expansion.ts  reranker.ts  telemetry.ts
        *.d.ts                           # tree-sitter 语言声明
      test/
        dsh-context-remdb.spec.ts  import-resolver.spec.ts
        code-relations.spec.ts  query-expansion.spec.ts
        reranker.spec.ts  telemetry.spec.ts
        core-boundary.spec.ts            # 新增：禁止 DSH/MCP 依赖
    dsh/
      package.json                       # name: dsh-context-milvus（契约冻结）
      tsconfig.json
      cordis-entry.yml  cordis.patch.yml
      client/client.js
      src/
        index.ts  tools.ts
        adr-frontmatter.ts  adr-chunker.ts  adr-anchor-index.ts
        adr-anchor-generator.ts  adr-service.ts  adr-indexer.ts
        adr-tools.ts  constraint-injector.ts
      test/
        adr-*.spec.ts  constraint-injector.spec.ts
    codex/
      package.json                       # name: codex-context-milvus
      tsconfig.json
      bin/
        cli.js                           # 子命令 mcp | init | doctor
        mcp.js                           # 直接启动 MCP
      src/
        server.ts  schemas.ts  handlers.ts
        result-format.ts  workspace-resolver.ts
        workspace-services.ts  context.ts
        init-wizard.ts  doctor.ts
      test/
        workspace-resolver.spec.ts  result-format.spec.ts
        handlers.spec.ts  init-wizard.spec.ts
        mcp-smoke.spec.ts
      .codex-plugin/plugin.json
      .mcp.json
      skills/context-milvus/SKILL.md
```

---

### Task 1: Workspace 骨架与 DSH 包搬迁

**Files:**
- Create: `package.json`（根，替换现有内容）
- Create: `tsconfig.base.json`
- Create: `packages/dsh/package.json`
- Create: `packages/dsh/tsconfig.json`
- Move: `src/` → `packages/dsh/src/`
- Move: `test/` → `packages/dsh/test/`
- Move: `client/` → `packages/dsh/client/`
- Move: `cordis-entry.yml`、`cordis.patch.yml` → `packages/dsh/`
- Modify: `jest.config.js`

**Interfaces:**
- Consumes: 无
- Produces: workspace 根脚本 `npm test` / `npm run build`；DSH 包仍为 `dsh-context-milvus`，`main` 不变。

- [ ] **Step 1: 用 git mv 搬迁文件，保留历史**

```bash
mkdir -p packages/dsh
git mv src packages/dsh/src
git mv test packages/dsh/test
git mv client packages/dsh/client
git mv cordis-entry.yml packages/dsh/cordis-entry.yml
git mv cordis.patch.yml packages/dsh/cordis.patch.yml
git mv tsconfig.json packages/dsh/tsconfig.json
git mv package.json packages/dsh/package.json
ls packages/dsh
```

- [ ] **Step 2: 写 `packages/dsh/package.json` 的 workspace 适配**

在 `packages/dsh/package.json` 中删除 `scripts.prepare`（保留 `build: tsc`），其余字段保持原值不动。确认仍有：

```json
{
  "name": "dsh-context-milvus",
  "main": "dist/plugins/dsh-context-milvus/index.js",
  "types": "dist/plugins/dsh-context-milvus/index.d.ts"
}
```

- [ ] **Step 3: 写根 `package.json`**

```json
{
  "name": "dsh-context-milvus-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/.bin/jest",
    "build": "npm run build -w dsh-context-milvus",
    "typecheck": "tsc -p packages/dsh/tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.11.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 4: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "useUnknownInCatchVariables": false
  }
}
```

- [ ] **Step 5: 改写 `packages/dsh/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 6: 写根 `jest.config.js`**

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/test/**/*.spec.ts'],
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
  moduleNameMapper: {
    '^dsh-context-milvus-core$': '<rootDir>/packages/core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/tsconfig.base.json' },
    ],
  },
}
```

- [ ] **Step 7: 修正测试内相对导入路径**

测试从 `test/` 引用源码的路径去掉多出的一层：

```bash
sed -i "s#\.\./src/plugins/dsh-context-milvus/#../src/#g" packages/dsh/test/*.spec.ts
grep -rn "\.\./src/" packages/dsh/test | head
```

- [ ] **Step 8: 安装依赖并跑测试**

```bash
npm install
npm test
```

Expected: 15 个 spec 全部 PASS（`moduleNameMapper` 里 core 映射在本任务还未生效，但此时测试尚未引用 core，不影响）。

- [ ] **Step 9: 类型检查**

```bash
npx tsc -p packages/dsh/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "refactor: convert repo to npm workspaces and relocate dsh package"
```

---

### Task 2: 创建 core 包并迁移框架无关模块

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Move 以下文件 `packages/dsh/src/plugins/dsh-context-milvus/` → `packages/core/src/`：
  `config.ts`、`types.ts`、`embedding.ts`、`milvus-service.ts`、`chunker.ts`、`indexer.ts`、`merkle.ts`、`ignore-matcher.ts`、`import-resolver.ts`、`code-relations.ts`、`query-expansion.ts`、`reranker.ts`、`telemetry.ts`、`tree-sitter-c-sharp.d.ts`
- Move 对应测试到 `packages/core/test/`：`dsh-context-remdb.spec.ts`、`import-resolver.spec.ts`、`code-relations.spec.ts`、`query-expansion.spec.ts`、`reranker.spec.ts`、`telemetry.spec.ts`
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/*.ts`（导入改包名）

**Interfaces:**
- Consumes: Task 1 的 workspace 与 jest 配置
- Produces: 包名 `dsh-context-milvus-core`，barrel `packages/core/src/index.ts` 导出 `getConfig`、`deriveMerkleFilePath`、`deriveImportMapFilePath`、`HashTracker`、`MilvusService`、`EmbeddingClient`、`ImportResolver`、`runIndex`、`getIndexStatus`、`findCallers`、`traceChain`、`chunkCode`、`createTelemetry`、`sanitizeQuery`、`DEFAULT_EXTENSIONS`、`DEFAULT_IGNORE_DIRS`、`DEFAULT_IGNORE_PATTERNS` 及全部类型。

- [ ] **Step 1: 新建 core 目录并移动文件**

```bash
mkdir -p packages/core/src packages/core/test
cd packages/dsh/src/plugins/dsh-context-milvus
git mv config.ts types.ts embedding.ts milvus-service.ts chunker.ts indexer.ts \
       merkle.ts ignore-matcher.ts import-resolver.ts code-relations.ts \
       query-expansion.ts reranker.ts telemetry.ts tree-sitter-c-sharp.d.ts \
       ../../../../packages/core/src/
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git mv packages/dsh/test/dsh-context-remdb.spec.ts packages/core/test/
git mv packages/dsh/test/import-resolver.spec.ts packages/core/test/
git mv packages/dsh/test/code-relations.spec.ts packages/core/test/
git mv packages/dsh/test/query-expansion.spec.ts packages/core/test/
git mv packages/dsh/test/reranker.spec.ts packages/core/test/
git mv packages/dsh/test/telemetry.spec.ts packages/core/test/
ls packages/core/src packages/core/test
```

- [ ] **Step 2: 写 `packages/core/package.json`**

`dependencies` 从原 DSH 包复制运行期依赖，去掉 `@deepseek-ai/*`：

```json
{
  "name": "dsh-context-milvus-core",
  "version": "0.1.0",
  "description": "Framework-agnostic core for dsh-context-milvus and codex-context-milvus",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "license": "MIT",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@zilliz/milvus2-sdk-node": "^3.0.4",
    "ignore": "^7.0.6",
    "js-yaml": "^5.4.1",
    "tree-sitter": "^0.25.1",
    "tree-sitter-c-sharp": "^0.23.5",
    "tree-sitter-cpp": "^0.23.4",
    "tree-sitter-go": "^0.25.0",
    "tree-sitter-java": "^0.23.5",
    "tree-sitter-python": "^0.25.0",
    "tree-sitter-rust": "^0.24.0",
    "tree-sitter-scala": "^0.24.0",
    "tree-sitter-typescript": "^0.23.2"
  }
}
```

- [ ] **Step 3: 写 `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: 写 `packages/core/src/index.ts`**

```ts
export * from './types.js'
export { getConfig, deriveMerkleFilePath, deriveImportMapFilePath,
         DEFAULT_EXTENSIONS, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PATTERNS } from './config.js'
export type { CordisConfig, PluginConfig } from './config.js'
export { EmbeddingClient } from './embedding.js'
export { MilvusService } from './milvus-service.js'
export type { SearchMeta } from './milvus-service.js'
export { HashTracker } from './merkle.js'
export type { IndexDelta } from './merkle.js'
export { IgnoreMatcher } from './ignore-matcher.js'
export { ImportResolver } from './import-resolver.js'
export { runIndex, getIndexStatus } from './indexer.js'
export type { IndexResult } from './indexer.js'
export { findCallers, traceChain, isNoiseSymbol, DEFAULT_STOP_WORDS } from './code-relations.js'
export type { RelationChunk, CallersResult, ChainNode, TraceResult,
              FindCallersOptions, TraceOptions, FindBySymbol } from './code-relations.js'
export { chunkCode } from './chunker.js'
export { expandQuery } from './query-expansion.js'
export { rerankResults } from './reranker.js'
export type { RerankConfig } from './reranker.js'
export { createTelemetry, sanitizeQuery } from './telemetry.js'
```

- [ ] **Step 5: 把 DSH 源码里的 core 导入改为包名**

```bash
cd packages/dsh/src/plugins/dsh-context-milvus
sed -i -E "s#'\./(config|types|embedding|milvus-service|chunker|indexer|merkle|ignore-matcher|import-resolver|code-relations|query-expansion|reranker|telemetry)\.js'#'dsh-context-milvus-core'#g" *.ts
grep -n "dsh-context-milvus-core" *.ts | head -40
```

Expected: `adr-*.ts`、`constraint-injector.ts`、`tools.ts`、`index.ts` 中对 core 模块的引用全部变成 `'dsh-context-milvus-core'`；`./adr-*.js` 的相对引用保持不变。

- [ ] **Step 6: 把 core 测试的导入指向 core 源码**

```bash
sed -i "s#'../src/plugins/dsh-context-milvus/#'../src/#g" packages/core/test/*.spec.ts
grep -rn "dsh-context-milvus/" packages/core/test | head
```

Expected: 无输出（全部替换完成）。

- [ ] **Step 7: 把 dsh 测试里引用的 core 模块改为包名**

```bash
cd packages/dsh/test
sed -i -E "s#'\.\./src/(config|types|embedding|milvus-service|chunker|indexer|merkle|ignore-matcher|import-resolver|code-relations|query-expansion|reranker|telemetry)\.js'#'dsh-context-milvus-core'#g" *.spec.ts
grep -rn "dsh-context-milvus-core" *.spec.ts | head -20
```

- [ ] **Step 8: 在 `packages/dsh/package.json` 增加 core 依赖**

在 `dependencies` 加 `"dsh-context-milvus-core": "^0.1.0"`。

- [ ] **Step 8b: 把 core 纳入根构建脚本**

根 `package.json` 改为：

```json
"build": "npm run build -w dsh-context-milvus-core && npm run build -w dsh-context-milvus",
"typecheck": "tsc -p packages/core/tsconfig.json --noEmit && tsc -p packages/dsh/tsconfig.json --noEmit"
```

- [ ] **Step 9: 跑测试验证拆分无损**

```bash
npm install
npm test
```

Expected: 全部 spec PASS。core 的 6 个 spec 与 dsh 的 9 个 spec 都通过。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "refactor: extract framework-agnostic core package"
```

---

### Task 3: core 边界守护与 Logger 抽象

**Files:**
- Create: `packages/core/src/logger.ts`
- Create: `packages/core/test/core-boundary.spec.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/indexer.ts`（progress 日志走注入 Logger）
- Modify: `packages/core/src/milvus-service.ts`（`console.log/warn` 改注入 Logger）

**Interfaces:**
- Consumes: Task 2 的 core barrel
- Produces: `Logger` 接口、`consoleLogger`、`silentLogger`；`runIndex` 与 `MilvusService` 接受可选 `logger`。

- [ ] **Step 1: 写失败测试 `packages/core/test/core-boundary.spec.ts`**

```ts
import { jest } from '@jest/globals'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')
const FORBIDDEN = [/@deepseek-ai\//, /@modelcontextprotocol\//, /from 'zod'/, /from "zod"/]

describe('core boundary', () => {
  it('does not import DSH, MCP or zod', () => {
    const offenders: string[] = []
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith('.ts')) continue
      const text = readFileSync(path.join(SRC, file), 'utf-8')
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not call console.log directly', () => {
    const offenders: string[] = []
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith('.ts') || file === 'logger.ts') continue
      const text = readFileSync(path.join(SRC, file), 'utf-8')
      if (/console\.(log|warn|info)\(/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/core/test/core-boundary.spec.ts`
Expected: FAIL —— 报告 `indexer.ts` / `milvus-service.ts` / 其它文件命中 `console.*`。

- [ ] **Step 3: 写 `packages/core/src/logger.ts`**

```ts
/** Minimal logging port so adapters can redirect output (DSH: console, Codex MCP: stderr). */
export interface Logger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

function write(stream: 'log' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
  console[stream](`[dsh-context-milvus-core] ${msg}${suffix}`)
}

/** Default logger used by the DSH adapter and tests. */
export const consoleLogger: Logger = {
  debug: (m, meta) => write('log', m, meta),
  info: (m, meta) => write('log', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
}

/** No-op logger for tests that assert on other behavior. */
export const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}
```

- [ ] **Step 4: 让 `MilvusService` 接受 logger**

在构造参数字段与类字段中加入 `logger?: Logger`，默认 `consoleLogger`：

```ts
import { consoleLogger, type Logger } from './logger.js'
// constructor 参数追加：logger?: Logger
private readonly logger: Logger
// 构造函数体内：this.logger = config.logger ?? consoleLogger
```

把 `milvus-service.ts` 中所有 `console.log(...)` / `console.warn(...)` 替换为 `this.logger.info(...)` / `this.logger.warn(...)`（文案不变，去掉 `[dsh-context-milvus]` 前缀，前缀由 logger 统一输出）。

- [ ] **Step 5: 让 `runIndex` 接受 logger**

`runIndex` 的 `options` 追加 `logger?: Logger`，在函数内 `const log = options?.logger ?? consoleLogger`；把 `progress` 默认实现改为 `(msg) => log.info(msg)`，并保证外部传入 `progress` 时优先使用外部实现。

对 core 内其余仍使用 `console.*` 的文件重复同样的替换（以 Step 2 的失败报告为准逐个处理，`logger.ts` 除外）。

- [ ] **Step 6: 更新 core barrel**

在 `packages/core/src/index.ts` 追加：

```ts
export type { Logger } from './logger.js'
export { consoleLogger, silentLogger } from './logger.js'
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test`
Expected: PASS，`core-boundary.spec.ts` 两个用例通过，既有 spec 无回归。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(core): add logger port and enforce core boundary"
```

---

### Task 4: DSH 对外契约冻结测试

**Files:**
- Create: `packages/dsh/test/public-surface.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `packages/dsh/src/plugins/dsh-context-milvus/{tools,adr-tools,index}.ts`
- Produces: 防止后续重构改动 DSH 工具名与配置字段的守护测试。

- [ ] **Step 1: 写测试**

```ts
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src/plugins/dsh-context-milvus')

const EXPECTED_TOOLS = [
  'search_code', 'index_code', 'index_status', 'find_callers', 'trace_call_chain',
  'search_adr', 'search_adr_by_file', 'create_adr', 'update_adr', 'list_adrs',
  'load_constraints', 'check_adr_consistency', 'index_specs',
].sort()

function toolNames(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf-8')
  return [...text.matchAll(/name:\s*'([a-z_]+)'/g)].map(m => m[1])
}

const EXPECTED_CONFIG_KEYS = [
  'milvusAddress', 'milvusToken', 'milvusCollection', 'milvusDim',
  'embeddingEndpoint', 'embeddingApiKey', 'embeddingModel', 'indexRoot',
  'indexExtensions', 'hybridMode', 'bm25RrfK', 'chunkContextLines',
  'queryExpansion', 'rerankEnabled', 'rerankMultiplier', 'indexIgnoreDirs',
  'merkleFilePath', 'ignorePatterns', 'adrEnabled', 'adrRoot', 'adrCollection',
  'adrConstraintReinjectEvery', 'adrSystemPrompt', 'specRoot', 'planRoot',
  'telemetryEnabled', 'telemetryFile',
].sort()

describe('dsh public surface', () => {
  it('keeps all 13 tool names', () => {
    const names = [...toolNames('tools.ts'), ...toolNames('adr-tools.ts')]
    expect([...new Set(names)].sort()).toEqual(EXPECTED_TOOLS)
  })

  it('keeps all config keys', () => {
    const text = readFileSync(path.join(SRC, 'index.ts'), 'utf-8')
    const keys = [...text.matchAll(/^\s{2}([a-zA-Z]+):\s*z\./gm)].map(m => m[1])
    expect([...new Set(keys)].sort()).toEqual(EXPECTED_CONFIG_KEYS)
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `npx jest packages/dsh/test/public-surface.spec.ts`
Expected: 若字段正则未匹配齐，FAIL 并列出差异；据实际 `Config` 字段补正则改 `EXPECTED_CONFIG_KEYS`（**只允许修正常量，不允许改源码**）。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "test(dsh): freeze public tool and config surface"
```

---

### Task 5: Codex 包骨架与工作区解析器

**Files:**
- Create: `packages/codex/package.json`
- Create: `packages/codex/tsconfig.json`
- Create: `packages/codex/src/workspace-resolver.ts`
- Create: `packages/codex/test/workspace-resolver.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type WorkspaceSource = 'explicit' | 'git' | 'cwd'`
  - `interface WorkspaceResolution { root: string; source: WorkspaceSource }`
  - `class WorkspaceError extends Error { readonly code: 'E_WORKSPACE_NOT_FOUND' }`
  - `function resolveWorkspaceRoot(explicitPath?: string, cwd?: string): WorkspaceResolution`

- [ ] **Step 1: 写失败测试 `packages/codex/test/workspace-resolver.spec.ts`**

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveWorkspaceRoot, WorkspaceError } from '../src/workspace-resolver.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ctx-ws-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('resolveWorkspaceRoot', () => {
  it('prefers an explicit path', async () => {
    const target = path.join(root, 'proj')
    await mkdir(path.join(target, '.git'), { recursive: true })
    const result = resolveWorkspaceRoot(target, root)
    expect(result).toEqual({ root: target, source: 'explicit' })
  })

  it('throws E_WORKSPACE_NOT_FOUND for a missing explicit path', () => {
    expect(() => resolveWorkspaceRoot(path.join(root, 'nope'), root))
      .toThrow(WorkspaceError)
  })

  it('walks up to the nearest .git directory', async () => {
    const repo = path.join(root, 'repo')
    const nested = path.join(repo, 'a', 'b')
    await mkdir(path.join(repo, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(resolveWorkspaceRoot(undefined, nested)).toEqual({ root: repo, source: 'git' })
  })

  it('treats a .git file (worktree) as a repository marker', async () => {
    const repo = path.join(root, 'wt')
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, '.git'), 'gitdir: /elsewhere\n', 'utf-8')
    expect(resolveWorkspaceRoot(undefined, repo)).toEqual({ root: repo, source: 'git' })
  })

  it('falls back to cwd when no .git exists', async () => {
    const plain = path.join(root, 'plain')
    await mkdir(plain, { recursive: true })
    expect(resolveWorkspaceRoot(undefined, plain)).toEqual({ root: plain, source: 'cwd' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/workspace-resolver.spec.ts`
Expected: FAIL —— `Cannot find module '../src/workspace-resolver.js'`。

- [ ] **Step 3: 写 `packages/codex/package.json`**

```json
{
  "name": "codex-context-milvus",
  "version": "0.1.0",
  "description": "Semantic code search for OpenAI Codex via Milvus (MCP server)",
  "type": "module",
  "bin": {
    "codex-context-milvus": "bin/cli.js",
    "codex-context-milvus-mcp": "bin/mcp.js"
  },
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "files": ["dist", "bin", ".codex-plugin", ".mcp.json", "skills", "README.md"],
  "license": "MIT",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.20.0",
    "zod": "^3.25.0",
    "dsh-context-milvus-core": "^0.1.0"
  }
}
```

- [ ] **Step 4: 写 `packages/codex/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4b: 把 codex 纳入根构建脚本**

根 `package.json` 改为：

```json
"build": "npm run build -w dsh-context-milvus-core && npm run build -w dsh-context-milvus && npm run build -w codex-context-milvus",
"typecheck": "tsc -p packages/core/tsconfig.json --noEmit && tsc -p packages/dsh/tsconfig.json --noEmit && tsc -p packages/codex/tsconfig.json --noEmit"
```

- [ ] **Step 5: 写实现 `packages/codex/src/workspace-resolver.ts`**

```ts
import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'

export type WorkspaceSource = 'explicit' | 'git' | 'cwd'

export interface WorkspaceResolution {
  root: string
  source: WorkspaceSource
}

export class WorkspaceError extends Error {
  readonly code = 'E_WORKSPACE_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/**
 * Resolve the workspace root.
 * Order: explicit path -> nearest ancestor containing .git -> cwd.
 */
export function resolveWorkspaceRoot(
  explicitPath?: string,
  cwd: string = process.cwd(),
): WorkspaceResolution {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new WorkspaceError(`工作区路径不存在或不是目录: ${resolved}`)
    }
    return { root: resolved, source: 'explicit' }
  }

  let dir = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      return { root: dir, source: 'git' }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { root: path.resolve(cwd), source: 'cwd' }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx jest packages/codex/test/workspace-resolver.spec.ts`
Expected: 5 个用例全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(codex): add workspace resolver"
```

---

### Task 6: Workspace 服务缓存与 RuntimeContext

**Files:**
- Create: `packages/codex/src/context.ts`
- Create: `packages/codex/src/workspace-services.ts`
- Create: `packages/codex/test/workspace-services.spec.ts`

**Interfaces:**
- Consumes: Task 2 core barrel、Task 5 resolver
- Produces:
  - `interface RuntimeContext { workspaceRoot: string; logger: Logger }`
  - `interface WorkspaceServices { root; config: PluginConfig; milvus: MilvusService; tracker: HashTracker; importResolver: ImportResolver }`
  - `class WorkspaceServiceCache { constructor(logger: Logger); get(root: string): Promise<WorkspaceServices>; size(): number }`
  - `function createStderrLogger(prefix?: string): Logger`

- [ ] **Step 1: 写失败测试 `packages/codex/test/workspace-services.spec.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { WorkspaceServiceCache } from '../src/workspace-services.js'
import { silentLogger } from 'dsh-context-milvus-core'

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-svc-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WorkspaceServiceCache', () => {
  it('creates and caches services per workspace root', async () => {
    const cache = new WorkspaceServiceCache(silentLogger)
    const first = await cache.get(root)
    const second = await cache.get(root)
    expect(second).toBe(first)
    expect(first.root).toBe(root)
    expect(first.config.indexRoot).toBe(root)
    expect(cache.size()).toBe(1)
  })

  it('isolates state files per root', async () => {
    const cache = new WorkspaceServiceCache(silentLogger)
    const other = await mkdtemp(path.join(tmpdir(), 'ctx-svc2-'))
    try {
      const a = await cache.get(root)
      const b = await cache.get(other)
      expect(a.config.merkleFilePath).not.toBe(b.config.merkleFilePath)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/workspace-services.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `packages/codex/src/context.ts`**

```ts
import type { Logger } from 'dsh-context-milvus-core'

export interface RuntimeContext {
  workspaceRoot: string
  logger: Logger
}

function emit(stream: 'log' | 'warn' | 'error', prefix: string, msg: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
  console[stream](`${prefix} ${msg}${suffix}`)
}

/**
 * MCP stdio uses stdout for JSON-RPC, so ALL logs must go to stderr.
 * `console.error` writes to stderr; `console.warn` also writes to stderr in Node,
 * but we route everything through error for a single guaranteed sink.
 */
export function createStderrLogger(prefix = '[codex-context-milvus]'): Logger {
  return {
    debug: (m, meta) => emit('error', prefix, m, meta),
    info: (m, meta) => emit('error', prefix, m, meta),
    warn: (m, meta) => emit('error', prefix, m, meta),
    error: (m, meta) => emit('error', prefix, m, meta),
  }
}
```

- [ ] **Step 4: 写 `packages/codex/src/workspace-services.ts`**

```ts
import {
  getConfig, deriveMerkleFilePath, deriveImportMapFilePath,
  EmbeddingClient, MilvusService, HashTracker, ImportResolver,
  type Logger, type PluginConfig,
} from 'dsh-context-milvus-core'

export interface WorkspaceServices {
  root: string
  config: PluginConfig
  milvus: MilvusService
  tracker: HashTracker
  importResolver: ImportResolver
}

export class WorkspaceServiceCache {
  private readonly cache = new Map<string, WorkspaceServices>()

  constructor(private readonly logger: Logger) {}

  async get(root: string): Promise<WorkspaceServices> {
    const existing = this.cache.get(root)
    if (existing) return existing

    const config = getConfig({
      indexRoot: root,
      merkleFilePath: deriveMerkleFilePath(root),
    })
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
      logger: this.logger,
    })

    const tracker = new HashTracker(config.merkleFilePath)
    await tracker.load().catch(() => {})
    const importResolver = new ImportResolver(deriveImportMapFilePath(root))
    await importResolver.load().catch(() => {})

    const services: WorkspaceServices = { root, config, milvus, tracker, importResolver }
    this.cache.set(root, services)
    this.logger.debug('workspace services ready', { root })
    return services
  }

  size(): number {
    return this.cache.size
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx jest packages/codex/test/workspace-services.spec.ts`
Expected: 2 个用例 PASS。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(codex): add workspace service cache and stderr logger"
```

---

### Task 7: 结果格式化与统一工具返回

**Files:**
- Create: `packages/codex/src/result-format.ts`
- Create: `packages/codex/test/result-format.spec.ts`

**Interfaces:**
- Consumes: core 的 `SearchResult`、`IndexResult`、`IndexStatus`、`CallersResult`、`TraceResult`
- Produces:
  - `interface ToolTextResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }`
  - `interface ToolStructuredResult<T> { content: ToolTextResult['content']; structuredContent: T; isError: false }`
  - `type ToolResult<T> = ToolStructuredResult<T> | (ToolTextResult & { isError: true })`
  - `function formatSearchResults(results: SearchResult[]): string`
  - `function formatIndexResult(r: IndexResult): string`
  - `function formatStatus(s: IndexStatus): string`
  - `function formatCallers(r: CallersResult): string`
  - `function formatChain(r: TraceResult): string`
  - `type ErrorCode = 'E_WORKSPACE_NOT_FOUND' | 'E_MILVUS_UNREACHABLE' | 'E_COLLECTION_INIT' | 'E_EMBEDDING_FAILED' | 'E_EMBEDDING_DIM_MISMATCH' | 'E_INDEX_ROOT_UNREADABLE' | 'E_IMPORT_MAP_MISSING' | 'E_INTERNAL'`
  - `function errorResult(code: ErrorCode, message: string, hint: string): ToolResult<never>`
  - `function okResult<T>(data: T, text: string): ToolResult<T>`

- [ ] **Step 1: 写失败测试 `packages/codex/test/result-format.spec.ts`**

```ts
import {
  formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain, errorResult, okResult,
} from '../src/result-format.js'
import type { SearchResult } from 'dsh-context-milvus-core'

const sample: SearchResult = {
  filePath: '/repo/src/config.ts', content: 'export const A = 1',
  score: 0.8731, language: 'typescript',
  startLine: 12, endLine: 40, name: 'parseConfig', chunkType: 'function_declaration',
}

describe('formatSearchResults', () => {
  it('renders path, line range, name and score', () => {
    const text = formatSearchResults([sample])
    expect(text).toContain('/repo/src/config.ts')
    expect(text).toContain('12-40')
    expect(text).toContain('parseConfig')
    expect(text).toMatch(/0\.87/)
  })

  it('handles empty results', () => {
    expect(formatSearchResults([])).toContain('未找到')
  })
})

describe('tool result envelope', () => {
  it('wraps data in content + structuredContent', () => {
    const result = okResult({ totalFiles: 3 }, 'files: 3')
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'files: 3' })
    expect((result as any).structuredContent).toEqual({ totalFiles: 3 })
  })

  it('renders errors with code and hint only', () => {
    const result = errorResult('E_MILVUS_UNREACHABLE', '无法连接 Milvus', '请启动 Milvus 或修改 MILVUS_ADDRESS')
    expect(result.isError).toBe(true)
    expect((result as any).structuredContent).toBeUndefined()
    expect(result.content[0].text).toContain('E_MILVUS_UNREACHABLE')
    expect(result.content[0].text).toContain('请启动 Milvus')
  })
})

describe('other formatters', () => {
  it('formats index result numbers', () => {
    const text = formatIndexResult({
      filesIndexed: 2, chunksIndexed: 5, filesRemoved: 1,
      chunksRemoved: 3, filesSkipped: 9, durationMs: 1200,
    })
    expect(text).toContain('索引完成')
    expect(text).toContain('2')
  })

  it('formats status', () => {
    expect(formatStatus({ totalFiles: 4, totalChunks: 8, indexedExtensions: ['.ts'] }))
      .toContain('从未索引')
  })

  it('formats callers with warning', () => {
    const text = formatCallers({ chunks: [], warning: 'import map 未加载' })
    expect(text).toContain('import map 未加载')
  })

  it('formats an empty chain', () => {
    expect(formatChain({ chain: [] })).toContain('未找到调用链')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/result-format.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现 `packages/codex/src/result-format.ts`**

```ts
import type {
  SearchResult, IndexResult, IndexStatus, CallersResult, TraceResult,
} from 'dsh-context-milvus-core'

export type ErrorCode =
  | 'E_WORKSPACE_NOT_FOUND' | 'E_MILVUS_UNREACHABLE' | 'E_COLLECTION_INIT'
  | 'E_EMBEDDING_FAILED' | 'E_EMBEDDING_DIM_MISMATCH' | 'E_INDEX_ROOT_UNREADABLE'
  | 'E_IMPORT_MAP_MISSING' | 'E_INTERNAL'

export interface TextContent { type: 'text'; text: string }

export interface ToolStructuredResult<T> {
  content: TextContent[]
  structuredContent: T
  isError: false
}

export interface ToolErrorResult {
  content: TextContent[]
  isError: true
}

export type ToolResult<T> = ToolStructuredResult<T> | ToolErrorResult

export function okResult<T>(data: T, text: string): ToolResult<T> {
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false }
}

export function errorResult(code: ErrorCode, message: string, hint: string): ToolErrorResult {
  return {
    content: [{ type: 'text', text: `错误 [${code}]: ${message}\n建议：${hint}` }],
    isError: true,
  }
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到匹配的代码片段。'
  return results.map((item, i) => {
    const lang = item.language ? ` (${item.language})` : ''
    const name = item.name ? `「${item.name}」` : ''
    return [
      `[结果 ${i + 1}] 文件: ${item.filePath}${lang}, 第 ${item.startLine}-${item.endLine} 行 ${name}`,
      `相关度: ${item.score.toFixed(4)}`,
      `类型: ${item.chunkType || '未知'}`,
      '内容:',
      '```' + (item.language || ''),
      item.content,
      '```',
    ].join('\n')
  }).join('\n---\n')
}

export function formatIndexResult(result: IndexResult): string {
  return [
    `索引完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
    `  - 新增/修改: ${result.filesIndexed} 个文件, ${result.chunksIndexed} 个代码块`,
    `  - 已删除: ${result.filesRemoved} 个文件, ${result.chunksRemoved} 个代码块`,
    `  - 未变更跳过: ${result.filesSkipped} 个文件`,
  ].join('\n')
}

export function formatStatus(status: IndexStatus): string {
  return [
    '📊 索引状态',
    `  已索引文件: ${status.totalFiles}`,
    `  代码块总数: ${status.totalChunks}`,
    `  最后索引: ${status.lastIndexed || '从未索引'}`,
    `  支持的文件类型: ${status.indexedExtensions.join(', ')}`,
  ].join('\n')
}

export function formatCallers(result: CallersResult): string {
  if (result.chunks.length === 0) {
    return result.warning ? `未找到引用该符号的代码。${result.warning}` : '未找到引用该符号的代码。'
  }
  const header = result.warning
    ? `找到 ${result.chunks.length} 个引用位置：${result.warning}\n\n`
    : `找到 ${result.chunks.length} 个引用位置：\n\n`
  return header + result.chunks.map((c, i) => {
    const res = c.resolution?.status ? ` (${c.resolution.status})` : ''
    const body = c.content.length > 200 ? c.content.slice(0, 200) + '...' : c.content
    return [`[${i + 1}] ${c.filePath}:${c.startLine}-${c.endLine}${res}`,
            `    ${c.chunkType}「${c.name}」`, body].join('\n')
  }).join('\n---\n')
}

export function formatChain(result: TraceResult): string {
  if (result.chain.length === 0) return '未找到调用链。'
  const lines = result.chain.map((n) => {
    const indent = '  '.repeat(n.depth)
    const callers = n.callers.length > 0 ? `\n${indent}  └─ 调用者: ${n.callers.join(', ')}` : ''
    return `${indent}${n.symbol} (${n.filePath}:${n.startLine}-${n.endLine})${callers}`
  })
  return `调用链 (${result.chain.length} 层):\n\n${lines.join('\n')}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest packages/codex/test/result-format.spec.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(codex): add unified tool result formatting"
```

---

### Task 8: search / index / status handlers

**Files:**
- Create: `packages/codex/src/handlers.ts`
- Create: `packages/codex/test/handlers.spec.ts`

**Interfaces:**
- Consumes: core 的 `runIndex`、`getIndexStatus`、`SearchResult`、`PluginConfig`、`HashTracker`、`ImportResolver`、`IndexResult`
- Produces:
  - `interface MilvusPort { ensureCollection(): Promise<void>; search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]> }`
  - `interface HandlerServices { root: string; config: PluginConfig; milvus: MilvusPort; tracker: HashTracker; importResolver: ImportResolver }`
  - `type ServiceProvider = (root: string) => Promise<HandlerServices>`
  - `interface SearchCodeArgs { query: string; topK?: number; path?: string; pathPrefix?: string }`
  - `interface IndexCodeArgs { mode?: 'full' | 'incremental'; path?: string }`
  - `interface IndexStatusArgs { path?: string }`
  - `function handleSearchCode(provider, logger, args): Promise<{ root: string; source: WorkspaceSource; results: SearchResult[] }>`
  - `function handleIndexCode(provider, logger, args): Promise<{ root: string; source: WorkspaceSource; result: IndexResult }>`
  - `function handleIndexStatus(provider, logger, args): Promise<{ root: string; source: WorkspaceSource; status: IndexStatus }>`

- [ ] **Step 1: 写失败测试 `packages/codex/test/handlers.spec.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { silentLogger } from 'dsh-context-milvus-core'
import { handleSearchCode, handleIndexCode, handleIndexStatus } from '../src/handlers.js'
import type { HandlerServices } from '../src/handlers.js'

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-h-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function makeServices(): HandlerServices {
  return {
    root,
    config: { indexRoot: root, indexExtensions: ['.ts'] } as any,
    milvus: {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(async () => ([{
        filePath: path.join(root, 'a.ts'), content: 'code', score: 0.5,
        language: 'typescript', startLine: 1, endLine: 2, name: 'a', chunkType: 'function',
      }])),
    } as any,
    tracker: { getStats: () => ({ totalFiles: 1, totalChunks: 1 }),
               getLastIndexedTimestamp: () => Date.now(),
               load: async () => true, save: async () => {} } as any,
    importResolver: {} as any,
  }
}

describe('handleSearchCode', () => {
  it('scopes the search to the workspace root by default', async () => {
    const services = makeServices()
    const out = await handleSearchCode(async () => services, silentLogger, { query: 'auth' })
    expect(services.milvus.search).toHaveBeenCalledWith('auth', 5, root)
    expect(out.root).toBe(root)
    expect(out.results).toHaveLength(1)
  })

  it('joins pathPrefix onto the workspace root', async () => {
    const services = makeServices()
    await handleSearchCode(async () => services, silentLogger,
      { query: 'auth', topK: 3, pathPrefix: 'src/api' })
    expect(services.milvus.search).toHaveBeenCalledWith('auth', 3, path.join(root, 'src/api'))
  })
})

describe('handleIndexStatus', () => {
  it('returns tracker stats', async () => {
    const services = makeServices()
    const out = await handleIndexStatus(async () => services, silentLogger, {})
    expect(out.status.totalFiles).toBe(1)
    expect(out.root).toBe(root)
  })
})

describe('handleIndexCode', () => {
  it('runs an incremental index by default', async () => {
    const services = makeServices()
    const out = await handleIndexCode(async () => services, silentLogger, {})
    expect(out.result.filesSkipped).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/handlers.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现 `packages/codex/src/handlers.ts`**

```ts
import * as path from 'node:path'
import {
  runIndex, getIndexStatus,
  type SearchResult, type PluginConfig, type HashTracker, type ImportResolver,
  type IndexResult, type IndexStatus, type Logger,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'

export interface MilvusPort {
  ensureCollection(): Promise<void>
  search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]>
}

export interface HandlerServices {
  root: string
  config: PluginConfig
  milvus: MilvusPort
  tracker: HashTracker
  importResolver: ImportResolver
}

export type ServiceProvider = (root: string) => Promise<HandlerServices>

export interface SearchCodeArgs {
  query: string
  topK?: number
  path?: string
  pathPrefix?: string
}

export interface IndexCodeArgs {
  mode?: 'full' | 'incremental'
  path?: string
}

export interface IndexStatusArgs {
  path?: string
}

export async function handleSearchCode(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; results: SearchResult[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  await services.milvus.ensureCollection()

  const scope = args.pathPrefix ? path.join(root, args.pathPrefix) : root
  const topK = args.topK ?? 5
  const results = await services.milvus.search(args.query, topK, scope)
  logger.debug('search_code done', { root, topK, count: results.length })
  return { root, source, results }
}

export async function handleIndexCode(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; result: IndexResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const mode = args.mode ?? 'incremental'
  const result = await runIndex(services.config, services.milvus as any, services.tracker, {
    mode,
    importResolver: services.importResolver,
    logger,
  })
  logger.info('index_code done', { root, mode, filesIndexed: result.filesIndexed })
  return { root, source, result }
}

export async function handleIndexStatus(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexStatusArgs,
): Promise<{ root: string; source: WorkspaceSource; status: IndexStatus }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const status = await getIndexStatus(services.config, services.tracker)
  logger.debug('index_status done', { root })
  return { root, source, status }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest packages/codex/test/handlers.spec.ts`
Expected: 4 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(codex): add search, index and status handlers"
```

---

### Task 9: find_callers / trace_call_chain handlers

**Files:**
- Modify: `packages/codex/src/handlers.ts`
- Modify: `packages/codex/test/handlers.spec.ts`

**Interfaces:**
- Consumes: Task 8 的 `ServiceProvider`、`HandlerServices`；core 的 `findCallers`、`traceChain`、`CallersResult`、`TraceResult`
- Produces:
  - `interface FindCallersArgs { symbol: string; direction?: 'backward' | 'forward'; maxResults?: number; sourceFile?: string; resolve?: boolean; path?: string }`
  - `interface TraceChainArgs { entry: string; direction?: 'backward' | 'forward'; maxDepth?: number; maxResults?: number; resolve?: boolean; path?: string }`
  - `function handleFindCallers(provider, logger, args): Promise<{ root; source; result: CallersResult }>`
  - `function handleTraceCallChain(provider, logger, args): Promise<{ root; source; result: TraceResult }>`

- [ ] **Step 1: 追加失败测试**

在 `packages/codex/test/handlers.spec.ts` 末尾追加：

```ts
import { handleFindCallers, handleTraceCallChain } from '../src/handlers.js'

describe('handleFindCallers', () => {
  it('warns and degrades when the import map is not loaded', async () => {
    const services = makeServices()
    services.importResolver = { isLoaded: () => false } as any
    services.milvus = {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(),
      queryByReference: jest.fn(async () => ([{
        filePath: path.join(root, 'a.ts'), content: 'c', startLine: 1, endLine: 2,
        chunkType: 'function', name: 'caller',
      }])),
      queryByName: jest.fn(async () => []),
    } as any
    const out = await handleFindCallers(async () => services, silentLogger, { symbol: 'parseConfig' })
    expect(out.result.chunks).toHaveLength(1)
    expect(out.result.warning).toContain('import map')
  })
})

describe('handleTraceCallChain', () => {
  it('returns a chain payload', async () => {
    const services = makeServices()
    services.importResolver = { isLoaded: () => false } as any
    services.milvus = {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(),
      queryByReference: jest.fn(async () => []),
      queryByName: jest.fn(async () => []),
    } as any
    const out = await handleTraceCallChain(async () => services, silentLogger, { entry: 'run' })
    expect(out.result.chain).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/handlers.spec.ts`
Expected: FAIL —— `handleFindCallers is not a function`。

- [ ] **Step 3: 在 `handlers.ts` 追加实现**

```ts
import {
  findCallers, traceChain,
  type CallersResult, type TraceResult, type FindBySymbol, type RelationChunk,
} from 'dsh-context-milvus-core'

export interface FindCallersArgs {
  symbol: string
  direction?: 'backward' | 'forward'
  maxResults?: number
  sourceFile?: string
  resolve?: boolean
  path?: string
}

export interface TraceChainArgs {
  entry: string
  direction?: 'backward' | 'forward'
  maxDepth?: number
  maxResults?: number
  resolve?: boolean
  path?: string
}

interface RelationPort extends MilvusPort {
  queryByReference(symbol: string, limit?: number, pathPrefix?: string): Promise<SearchResult[]>
  queryByName(name: string, limit?: number, pathPrefix?: string): Promise<SearchResult[]>
}

interface RelationServices extends HandlerServices {
  milvus: RelationPort
}

function toRelationChunk(r: SearchResult): RelationChunk {
  return {
    filePath: r.filePath, content: r.content, startLine: r.startLine,
    endLine: r.endLine, chunkType: r.chunkType, name: r.name,
    references: r.references ?? [],
  }
}

function makeFindBySymbol(services: RelationServices, root: string): FindBySymbol {
  return async (symbol, direction, limit) => {
    const results = direction === 'backward'
      ? await services.milvus.queryByReference(symbol, limit, root)
      : await services.milvus.queryByName(symbol, limit, root)
    return results.map(toRelationChunk)
  }
}

function resolverFor(services: HandlerServices, resolve: boolean) {
  if (!resolve || !services.importResolver.isLoaded()) return undefined
  return {
    resolve: (fp: string, sym: string) => services.importResolver.resolve(fp, sym),
    getExports: (fp: string) => services.importResolver.getExports(fp),
  }
}

export async function handleFindCallers(
  provider: ServiceProvider,
  logger: Logger,
  args: FindCallersArgs,
): Promise<{ root: string; source: WorkspaceSource; result: CallersResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = (await provider(root)) as RelationServices
  await services.milvus.ensureCollection()

  const direction = args.direction === 'forward' ? 'forward' : 'backward'
  const resolve = args.resolve !== false
  const sourceFile = args.sourceFile ? path.resolve(root, args.sourceFile) : undefined
  const result = await findCallers(makeFindBySymbol(services, root), args.symbol, direction, {
    maxResults: args.maxResults ?? 20,
    sourceFile,
    resolver: resolverFor(services, resolve),
  })

  if (!resolve || !services.importResolver.isLoaded()) {
    const warning = 'import map 未加载，已降级为名称匹配；运行 index_code 后可精确解析。'
    result.warning = result.warning ? `${result.warning} ${warning}` : warning
  }
  logger.debug('find_callers done', { root, symbol: args.symbol, count: result.chunks.length })
  return { root, source, result }
}

export async function handleTraceCallChain(
  provider: ServiceProvider,
  logger: Logger,
  args: TraceChainArgs,
): Promise<{ root: string; source: WorkspaceSource; result: TraceResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = (await provider(root)) as RelationServices
  await services.milvus.ensureCollection()

  const direction = args.direction === 'forward' ? 'forward' : 'backward'
  const resolve = args.resolve !== false
  const result = await traceChain(makeFindBySymbol(services, root), args.entry, {
    direction,
    maxDepth: args.maxDepth ?? 3,
    maxResults: args.maxResults ?? 10,
    resolver: resolverFor(services, resolve),
  })
  logger.debug('trace_call_chain done', { root, entry: args.entry, nodes: result.chain.length })
  return { root, source, result }
}
```

若 `TraceOptions` 未声明 `resolver` 字段，则在 core 的 `TraceOptions` 接口中追加可选 `resolver?: FindCallersOptions['resolver']`，并让 `traceChain` 把它透传给内部 `findCallers` 调用。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest packages/codex/test/handlers.spec.ts`
Expected: 6 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(codex): add callers and call-chain handlers"
```

---

### Task 10: MCP Server、schemas 与 stdio 冒烟测试

**Files:**
- Create: `packages/codex/src/schemas.ts`
- Create: `packages/codex/src/server.ts`
- Create: `packages/codex/bin/mcp.js`
- Create: `packages/codex/test/mcp-smoke.spec.ts`

**Interfaces:**
- Consumes: Task 5–9 全部模块
- Produces: `function createServer(provider?: ServiceProvider): McpServer`；`function main(): Promise<void>`；可执行 `bin/mcp.js`。

- [ ] **Step 1: 写 `packages/codex/src/schemas.ts`**

```ts
import { z } from 'zod'

const direction = z.enum(['backward', 'forward']).optional()

export const searchCodeSchema = {
  query: z.string().describe('自然语言查询'),
  topK: z.number().int().positive().optional().describe('返回结果数，默认 5'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
  pathPrefix: z.string().optional().describe('限定子目录（相对工作区根）'),
}

export const indexCodeSchema = {
  mode: z.enum(['full', 'incremental']).optional().describe('默认 incremental'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const indexStatusSchema = {
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const findCallersSchema = {
  symbol: z.string().describe('符号名（函数/变量/类）'),
  direction: direction.describe('backward=谁引用我，forward=我引用谁'),
  maxResults: z.number().int().positive().optional(),
  sourceFile: z.string().optional(),
  resolve: z.boolean().optional(),
  path: z.string().optional(),
}

export const traceCallChainSchema = {
  entry: z.string().describe('入口符号名'),
  direction: direction.describe('backward=影响分析，forward=依赖分析'),
  maxDepth: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
  resolve: z.boolean().optional(),
  path: z.string().optional(),
}
```

- [ ] **Step 2: 写 `packages/codex/src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WorkspaceServiceCache } from './workspace-services.js'
import { createStderrLogger } from './context.js'
import {
  handleSearchCode, handleIndexCode, handleIndexStatus,
  handleFindCallers, handleTraceCallChain, type ServiceProvider,
} from './handlers.js'
import {
  okResult, errorResult, formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain,
} from './result-format.js'
import {
  searchCodeSchema, indexCodeSchema, indexStatusSchema,
  findCallersSchema, traceCallChainSchema,
} from './schemas.js'

export const VERSION = '0.1.0'

function classify(err: unknown): ReturnType<typeof errorResult> {
  const message = err instanceof Error ? err.message : String(err)
  if (err && typeof err === 'object' && (err as any).code === 'E_WORKSPACE_NOT_FOUND') {
    return errorResult('E_WORKSPACE_NOT_FOUND', message, '检查 path 参数，或省略它让工具自动发现工作区')
  }
  if (/ECONNREFUSED|UNAVAILABLE|connect/i.test(message)) {
    return errorResult('E_MILVUS_UNREACHABLE', message, '确认 Milvus 已启动，并检查 MILVUS_ADDRESS')
  }
  if (/embedding/i.test(message)) {
    return errorResult('E_EMBEDDING_FAILED', message, '检查 EMBEDDING_ENDPOINT 与 EMBEDDING_MODEL')
  }
  return errorResult('E_INTERNAL', message, '查看 Codex MCP server 的 stderr 日志')
}

export function createServer(provider?: ServiceProvider): McpServer {
  const logger = createStderrLogger()
  const cache = new WorkspaceServiceCache(logger)
  const resolveServices: ServiceProvider = provider ?? ((root) => cache.get(root))
  const server = new McpServer({ name: 'codex-context-milvus', version: VERSION })

  const wrap = <T>(run: () => Promise<{ payload: T; text: string }>) =>
    run().then(r => okResult(r.payload, r.text)).catch(classify)

  server.registerTool('search_code', {
    description: '在代码库中执行语义搜索。定位功能实现、理解代码逻辑时优先使用。',
    inputSchema: searchCodeSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleSearchCode(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, results: out.results },
             text: formatSearchResults(out.results) }
  }))

  server.registerTool('index_code', {
    description: '索引代码仓库到向量数据库。首次搜索前必须先执行一次。',
    inputSchema: indexCodeSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleIndexCode(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, ...out.result },
             text: formatIndexResult(out.result) }
  }))

  server.registerTool('index_status', {
    description: '查看索引状态：已索引文件数、代码块数、最后索引时间。',
    inputSchema: indexStatusSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleIndexStatus(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, ...out.status },
             text: formatStatus(out.status) }
  }))

  server.registerTool('find_callers', {
    description: '查找引用某符号的所有位置，用于修改前的影响分析。',
    inputSchema: findCallersSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleFindCallers(resolveServices, logger, args)
    return { payload: { root: out.root, ...out.result }, text: formatCallers(out.result) }
  }))

  server.registerTool('trace_call_chain', {
    description: '从入口符号出发 BFS 追踪调用链（影响/依赖分析）。',
    inputSchema: traceCallChainSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleTraceCallChain(resolveServices, logger, args)
    return { payload: { root: out.root, ...out.result }, text: formatChain(out.result) }
  }))

  return server
}

export async function main(): Promise<void> {
  const server = createServer()
  await server.connect(new StdioServerTransport())
}

process.on('uncaughtException', (err) => {
  console.error('[codex-context-milvus] uncaughtException:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[codex-context-milvus] unhandledRejection:', err)
})
```

- [ ] **Step 3: 写 `packages/codex/bin/mcp.js`**

```js
#!/usr/bin/env node
import { main } from '../dist/server.js'

main().catch((err) => {
  console.error('[codex-context-milvus] fatal:', err)
  process.exit(1)
})
```

执行 `chmod +x packages/codex/bin/mcp.js`。

- [ ] **Step 4: 写 stdio 冒烟测试 `packages/codex/test/mcp-smoke.spec.ts`**

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

describe('mcp stdio smoke', () => {
  it('lists the five tools', async () => {
    const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
    })

    rpc(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1.0.0' },
    })
    const deadline = Date.now() + 10000
    while (!lines.some(l => l.includes('"id":1')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    const init = JSON.parse(lines.find(l => l.includes('"id":1'))!)
    expect(init.result.serverInfo.name).toBe('codex-context-milvus')

    rpc(child, 2, 'notifications/initialized', {})
    rpc(child, 3, 'tools/list', {})
    while (!lines.some(l => l.includes('"id":3')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    const list = JSON.parse(lines.find(l => l.includes('"id":3'))!)
    const names = list.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['find_callers', 'index_code', 'index_status', 'search_code', 'trace_call_chain'])

    child.kill()
    await once(child, 'exit').catch(() => {})
  }, 20000)
})
```

- [ ] **Step 5: 构建并运行冒烟测试**

```bash
npm install
npm run build
npx jest packages/codex/test/mcp-smoke.spec.ts
```

Expected: PASS，5 个工具名正确。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(codex): add MCP stdio server and smoke test"
```

---

### Task 11: init 向导与 doctor

**Files:**
- Create: `packages/codex/src/init-wizard.ts`
- Create: `packages/codex/src/doctor.ts`
- Create: `packages/codex/bin/cli.js`
- Create: `packages/codex/test/init-wizard.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 resolver
- Produces:
  - `interface InitOptions { milvusAddress: string; embeddingEndpoint: string; embeddingModel: string; workspaceRoot: string; milvusToken?: string; embeddingApiKey?: string }`
  - `function renderMcpSection(options: InitOptions): string`
  - `function upsertMcpSection(existing: string, options: InitOptions): { toml: string; changed: boolean }`
  - `function writeProjectConfig(projectRoot: string, options: InitOptions): Promise<{ path: string; backup?: string; changed: boolean }>`
  - `function runDoctor(): Promise<{ ok: boolean; lines: string[] }>`

- [ ] **Step 1: 写失败测试 `packages/codex/test/init-wizard.spec.ts`**

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { renderMcpSection, upsertMcpSection, writeProjectConfig } from '../src/init-wizard.js'

const options = {
  milvusAddress: 'localhost:19530',
  embeddingEndpoint: 'http://localhost:11434/api/embed',
  embeddingModel: 'nomic-embed-text',
  workspaceRoot: '/repo',
} as const

describe('renderMcpSection', () => {
  it('omits secrets by default', () => {
    const text = renderMcpSection({ ...options })
    expect(text).toContain('[mcp_servers.context-milvus]')
    expect(text).toContain('CONTEXT_MILVUS_WORKSPACE = "/repo"')
    expect(text).not.toContain('MILVUS_TOKEN')
    expect(text).not.toContain('EMBEDDING_API_KEY')
  })

  it('includes secrets only when explicitly provided', () => {
    const text = renderMcpSection({ ...options, milvusToken: 't', embeddingApiKey: 'k' })
    expect(text).toContain('MILVUS_TOKEN = "t"')
    expect(text).toContain('EMBEDDING_API_KEY = "k"')
  })
})

describe('upsertMcpSection', () => {
  it('appends when the section is absent and preserves other content', () => {
    const existing = 'model = "o3"\n'
    const { toml, changed } = upsertMcpSection(existing, { ...options })
    expect(changed).toBe(true)
    expect(toml).toContain('model = "o3"')
    expect(toml).toContain('[mcp_servers.context-milvus]')
  })

  it('replaces only the existing section', () => {
    const existing = [
      'model = "o3"',
      '',
      '[mcp_servers.context-milvus]',
      'command = "old"',
      '',
      '[mcp_servers.other]',
      'command = "keep"',
      '',
    ].join('\n')
    const { toml } = upsertMcpSection(existing, { ...options })
    expect(toml).toContain('model = "o3"')
    expect(toml).toContain('[mcp_servers.other]')
    expect(toml).toContain('command = "keep"')
    expect(toml).not.toContain('command = "old"')
    expect(toml.match(/\[mcp_servers\.context-milvus\]/g)).toHaveLength(1)
  })

  it('is idempotent', () => {
    const first = upsertMcpSection('', { ...options }).toml
    const second = upsertMcpSection(first, { ...options })
    expect(second.changed).toBe(false)
    expect(second.toml).toBe(first)
  })
})

describe('writeProjectConfig', () => {
  it('creates .codex/config.toml and backs up an existing file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ctx-init-'))
    try {
      const first = await writeProjectConfig(root, { ...options, workspaceRoot: root })
      expect(existsSync(first.path)).toBe(true)
      expect(first.backup).toBeUndefined()

      const second = await writeProjectConfig(root, { ...options, workspaceRoot: root })
      expect(second.backup && existsSync(second.backup)).toBe(true)
      const text = await readFile(second.path, 'utf-8')
      expect(text).toContain('[mcp_servers.context-milvus]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest packages/codex/test/init-wizard.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现 `packages/codex/src/init-wizard.ts`**

```ts
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

export interface InitOptions {
  milvusAddress: string
  embeddingEndpoint: string
  embeddingModel: string
  workspaceRoot: string
  milvusToken?: string
  embeddingApiKey?: string
}

export const SECTION_HEADER = '[mcp_servers.context-milvus]'
const SECTION_ENV_HEADER = '[mcp_servers.context-milvus.env]'

export function renderMcpSection(options: InitOptions): string {
  const env: string[] = [
    `MILVUS_ADDRESS = ${JSON.stringify(options.milvusAddress)}`,
    `EMBEDDING_ENDPOINT = ${JSON.stringify(options.embeddingEndpoint)}`,
    `EMBEDDING_MODEL = ${JSON.stringify(options.embeddingModel)}`,
    `CONTEXT_MILVUS_WORKSPACE = ${JSON.stringify(options.workspaceRoot)}`,
  ]
  if (options.milvusToken) env.push(`MILVUS_TOKEN = ${JSON.stringify(options.milvusToken)}`)
  if (options.embeddingApiKey) env.push(`EMBEDDING_API_KEY = ${JSON.stringify(options.embeddingApiKey)}`)

  return [
    SECTION_HEADER,
    'command = "npx"',
    'args = ["-y", "codex-context-milvus", "mcp"]',
    'enabled = true',
    '',
    SECTION_ENV_HEADER,
    ...env,
    '',
  ].join('\n')
}

/** Extract a top-level section block: from its header to the next top-level header. */
function extractSection(text: string, header: string): { start: number; end: number } | null {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === header)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // A top-level table header that is not our own env sub-table.
    if (/^\s*\[/.test(line) && !line.includes('context-milvus')) { end = i; break }
  }
  return { start, end }
}

export function upsertMcpSection(existing: string, options: InitOptions): { toml: string; changed: boolean } {
  const block = renderMcpSection(options)
  const found = extractSection(existing, SECTION_HEADER)

  if (!found) {
    const base = existing.length === 0 ? '' : existing.replace(/\n*$/, '\n\n')
    return { toml: base + block, changed: true }
  }

  const lines = existing.split('\n')
  // Also swallow the env sub-table that follows ours.
  let end = found.end
  if ((lines[end] ?? '').trim() === SECTION_ENV_HEADER) {
    // env header is inside the block already because extractSection stops at non-context-milvus headers
  }
  const before = lines.slice(0, found.start).join('\n')
  const after = lines.slice(end).join('\n')
  const next = [before.replace(/\n*$/, ''), block.trimEnd(), after.replace(/^\n*/, '')]
    .filter(part => part.length > 0)
    .join('\n\n') + '\n'

  return { toml: next, changed: next !== existing }
}

export async function writeProjectConfig(
  projectRoot: string,
  options: InitOptions,
): Promise<{ path: string; backup?: string; changed: boolean }> {
  const dir = path.join(projectRoot, '.codex')
  const target = path.join(dir, 'config.toml')
  await mkdir(dir, { recursive: true })

  const existing = existsSync(target) ? await readFile(target, 'utf-8') : ''
  const { toml, changed } = upsertMcpSection(existing, options)

  let backup: string | undefined
  if (changed && existsSync(target)) {
    backup = `${target}.bak`
    await copyFile(target, backup)
  }
  if (changed) await writeFile(target, toml, 'utf-8')
  return { path: target, backup, changed }
}
```

- [ ] **Step 4: 写 `packages/codex/src/doctor.ts`**

```ts
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { getConfig, MilvusService, EmbeddingClient } from 'dsh-context-milvus-core'
import { createStderrLogger } from './context.js'
import { resolveWorkspaceRoot } from './workspace-resolver.js'

export async function runDoctor(): Promise<{ ok: boolean; lines: string[] }> {
  const logger = createStderrLogger()
  const lines: string[] = []
  let ok = true

  const { root, source } = resolveWorkspaceRoot(process.env.CONTEXT_MILVUS_WORKSPACE)
  lines.push(`workspace: ${root} (source=${source})`)

  const config = getConfig({ indexRoot: root })
  lines.push(`milvus: ${config.milvusAddress} collection=${config.milvusCollection} dim=${config.milvusDim}`)
  lines.push(`embedding: ${config.embedding.endpoint} model=${config.embedding.model}`)

  const configFile = path.join(root, '.codex', 'config.toml')
  lines.push(`project config: ${existsSync(configFile) ? configFile : '未找到（可运行 init 生成）'}`)

  try {
    const embedding = new EmbeddingClient(config.embedding)
    const vectors = await embedding.embed(['doctor connectivity probe'])
    lines.push(`embedding probe: ok (dim=${vectors[0]?.length ?? 0})`)
  } catch (err) {
    ok = false
    lines.push(`embedding probe: FAILED — ${(err as Error).message}`)
  }

  try {
    const milvus = new MilvusService({
      address: config.milvusAddress, token: config.milvusToken,
      collection: config.milvusCollection, dim: config.milvusDim,
      embeddingClient: new EmbeddingClient(config.embedding),
      logger,
    })
    await milvus.ensureCollection()
    lines.push('milvus probe: ok')
  } catch (err) {
    ok = false
    lines.push(`milvus probe: FAILED — ${(err as Error).message}`)
  }

  return { ok, lines }
}
```

- [ ] **Step 5: 写 `packages/codex/bin/cli.js`**

```js
#!/usr/bin/env node
const [command] = process.argv.slice(2)

async function main() {
  if (command === 'mcp') {
    const { main: runMcp } = await import('../dist/server.js')
    return runMcp()
  }
  if (command === 'init') {
    const { runInitCli } = await import('../dist/cli.js')
    return runInitCli(process.argv.slice(3))
  }
  if (command === 'doctor') {
    const { runDoctor } = await import('../dist/doctor.js')
    const { ok, lines } = await runDoctor()
    for (const line of lines) console.error(line)
    process.exit(ok ? 0 : 1)
  }
  console.error('用法: codex-context-milvus <mcp|init|doctor>')
  process.exit(2)
}

main().catch((err) => {
  console.error('[codex-context-milvus] fatal:', err)
  process.exit(1)
})
```

执行 `chmod +x packages/codex/bin/cli.js`。

- [ ] **Step 6: 写 `packages/codex/src/cli.ts`（init 命令行）**

```ts
import { createInterface } from 'node:readline/promises'
import { resolveWorkspaceRoot } from './workspace-resolver.js'
import { writeProjectConfig, type InitOptions } from './init-wizard.js'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export async function runInitCli(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot(flag(args, 'workspace')).root
  const nonInteractive = args.includes('--non-interactive') || args.includes('--yes')

  const options: InitOptions = {
    milvusAddress: flag(args, 'milvus-address') ?? 'localhost:19530',
    embeddingEndpoint: flag(args, 'embedding-endpoint') ?? 'http://localhost:11434/api/embed',
    embeddingModel: flag(args, 'embedding-model') ?? 'nomic-embed-text',
    workspaceRoot: root,
  }

  if (!nonInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    options.milvusAddress = (await rl.question(`Milvus 地址 [${options.milvusAddress}]: `)) || options.milvusAddress
    options.embeddingEndpoint = (await rl.question(`Embedding endpoint [${options.embeddingEndpoint}]: `)) || options.embeddingEndpoint
    options.embeddingModel = (await rl.question(`Embedding model [${options.embeddingModel}]: `)) || options.embeddingModel
    const writeSecrets = await rl.question('是否写入 MILVUS_TOKEN / EMBEDDING_API_KEY？（y/N）: ')
    if (writeSecrets.trim().toLowerCase() === 'y') {
      const token = await rl.question('MILVUS_TOKEN（留空跳过）: ')
      if (token) options.milvusToken = token
      const key = await rl.question('EMBEDDING_API_KEY（留空跳过）: ')
      if (key) options.embeddingApiKey = key
    }
    rl.close()
  }

  const result = await writeProjectConfig(root, options)
  console.error(result.changed
    ? `已写入 ${result.path}${result.backup ? `（备份: ${result.backup}）` : ''}`
    : `配置未变化: ${result.path}`)
}
```

在 `packages/codex/package.json` 的 `files` 中已含 `dist`，无需改动。

- [ ] **Step 7: 运行测试确认通过**

```bash
npx tsc -p packages/codex/tsconfig.json --noEmit
npx jest packages/codex/test/init-wizard.spec.ts
```

Expected: 类型检查 0 退出码；6 个 init 用例 PASS。

- [ ] **Step 8: 手动验证向导**

```bash
npm run build
mkdir -p /tmp/ctx-init-demo && cd /tmp/ctx-init-demo
node /mnt/home/bobjia/workspace/dsh-context-milvus/packages/codex/bin/cli.js init --yes --non-interactive
cat .codex/config.toml
```

Expected: 文件包含 `[mcp_servers.context-milvus]` 与 `CONTEXT_MILVUS_WORKSPACE = "/tmp/ctx-init-demo"`。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(codex): add init wizard and doctor"
```

---

### Task 12: Codex Plugin 清单、Skill 与文档

**Files:**
- Create: `packages/codex/.codex-plugin/plugin.json`
- Create: `packages/codex/.mcp.json`
- Create: `packages/codex/skills/context-milvus/SKILL.md`
- Create: `packages/codex/README.md`
- Modify: `README.md`（根，追加 Codex 安装章节）

**Interfaces:**
- Consumes: Task 10 的 `bin/cli.js`（`mcp` 子命令）
- Produces: 可被 `codex plugin marketplace add <local path>` 识别的插件包。

- [ ] **Step 1: 写 `packages/codex/.codex-plugin/plugin.json`**

```json
{
  "name": "context-milvus",
  "version": "0.1.0",
  "description": "Semantic code search for Codex backed by a Milvus vector database",
  "author": { "name": "bobjia" },
  "license": "MIT",
  "keywords": ["code-search", "semantic-search", "milvus", "rag", "mcp"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Context Milvus",
    "shortDescription": "Semantic code search over your repository",
    "longDescription": "Indexes the repository into Milvus with AST-aware chunking, then answers natural-language code queries. Provides search_code, index_code, index_status, find_callers and trace_call_chain over MCP.",
    "developerName": "bobjia",
    "category": "Developer Tools",
    "capabilities": ["Read", "Write"]
  }
}
```

- [ ] **Step 2: 写 `packages/codex/.mcp.json`**

```json
{
  "mcpServers": {
    "context-milvus": {
      "command": "npx",
      "args": ["-y", "codex-context-milvus", "mcp"],
      "env_vars": ["MILVUS_ADDRESS", "MILVUS_TOKEN", "MILVUS_COLLECTION", "MILVUS_EMBEDDING_DIM", "EMBEDDING_ENDPOINT", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "CONTEXT_MILVUS_WORKSPACE"],
      "tool_timeout_sec": 1800
    }
  }
}
```

- [ ] **Step 3: 写 `packages/codex/skills/context-milvus/SKILL.md`**

```markdown
---
name: context-milvus
description: Use when the user asks where a feature is implemented, how code works, or wants impact analysis before changing a symbol; also use before large refactors in repositories indexed in Milvus. Prefer this semantic search over broad grep over the whole repository.
---

# Context Milvus code search

## When to use

- 用户问“某功能在哪实现 / 怎么实现的” → 先 `search_code`，不要先全仓库 grep。
- 修改函数/变量/类之前 → 先 `find_callers` 做影响分析。
- 需要理解上下游调用关系 → `trace_call_chain`。

## Workflow

1. 首次使用先调用 `index_status`。若返回“从未索引”，调用 `index_code`（大仓库用 `mode: "full"`）。
2. 之后用 `search_code` 做自然语言检索，`topK` 保持 5 左右。
3. 代码变更后调用 `index_code`（默认增量）。
4. 多工作区场景显式传绝对路径 `path`。

## Rules

- 不要用 grep 全仓库搜索来回答“功能在哪”这类问题。
- 搜索结果里的文件路径是绝对路径，读取源码用 Codex 的读文件工具。
- 如果 `find_callers` / `trace_call_chain` 返回“import map 未加载”警告，先运行 `index_code` 再重试以启用精确解析。
```

- [ ] **Step 4: 写 `packages/codex/README.md`**

内容包含：一句话定位、安装（`npm i -g codex-context-milvus` 或 `npx`）、配置（`codex mcp add` 与 `init` 两种）、5 个工具表格、Milvus/Embedding 前置条件、故障排查（`doctor`、错误码表）、已知限制（Windows tree-sitter、工作区自动发现、无 ADR）。

- [ ] **Step 5: 根 README 追加 Codex 章节**

在 `README.md` 的 Features 之后追加 “## Codex CLI support” 一节，指向 `packages/codex/README.md`，并给出最短安装命令：

```bash
codex mcp add context-milvus -- npx -y codex-context-milvus mcp
```

- [ ] **Step 6: 验证插件清单为合法 JSON**

本任务不发布 marketplace（规格明确列为非目标），只验证清单可被解析：

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/codex/.codex-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('packages/codex/.mcp.json','utf8')); console.error('plugin json ok')"
```

Expected: 输出 `plugin json ok`。若后续要发布 marketplace，需另行补 `.agents/plugins/marketplace.json` 与索引 spec。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(codex): add plugin manifest, skill and docs"
```

---

### Task 13: 发版准备与端到端验收

**Files:**
- Modify: `packages/core/package.json`、`packages/dsh/package.json`、`packages/codex/package.json`（版本与依赖范围）
- Create: `docs/codex-mcp-manual-verification.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可发布的三个包与人工验收清单。

- [ ] **Step 1: 对齐版本与依赖范围**

- `packages/core/package.json` → `"version": "0.1.0"`
- `packages/dsh/package.json` → 版本在现有 `0.6.5` 基础上递增为 `0.6.6`，`dependencies` 含 `"dsh-context-milvus-core": "^0.1.0"`
- `packages/codex/package.json` → `"version": "0.1.0"`，`dependencies` 含 `"dsh-context-milvus-core": "^0.1.0"`

- [ ] **Step 2: 全量构建与测试**

```bash
npm install
npm run build
npm test
```

Expected: 三者均成功，所有 spec PASS。

- [ ] **Step 3: 检查打包内容**

```bash
cd packages/dsh && npm pack --dry-run
cd ../core && npm pack --dry-run
cd ../codex && npm pack --dry-run
```

Expected: `dsh` 包含 `dist/plugins/dsh-context-milvus/index.js` 与 `.d.ts`、`client/`、`cordis*.yml`；`core` 包含 `dist/index.js`；`codex` 包含 `dist/`、`bin/`、`.codex-plugin/`、`.mcp.json`、`skills/`。

- [ ] **Step 4: 真实 Milvus + Embedding 冒烟（人工）**

```bash
docker run -d --name milvus -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest standalone
ollama serve & ollama pull nomic-embed-text
node packages/codex/bin/cli.js doctor
```

Expected: `doctor` 输出 embedding probe ok 与 milvus probe ok，退出码 0。

- [ ] **Step 5: Codex 端到端（人工）**

```bash
codex mcp add context-milvus -- npx -y codex-context-milvus mcp
cd /mnt/home/bobjia/workspace/dsh-context-milvus
codex exec "先调用 index_status；如果从未索引就调用 index_code mode=full；然后搜索 semantic search 的实现位置"
```

Expected: Codex 成功调用 `index_status` → `index_code` → `search_code`，并给出 `milvus-service.ts` 相关片段。

- [ ] **Step 6: 写人工验收清单 `docs/codex-mcp-manual-verification.md`**

记录 Step 4/5 的实际命令、观察结果与日期，并列出已知限制（Windows tree-sitter 未验证、MCP Roots 未接入、ADR 未移植、无 marketplace 发布）。

- [ ] **Step 7: 最终提交**

```bash
git add -A
git commit -m "chore: prepare codex-context-milvus 0.1.0 release"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| 仓库结构 / 构建与发布 | Task 1、2、13 |
| core 包与边界 | Task 2、3 |
| dsh 包契约冻结 | Task 1、4 |
| codex 包模块划分 | Task 5–11 |
| 工作区解析（explicit/.git/cwd） | Task 5 |
| 环境变量配置 | Task 6、11 |
| init 向导（备份、幂等、密钥默认不写） | Task 11 |
| MCP Server（stdio、按 root 缓存、懒初始化） | Task 6、10 |
| 5 个工具契约 | Task 8、9、10 |
| 返回格式（text + structuredContent，错误不含 secret） | Task 7、10 |
| 错误码表 | Task 7、10 |
| 日志与进程契约（stderr-only） | Task 3、6、10 |
| 迁移步骤 | Task 1–13 |
| 测试策略 | 每个任务的测试步骤 + Task 13 |
| 验收标准 | Task 13 |
| 插件清单与 Skill | Task 12 |

无遗漏章节。

**2. Placeholder scan**

已检查：无 `TBD`/`TODO`/“类似 Task N”/“补充错误处理”等占位描述；每个代码步骤都给出可直接落盘的完整代码或精确命令。

**3. Type consistency**

- `HandlerServices` 在 Task 8 定义，Task 9 通过 `RelationServices extends HandlerServices` 扩展，未重命名。
- `MilvusService` 构造参数中的 `logger` 由 Task 3 加入，Task 6 使用，一致。
- `ToolResult<T>` / `errorResult` / `okResult` 在 Task 7 定义，Task 10 使用，一致。
- `resolveWorkspaceRoot` 返回 `WorkspaceResolution` 在 Task 5 定义，Task 8/9/11 使用，一致。
- `runIndex` 的 `logger` 选项由 Task 3 加入，Task 8 传入，一致。
- 已知待对齐点：core 的 `TraceOptions` 若缺少 `resolver`，Task 9 Step 3 明确要求补上并透传，属计划内的显式改动，不是隐含假设。
