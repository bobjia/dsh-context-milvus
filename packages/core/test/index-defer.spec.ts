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
