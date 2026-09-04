---
id: SPEC-2026-09-04-dsh-context-remdb-design
type: spec
status: active
created: '2026-09-04'
updated: '2026-09-04'
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: dsh context remdb design
  change_type: architecture
related_decisions: []
auto_generated: true
---

# dsh-context-remdb Design Specification

## Overview

dsh-context-remdb is a DeepSeek Harness (DSH) plugin that enables semantic code search through RemDB, a Milvus-compatible vector database. The plugin registers a `semantic_search_code` tool that converts natural language queries into vector searches, allowing DSH agents to find relevant code snippets by intent rather than keyword matching.

## Design Principles

- **Follow DSH plugin conventions**: Cordis framework module with `name`, `inject`, `apply(ctx)` pattern
- **Self-contained initialization**: Auto-create the RemDB collection on first load (no manual setup)
- **Server-side embedding**: The RemDB server handles text-to-vector conversion internally
- **Minimal configuration**: Environment variables only, sensible defaults throughout
- **Graceful degradation**: Clear error messages for connection failures, missing config, empty results

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMDB_ENDPOINT` | `http://localhost:19530` | RemDB server address |
| `REMDB_TOKEN` | (empty) | Optional Bearer token for authentication |
| `REMDB_COLLECTION` | `code_embeddings` | Target collection name |
| `REMDB_EMBEDDING_DIM` | `768` | Vector dimension — must match the embedding model used to populate the collection |

## Plugin Architecture

### Directory Structure

```
dsh-context-remdb/
├── src/
│   └── plugins/
│       └── dsh-context-remdb.ts    # Main plugin entry point
├── package.json                       # Plugin metadata and dependencies
├── tsconfig.json                      # TypeScript configuration
├── .gitignore
└── README.md                          # Usage documentation
```

### Component Breakdown

#### 1. Plugin Entry (`src/plugins/dsh-context-remdb.ts`)

The single file containing all plugin logic. It is intentionally kept as one focused module rather than split prematurely, but the three responsibilities are clearly separated within the file:

- **Configuration reader**: Reads and validates environment variables
- **RemDB service**: Wraps `RemDbClient` with collection initialization and text search
- **Tool definition**: Registers `semantic_search_code` via `defineTool` + `ctx.tools.register()`

#### 2. Package Dependencies

```json
{
  "name": "dsh-context-remdb",
  "private": true,
  "dependencies": {
    "remdb-sdk-node": "file:~/remdb-sdk-node"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^1.x",
    "@deepseek-ai/dsh-tools": "^0.1.x"
  }
}
```

- `remdb-sdk-node`: Local SDK for RemDB (collection management + HTTP transport)
- `@deepseek-ai/cordis`: DSH framework types (`Context`)
- `@deepseek-ai/dsh-tools`: `defineTool` API and `ToolRuntime` (`ctx.tools`)

## Collection Schema

The plugin auto-creates the collection with this schema on first load:

```typescript
{
  autoId: true,
  fields: [
    { name: 'id',           type: 'Int64',       isPrimary: true, autoId: true },
    { name: 'vector',       type: 'FloatVector',  params: { dim: 768 } },
    { name: 'file_path',    type: 'VarChar',      params: { max_length: 1024 } },
    { name: 'code_content', type: 'Text' },
    { name: 'start_line',   type: 'Int32' },
    { name: 'language',     type: 'VarChar',      params: { max_length: 64 } },
    { name: 'repo_path',    type: 'VarChar',      params: { max_length: 512 } },
  ],
}
```

Index: `{ fieldName: 'vector', indexName: 'idx_vector', metricType: 'COSINE' }`

The `dim` parameter is read from `REMDB_EMBEDDING_DIM` (default 768).

## Tool Definition

### Tool Metadata

- **Name**: `semantic_search_code`
- **Description**: `在代码库中执行语义搜索。当用户提出模糊的功能需求、询问代码逻辑或需要根据自然语言描述查找代码时，使用此工具。`
- **Parameters**:
  - `query` (string, required): The natural language query
  - `topK` (number, optional, default 5): Number of results to return

