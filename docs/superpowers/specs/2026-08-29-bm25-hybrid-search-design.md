---
id: SPEC-2026-09-04-bm25-hybrid-search-design
type: spec
status: active
created: '2026-09-04'
updated: '2026-09-04'
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: /mnt/home/bobjia/workspace/dsh-context-milvus/src/plugins/dsh-context-milvus/milvus-service.ts
    symbols: []
    lines:
      - 136
      - 136
    git_commit: ''
  - file: /mnt/home/bobjia/workspace/dsh-context-milvus/src/plugins/dsh-context-milvus/config.ts
    symbols:
      - bm25RrfK
    lines:
      - 137
      - 137
    git_commit: ''
  - file: /mnt/home/bobjia/workspace/dsh-context-milvus/src/plugins/dsh-context-milvus/index.ts
    symbols: []
    lines:
      - 138
      - 138
    git_commit: ''
  - file: /mnt/home/bobjia/workspace/dsh-context-milvus/test/dsh-context-remdb.spec.ts
    symbols:
      - createCollection
      - functions
      - enable_analyzer
      - SparseFloatVector
      - hybridSearch
      - rrf
      - k
      - search
      - sparse_vector
      - renameCollection
      - bm25RrfK
      - k1
      - b
      - dover_amp
      - index_code
      - full
      - loginUser
      - login
      - user
    lines:
      - 139
      - 172
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: bm25 hybrid search design
  change_type: architecture
related_decisions: []
auto_generated: true
---

# BM25 Keyword Fusion — Design

Date: 2026-08-29
Status: Approved (approach + migration policy confirmed by user)

## Context

`dsh-context-milvus` currently performs **pure dense vector** search: queries are
embedded via a local embedding API and matched against a single COSINE `FloatVector`
field. The `hybridMode` config flag is parsed but unused; docs state BM25 fusion is
"预留开关，BM25 融合尚未实现".

The user asked to implement BM25 keyword fusion for real.

## Environment findings (verified)

- Running Milvus server: **v2.5.0** at `localhost:19530` (reachable).
- SDK: `@zilliz/milvus2-sdk-node@3.0.4`. Supports `FunctionObject` with
  `FunctionType.BM25`, `SparseFloatVector` (DataType 104), `hybridSearch` with
  `RANKER_TYPE.RRF` / `WEIGHTED`, `createCollection(functions: [...])`, and
  `MetricType.BM25` indexes.
- Existing prototype collections `hybrid_code_chunks_a3958ce7` /
  `hybrid_code_chunks_ca144846` on this server confirm the exact native hybrid
  pattern (function-output BM25 sparse field + dense + RRF) was already explored
  here.
- A throwaway spike (temp collection, since dropped) confirmed end-to-end:
  createCollection with `functions: [{type: BM25, input_field_names: ['code_content'],
  output_field_names: ['sparse_vector']}]`, `SPARSE_INVERTED_INDEX`/`BM25` sparse
  index, and a two-branch `hybridSearch` + RRF **actually fuses keywords with semantic
  signals** (a keyword-favored doc ranked #1 even when the dense query pointed at other
  docs).

## Decisions

1. **Native Milvus BM25** (not in-process BM25). Single data source; insert /
   incremental / delete pipelines unchanged; matches server capabilities.
2. **Reuse the existing `code_content` VarChar field** as the BM25 text input (add
   `enable_analyzer: true`), and add one function-output field `sparse_vector`
   (`SparseFloatVector`). No new scalar field, no change to inserts, no change to
   `output_fields` or the tool result contract.
3. **Old-collection migration: rename + recreate.** If the live collection lacks
   `sparse_vector`, rename it to `<name>_legacy_<epochMs>` and create the new hybrid
   schema under the original name. Old data is preserved and recoverable; the user
   re-runs `index_code` to rebuild.
4. **Fusion = RRF** (Reciprocal Rank Fusion), `k = 60` default, configurable
   (`bm25RrfK`). BM25 branch takes the **raw query text** (Milvus tokenizes
   internally — no second embedding call).
5. **Graceful degradation.** If the server cannot create the function field
   (< v2.5), log a warning, create the legacy dense-only schema, and run in dense-only
   mode for this collection. `hybridMode` config default stays `true`.
6. **`hybridMode=false` keeps the existing pure-vector path untouched.**

## Changes

### Schema (in `initCollection`)

Existing fields unchanged. Two deltas when hybrid is enabled:

```ts
fields: [
  // ... id, vector, file_path, start_line, end_line, language, chunk_type, name
  { name: 'code_content', data_type: DataType.VarChar, max_length: 65535,
    type_params: { enable_analyzer: 'true' } },          // was plain VarChar
  { name: 'sparse_vector', data_type: DataType.SparseFloatVector },  // NEW
],
functions: [
  { name: 'bm25_fn', type: FunctionType.BM25,
    input_field_names: ['code_content'],
    output_field_names: ['sparse_vector'],
    params: {} },                                         // server defaults k1=1.2, b=0.7
],
```

