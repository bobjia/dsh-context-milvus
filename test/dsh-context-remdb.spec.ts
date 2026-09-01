/**
 * dsh-context-milvus tests
 *
 * Covers: config, merkle, chunker, embedding, milvus-service, and formatting helpers.
 * Uses jest.unstable_mockModule for ESM compatibility.
 */

import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

// ═════════════════════════════════════════════════════════════════════════
// Mock @zilliz/milvus2-sdk-node
// ═════════════════════════════════════════════════════════════════════════

const mockConnectPromise = Promise.resolve()
const mockHasCollection = jest.fn()
const mockCreateCollection = jest.fn()
const mockCreateIndex = jest.fn()
const mockLoadCollectionSync = jest.fn()
const mockInsert = jest.fn()
const mockDelete = jest.fn()
const mockSearch = jest.fn()
const mockDescribeCollection = jest.fn()
const mockHybridSearch = jest.fn()
const mockRenameCollection = jest.fn()

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({
    connectPromise: mockConnectPromise,
    hasCollection: mockHasCollection,
    createCollection: mockCreateCollection,
    createIndex: mockCreateIndex,
    loadCollectionSync: mockLoadCollectionSync,
    insert: mockInsert,
    delete: mockDelete,
    search: mockSearch,
    describeCollection: mockDescribeCollection,
    hybridSearch: mockHybridSearch,
    renameCollection: mockRenameCollection,
  })),
  DataType: {
    None: 0,
    Bool: 1,
    Int8: 2,
    Int16: 3,
    Int32: 4,
    Int64: 5,
    Float: 10,
    Double: 11,
    VarChar: 21,
    Array: 22,
    JSON: 23,
    Geometry: 24,
    Text: 25,
    Timestamptz: 26,
    BinaryVector: 100,
    FloatVector: 101,
    Float16Vector: 102,
    BFloat16Vector: 103,
    SparseFloatVector: 104,
    Int8Vector: 105,
    ArrayOfVector: 106,
    Struct: 201,
  },
  MetricType: {
    L2: 'L2',
    IP: 'IP',
    COSINE: 'COSINE',
    BM25: 'BM25',
  },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf', WEIGHTED: 'weighted' },
  ErrorCode: {
    SUCCESS: 'Success',
    IndexNotExist: 'IndexNotExist',
    UnexpectedError: 'UnexpectedError',
  },
}))

// Helper to create a mock EmbeddingClient
function mockEmbeddingClient(vectors: number[][] = [[0.1, 0.2, 0.3]]): any {
  return { embed: jest.fn().mockResolvedValue(vectors) }
}

// Dynamic imports after mocking
const { getConfig } = await import('../src/plugins/dsh-context-milvus/config.js')
const { HashTracker } = await import('../src/plugins/dsh-context-milvus/merkle.js')
const { MilvusService } = await import('../src/plugins/dsh-context-milvus/milvus-service.js')
const { EmbeddingClient } = await import('../src/plugins/dsh-context-milvus/embedding.js')
const { runIndex, getIndexStatus } = await import('../src/plugins/dsh-context-milvus/indexer.js')

// ═════════════════════════════════════════════════════════════════════════
// getConfig
// ═════════════════════════════════════════════════════════════════════════