### Execution Flow

```
Agent calls semantic_search_code(query, topK)
  │
  ├─► Plugin reads env config (cached)
  │
  ├─► Lazily initialize RemDbClient (singleton, first call only)
  │     └─► Check collection exists → auto-create if missing
  │
  ├─► Send text search via POST /v2/vectordb/entities/search
  │     Body: { collectionName, text, limit, outputFields }
  │     └─► RemDB server: text → embedding → ANN search → results
  │
  ├─► Format results
  │     └─► [{ filePath, content, score, language, startLine }]
  │
  └─► Return formatted results to Agent
```

### Output Schema

```typescript
{
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        filePath:  { type: 'string' },
        content:   { type: 'string' },
        score:     { type: 'number' },
        language:  { type: 'string' },
        startLine: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  // Render as formatted text block for the model
  // Example output:
  //   [结果 1] 文件: src/auth/login.ts (TypeScript, 第 42 行)
  //   相关度: 0.92
  //   内容:
  //   ```typescript
  //   export async function loginUser(credentials: Credentials) {
  //     const user = await authenticate(credentials);
  //     return generateToken(user);
  //   }
  //   ```
  //   ---
  //   [结果 2] ...
  render: (args, value) => {
    const items = value as Array<Record<string, any>>;
    if (items.length === 0) {
      return [{ type: 'text' as const, text: '未找到匹配的代码片段。' }];
    }
    const lines = items.map((item, i) => {
      const lang = item.language ? ` (${item.language})` : '';
      return `[结果 ${i + 1}] 文件: ${item.filePath}${lang}, 第 ${item.startLine} 行\n` +
        `相关度: ${(item.score as number).toFixed(4)}\n` +
        '内容:\n' +
        '```' + (item.language || '') + '\n' +
        (item.content as string) + '\n' +
        '```';
    });
    return [{ type: 'text' as const, text: lines.join('\n---\n') }];
  },
}
```

### Text Search API Contract

Since the current `SearchReq` type in `remdb-sdk-node` expects `vector: number[]`, but the RemDB server accepts `text` directly, the plugin defines a local extended type:

```typescript
interface TextSearchReq {
  collectionName: string;
  text: string;           // Server handles embedding internally
  annsField?: string;
  limit?: number;
  offset?: number;
  outputFields?: string[];
  filter?: string;
}
```

The plugin sends this via `RemDbClient`'s inherited `POST()` method (the SDK's `HttpBaseClient`), bypassing the typed `search()` method to avoid the `vector` requirement.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Missing `REMDB_ENDPOINT` | Collection init fails with clear error message |
| RemDB connection refused | Tool returns error: "无法连接到 RemDB 服务器，请检查 REMDB_ENDPOINT 配置" |
| Collection not found (startup) | Auto-create with configured schema and index |
| Search timeout | SDK's built-in AbortController timeout (configurable via `timeout`) |
| No matching results | Return empty array — Agent handles "未找到匹配的代码片段" |
| Invalid tool arguments | Handled by `defineTool`'s built-in JSON Schema validation |

## Cordis Plugin Registration

The plugin is loaded via `cordis.yml` patch layer:

```yaml
plugins:
  dsh-context-remdb:
    $include: ./src/plugins/dsh-context-remdb.ts
```

## Testing Strategy

- **Unit tests**: Mock `RemDbClient` and verify tool registration, parameter validation, result formatting
- **Integration tests**: Against a running remdb-server instance (end-to-end search flow)
- **Test framework**: Jest + ts-jest (matching the SDK's test setup)

## Future Considerations

- **Multi-collection support**: Allow searching across multiple indexed collections
- **Filter support**: Expose `filter` parameter for language/repo scoping
- **Re-indexing trigger**: A separate tool to trigger code re-indexing
- **Custom embedding model config**: Allow configuring which embedding model RemDB uses server-side