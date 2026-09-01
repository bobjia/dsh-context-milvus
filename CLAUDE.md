# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build          # tsc — compile src/ to dist/

# Test (single file)
npx jest test/dsh-context-remdb.spec.ts

# Test (all, with ESM support)
npm test               # node --experimental-vm-modules node_modules/.bin/jest

# Test with coverage
npm run test:coverage

# Test ADR modules
npx jest test/adr-frontmatter.spec.ts
npx jest test/adr-chunker.spec.ts
npx jest test/adr-anchor-index.spec.ts
npx jest test/adr-service.spec.ts
npx jest test/adr-indexer.spec.ts
npx jest test/adr-tools.spec.ts
npx jest test/constraint-injector.spec.ts
```

## Architecture

This is a **DSH plugin** (DeepSeek's Cordis plugin framework) that provides semantic code search in a DSH agent environment. It indexes code into a **Milvus vector database** and searches it via natural language queries.

### Plugin entry: `src/plugins/dsh-context-milvus/index.ts`

The `apply()` function bootstraps all services and registers three DSH tools via `ctx.tools.register()`:

- `search_code` — semantic search against Milvus
- `index_code` — full or incremental codebase indexing
- `index_status` — query index state

Each tool uses `defineTool()` from `@deepseek-ai/dsh-tools` with typed parameters, output schema, and a render function for model consumption.

### Module dependency graph

```
index.ts (entry point)
  ├── config.ts     — config resolution (Cordis config > env vars > defaults)
  │     └── DEFAULT_IGNORE_PATTERNS — built-in gitignore-style ignore rules
  ├── milvus-service.ts — Milvus vector DB client wrapper (CRUD, search)
  │     └── embedding.ts — OpenAI-compatible embedding API client
  ├── merkle.ts     — SHA-256 hash tracker for incremental indexing (persisted to JSON)
  ├── tools.ts      — DSH tool definitions, formatting, workspace-aware tracker creation
  ├── ignore-matcher.ts — gitignore-style pattern matching for file exclusion
  └── indexer.ts    — indexing pipeline orchestration
        └── chunker.ts — tree-sitter AST chunking (TS/JS/Python/Java/Go/Rust/C++/C#/Scala) + regex fallback (PHP)

### ADR 决策记忆系统（新增模块）

```
adr-frontmatter.ts      — YAML frontmatter 解析
adr-chunker.ts          — Markdown 章节分块
adr-anchor-index.ts     — code_anchors 反向索引
adr-service.ts          — ADR CRUD + 状态管理
adr-indexer.ts          — ADR 索引管道
adr-tools.ts            — 7 个 ADR 工具
constraint-injector.ts  — 系统提示注入 + 约束重注入
```

ADR 默认关闭（`adrEnabled: false`），通过 DSH 配置面板启用。配置项包括 `adrRoot`、`adrConstraintReinjectEvery` 等。

Milvus 集合: `adr_embeddings`（与 `code_embeddings` 分离，含 adr_id/status/section/code_anchors 字段）

### Key design decisions

- **Config precedence**: Cordis config (from `cordis.patch.yml`) > environment variables > defaults. All config fields have env var fallbacks; see `config.ts` for the mapping.
- **Incremental indexing**: `HashTracker` (merkle.ts) stores SHA-256 hashes per file in a local JSON file. On each index run, it compares current hashes against stored ones to produce a delta (toIndex / toRemove / unchanged). Tree-sitter AST parsing is used for TypeScript, JavaScript, Python, Java, Go, Rust, C++, C#, and Scala; PHP and other languages use a regex-based chunker that detects function/class/method boundaries.
- **Ignore pattern system**: `IgnoreMatcher` (ignore-matcher.ts) provides gitignore-style pattern matching with three layers: built-in defaults, codebase ignore files (.gitignore, .ignore, .xxxignore), and a global `~/.context/.contextignore` file. Replaces hardcoded directory skipping in walkDirectory.
- **Workspace isolation**: Different code paths use independent Merkle state files (derived from `deriveMerkleFilePath()` in config.ts), so indexing multiple workspaces doesn't corrupt state.
- **Milvus collection schema**: `{id, vector, file_path, code_content, start_line, end_line, language, chunk_type, name}` with COSINE metric on the vector index. Uses `@zilliz/milvus2-sdk-node` (gRPC) for all database operations.
- **Embedding**: The `EmbeddingClient` calls an OpenAI-compatible API. Query text is embedded locally before vector search.
- **Batch operations**: Milvus inserts are batched at 100 rows; delete operations are done one file at a time.

### Supported languages

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

### Test structure

Tests in `test/dsh-context-remdb.spec.ts` use ESM-compatible mocking (`jest.unstable_mockModule`). The `@zilliz/milvus2-sdk-node` module is fully mocked; `EmbeddingClient` mocks override `globalThis.fetch`. Tests cover config resolution, HashTracker CRUD/persistence, embedding API calls, Milvus collection/search/insert/delete, and chunker output for all supported languages.