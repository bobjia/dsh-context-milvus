// test/adr-indexer.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// Mock Milvus SDK
const mockInsert = jest.fn()
const mockDelete = jest.fn()
const mockHasCollection = jest.fn()
const mockCreateCollection = jest.fn()
const mockCreateIndex = jest.fn()
const mockLoadCollectionSync = jest.fn()
const mockConnectPromise = Promise.resolve()

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({
    connectPromise: mockConnectPromise,
    hasCollection: mockHasCollection,
    createCollection: mockCreateCollection,
    createIndex: mockCreateIndex,
    loadCollectionSync: mockLoadCollectionSync,
    insert: mockInsert,
    delete: mockDelete,
  })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { MilvusService } = await import('../src/plugins/dsh-context-milvus/milvus-service.js')
const { HashTracker } = await import('../src/plugins/dsh-context-milvus/merkle.js')
const { AdrAnchorIndex } = await import('../src/plugins/dsh-context-milvus/adr-anchor-index.js')
const { runAdrIndex, getAdrIndexStatus } = await import('../src/plugins/dsh-context-milvus/adr-indexer.js')

describe('runAdrIndex', () => {
  let tempDir: string
  let adrDir: string
  let config: any
  let milvus: any
  let tracker: HashTracker
  let anchorIndex: AdrAnchorIndex

  beforeEach(async () => {
    // Mock fetch so EmbeddingClient doesn't make real HTTP calls
    globalThis.fetch = jest.fn<any>().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }) as any

    tempDir = await mkdtemp(path.join(tmpdir(), 'adr-idx-'))
    adrDir = path.join(tempDir, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })

    config = {
      indexRoot: tempDir,
      adrRoot: adrDir,
      adrEnabled: true,
      embedding: { endpoint: 'http://test/embed', model: 'test', dim: 3, apiKey: undefined },
      ignorePatterns: [],
    }

    mockHasCollection.mockResolvedValue({ value: false })
    mockCreateCollection.mockResolvedValue({})
    mockCreateIndex.mockResolvedValue({})
    mockLoadCollectionSync.mockResolvedValue({})
    mockInsert.mockResolvedValue({ insert_cnt: 1 })
    mockDelete.mockResolvedValue({ delete_cnt: 0 })

    const embeddingMock = { embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) }
    milvus = new MilvusService({
      address: 'localhost:19530', collection: 'test', dim: 3,
      embeddingClient: embeddingMock, hybridMode: false,
    })
    milvus.ensureCollection = jest.fn().mockResolvedValue(undefined)
    milvus.ensureAdrCollection = jest.fn().mockResolvedValue(undefined)
    milvus.insertAdrChunks = jest.fn().mockResolvedValue(1)
    milvus.deleteAdrByFilePath = jest.fn().mockResolvedValue(0)

    const merklePath = path.join(tempDir, 'adr-merkle.json')
    tracker = new HashTracker(merklePath)
    await tracker.load()

    const anchorPath = path.join(tempDir, 'anchors.json')
    anchorIndex = new AdrAnchorIndex(anchorPath)
    await anchorIndex.load()
  })

  afterEach(() => {
    delete (globalThis as any).fetch
  })

  it('indexes ADR files and returns counts', async () => {
    // Create a sample ADR
    await writeFile(path.join(adrDir, 'ADR-0001-test.md'),
      `---
id: ADR-0001-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## 决策目标

Test goal
`)

    const result = await runAdrIndex(config, milvus, tracker, anchorIndex)
    expect(result.filesIndexed).toBe(1)
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(1)
    expect(milvus.ensureAdrCollection).toHaveBeenCalled()
    expect(milvus.insertAdrChunks).toHaveBeenCalled()
  })

  it('skips unchanged files in incremental mode', async () => {
    // Index once
    await writeFile(path.join(adrDir, 'ADR-0001-test.md'),
      `---
id: ADR-0001-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## 决策目标

Test
`)
    await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'full' })
    jest.clearAllMocks()

    // Second run (incremental) — no changes
    const result = await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'incremental' })
    expect(result.filesIndexed).toBe(0)
    expect(result.filesSkipped).toBe(1)
  })

  it('returns index status', async () => {
    const { AdrService } = await import('../src/plugins/dsh-context-milvus/adr-service.js')
    const status = await getAdrIndexStatus(tracker, new AdrService(adrDir))
    expect(status).toHaveProperty('totalAdrs')
    expect(status).toHaveProperty('totalChunks')
    expect(status).toHaveProperty('lastIndexed')
    expect(status).toHaveProperty('activeAdrs')
    // Fresh tracker + empty ADR dir → all-zero status
    expect(status.totalAdrs).toBe(0)
    expect(status.activeAdrs).toBe(0)
    expect(status.lastIndexed).toBe('')
  })
})