describe('getConfig()', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...OLD_ENV }
    delete process.env.MILVUS_ADDRESS
    delete process.env.MILVUS_TOKEN
    delete process.env.MILVUS_COLLECTION
    delete process.env.MILVUS_EMBEDDING_DIM
    delete process.env.INDEX_ROOT
    delete process.env.INDEX_EXTENSIONS
    delete process.env.HYBRID_MODE
    delete process.env.BM25_RRF_K
    })

  afterAll(() => {
    process.env = OLD_ENV
  })

  it('returns default values when no env vars are set', () => {
    const config = getConfig()
    expect(config.milvusAddress).toBe('localhost:19530')
    expect(config.milvusToken).toBeUndefined()
    expect(config.milvusCollection).toBe('code_embeddings')
    expect(config.milvusDim).toBe(768)
    expect(config.hybridMode).toBe(true)
    expect(config.indexExtensions.length).toBeGreaterThan(0)
    expect(config.embedding.endpoint).toBe('http://localhost:11434/api/embed')
    expect(config.embedding.model).toBe('nomic-embed-text')
    expect(config.embedding.dim).toBe(768)
  })

  it('reads values from environment variables', () => {
    process.env.MILVUS_ADDRESS = 'custom:19530'
    process.env.MILVUS_TOKEN = 'my-token'
    process.env.MILVUS_COLLECTION = 'my_codes'
    process.env.MILVUS_EMBEDDING_DIM = '1024'
    process.env.HYBRID_MODE = 'false'

    const config = getConfig()
    expect(config.milvusAddress).toBe('custom:19530')
    expect(config.milvusToken).toBe('my-token')
    expect(config.milvusCollection).toBe('my_codes')
    expect(config.milvusDim).toBe(1024)
    expect(config.hybridMode).toBe(false)
  })

  it('uses INDEX_EXTENSIONS for custom file types', () => {
    process.env.INDEX_EXTENSIONS = '.vue,.svelte,.astro'
    const config = getConfig()
    expect(config.indexExtensions).toEqual(['.vue', '.svelte', '.astro'])
  })

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

  it('Cordis config overrides environment variables', () => {
    process.env.MILVUS_ADDRESS = 'env:19530'
    process.env.MILVUS_COLLECTION = 'env_collection'

    const config = getConfig({
      milvusAddress: 'config:19530',
      milvusCollection: 'config_collection',
    })

    expect(config.milvusAddress).toBe('config:19530')
    expect(config.milvusCollection).toBe('config_collection')
  })

  it('merges partial Cordis config with env var defaults', () => {
    process.env.MILVUS_ADDRESS = 'env:19530'

    const config = getConfig({
      milvusCollection: 'custom_collection',
    })

    expect(config.milvusAddress).toBe('env:19530') // from env
    expect(config.milvusCollection).toBe('custom_collection') // from config
  })

  it('sets adrEnabled default to false', () => {
    const cfg = getConfig()
    expect(cfg.adrEnabled).toBe(false)
  })

  it('sets adrConstraintReinjectEvery default to 0', () => {
    const cfg = getConfig()
    expect(cfg.adrConstraintReinjectEvery).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// HashTracker (Merkle)
// ═════════════════════════════════════════════════════════════════════════

describe('HashTracker', () => {
  let tempDir: string
  let tracker: HashTracker

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'milvus-test-'))
    tracker = new HashTracker(path.join(tempDir, 'merkle.json'))
  })

  afterEach(async () => {
    // Cleanup handled by OS temp dir
  })

  it('starts with empty state', async () => {
    const loaded = await tracker.load()
    expect(loaded).toBe(false)
    expect(tracker.getStats()).toEqual({ totalFiles: 0, totalChunks: 0 })
  })

  it('computes delta for new files', () => {
    const files = new Map([
      ['/src/a.ts', 'hash-a'],
      ['/src/b.ts', 'hash-b'],
    ])
    const delta = tracker.computeDelta(files)
    expect(delta.toIndex).toEqual(['/src/a.ts', '/src/b.ts'])
    expect(delta.toRemove).toEqual([])
    expect(delta.unchanged).toEqual([])
  })

  it('detects modified files', async () => {
    // First index
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    await tracker.save()

    // Reload
    const tracker2 = new HashTracker(path.join(tempDir, 'merkle.json'))
    await tracker2.load()

    // b.ts changed
    const files = new Map([
      ['/src/a.ts', 'hash-a'],
      ['/src/b.ts', 'hash-b-modified'],
    ])
    const delta = tracker2.computeDelta(files)
    expect(delta.toIndex).toEqual(['/src/b.ts'])
    expect(delta.toRemove).toEqual([])
    expect(delta.unchanged).toEqual(['/src/a.ts'])
  })

  it('detects deleted files', () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)

    const files = new Map([['/src/a.ts', 'hash-a']])
    const delta = tracker.computeDelta(files)
    expect(delta.toIndex).toEqual([])
    expect(delta.toRemove).toEqual(['/src/b.ts'])
    expect(delta.unchanged).toEqual(['/src/a.ts'])
  })

  it('persists and reloads state', async () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    await tracker.save()

    const tracker2 = new HashTracker(path.join(tempDir, 'merkle.json'))
    const loaded = await tracker2.load()
    expect(loaded).toBe(true)
    expect(tracker2.getStats()).toEqual({ totalFiles: 2, totalChunks: 5 })
  })

  it('removes specific records', () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    tracker.removeRecords(['/src/a.ts'])
    expect(tracker.getStats()).toEqual({ totalFiles: 1, totalChunks: 2 })
  })

  it('computes hash of content', () => {
    const hash1 = HashTracker.hashContent('hello world')
    const hash2 = HashTracker.hashContent('hello world')
    const hash3 = HashTracker.hashContent('hello world!')
    expect(hash1).toBe(hash2)
    expect(hash1).not.toBe(hash3)
    expect(hash1.length).toBe(64) // SHA-256 hex
  })
})

