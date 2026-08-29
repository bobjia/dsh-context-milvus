# BM25 Keyword Fusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement native Milvus BM25 keyword fusion so `hybridMode=true` runs dense-vector + BM25-text hybrid search with RRF ranking, plus a rename-and-recreate migration for the existing dense-only collection.

**Architecture:** Collection gains a `sparse_vector` function-output field (BM25 over the existing `code_content` TEXT field) and a `SPARSE_INVERTED_INDEX`/`BM25` index. `MilvusService.search()` switches from `client.search` to `client.hybridSearch` (two branches + `rerank: rrf`). `ensureCollection()` detects a legacy dense-only schema and renames it before recreating.

**Tech Stack:** Node ESM, `@zilliz/milvus2-sdk-node@3.0.4`, jest (`jest.unstable_mockModule`), schemastery config schema.

**Spec:** `docs/superpowers/specs/2026-08-29-bm25-hybrid-search-design.md`

## Global Constraints

(Verified against live Milvus **v2.5.0** + SDK **3.0.4**; do not deviate without re-verifying.)

- Hybrid collection schema: fields `id`(Int64 PK autoID), `vector`(FloatVector dim, COSINE), `file_path`(VarChar 1024), `code_content`(VarChar 65535, `type_params: {enable_analyzer: 'true'}`), `start_line/end_line`(Int32), `language`(VarChar 64), `chunk_type`(VarChar 64), `name`(VarChar 256), `sparse_vector`(SparseFloatVector), `enable_dynamic_field: true`.
- `functions: [{ name: 'bm25_fn', type: FunctionType.BM25, input_field_names: ['code_content'], output_field_names: ['sparse_vector'], params: {} }]`.
- Dense index: `AUTOINDEX`/`COSINE`; sparse index: `SPARSE_INVERTED_INDEX`/`MetricType.BM25`.
- `hybridSearch` request: `data: [{ anns_field:'vector', data:<dense>, params:{metric_type:'COSINE'} }, { anns_field:'sparse_vector', data:<raw query text>, params:{metric_type:'BM25'} }]`, `rerank: { strategy:'rrf', params:{ k } }`, plus `limit`, `output_fields`, optional `filter` (path prefix). nq=1 → flat `results[]`.
- Chunks are identified by `file_path` + line range; `sparse_vector` is function-derived (never sent on insert).
- `MilvusService` constructor accepts optional `hybridMode` (default **false** = dense-only legacy behavior) and `bm25RrfK` (default 60). The plugin entry passes `config.hybridMode`/`config.bm25RrfK` explicitly.
- `hybridMode=false` must preserve today's exact `client.search` behavior.
- Migration: legacy collection (hasCollection true, no `sparse_vector` field in `describeCollection().schema.fields`) → `renameCollection({collection_name, new_collection_name: `<name>_legacy_<epochMs>`})` → create hybrid schema under original name. Log INFO telling user to re-run `index_code`.
- Fallback: if hybrid `createCollection` throws (server < 2.5), log warning, recreate with the legacy dense-only schema, set `effectiveHybridMode=false` so `search()` uses the dense path. No throws escape `ensureCollection` for unsupported servers.
- Config: `bm25RrfK` — Cordis config > env `BM25_RRF_K` (positive int) > default 60. Env var listed in docs.
- Docs to update: `README.md`, `why-dsh-context-milvus.md`, `cordis-entry.yml`. Tests mock the SDK; no file in `test/` may hit a live Milvus.

---

### Task 1: Config plumbing for `bm25RrfK`

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`
- Modify: `src/plugins/dsh-context-milvus/index.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: existing `CordisConfig`, `PluginConfig`, `getConfig(overrides?)` in `config.ts`.
- Produces: `PluginConfig.bm25RrfK: number` (default 60); `CordisConfig.bm25RrfK?: number`; schemastery `Config` field `bm25RrfK`; env `BM25_RRF_K`.

- [ ] **Step 1: Write the failing config tests**

Add inside the existing `describe('getConfig()', ...)` block (after the `uses INDEX_EXTENSIONS` test at ~line 141), and to the `beforeEach` env cleanup add `delete process.env.BM25_RRF_K`:

