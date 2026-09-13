import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'

// The core barrel loads the Milvus SDK, which cannot load under Jest's ESM
// runtime — stub it. The mock must be registered BEFORE the module graph is
// imported, hence the dynamic import below instead of a top-level static one.
// The export names must mirror what core/src/milvus-service.ts imports by name,
// otherwise ESM linking fails on the missing names.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { getConfig, createAdrBundle } = await import('../src/index.js')

const fetchSpy = jest.fn()
beforeAll(() => { (globalThis as any).fetch = fetchSpy })
afterEach(() => { fetchSpy.mockClear() })

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'adr-bundle-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('createAdrBundle', () => {
  it('resolves adrRoot relative to indexRoot', async () => {
    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    expect(b.adrRoot).toBe(path.join(root, 'docs', 'decisions'))
    expect(b.exists).toBe(false)
  })

  it('never touches the network while assembling', async () => {
    await mkdir(path.join(root, 'docs', 'decisions'), { recursive: true })
    await createAdrBundle(getConfig({ indexRoot: root }))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not create the ADR directory when it is missing', async () => {
    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    expect(b.exists).toBe(false)
    expect(existsSync(path.join(root, 'docs'))).toBe(false)
  })

  it('reports exists once the directory is there', async () => {
    await mkdir(path.join(root, 'adr'), { recursive: true })
    const b = await createAdrBundle(getConfig({ indexRoot: root, adrRoot: 'adr' }))
    expect(b.exists).toBe(true)
  })

  it('creates the ADR root only when the caller asks for it', async () => {
    // This is the DSH plugin's historical behaviour, which it now passes
    // explicitly; without it the plugin would stop creating docs/decisions.
    const b = await createAdrBundle(getConfig({ indexRoot: root }), { createWhenMissing: true })
    expect(b.exists).toBe(true)
    expect(existsSync(path.join(root, 'docs', 'decisions'))).toBe(true)
  })

  it('caches titles across calls', async () => {
    const adrDir = path.join(root, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })
    const body = `---
id: ADR-0001-retry-queue
type: adr
status: active
created: 2026-09-01
updated: 2026-09-01
author: t
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  change_type: architecture
related_decisions: []
auto_generated: false
---

# 使用重试队列隔离下游故障

正文
`
    await writeFile(path.join(adrDir, 'ADR-0001-retry-queue.md'), body, 'utf-8')

    const b = await createAdrBundle(getConfig({ indexRoot: root }))
    const first = await b.titles()
    expect(first.get('ADR-0001-retry-queue')).toEqual({
      title: '使用重试队列隔离下游故障', status: 'active',
    })

    // A second read must come from the cache: adding a file changes nothing
    // until titles() is called on a fresh bundle.
    await writeFile(path.join(adrDir, 'ADR-0002-x.md'), body.replace('0001-retry-queue', '0002-x'), 'utf-8')
    const second = await b.titles()
    expect(second.size).toBe(1)
    expect(second).toBe(first)
  })
})
