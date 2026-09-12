# dsh-context-milvus-core

Framework-agnostic retrieval engine behind [`dsh-context-milvus`](../dsh) (DSH plugin) and [`codex-context-milvus`](../codex) (MCP server for OpenAI Codex).

It indexes a repository into a Milvus collection with tree-sitter AST chunking and answers natural-language queries with hybrid BM25 + vector retrieval, query expansion and two-stage reranking. Incremental runs are driven by a per-workspace SHA-256 Merkle state file, and a persistent import map gives `find_callers` / `trace_call_chain` cross-file symbol resolution.

## Boundary

This package must not import `@deepseek-ai/*`, `@modelcontextprotocol/*` or `zod`, and must not call `console.log/warn/info` directly — logging goes through the injectable `Logger` port (`consoleLogger`, `silentLogger`, or an adapter-provided sink). Both rules are enforced by `test/core-boundary.spec.ts`.

## Main exports

| Area | Exports |
|---|---|
| Config | `getConfig`, `deriveMerkleFilePath`, `deriveImportMapFilePath`, `DEFAULT_EXTENSIONS`, `DEFAULT_IGNORE_DIRS`, `DEFAULT_IGNORE_PATTERNS`, `PluginConfig`, `CordisConfig` |
| Milvus | `MilvusService` (`ensureCollection`, `search`, `queryByReference`, `queryByName`, `insertChunks`, ADR methods), `SearchMeta` |
| Embedding | `EmbeddingClient` |
| Indexing | `runIndex`, `getIndexStatus`, `IndexResult`, `HashTracker`, `IgnoreMatcher`, `chunkCode` |
| Relations | `findCallers`, `traceChain`, `isNoiseSymbol`, `DEFAULT_STOP_WORDS`, `RelationChunk`, `CallersResult`, `TraceResult`, `FindBySymbol` |
| Retrieval quality | `expandQuery`, `rerankResults`, `RerankConfig` |
| Telemetry / logging | `createTelemetry`, `sanitizeQuery`, `Logger`, `consoleLogger`, `silentLogger` |
| Types | all code, index and ADR types |

## Usage

```ts
import { getConfig, MilvusService, EmbeddingClient, HashTracker, runIndex, silentLogger } from 'dsh-context-milvus-core'

const config = getConfig({ indexRoot: '/path/to/repo' })
const embedding = new EmbeddingClient(config.embedding)
const milvus = new MilvusService({
  address: config.milvusAddress,
  token: config.milvusToken,
  collection: config.milvusCollection,
  dim: config.milvusDim,
  embeddingClient: embedding,
  logger: silentLogger,
})
const tracker = new HashTracker(config.merkleFilePath)
await tracker.load()

const result = await runIndex(config, milvus, tracker, { mode: 'incremental', logger: silentLogger })
```

Requires Node.js ≥ 18, a reachable Milvus, and an OpenAI-compatible embedding endpoint. ESM only.

## License

MIT