```ts
it('defaults bm25RrfK to 60', () => {
  const config = getConfig()
  expect(config.bm25RrfK).toBe(60)
})

it('reads BM25_RRF_K from environment', () => {
  process.env.BM25_RRF_K = '30'
  const config = getConfig()
  expect(config.bm25RrfK).toBe(30)
})

it('Cordis config overrides BM25_RRF_K env', () => {
  process.env.BM25_RRF_K = '30'
  const config = getConfig({ bm25RrfK: 42 })
  expect(config.bm25RrfK).toBe(42)
})

it('ignores invalid BM25_RRF_K and falls back to 60', () => {
  process.env.BM25_RRF_K = 'abc'
  const config = getConfig()
  expect(config.bm25RrfK).toBe(60)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts -t "bm25RrfK" --no-cache`
Expected: FAIL — `config.bm25RrfK` is `undefined`.

- [ ] **Step 3: Implement in `config.ts`**

```ts
// CordisConfig interface — add after hybridMode:
  /** RRF 融合参数 k（越高越偏向名次，默认 60） */
  bm25RrfK?: number
```

```ts
// PluginConfig interface — add after hybridMode:
  bm25RrfK: number
```

In `getConfig()`, before the `return`:

```ts
const rrfKRaw = parseInt(process.env.BM25_RRF_K ?? '', 10)
const bm25RrfK = overrides?.bm25RrfK ?? (!isNaN(rrfKRaw) && rrfKRaw > 0 ? rrfKRaw : 60)
```

Add to the returned object (after `hybridMode: ...`):

```ts
    bm25RrfK,
```

- [ ] **Step 4: Add the schemastery field in `index.ts`**

Insert after the `hybridMode` block in `Config`:

```ts
  /** BM25 关键词融合 RRF 参数 */
  bm25RrfK: z.number()
    .default(60)
    .description('混合检索 RRF 融合参数 k（默认 60）'),
```