// ═════════════════════════════════════════════════════════════════════════
// EmbeddingClient
// ═════════════════════════════════════════════════════════════════════════

describe('EmbeddingClient', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns embeddings from OpenAI-compatible API', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      }),
    })

    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })

    const vectors = await client.embed(['hello', 'world'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3])
    expect(vectors[1]).toEqual([0.4, 0.5, 0.6])
  })

  it('returns embeddings from Ollama API', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        model: 'nomic-embed-text',
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    })

    const client = new EmbeddingClient({
      endpoint: 'http://localhost:11434/api/embed',
      model: 'nomic-embed-text',
      dim: 768,
    })

    const vectors = await client.embed(['hello', 'world'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3])
    expect(vectors[1]).toEqual([0.4, 0.5, 0.6])
  })

  it('returns empty array for empty input', async () => {
    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })
    const vectors = await client.embed([])
    expect(vectors).toEqual([])
  })

  it('throws on API error', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('invalid api key'),
    })

    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })

    await expect(client.embed(['test'])).rejects.toThrow('Embedding API error')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// MilvusService
// ═════════════════════════════════════════════════════════════════════════

describe('MilvusService', () => {
  const defaultConfig = {
    address: 'localhost:19530',
    token: undefined as string | undefined,
    collection: 'test_collection',
    dim: 768,
    embeddingClient: mockEmbeddingClient(),
  }

  beforeEach(() => {
    mockHasCollection.mockReset()
    mockCreateCollection.mockReset()
    mockCreateIndex.mockReset()
    mockLoadCollectionSync.mockReset()
    mockInsert.mockReset()
    mockDelete.mockReset()
    mockSearch.mockReset()
    mockDescribeCollection.mockReset()
    mockHybridSearch.mockReset()
    mockRenameCollection.mockReset()
  })

  describe('ensureCollection()', () => {
    it('does nothing when the collection already exists', async () => {
      mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

      const service = new MilvusService(defaultConfig)
      await service.ensureCollection()

      expect(mockHasCollection).toHaveBeenCalledWith({ collection_name: 'test_collection' })
      expect(mockCreateCollection).not.toHaveBeenCalled()
      expect(mockCreateIndex).not.toHaveBeenCalled()
      expect(mockLoadCollectionSync).not.toHaveBeenCalled()
    })

    it('creates collection when it does not exist', async () => {
      mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: false })
      mockCreateCollection.mockResolvedValue({ error_code: 'Success' })
      mockCreateIndex.mockResolvedValue({ error_code: 'Success' })
      mockLoadCollectionSync.mockResolvedValue({ error_code: 'Success' })

      const service = new MilvusService(defaultConfig)
      await service.ensureCollection()

      expect(mockCreateCollection).toHaveBeenCalledTimes(1)
      const callArgs = (mockCreateCollection.mock.calls[0] as any[])[0] as any
      expect(callArgs.collection_name).toBe('test_collection')
      // Verify fields include vector field with correct dimension
      const vectorField = callArgs.fields.find((f: any) => f.name === 'vector')
      expect(vectorField).toBeDefined()
      expect(vectorField.dim).toBe(768)

      expect(mockCreateIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          collection_name: 'test_collection',
          field_name: 'vector',
          metric_type: 'COSINE',
        }),
      )
      expect(mockLoadCollectionSync).toHaveBeenCalledWith({
        collection_name: 'test_collection',
      })
    })

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
  })

  describe('search()', () => {
    it('returns formatted results', async () => {
      mockSearch.mockResolvedValue({
        results: [
          {
            score: 0.9,
            id: '1',
            file_path: 'src/auth.ts',
            code_content: 'export function login() {}',
            start_line: 42,
            end_line: 45,
            language: 'typescript',
            chunk_type: 'function_declaration',
            name: 'login',
          },
        ],
        recalls: [],
        session_ts: 0,
        collection_name: 'test_collection',
      })

      const service = new MilvusService(defaultConfig)
      const results = await service.search('login', 5)

      // The search method should first embed the query, then call client.search()
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          collection_name: 'test_collection',
          limit: 5,
        }),
      )
      expect(results).toHaveLength(1)
      expect(results[0].filePath).toBe('src/auth.ts')
      expect(results[0].score).toBeCloseTo(0.9)
      expect(results[0].name).toBe('login')
    })

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
  })

  describe('insertChunks()', () => {
    it('inserts chunks in batches', async () => {
      mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })

      const service = new MilvusService(defaultConfig)
      const count = await service.insertChunks([
        {
          filePath: 'src/test.ts',
          content: 'function foo() {}',
          startLine: 1,
          endLine: 3,
          language: 'typescript',
          chunkType: 'function_declaration',
          name: 'foo',
          vector: [0.1, 0.2, 0.3],
        },
      ])

      expect(count).toBe(1)
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })

    it('returns 0 for empty input', async () => {
      const service = new MilvusService(defaultConfig)
      const count = await service.insertChunks([])
      expect(count).toBe(0)
      expect(mockInsert).not.toHaveBeenCalled()
    })
  })

  describe('deleteByFilePath()', () => {
    it('deletes by file path filter', async () => {
      mockDelete.mockResolvedValue({ delete_cnt: '3', succ_index: [0], err_index: [] })

      const service = new MilvusService(defaultConfig)
      const count = await service.deleteByFilePath('src/test.ts')

      expect(count).toBe(3)
      expect(mockDelete).toHaveBeenCalledWith({
        collection_name: 'test_collection',
        filter: 'file_path == "src/test.ts"',
      })
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// MilvusService ADR collection
// ═════════════════════════════════════════════════════════════════════════

describe('MilvusService ADR collection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasCollection.mockResolvedValue({ value: false })
    mockCreateCollection.mockResolvedValue({})
    mockCreateIndex.mockResolvedValue({})
    mockLoadCollectionSync.mockResolvedValue({})
  })

  it('ensures ADR collection with correct schema', async () => {
    const embedding = mockEmbeddingClient()
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    // Set adrCollection
    ;(service as any).adrCollection = 'adr_embeddings'

    await service.ensureAdrCollection()

    expect(mockCreateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: 'adr_embeddings',
      }),
    )
    // Verify ADR-specific fields exist
    const callArgs = mockCreateCollection.mock.calls[0][0]
    const fieldNames = callArgs.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('adr_id')
    expect(fieldNames).toContain('status')
    expect(fieldNames).toContain('section')
    expect(fieldNames).toContain('code_anchors')
    expect(fieldNames).toContain('trigger_type')
  })

  it('falls back to dense-only ADR schema when hybrid creation is unsupported', async () => {
    mockCreateCollection
      .mockRejectedValueOnce(new Error('function field not supported on this server'))
      .mockResolvedValueOnce({})
    mockCreateIndex.mockResolvedValue({})
    mockLoadCollectionSync.mockResolvedValue({})

    const embedding = mockEmbeddingClient()
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: true,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    await service.ensureAdrCollection() // must not throw

    expect(mockCreateCollection).toHaveBeenCalledTimes(2)
    const firstArgs = mockCreateCollection.mock.calls[0][0]
    const secondArgs = mockCreateCollection.mock.calls[1][0]
    expect(firstArgs.functions).toBeDefined()
    expect(secondArgs.functions).toBeUndefined()
    const contentField = secondArgs.fields.find((f: any) => f.name === 'content')
    expect(contentField.type_params).toBeUndefined()
  })

  it('inserts ADR chunks with vectors', async () => {
    mockInsert.mockResolvedValue({ insert_cnt: 2 })
    const embedding = mockEmbeddingClient([[0.1, 0.2], [0.3, 0.4]])
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    const chunks = [
      { filePath: '/doc.md', adrId: 'ADR-0001', section: 'goal', content: 'text', startLine: 1, endLine: 2, status: 'active', codeAnchors: ['src/a.ts'], triggerType: 'refactor', vector: [0.1, 0.2] },
      { filePath: '/doc.md', adrId: 'ADR-0001', section: 'constraints', content: 'text2', startLine: 3, endLine: 4, status: 'active', codeAnchors: ['src/a.ts'], triggerType: 'refactor', vector: [0.3, 0.4] },
    ]
    const count = await service.insertAdrChunks(chunks as any)
    expect(count).toBe(2)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: 'adr_embeddings' }),
    )
  })

  it('searches ADR collection', async () => {
    const embedding = mockEmbeddingClient([[0.1, 0.2, 0.3]])
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    mockSearch.mockResolvedValue({
      results: [{
        adr_id: 'ADR-0001',
        file_path: '/doc.md',
        status: 'active',
        section: 'goal',
        content: 'text',
        score: 0.95,
        trigger_type: 'refactor',
        code_anchors: '["src/a.ts"]',
      }],
    })

    const results = await service.searchAdr('test query', 5)
    expect(results).toHaveLength(1)
    expect(results[0].adrId).toBe('ADR-0001')
    expect(results[0].content).toBe('text')
    expect(results[0].score).toBe(0.95)
  })

  it('deletes ADR chunks by file path', async () => {
    mockDelete.mockResolvedValue({ delete_cnt: 3 })
    const embedding = mockEmbeddingClient()
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    const count = await service.deleteAdrByFilePath('/doc.md')
    expect(count).toBe(3)
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: 'adr_embeddings',
        filter: 'file_path == "/doc.md"',
      }),
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Chunker (tree-sitter integration test)
// ═════════════════════════════════════════════════════════════════════════

