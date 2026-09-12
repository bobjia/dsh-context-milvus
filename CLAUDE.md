# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install (peer conflict between @deepseek-ai/dsh-llm and @deepseek-ai/dsh-settings
# over @deepseek-ai/dsh-brand predates this layout — the flag is required)
npm ci --legacy-peer-deps          # or: npm install --legacy-peer-deps

# Build all three packages in dependency order (core → dsh → codex)
npm run build

# Typecheck (builds core first: dsh/codex resolve it via its emitted dist/*.d.ts)
npm run typecheck

# Test everything (ESM: jest must run under --experimental-vm-modules)
npm test

# Test a single file — `npx jest <file>` does NOT work in this repo
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/core-boundary.spec.ts

# Test with coverage
npm run test:coverage

# Retrieval / agent / telemetry evaluation harness (lives at repo root)
npm run test:eval
npm run eval:telemetry
```

Release artifacts are three npm packages published from this workspace: `dsh-context-milvus-core` (unscoped, public), `dsh-context-milvus` (the DSH plugin, existing name), and `codex-context-milvus` (the MCP server + CLI).

## Architecture

This is a **private npm workspace** (`packages/*`) holding one retrieval engine and two adapters. It indexes code into a **Milvus vector database** and searches it via natural-language queries.

```
packages/core     dsh-context-milvus-core     framework-agnostic engine
packages/dsh      dsh-context-milvus          DSH (Cordis) plugin adapter, 13 tools
packages/codex    codex-context-milvus        MCP stdio server for OpenAI Codex, 5 tools
```

Dependency direction is one-way: `dsh` → `core` and `codex` → `core`. Adapters never import each other.

### core boundary is enforced

`packages/core/src` must not import `@deepseek-ai/*`, `@modelcontextprotocol/*` or `zod`, and must not call `console.log/warn/info` directly — logging goes through the injected `Logger` port (`consoleLogger`, `silentLogger`, or an adapter sink such as the MCP server's stderr logger). Both rules are asserted by `packages/core/test/core-boundary.spec.ts`.

### The core engine

```
packages/core/src/
  index.ts             — public barrel (the only import surface for adapters)
  config.ts            — getConfig(): overrides > env vars > defaults; deriveMerkleFilePath/deriveImportMapFilePath
  types.ts             — all shared types, including the ADR types
  milvus-service.ts    — Milvus client (collection init, hybrid search, insert/delete, ADR collection)
  embedding.ts         — OpenAI-compatible embedding client
  query-expansion.ts   — synonym expansion before embedding
  reranker.ts          — two-stage proportional rerank over a topK × multiplier pool
  indexer.ts           — runIndex(): walk → hash delta → chunk → embed → insert; getIndexStatus()
  chunker.ts           — tree-sitter AST chunking + regex fallback
  merkle.ts            — HashTracker: SHA-256 per-file state, produces toIndex/toRemove/unchanged
  ignore-matcher.ts    — three-layer gitignore-style matching
  import-resolver.ts   — persistent import/export map for cross-file symbol resolution
  code-relations.ts    — findCallers / traceChain (BFS) over the relation data
  telemetry.ts         — opt-in JSONL telemetry
  logger.ts            — Logger port (consoleLogger / silentLogger)
```

### The DSH adapter (`packages/dsh/src/plugins/dsh-context-milvus/`)

`index.ts` is the Cordis entry: `apply()` bootstraps services, installs the settings section, and registers **13 tools** — `search_code`, `index_code`, `index_status`, `find_callers`, `trace_call_chain` plus the 8 ADR tools (`search_adr`, `search_adr_by_file`, `create_adr`, `update_adr`, `list_adrs`, `load_constraints`, `check_adr_consistency`, `index_specs`). `tools.ts` and `adr-tools.ts` hold the tool definitions; every engine import goes through `dsh-context-milvus-core`.

ADR decision memory lives here (not in core, except its types in `core/src/types.ts`):

```
adr-frontmatter.ts       — YAML frontmatter parsing
adr-chunker.ts           — Markdown section chunking
adr-anchor-index.ts      — code_anchors reverse index
adr-anchor-generator.ts  — anchor generation for spec documents
adr-service.ts           — ADR CRUD + status management
adr-indexer.ts           — ADR indexing pipeline
adr-tools.ts             — the 8 ADR tools
constraint-injector.ts   — system prompt injection + per-step constraint re-injection
```

ADR is off by default (`adrEnabled: false`); enable it in the DSH settings panel. Milvus keeps ADR data in a separate `adr_embeddings` collection.

**Frozen public contract**: `packages/dsh/test/public-surface.spec.ts` pins all 13 tool names and the 27 `Config` keys, and `packages/dsh/package.json` keeps `main: dist/plugins/dsh-context-milvus/index.js`. Changing any of those requires updating that test deliberately — it exists to make such a change loud.

### The Codex adapter (`packages/codex/src/`)

MCP stdio server + CLI (`bin/cli.js`: `mcp` | `init` | `doctor`; `bin/mcp.js` starts the server directly).

```
workspace-resolver.ts  — explicit path → nearest ancestor .git → cwd
context.ts             — createStderrLogger(): stdout is reserved for JSON-RPC
workspace-services.ts  — per-workspace service cache (config, Milvus, tracker, import resolver)
result-format.ts       — text + structuredContent envelope, ErrorCode table, formatters
handlers.ts            — the 5 tool handlers, framework-free and unit-testable
schemas.ts             — zod input schemas
server.ts              — McpServer wiring + error classification
init-wizard.ts         — upsert [mcp_servers.context-milvus] into <repo>/.codex/config.toml
doctor.ts              — connectivity probes for embedding + Milvus
```

The Codex surface is deliberately 5 tools: no ADR tools, no runtime config hot-reload, no constraint injection (Codex has no hook that can write into a conversation).

## Key design decisions

- **Config precedence**: adapter config (Cordis config, or MCP `env`) > environment variables > defaults. Authoritative mapping lives in `packages/core/src/config.ts`.
- **Workspace isolation**: Merkle state and import maps are stored per workspace under `~/.milvus-index/`, keyed by a hash of the absolute path (`deriveMerkleFilePath()` / `deriveImportMapFilePath()`). An index built by one adapter is therefore reused by the other.
- **Incremental indexing**: `HashTracker` compares current hashes against stored ones to produce a delta (toIndex / toRemove / unchanged); `mode: "full"` re-indexes everything and removes nothing.
- **Ignore patterns**: `IgnoreMatcher` layers built-in defaults, codebase ignore files (.gitignore, .ignore, .xxxignore), and a global `~/.context/.contextignore`.
- **Milvus schema**: `{id, vector, file_path, code_content, start_line, end_line, language, chunk_type, name}` with COSINE metric, plus a `sparse_vector` field in hybrid mode; `@zilliz/milvus2-sdk-node` (gRPC). Inserts batch at 100 rows, deletes are per-file. Legacy dense-only collections are renamed to `*_legacy_*` and recreated.
- **stderr-only logging in the MCP adapter**, because MCP stdio reserves stdout for JSON-RPC.
- **ESM everywhere**: `"type": "module"`, `target: ES2022`, `module/moduleResolution: NodeNext`, `strict: true`. Each package has its own `tsconfig.json` extending `tsconfig.base.json`.

## Supported languages

| Language | Extensions | Chunking method |
|----------|-----------|-----------------|
| TypeScript | .ts, .tsx, .mts, .cts | tree-sitter |
| JavaScript | .js, .jsx, .mjs, .cjs | tree-sitter |
| Python | .py | tree-sitter |
| Java | .java | tree-sitter |
| Go | .go | tree-sitter |
| Rust | .rs | tree-sitter |
| C++ | .cpp, .cxx, .cc, .hpp, .h, .hh | tree-sitter |
| C# | .cs | tree-sitter |
| Scala | .scala | tree-sitter |
| PHP | .php | regex fallback |

## Test structure

Specs live next to their package: `packages/{core,dsh,codex}/test/*.spec.ts`, matched by the single root `jest.config.js` (`roots: ['<rootDir>/packages']`). That config maps `dsh-context-milvus-core` to `packages/core/src/index.ts`, so tests run against sources with no prior build.

Two things catch people working here:

- **The real Milvus SDK cannot be loaded inside Jest's ESM runtime** (`@zilliz/milvus2-sdk-node` → parquetjs → thrift → uuid, and uuid is ESM-only). Any spec that imports the core barrel at runtime must stub the SDK first: `jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)` via `packages/codex/test/helpers/milvus-sdk-mock.ts`.
- **Mocks of engine modules must target the source path** (`../../core/src/merkle.js`), not the package name: jest resolves both to the same module, so stubbing the source file still intercepts the barrel's re-export, whereas stubbing the package name would force you to fake every other core export.

Core specs mock modules (`jest.unstable_mockModule`) rather than any framework, and `EmbeddingClient` tests override `globalThis.fetch`. `packages/codex/test/mcp-smoke.spec.ts` is the exception that proves the integration: it spawns the built `bin/mcp.js` and speaks real JSON-RPC over stdio, so `npm run build` must precede it.

`docs/codex-mcp-manual-verification.md` records what automated checks cover and which steps still need a real Milvus + Codex session.