- [ ] **Step 5: Run tests**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS (all existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/config.ts src/plugins/dsh-context-milvus/index.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: add bm25RrfK RRF fusion config (default 60)"
```

---

### Task 2: Hybrid collection schema + sparse index

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `MilvusService` constructor (`{address, token, collection, dim, embeddingClient}`), `DataType`, `MetricType`, `FunctionType` from `@zilliz/milvus2-sdk-node`.
- Produces: constructor accepts `hybridMode?: boolean` (new, default false) and `bm25RrfK?: number` (default 60); private `this.effectiveHybridMode: boolean` initialized to `this.hybridMode`.

- [ ] **Step 1: Extend the SDK mock**

In the `jest.unstable_mockModule('@zilliz/milvus2-sdk-node', ...)` factory:
- add jest fns `mockDescribeCollection`, `mockHybridSearch`, `mockRenameCollection`
- add to `MilvusClient` mock methods: `describeCollection: mockDescribeCollection, hybridSearch: mockHybridSearch, renameCollection: mockRenameCollection`
- add `BM25: 'BM25'` to `MetricType`
- add exports `FunctionType: { BM25: 'BM25' }, RANKER_TYPE: { RRF: 'rrf', WEIGHTED: 'weighted' }`

- [ ] **Step 2: Write the failing test for hybrid schema creation**

Inside `describe('MilvusService', ...)`, keep `defaultConfig` as-is (no `hybridMode` key — dense default). Add a new test in `ensureCollection()`:

```ts
it('creates collection with BM25 function field when hybridMode is on', async () => {
  mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: false })
  mockCreateCollection.mockResolvedValue({ error_code: 'Success' })
  mockCreateIndex.mockResolvedValue({ error_code: 'Success' })
  mockLoadCollectionSync.mockResolvedValue({ error_code: 'Success' })

  const service = new MilvusService({ ...defaultConfig, hybridMode: true })
  await service.ensureCollection()

  const callArgs = (mockCreateCollection.mock.calls[0] as any[])[0] as any
  expect(callArgs.functions).toEqual([
    {
      name: 'bm25_fn',
      type: 'BM25',
      input_field_names: ['code_content'],
      output_field_names: ['sparse_vector'],
      params: {},
    },
  ])
  const contentField = callArgs.fields.find((f: any) => f.name === 'code_content')
  expect(contentField.type_params).toEqual({ enable_analyzer: 'true' })
  const sparseField = callArgs.fields.find((f: any) => f.name === 'sparse_vector')
  expect(sparseField.data_type).toBe(104) // SparseFloatVector

  expect(mockCreateIndex).toHaveBeenCalledWith(
    expect.objectContaining({
      collection_name: 'test_collection',
      field_name: 'sparse_vector',
      index_type: 'SPARSE_INVERTED_INDEX',
      metric_type: 'BM25',
    }),
  )
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts -t "BM25 function field" --no-cache`
Expected: FAIL — no `functions` key, no `sparse_vector` field.

- [ ] **Step 4: Implement in `milvus-service.ts`**

Update the import:

```ts
import { MilvusClient, DataType, MetricType, FunctionType, ErrorCode } from '@zilliz/milvus2-sdk-node'
```

Constructor: add fields and params.

```ts
  private readonly hybridMode: boolean
  private readonly bm25RrfK: number
  private effectiveHybridMode = false

  constructor(config: {
    address: string
    token: string | undefined
    collection: string
    dim: number
    embeddingClient: EmbeddingClient
    hybridMode?: boolean
    bm25RrfK?: number
  }) {
    // ...existing assignments...
    this.hybridMode = config.hybridMode ?? false
    this.bm25RrfK = config.bm25RrfK ?? 60
    this.effectiveHybridMode = this.hybridMode
  }
```

In `initCollection()`, build the field list and function, and add the sparse index:

```ts
    const hybridFields: any[] = this.hybridMode
      ? [{ name: 'sparse_vector', data_type: DataType.SparseFloatVector }]
      : []

    await client.createCollection({
      collection_name: collection,
      fields: [
        { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: true },
        { name: 'vector', data_type: DataType.FloatVector, dim },
        { name: 'file_path', data_type: DataType.VarChar, max_length: 1024 },
        {
          name: 'code_content',
          data_type: DataType.VarChar,
          max_length: 65535,
          ...(this.hybridMode ? { type_params: { enable_analyzer: 'true' } } : {}),
        },
        { name: 'start_line', data_type: DataType.Int32 },
        { name: 'end_line', data_type: DataType.Int32 },
        { name: 'language', data_type: DataType.VarChar, max_length: 64 },
        { name: 'chunk_type', data_type: DataType.VarChar, max_length: 64 },
        { name: 'name', data_type: DataType.VarChar, max_length: 256 },
        ...hybridFields,
      ],
      enable_dynamic_field: true,
      ...(this.hybridMode
        ? {
            functions: [
              {
                name: 'bm25_fn',
                type: FunctionType.BM25,
                input_field_names: ['code_content'],
                output_field_names: ['sparse_vector'],
                params: {},
              },
            ],
          }
        : {}),
    } as any)

    // Dense index
    await client.createIndex({
      collection_name: collection,
      field_name: 'vector',
      metric_type: MetricType.COSINE,
      index_name: 'idx_vector',
    } as any)

    // Sparse BM25 index
    if (this.hybridMode) {
      await client.createIndex({
        collection_name: collection,
        field_name: 'sparse_vector',
        index_type: 'SPARSE_INVERTED_INDEX',
        metric_type: MetricType.BM25,
        index_name: 'idx_sparse_bm25',
      } as any)
    }

    await client.loadCollectionSync({
      collection_name: collection,
    })
```

- [ ] **Step 5: Run tests**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS (existing `creates collection when it does not exist` still passes — legacy default, no `functions`, no sparse index).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: hybrid collection schema with BM25 function field and sparse index"
```

---

### Task 3: Migration — rename legacy dense-only collection

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `client.describeCollection` (returns `{ schema: { fields: [{ name }] } }`), `client.renameCollection({ collection_name, new_collection_name })`.
- Produces: `ensureCollection()` migration branch — only when `hybridMode` is on and schema lacks `sparse_vector`.

- [ ] **Step 1: Write failing migration tests**

```ts
it('renames a legacy dense-only collection and recreates hybrid', async () => {
  mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
  mockDescribeCollection.mockResolvedValue({
    schema: { fields: [{ name: 'id' }, { name: 'vector' }, { name: 'code_content' }] },
  })
  mockRenameCollection.mockResolvedValue({ error_code: 'Success' })
  mockCreateCollection.mockResolvedValue({ error_code: 'Success' })
  mockCreateIndex.mockResolvedValue({ error_code: 'Success' })
  mockLoadCollectionSync.mockResolvedValue({ error_code: 'Success' })

  const service = new MilvusService({ ...defaultConfig, hybridMode: true })
  await service.ensureCollection()

  expect(mockRenameCollection).toHaveBeenCalledWith(
    expect.objectContaining({ collection_name: 'test_collection' }),
  )
  const newName = (mockRenameCollection.mock.calls[0][0] as any).new_collection_name
  expect(newName).toMatch(/^test_collection_legacy_\d+$/)
  expect(mockCreateCollection).toHaveBeenCalledTimes(1)
})

it('does not rename when the hybrid schema already exists', async () => {
  mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
  mockDescribeCollection.mockResolvedValue({
    schema: { fields: [{ name: 'id' }, { name: 'sparse_vector' }] },
  })

  const service = new MilvusService({ ...defaultConfig, hybridMode: true })
  await service.ensureCollection()

  expect(mockRenameCollection).not.toHaveBeenCalled()
  expect(mockCreateCollection).not.toHaveBeenCalled()
})

it('does not probe schema when hybridMode is off', async () => {
  mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

  const service = new MilvusService({ ...defaultConfig }) // hybridMode defaults false
  await service.ensureCollection()

  expect(mockDescribeCollection).not.toHaveBeenCalled()
  expect(mockRenameCollection).not.toHaveBeenCalled()
})
```

Add `mockDescribeCollection.mockReset()` / `mockRenameCollection.mockReset()` / `mockHybridSearch.mockReset()` to the `MilvusService` `beforeEach` block.

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts -t "legacy" --no-cache`
Expected: FAIL — first legacy test hits `undefined.schema` (describeCollection not implemented in service).

- [ ] **Step 3: Implement migration in `initCollection()`**

Replace the top of `initCollection()` (the existing `hasCollection` early-return block):

```ts
    // Wait for connection to be ready
    await client.connectPromise

    const hasRes = await client.hasCollection({ collection_name: collection })
    if (hasRes.value) {
      // Hybrid mode needs the BM25 sparse field. Detect a legacy dense-only
      // collection and rename it so we can recreate with the hybrid schema.
      if (this.hybridMode) {
        const desc = await client.describeCollection({ collection_name: collection })
        const fields = (desc?.schema?.fields ?? []) as Array<{ name: string }>
        const hasSparse = fields.some((f) => f.name === 'sparse_vector')
        if (!hasSparse) {
          const legacyName = `${collection}_legacy_${Date.now()}`
          console.log(
            `[dsh-context-milvus] 检测到旧版纯向量集合 "${collection}"，` +
              `已重命名为 "${legacyName}" 并重建混合索引。` +
              `请运行 index_code(mode=full) 重新索引。`,
          )
          await client.renameCollection({
            collection_name: collection,
            new_collection_name: legacyName,
          } as any)
          // fall through to create the hybrid collection under the original name
        } else {
          this.collectionReady = true
          return
        }
      } else {
        this.collectionReady = true
        return
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS — existing `does nothing when the collection already exists` test unaffected (hybridMode default false → no describe).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: migrate legacy dense-only collection on hybrid enable"
```

---

### Task 4: Fallback to legacy schema when hybrid creation fails

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `initCollection()` create path; `this.effectiveHybridMode`.
- Produces: On `createCollection` failure with hybrid, logs warning, sets `this.effectiveHybridMode = false`, recreates dense-only (fields without `code_content` analyzer / no function / no sparse index), then loads. `ensureCollection` never rejects for unsupported-hybrid servers.

- [ ] **Step 1: Write failing fallback test**

```ts
it('falls back to dense-only schema when hybrid creation is unsupported', async () => {
  mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: false })
  mockCreateCollection
    .mockRejectedValueOnce(new Error('function field not supported on this server'))
    .mockResolvedValueOnce({ error_code: 'Success' })
  mockCreateIndex.mockResolvedValue({ error_code: 'Success' })
  mockLoadCollectionSync.mockResolvedValue({ error_code: 'Success' })

  const service = new MilvusService({ ...defaultConfig, hybridMode: true })
  await service.ensureCollection() // must not throw

  expect(mockCreateCollection).toHaveBeenCalledTimes(2)
  const firstArgs = (mockCreateCollection.mock.calls[0][0] as any)
  const secondArgs = (mockCreateCollection.mock.calls[1][0] as any)
  expect(firstArgs.functions).toBeDefined()
  expect(secondArgs.functions).toBeUndefined()
  expect(secondArgs.fields.find((f: any) => f.name === 'code_content').type_params).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts -t "falls back" --no-cache`
Expected: FAIL — `ensureCollection` rejects / `createCollection` called once.

- [ ] **Step 3: Implement the fallback**

In `initCollection()`, extract the current create+index+load body into a private helper, then guard it:

```ts
  private async createCollectionWithSchema(): Promise<void> {
    // (the whole createCollection / createIndex / loadCollectionSync block from Task 2)
  }

  private async initCollection(): Promise<void> {
    const client = this.getClient()
    const { collection } = this

    await client.connectPromise

    const hasRes = await client.hasCollection({ collection_name: collection })
    if (hasRes.value) {
      // ... migration branch from Task 3 (unchanged) ...
    }

    if (!this.hybridMode) {
      await this.createCollectionWithSchema()
      this.collectionReady = true
      return
    }

    try {
      await this.createCollectionWithSchema()
    } catch (err) {
      // Server < 2.5: function fields unsupported. Retry with the legacy
      // dense-only schema and run this collection in dense mode.
      console.warn(
        `[dsh-context-milvus] 服务器不支持 BM25 function 字段，已降级为纯向量检索: ` +
          `${(err as Error).message}`,
      )
      this.effectiveHybridMode = false
      this.hybridMode = false
      await this.createCollectionWithSchema()
    }

    this.collectionReady = true
  }
```

Note: `createCollectionWithSchema()` must read `this.hybridMode`/`this.effectiveHybridMode` at call time (it uses `this.hybridMode` to decide fields/functions — already does). The dense path must **not** call `loadCollectionSync` twice; the helper owns the full sequence.

- [ ] **Step 4: Run tests**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: degrade to dense-only when server lacks BM25 support"
```

---

### Task 5: Hybrid search via `client.hybridSearch`

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `SearchSimpleReq`-adjacent `HybridSearchReq` shape, `RANKER_TYPE.RRF`, `this.effectiveHybridMode`, `this.bm25RrfK`.
- Produces: `search(query, topK, pathPrefix?)` branches — hybrid (hybridSearch) when effective, dense (`client.search`) otherwise — same `SearchResult[]` return shape.

- [ ] **Step 1: Write failing hybrid search test**

```ts
it('runs hybridSearch with dense + BM25 branches and RRF rerank', async () => {
  mockHybridSearch.mockResolvedValue({
    results: [
      {
        score: 0.5, id: '1', file_path: 'src/auth.ts',
        code_content: 'export function login() {}', start_line: 42, end_line: 45,
        language: 'typescript', chunk_type: 'function_declaration', name: 'login',
      },
    ],
    recalls: [], session_ts: 0, collection_name: 'test_collection',
  })

  const service = new MilvusService({ ...defaultConfig, hybridMode: true, bm25RrfK: 30 })
  const results = await service.search('login function', 5, '/workspace/proj')

  expect(mockHybridSearch).toHaveBeenCalledWith(
    expect.objectContaining({
      collection_name: 'test_collection',
      limit: 5,
      output_fields: ['file_path', 'code_content', 'start_line', 'end_line', 'language', 'chunk_type', 'name'],
      data: [
        { anns_field: 'vector', data: [0.1, 0.2, 0.3], params: { metric_type: 'COSINE' } },
        { anns_field: 'sparse_vector', data: 'login function', params: { metric_type: 'BM25' } },
      ],
      rerank: { strategy: 'rrf', params: { k: 30 } },
      filter: 'file_path like "/workspace/proj%"',
    }),
  )
  expect(results).toHaveLength(1)
  expect(results[0].name).toBe('login')
  expect(results[0].score).toBeCloseTo(0.5)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts -t "hybridSearch" --no-cache`
Expected: FAIL — `mockHybridSearch` not called (search still uses `client.search`).

- [ ] **Step 3: Implement hybrid search in `search()`**

Refactor the existing `search()` to branch after embedding:

```ts
    const vectors = await this.embeddingClient.embed([query])
    if (vectors.length === 0) return []
    const vector = vectors[0]

    const outputFields = [
      'file_path', 'code_content', 'start_line', 'end_line',
      'language', 'chunk_type', 'name',
    ]

    let response: any
    if (this.effectiveHybridMode) {
      response = await client.hybridSearch({
        collection_name: collection,
        data: [
          { anns_field: 'vector', data: vector, params: { metric_type: 'COSINE' } },
          { anns_field: 'sparse_vector', data: query, params: { metric_type: 'BM25' } },
        ],
        rerank: { strategy: RANKER_TYPE.RRF, params: { k: this.bm25RrfK } },
        limit: topK,
        output_fields: outputFields,
        ...(pathPrefix ? { filter: `file_path like "${pathPrefix}%"` } : {}),
      })
    } else {
      const searchParams: SearchSimpleReq = {
        collection_name: collection,
        vector,
        limit: topK,
        output_fields: outputFields,
      }
      if (pathPrefix) {
        searchParams.filter = `file_path like "${pathPrefix}%"`
      }
      response = await client.search(searchParams)
    }

    // Milvus returns SearchResultData[] for nq === 1; guard against the
    // nested form the SDK types allow for multi-vector hybrid queries.
    const raw = (response.results ?? []) as unknown
    const items = Array.isArray(raw) && raw.length > 0 && Array.isArray((raw as any[])[0])
      ? (raw as any[][]).flat()
      : (raw as any[])

    return items.map((item: any) => ({
      filePath: item.file_path ?? '',
      content: item.code_content ?? '',
      score: item.score,
      language: item.language ?? '',
      startLine: Number(item.start_line ?? 0),
      endLine: Number(item.end_line ?? 0),
      name: item.name ?? '',
      chunkType: item.chunk_type ?? '',
    }))
```

Update imports: add `RANKER_TYPE` to the milvus2-sdk-node import.

- [ ] **Step 4: Run full suite**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS — existing `search() returns formatted results` test unaffected (`defaultConfig` has no hybridMode → dense `client.search`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: hybrid search with dense + BM25 RRF fusion"
```

---

### Task 6: Wire plugin entry — always pass hybrid config

**Files:**
- Modify: `src/plugins/dsh-context-milvus/index.ts`
- Test: `test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `resolved.hybridMode`, `resolved.bm25RrfK` (Tasks 1).
- Produces: `MilvusService` constructed with `hybridMode` + `bm25RrfK` from resolved config.

- [ ] **Step 1: Update the constructor call in `apply()`**

```ts
  const milvus = new MilvusService({
    address: resolved.milvusAddress,
    token: resolved.milvusToken,
    collection: resolved.milvusCollection,
    dim: resolved.milvusDim,
    embeddingClient,
    hybridMode: resolved.hybridMode,
    bm25RrfK: resolved.bm25RrfK,
  })
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run full suite**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/dsh-context-remdb.spec.ts --no-cache`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/dsh-context-milvus/index.ts
git commit -m "feat: pass hybridMode and bm25RrfK from plugin config to service"
```

---

### Task 7: Documentation reconciliation

**Files:**
- Modify: `README.md`, `why-dsh-context-milvus.md`, `cordis-entry.yml`

The feature now exists; text that said BM25 was "预留开关/尚未实现" must be reversed, and the new `bm25RrfK` field documented.

- [ ] **Step 1: Update `README.md`**

- Config table row (line ~83): replace
  `| \`hybridMode\` | boolean | \`true\` | 预留开关，BM25 融合尚未实现（当前仅向量检索） |`
  with
  `| \`hybridMode\` | boolean | \`true\` | 启用混合检索（BM25 全文 + 向量语义，RRF 融合） |`
- Add row after it:
  `| \`bm25RrfK\` | number | \`60\` | 混合检索 RRF 融合参数 k |`
- In `## 功能` add a bullet: `- **混合检索** — BM25 关键词 + 向量语义双路检索，RRF 融合，`hybridMode` 控制开关`
- In the env-var block add: `export BM25_RRF_K=60`
- In `config.example` yaml block add `bm25RrfK: 60`

- [ ] **Step 2: Update `why-dsh-context-milvus.md`**

- §2 note (line ~21): replace
  `> 注：BM25 关键词融合尚未实现，\`hybridMode\` 是预留开关——当前所有检索都是纯向量相似度。`
  with
  `> 注：BM25 关键词融合已实现——Milvus 原生 BM25 全文检索与向量语义双路检索，RRF 融合（\`hybridMode\` 默认开启）。`
- §4 workflow step 2 (line ~47): `发起**语义（向量）检索**` → `发起**混合检索**（向量语义 + BM25 关键词，RRF 融合）`
- Config table `hybridMode` row (line ~91): `预留开关，BM25 融合尚未实现（当前仅向量检索）` → `启用混合检索（BM25 全文 + 向量语义，RRF 融合）`; add row `| \`bm25RrfK\` | \`BM25_RRF_K\` | number | \`60\` | RRF 融合参数 k |`

- [ ] **Step 3: Update `cordis-entry.yml`**

- `hybridMode` row (line ~48): `预留开关，BM25 融合尚未实现（当前仅向量检索）` → `启用混合检索（BM25 全文 + 向量语义，RRF 融合）`
- Add row `| \`bm25RrfK\` | number | \`60\` | RRF 融合参数 k |`

- [ ] **Step 4: Spot-check remaining claims**

Run: `grep -rn "BM25 融合尚未实现\|未实现\|预留开关" README.md why-dsh-context-milvus.md cordis-entry.yml CLAUDE.md || echo clean`
Expected: no output (or only user-facing caveats that are still true).

- [ ] **Step 5: Commit**

```bash
git add README.md why-dsh-context-milvus.md cordis-entry.yml
git commit -m "docs: document BM25 hybrid search as implemented, add bm25RrfK"
```

---

### Task 8: End-to-end verification (manual, live server)

**Files:** none (uses `scripts/` ad hoc — do not commit)

Verify the full chain against the real Milvus at `localhost:19530`:

- [ ] **Step 1: Build + start fresh collection**
  - Run: `npm run build`
  - Write a throwaway script (repo root, delete after) that imports `dist/plugins/dsh-context-milvus/milvus-service.js`, constructs with `hybridMode: true`, calls `ensureCollection()`, then `insertChunks()` on 3–4 code chunks.
- [ ] **Step 2: Confirm collection created with hybrid schema**
  - `describeCollection` via the SDK → schema has `sparse_vector` + function; index list contains `idx_sparse_bm25`.
- [ ] **Step 3: Search returns RRF-fused ranks**
  - `search('how do users log in and authenticate', 5)` returns the login chunk ranked #1 when the embedding would favour another chunk (same check the spike performed).
- [ ] **Step 4: Migration smoke**
  - Rename path already exercised by Task 3 tests; optionally re-run `ensureCollection()` with the pre-existing `code_embeddings` collection to observe rename → recreate → INFO log.
- [ ] **Step 5: Cleanup**
  - Drop the throwaway test collection; `rm` the script. Confirm `git status` clean for untracked scratch files.

---

## Self-Review

- **Spec coverage:** schema (Task 2 ✓), search branches (Task 5 ✓), migration (Task 3 ✓), fallback (Task 4 ✓), config `hybridMode`/`bm25RrfK` (Tasks 1+6 ✓), docs (Task 7 ✓), live verification (Task 8 ✓). Non-goals respected (no weighted fusion, no k1/b tuning, no analyzer customization, no data migration).
- **Placeholders:** none — every test and code block is concrete.
- **Type consistency:** `bm25RrfK` (config) — `bm25RrfK` (MilvusService constructor) — `params.k` (RRF) stay consistent; `effectiveHybridMode` set in constructor (Task 2) and flipped in fallback (Task 4); `RANKER_TYPE.RRF` imported in Task 5; mock exports extended once in Task 2 and reused by Tasks 3–5.