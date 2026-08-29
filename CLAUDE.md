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
```

## Architecture

This is a **DSH plugin** (DeepSeek's Cordis plugin framework) that provides semantic code search in a DSH agent environment. It indexes code into a **Milvus vector database** and searches it via natural language queries.

### Plugin entry: `src/plugins/dsh-context-remdb/index.ts`

The `apply()` function bootstraps all services and registers three DSH tools via `ctx.tools.register()`:

- `search_code` — semantic search against Milvus
- `index_code` — full or incremental codebase indexing
- `index_status` — query index state

Each tool uses `defineTool()` from `@deepseek-ai/dsh-tools` with typed parameters, output schema, and a render function for model consumption.

### Module dependency graph

```
index.ts (entry point)
  ├── config.ts     — config resolution (Cordis config > env vars > defaults)
  ├── milvus-service.ts — Milvus vector DB client wrapper (CRUD, search)
  │     └── embedding.ts — OpenAI-compatible embedding API client
  ├── merkle.ts     — SHA-256 hash tracker for incremental indexing (persisted to JSON)
  ├── tools.ts      — DSH tool definitions, formatting, workspace-aware tracker creation
  └── indexer.ts    — indexing pipeline orchestration
        └── chunker.ts — tree-sitter AST chunking (TS/JS) + regex fallback (Python/Rust/Go/Java/PHP)
```

### Key design decisions

- **Config precedence**: Cordis config (from `cordis.patch.yml`) > environment variables > defaults. All config fields have env var fallbacks; see `config.ts` for the mapping.
- **Incremental indexing**: `HashTracker` (merkle.ts) stores SHA-256 hashes per file in a local JSON file. On each index run, it compares current hashes against stored ones to produce a delta (toIndex / toRemove / unchanged). Tree-sitter AST parsing is only used for TypeScript/JavaScript; other languages (Python, Rust, Go, Java, PHP) use a regex-based chunker that detects function/class/method boundaries.
- **Workspace isolation**: Different code paths use independent Merkle state files (derived from `deriveMerkleFilePath()` in config.ts), so indexing multiple workspaces doesn't corrupt state.
- **Milvus collection schema**: `{id, vector, file_path, code_content, start_line, end_line, language, chunk_type, name}` with COSINE metric on the vector index. Uses `@zilliz/milvus2-sdk-node` (gRPC) for all database operations.
- **Embedding**: The `EmbeddingClient` calls an OpenAI-compatible API. Query text is embedded locally before vector search.
- **Batch operations**: Milvus inserts are batched at 100 rows; delete operations are done one file at a time.

### Supported languages

| Language | Extensions | Chunking method |
|----------|-----------|-----------------|
| TypeScript | .ts, .tsx, .mts, .cts | tree-sitter |
| JavaScript | .js, .jsx, .mjs, .cjs | tree-sitter |
| Python | .py | regex fallback |
| Rust | .rs | regex fallback |
| Go | .go | regex fallback |
| Java | .java | regex fallback |
| PHP | .php | regex fallback |

### Test structure

Tests in `test/dsh-context-remdb.spec.ts` use ESM-compatible mocking (`jest.unstable_mockModule`). The `@zilliz/milvus2-sdk-node` module is fully mocked; `EmbeddingClient` mocks override `globalThis.fetch`. Tests cover config resolution, HashTracker CRUD/persistence, embedding API calls, Milvus collection/search/insert/delete, and chunker output for all supported languages.