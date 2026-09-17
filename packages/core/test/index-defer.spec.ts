import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockEnsureCollection = jest.fn(async () => {})
const mockEnsureAdrCollection = jest.fn(async () => {})
const mockInsertChunks = jest.fn(async () => 1)
const mockDeleteByFilePaths = jest.fn(async () => 0)
const mockDeleteByFilePath = jest.fn(async () => 0)

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { runIndex } = await import('../src/indexer.js')
const { HashTracker } = await import('../src/merkle.js')
const { getConfig } = await import('../src/config.js')

/** Structural stand-in for MilvusService — only the methods runIndex calls. */
function fakeMilvus(): any {
  return {
    ensureCollection: mockEnsureCollection,
    ensureAdrCollection: mockEnsureAdrCollection,
    insertChunks: mockInsertChunks,
    deleteByFilePaths: mockDeleteByFilePaths,
    deleteByFilePath: mockDeleteByFilePath,
  }
}

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'defer-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

function cfg() {
  return { ...getConfig({}), indexRoot: tmp, indexExtensions: ['.ts'] }
}

/** Stub the embedding endpoint with a deterministic one-vector-per-input reply. */
function mockFetchOk(): void {
  globalThis.fetch = jest.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body))
    return {
      ok: true,
      json: async () => ({
        data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
      }),
    }
  }) as any
}

describe('runIndex large-workspace deferral', () => {
  it('defers without touching Milvus, embeddings or the tracker', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    await write('b.ts', 'export function beta() { return 2 }\n')
    const fetchSpy = jest.fn()
    globalThis.fetch = fetchSpy as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const merklePath = path.join(tmp, 'merkle.json')

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'full',
      deferLargeWorkspace: { files: 1 },
    })

    expect(result.deferred).toBe(true)
    expect(result.workspaceFiles).toBe(2)
    expect(result.workspaceBytes).toBeGreaterThan(0)
    expect(result.pendingFiles).toBe(2)
    expect(result.pendingBytes).toBe(result.workspaceBytes)
    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(result.filesSkipped).toBe(2)

    expect(mockEnsureCollection).not.toHaveBeenCalled()
    expect(mockInsertChunks).not.toHaveBeenCalled()
    expect(mockDeleteByFilePaths).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(merklePath)).toBe(false)
  })

  it('does not defer when the workspace is under the injected limit', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    globalThis.fetch = jest.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        }),
      }
    }) as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'full',
      deferLargeWorkspace: { files: 10 },
    })

    expect(result.deferred).toBeUndefined()
    expect(mockEnsureCollection).toHaveBeenCalled()
  })

  it('runs the full pipeline when deferLargeWorkspace is not set (Codex path)', async () => {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    globalThis.fetch = jest.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        }),
      }
    }) as any
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    const result = await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full' })

    expect(result.deferred).toBeUndefined()
    expect(mockEnsureCollection).toHaveBeenCalled()
  })
})

/**
 * The threshold is measured on the work this run would actually do
 * (delta.toIndex), not on the size of the whole workspace. A big repo with a
 * one-file edit must therefore index inline.
 */
describe('runIndex deferral is sized on pending work', () => {
  /** 3 files with an injected file limit of 2: the workspace is over the limit. */
  async function seedThreeFiles(): Promise<void> {
    await write('a.ts', 'export function alpha() { return 1 }\n')
    await write('b.ts', 'export function beta() { return 2 }\n')
    await write('c.ts', 'export function gamma() { return 3 }\n')
  }

  it('does not defer a one-file change inside an over-limit workspace', async () => {
    await seedThreeFiles()
    mockFetchOk()
    const merklePath = path.join(tmp, 'merkle.json')
    const tracker = new HashTracker(merklePath)

    // First pass indexes everything, so the tracker knows all three hashes.
    const first = await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'incremental' })
    expect(first.deferred).toBeUndefined()
    expect(first.filesIndexed).toBe(3)

    // One file changes; the workspace is still above the injected limit, but
    // this run only has one file to do.
    await write('b.ts', 'export function beta() { return 22 }\n')
    mockEnsureCollection.mockClear()

    const second = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'incremental',
      deferLargeWorkspace: { files: 2 },
    })

    expect(second.deferred).toBeUndefined()
    expect(second.filesIndexed).toBe(1)
    expect(second.filesSkipped).toBe(2)
    expect(mockEnsureCollection).toHaveBeenCalled()
    expect(mockInsertChunks).toHaveBeenCalled()
  })

  it('defers mode=full on the same workspace because toIndex is every file', async () => {
    await seedThreeFiles()
    mockFetchOk()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    // Seed the tracker so the only difference from the incremental case is mode.
    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'incremental' })
    mockEnsureCollection.mockClear()
    mockInsertChunks.mockClear()

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'full',
      deferLargeWorkspace: { files: 2 },
    })

    expect(result.deferred).toBe(true)
    expect(result.pendingFiles).toBe(3)
    expect(result.workspaceFiles).toBe(3)
    expect(mockEnsureCollection).not.toHaveBeenCalled()
    expect(mockInsertChunks).not.toHaveBeenCalled()
  })

  it('defers the first index of the same workspace because the tracker is empty', async () => {
    await seedThreeFiles()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))

    const result = await runIndex(cfg(), fakeMilvus(), tracker, {
      mode: 'incremental',
      deferLargeWorkspace: { files: 2 },
    })

    expect(result.deferred).toBe(true)
    expect(result.pendingFiles).toBe(3)
    expect(result.pendingBytes).toBe(result.workspaceBytes)
    expect(mockEnsureCollection).not.toHaveBeenCalled()
  })
})
