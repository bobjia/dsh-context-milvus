// test/adr-indexer.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
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
  let specDir: string
  let planDir: string
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
    specDir = path.join(tempDir, 'docs', 'superpowers', 'specs')
    planDir = path.join(tempDir, 'docs', 'superpowers', 'plans')
    await mkdir(adrDir, { recursive: true })
    await mkdir(specDir, { recursive: true })
    await mkdir(planDir, { recursive: true })

    config = {
      indexRoot: tempDir,
      adrRoot: adrDir,
      specRoot: specDir,
      planRoot: planDir,
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

  it('scans specRoot for YYYY-MM-DD-*-design.md files', async () => {
    await writeFile(path.join(specDir, '2026-09-01-my-design.md'),
      `---
id: 2026-09-01-my-design
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test spec"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Context

This is a spec document.
`)

    const result = await runAdrIndex(config, milvus, tracker, anchorIndex)
    expect(result.filesIndexed).toBe(1)
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(1)

    // Verify docType in chunks passed to Milvus
    const insertedChunks = milvus.insertAdrChunks.mock.calls[0][0]
    expect(insertedChunks[0].docType).toBe('spec')
  })

  it('scans planRoot for YYYY-MM-DD-*.md files (excluding -design)', async () => {
    // Create a plan file (should be indexed)
    await writeFile(path.join(planDir, '2026-09-01-my-plan.md'),
      `---
id: 2026-09-01-my-plan
type: plan
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test plan"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Implementation

Implement the plan.
`)

    // Create a design.md file in planDir (should NOT be indexed by plan regex)
    await writeFile(path.join(planDir, '2026-09-01-my-design.md'),
      `---
id: 2026-09-01-my-design
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test design"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Context

This is a design file.
`)

    const result = await runAdrIndex(config, milvus, tracker, anchorIndex)
    // Only the plan file should be indexed (design file excluded by plan regex)
    expect(result.filesIndexed).toBe(1)

    // Verify docType in chunks passed to Milvus is 'plan'
    const insertedChunks = milvus.insertAdrChunks.mock.calls[0][0]
    expect(insertedChunks[0].docType).toBe('plan')
  })

  it('skips missing root directories silently', async () => {
    // Remove spec and plan directories
    await rm(specDir, { recursive: true, force: true })
    await rm(planDir, { recursive: true, force: true })

    // ADR dir still exists with an ADR file
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
    // Should still index the ADR file, spec/plan dirs missing → skipped silently
    expect(result.filesIndexed).toBe(1)
  })

  it('preserves tracker state when all root directories are missing', async () => {
    // First: index a file normally to establish tracker state
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
    await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'full' })
    expect(tracker.getStats().totalFiles).toBe(1)

    // Now remove ALL three root directories (simulating transient unavailability)
    await rm(adrDir, { recursive: true, force: true })
    await rm(specDir, { recursive: true, force: true })
    await rm(planDir, { recursive: true, force: true })
    jest.clearAllMocks()

    // Second run (incremental) — no root is available → zero result, state preserved
    const result = await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'incremental' })
    expect(result.filesIndexed).toBe(0)
    expect(result.filesRemoved).toBe(0)
    expect(result.filesSkipped).toBe(0)
    expect(tracker.getStats().totalFiles).toBe(1)
    // No Milvus deletions should have been triggered
    expect(milvus.deleteAdrByFilePath).not.toHaveBeenCalled()
  })

  it('all roots share the same Merkle tracker', async () => {
    // Create files in all three roots
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

    await writeFile(path.join(specDir, '2026-09-01-my-design.md'),
      `---
id: 2026-09-01-my-design
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test spec"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Context

Spec content.
`)

    await writeFile(path.join(planDir, '2026-09-01-my-plan.md'),
      `---
id: 2026-09-01-my-plan
type: plan
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test plan"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Implementation

Plan content.
`)

    await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'full' })
    const stats = tracker.getStats()
    expect(stats.totalFiles).toBe(3)
  })

  it('computes incremental delta across all roots', async () => {
    // Create files in all three roots
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

    await writeFile(path.join(specDir, '2026-09-01-my-design.md'),
      `---
id: 2026-09-01-my-design
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test spec"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Context

Spec content.
`)

    await writeFile(path.join(planDir, '2026-09-01-my-plan.md'),
      `---
id: 2026-09-01-my-plan
type: plan
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test plan"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Implementation

Plan content.
`)

    // Full index first
    await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'full' })
    jest.clearAllMocks()

    // Incremental run — no changes
    const result = await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'incremental' })
    expect(result.filesIndexed).toBe(0)
    expect(result.filesSkipped).toBe(3)
  })

  it('does not treat -redesign.md as a spec file (regex blind spot regression)', async () => {
    // 2026-09-01-redesign.md ends with "design.md" but has no "-" before
    // "design" — it must NOT match SPEC_FILE_RE.
    await writeFile(path.join(specDir, '2026-09-01-redesign.md'),
      `---
id: 2026-09-01-redesign
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Redesign"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## Context

Redesign doc.
`)

    // 2026-09-01-my-design.md DOES have "-" before "design" — it must match.
    await writeFile(path.join(specDir, '2026-09-01-my-design.md'),
      `---
id: 2026-09-01-my-design
type: spec
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test spec"
  change_type: new_feature
related_decisions: []
auto_generated: false
---

## Context

This is a spec document.
`)

    const result = await runAdrIndex(config, milvus, tracker, anchorIndex)
    // Only my-design.md is indexed; redesign.md is excluded by the fixed regex
    expect(result.filesIndexed).toBe(1)

    const insertedChunks = milvus.insertAdrChunks.mock.calls[0][0]
    expect(insertedChunks[0].docType).toBe('spec')
    // The indexed file is the my-design one, not redesign
    expect(insertedChunks[0].filePath).toContain('2026-09-01-my-design.md')
  })
})