Indexes:

```ts
// existing
createIndex({ field_name: 'vector', index_type: 'AUTOINDEX', metric_type: COSINE })
// new
createIndex({ field_name: 'sparse_vector', index_type: 'SPARSE_INVERTED_INDEX',
              metric_type: MetricType.BM25 })
```

Insert rows: identical to today (sparse_vector is derived by the function; do not send).

### Search (in `search()`)

`hybridMode=true`:

```ts
const response = await client.hybridSearch({
  collection_name: collection,
  data: [
    { anns_field: 'vector',        data: vector,                params: { metric_type: 'COSINE' } },
    { anns_field: 'sparse_vector', data: query,                 params: { metric_type: 'BM25' } },
  ],
  rerank: { strategy: 'rrf', params: { k: rrfK } },
  limit: topK,
  output_fields: [ 'file_path', 'code_content', 'start_line', 'end_line',
                   'language', 'chunk_type', 'name' ],
  ...(pathPrefix ? { filter: `file_path like "${pathPrefix}%"` } : {}),
})
```

Result mapping unchanged (single branch output -> [] array). RRF fused score is
returned as `score`. `hybridMode=false` → current `client.search` vector path,
byte-for-byte behavior preserved.

### Migration (in `ensureCollection` / `initCollection`)

On `hasCollection` true:

1. `describeCollection`; if schema lacks `sparse_vector` and hybrid mode is on →
   `renameCollection({ collection_name, new_collection_name: `${collection}_legacy_${Date.now()}` })`.
2. Create the new hybrid collection (idempotent — old name now free).
3. Log a clear INFO line telling the user to re-run `index_code`.

If hybrid mode is off, leave any existing collection alone.

### Fallback (server too old)

Catch function-field creation failure (e.g. service unsupported). Log warning,
proceed with the legacy dense-only `createCollection` path, set `effectiveHybridMode=false`
for this collection. `search()` must branch on the actual live schema, not just config.

### Config (in `config.ts` + `index.ts` schema)

- `hybridMode` — now effective. Default `true`, env `HYBRID_MODE`, `'false'` disables.
- `bm25RrfK` — number, default `60`, env `BM25_RRF_K`; rrf `k` in search rerank.

`PluginConfig` gains `bm25RrfK`. `CordisConfig` gains the optional field + schema
entry (`.default(60)`).

## Files touched

- `src/plugins/dsh-context-milvus/milvus-service.ts` — schema, indexes, hybridSearch, migration, fallback, schema-version check
- `src/plugins/dsh-context-milvus/config.ts` — `bm25RrfK` resolution
- `src/plugins/dsh-context-milvus/index.ts` — Config schema field
- `test/dsh-context-remdb.spec.ts` — new cases (see Testing)
- Docs: `README.md`, `why-dsh-context-milvus.md`, `CLAUDE.md` — replace "预留开关 / BM25 尚未实现" with actual behavior description

Untouched: `indexer.ts`, `tools.ts`, `types.ts`, `chunker.ts`, `embedding.ts`, `merkle.ts`,
`ignore-matcher.ts`, `client/`.

## Testing (jest, SDK fully mocked — no live Milvus)

1. `createCollection` sent with `functions` + `enable_analyzer` + `SparseFloatVector`
   when hybrid on.
2. `hybridSearch` request carries two branches + `rrf` rerank with configured `k`;
   BM25 branch data = raw query text.
3. `search` with `hybridMode=false` still uses single-branch `client.search`.
4. Migration: existing collection without `sparse_vector` → `renameCollection`
   called then new collection created; with `sparse_vector` → no rename.
5. Fallback: function creation throws → legacy schema path used, no throw.
6. Path filter still forwarded into both branches' request.
7. Config: `bm25RrfK` from cordis config > env > default 60.

## Non-goals (v1)

- No server-side weighted fusion (WEIGHTED) — RRF only.
- No `k1`/`b`/`dover_amp` BM25 tunables exposed (server defaults).
- No analyzer customization (default tokenizer, matching prototype).
- No migration of data into the new schema — re-index via `index_code` (`full`).

## Risks

- Analyzer tokenization of code identifiers (camelCase split, `loginUser` →
  `login`/`user`) may produce surprising keyword matches; accepted for v1,
  consistent with the existing prototype. Future: custom analyzer params.
- Rename-then-recreate loses the old query/count history; old data preserved under
  `_legacy_<ts>` for rollback.
- `hybridSearch` filter + RRF with an empty BM25 branch still returns dense-side
  results (RRF degrades gracefully); verified conceptually, covered by tests at the
  request level.