describe('chunkCode (tree-sitter)', () => {
  it('extracts functions from TypeScript code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
function hello(name: string): string {
  return "Hello " + name;
}

class Greeter {
  greet(name: string) {
    return "Hi " + name;
  }
}
`
    const chunks = await chunkCode('/tmp/test.ts', code, '.ts')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'hello')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_declaration')
    expect(func!.content).toContain('function hello')

    const method = chunks.find((c) => c.name === 'greet')
    expect(method).toBeDefined()
    expect(method!.chunkType).toBe('method_definition')
  })

  it('extracts functions from Python code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
def hello(name):
    return f"Hello {name}"

class Greeter:
    def greet(self, name):
        return f"Hi {name}"
`
    const chunks = await chunkCode('/tmp/test.py', code, '.py')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'hello')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_definition')

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_definition')
  })

  it('extracts functions from Rust code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
fn main() {
    println!("Hello");
}

struct User {
    name: String,
}
`
    const chunks = await chunkCode('/tmp/test.rs', code, '.rs')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'main')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_item')
  })

  it('extracts classes and methods from Java code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
public class Greeter {
    private String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet(String greeting) {
        return greeting + " " + this.name;
    }
}

interface Logger {
    void log(String message);
}
`
    const chunks = await chunkCode('/tmp/test.java', code, '.java')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_declaration')

    const method = chunks.find((c) => c.name === 'greet')
    expect(method).toBeDefined()
    expect(method!.chunkType).toBe('method_declaration')
  })

  it('extracts functions and types from Go code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
package main

func hello(name string) string {
    return "Hello " + name
}

type User struct {
    Name string
    Age  int
}

func (u *User) Greet() string {
    return "Hi " + u.Name
}
`
    const chunks = await chunkCode('/tmp/test.go', code, '.go')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func_ = chunks.find((c) => c.name === 'hello')
    expect(func_).toBeDefined()
    expect(func_!.chunkType).toBe('function_declaration')

    const method = chunks.find((c) => c.name === 'Greet')
    expect(method).toBeDefined()
    expect(method!.chunkType).toBe('method_declaration')
  })

  it('extracts functions and classes from C++ code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
#include <string>

class Greeter {
private:
    std::string name;

public:
    Greeter(const std::string& name) : name(name) {}

    std::string greet(const std::string& greeting) {
        return greeting + " " + name;
    }
};

namespace utils {
    int add(int a, int b) {
        return a + b;
    }
}
`
    const chunks = await chunkCode('/tmp/test.cpp', code, '.cpp')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_specifier')
  })

  it('extracts classes and methods from C# code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
using System;

namespace HelloWorld
{
    public class Greeter
    {
        private string name;

        public Greeter(string name)
        {
            this.name = name;
        }

        public string Greet(string greeting)
        {
            return greeting + " " + name;
        }
    }

    public interface ILogger
    {
        void Log(string message);
    }
}
`
    const chunks = await chunkCode('/tmp/test.cs', code, '.cs')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_declaration')

    const iface = chunks.find((c) => c.name === 'ILogger')
    expect(iface).toBeDefined()
    expect(iface!.chunkType).toBe('interface_declaration')
  })

  it('extracts classes and methods from Scala code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `
class Greeter(name: String) {
    def greet(greeting: String): String = {
        greeting + " " + name
    }
}

trait Logger {
    def log(message: String): Unit
}

object Main {
    def main(args: Array[String]): Unit = {
        println("Hello")
    }
}
`
    const chunks = await chunkCode('/tmp/test.scala', code, '.scala')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_definition')

    const trait_ = chunks.find((c) => c.name === 'Logger')
    expect(trait_).toBeDefined()
    expect(trait_!.chunkType).toBe('trait_definition')
  })

  it('extracts functions, classes, and interfaces from PHP code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const code = `<?php

function greet(string $name): string {
    return "Hello " . $name;
}

class Greeter {
    public function sayHello(string $name): string {
        return "Hi " . $name;
    }
}

interface Logger {
    public function log(string $message): void;
}

trait Loggable {
    public function log(string $message): void {
        echo $message;
    }
}

enum Status {
    case Active;
    case Inactive;
}
`
    const chunks = await chunkCode('/tmp/test.php', code, '.php')
    expect(chunks.length).toBeGreaterThanOrEqual(5)

    const func = chunks.find((c) => c.name === 'greet')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_definition')

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_declaration')

    const iface = chunks.find((c) => c.name === 'Logger')
    expect(iface).toBeDefined()
    expect(iface!.chunkType).toBe('interface_declaration')

    const trait = chunks.find((c) => c.name === 'Loggable')
    expect(trait).toBeDefined()
    expect(trait!.chunkType).toBe('trait_declaration')

    const enumType = chunks.find((c) => c.name === 'Status')
    expect(enumType).toBeDefined()
    expect(enumType!.chunkType).toBe('enum_declaration')
  })

  it('returns empty array for code with no chunkable structures', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    const chunks = await chunkCode('/tmp/test.ts', 'const x = 1;', '.ts')
    expect(chunks).toEqual([])
  })

  it('throws for unsupported extension', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

    await expect(chunkCode('/tmp/test.xyz', 'some content', '.xyz')).rejects.toThrow(
      'Unsupported file extension',
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Indexer pipeline — runIndex
// ═════════════════════════════════════════════════════════════════════════

/** Create a temp directory and populate it with files */
async function createTestDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'index-test-'))
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }
  return dir
}

/**
 * Create a smart fetch mock that returns one embedding vector per input text.
 * Used by the real EmbeddingClient inside runIndex().
 */
function createFetchMock(): jest.Mock {
  return jest.fn().mockImplementation(async (_url: string, _options: any) => {
    let numInputs = 1
    try {
      const body = JSON.parse(_options?.body ?? '{}')
      if (Array.isArray(body.input)) {
        numInputs = body.input.length
      }
    } catch {
      // fallback to 1
    }

    const data = Array.from({ length: numInputs }, (_, i) => ({
      embedding: [0.1 + i * 0.1, 0.2 + i * 0.1, 0.3 + i * 0.1],
    }))

    return {
      ok: true,
      json: () => Promise.resolve({ data }),
    }
  })
}

describe('runIndex()', () => {
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = createFetchMock()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockHasCollection.mockReset()
    mockCreateCollection.mockReset()
    mockCreateIndex.mockReset()
    mockLoadCollectionSync.mockReset()
    mockInsert.mockReset()
    mockDelete.mockReset()
    mockSearch.mockReset()
    mockDescribeCollection.mockReset()
    mockHybridSearch.mockReset()
    mockRenameCollection.mockReset()
  })

  // ── Full mode ─────────────────────────────────────────────────────────

  it('full mode: indexes all files in the directory', async () => {
    const tempDir = await createTestDir({
      'greeter.ts': `
function greet(name: string): string {
  return "Hello " + name;
}
`,
      'math.ts': `
function add(a: number, b: number): number {
  return a + b;
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, milvus, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(2)
    expect(result.chunksIndexed).toBe(2)
    expect(result.filesRemoved).toBe(0)
    expect(result.filesSkipped).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(tracker.getStats().totalFiles).toBe(2)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('full mode: re-indexes all files even if already indexed', async () => {
    const tempDir = await createTestDir({
      'hello.ts': `
function hello(): void {
  console.log("hello");
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, milvus, tracker, { mode: 'full' })
    expect(result1.filesIndexed).toBe(1)

    const result2 = await runIndex(config, milvus, tracker, { mode: 'full' })
    expect(result2.filesIndexed).toBe(1)
    expect(result2.filesSkipped).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('full mode: indexes multiple file types (ts, py, rs)', async () => {
    const tempDir = await createTestDir({
      'main.ts': `
function main(): void {
  console.log("hello");
}
`,
      'utils.py': `
def add(a, b):
    return a + b
`,
      'lib.rs': `
fn compute(x: i32) -> i32 {
    x * 2
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, milvus, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(3)
    expect(result.chunksIndexed).toBe(3)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Incremental mode ─────────────────────────────────────────────────

  it('incremental mode: first run indexes all files', async () => {
    const tempDir = await createTestDir({
      'app.ts': `
function run(): void {
  // do something
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockResolvedValue({ delete_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(1)
    expect(result.filesSkipped).toBe(0)
    expect(result.filesRemoved).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: skips unchanged files on second run', async () => {
    const tempDir = await createTestDir({
      'stable.ts': `
function stable(): string {
  return "I never change";
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockResolvedValue({ delete_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(1)

    const result2 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(0)
    expect(result2.filesSkipped).toBe(1)
    expect(result2.filesRemoved).toBe(0)
    expect(mockInsert).toHaveBeenCalledTimes(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: detects modified file and re-indexes it', async () => {
    const tempDir = await createTestDir({
      'changing.ts': `
function original(): string {
  return "original";
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockResolvedValue({ delete_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(1)

    await writeFile(
      path.join(tempDir, 'changing.ts'),
      `
function updated(): string {
  return "updated";
}
`,
      'utf-8',
    )

    mockInsert.mockClear()
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockClear()
    mockDelete.mockResolvedValue({ delete_cnt: '1', succ_index: [0], err_index: [] })

    const result2 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(1)
    expect(result2.filesSkipped).toBe(0)
    expect(result2.filesRemoved).toBe(0)
    expect(mockInsert).toHaveBeenCalledTimes(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: detects deleted file and removes from index', async () => {
    const tempDir = await createTestDir({
      'keep.ts': `
function keep(): string {
  return "keep me";
}
`,
      'remove.ts': `
function remove(): string {
  return "remove me";
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockResolvedValue({ delete_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(2)

    await rm(path.join(tempDir, 'remove.ts'))

    mockInsert.mockClear()
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })
    mockDelete.mockClear()

    const result2 = await runIndex(config, milvus, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(0)
    expect(result2.filesSkipped).toBe(1)
    expect(result2.filesRemoved).toBe(1)
    expect(result2.chunksRemoved).toBe(1)
    expect(tracker.getStats().totalFiles).toBe(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Edge cases ───────────────────────────────────────────────────────

  it('handles an empty directory', async () => {
    const tempDir = await createTestDir({})

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, milvus, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(result.filesRemoved).toBe(0)
    expect(result.filesSkipped).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('skips files with no chunkable structures but records hash', async () => {
    const tempDir = await createTestDir({
      'empty.ts': 'const x = 1;',
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, milvus, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(tracker.getStats().totalFiles).toBe(1)
    expect(tracker.getStats().totalChunks).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('ignores files with unsupported extensions', async () => {
    const tempDir = await createTestDir({
      'data.txt': 'hello world',
      'notes.md': '# Readme',
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, milvus, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('skips hidden directories and node_modules', async () => {
    const tempDir = await createTestDir({
      'src/a.ts': `
function a(): void {}
`,
      'node_modules/b.ts': `
function b(): void {}
`,
      '.hidden/c.ts': `
function c(): void {}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })
    mockInsert.mockResolvedValue({ insert_cnt: '1', succ_index: [0], err_index: [] })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, milvus, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Error handling ───────────────────────────────────────────────────

  it('handles embedding API failure gracefully', async () => {
    const tempDir = await createTestDir({
      'broken.ts': `
function broken(): void {
  throw new Error("broken");
}
`,
    })

    mockHasCollection.mockResolvedValue({ status: { error_code: 'Success' }, value: true })

    const milvus = new MilvusService({
      address: 'localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    // Make the embedding API fail
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error'),
    })

    const errors: string[] = []
    const result = await runIndex(config, milvus, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(result.filesIndexed).toBe(0)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]).toContain('失败')
    expect(tracker.getStats().totalFiles).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// getIndexStatus
// ═════════════════════════════════════════════════════════════════════════

describe('getIndexStatus()', () => {
  it('returns empty state when no files have been indexed', async () => {
    const tempDir = await createTestDir({})
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(0)
    expect(status.totalChunks).toBe(0)
    expect(status.lastIndexed).toBeUndefined()
    expect(status.indexedExtensions.length).toBeGreaterThan(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns correct stats after indexing', async () => {
    const tempDir = await createTestDir({
      'a.ts': `
function a(): void {}
`,
      'b.ts': `
function b(): void {}
`,
    })

    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    tracker.updateRecord(
      path.join(tempDir, 'a.ts'),
      'hash-a',
      3,
    )
    tracker.updateRecord(
      path.join(tempDir, 'b.ts'),
      'hash-b',
      2,
    )
    await tracker.save()

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(2)
    expect(status.totalChunks).toBe(5)
    expect(status.lastIndexed).toBeDefined()
    expect(typeof status.lastIndexed).toBe('string')
    expect(status.indexedExtensions).toContain('.ts')

    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns undefined lastIndexed when tracker has no records', async () => {
    const tempDir = await createTestDir({})
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(0)
    expect(status.lastIndexed).toBeUndefined()

    await rm(tempDir, { recursive: true, force: true })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// IgnoreMatcher
// ═════════════════════════════════════════════════════════════════════════

describe('IgnoreMatcher', () => {
  it('ignores node_modules directory', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**', 'node_modules'])
    expect(m.ignores('node_modules/some/file.js', false)).toBe(true)
    expect(m.ignores('node_modules', true)).toBe(true)
  })

  it('ignores .git directory', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['.git/**', '.git'])
    expect(m.ignores('.git/HEAD', false)).toBe(true)
    expect(m.ignores('.git', true)).toBe(true)
  })

  it('does not ignore source files', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**', '.git/**'])
    expect(m.ignores('src/index.ts', false)).toBe(false)
    expect(m.ignores('src/utils/helper.ts', false)).toBe(false)
  })

  it('ignores hidden segments', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher([])
    expect(m.ignores('.vscode/settings.json', false)).toBe(true)
    expect(m.ignores('.github/workflows/ci.yml', false)).toBe(true)
  })

  it('supports wildcard patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['*.log', 'dist/**', '*.min.js'])
    expect(m.ignores('app.log', false)).toBe(true)
    expect(m.ignores('dist/bundle.js', false)).toBe(true)
    expect(m.ignores('dist/sub/bundle.js', false)).toBe(true)
    expect(m.ignores('app.min.js', false)).toBe(true)
    expect(m.ignores('src/index.ts', false)).toBe(false)
  })

  it('supports dynamic addPatterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**'])
    expect(m.ignores('src/file.ts', false)).toBe(false)
    m.addPatterns(['*.log'])
    expect(m.ignores('app.log', false)).toBe(true)
  })

  it('handles empty patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher([])
    expect(m.ignores('src/file.ts', false)).toBe(false)
  })

  it('ignores comment lines and empty patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['# comment', '', 'node_modules/**'])
    expect(m.ignores('node_modules/pkg/index.js', false)).toBe(true)
    expect(m.ignores('src/main.ts', false)).toBe(false)
  })
})