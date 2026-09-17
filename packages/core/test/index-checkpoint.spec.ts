import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
  tmp = await mkdtemp(path.join(tmpdir(), 'checkpoint-'))
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

function mockEmbeddings(): void {
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

describe('runIndex checkpointing', () => {
  const FILES = [
    ['a.ts', 'export function alpha() { return 1 }\n'],
    ['b.ts', 'export function beta() { return 2 }\n'],
    ['c.ts', 'export function gamma() { return 3 }\n'],
    ['d.ts', 'export function delta() { return 4 }\n'],
  ] as const

  it('saves once at the end when checkpointEvery is 0', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full', checkpointEvery: 0 })

    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('saves periodically while processing, not only at the end', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full', checkpointEvery: 1 })

    // One save per file plus the final save — the final save alone would be 1.
    expect(saveSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('defaults to checkpointing every DEFAULT_CHECKPOINT_EVERY files', async () => {
    for (const [name, content] of FILES) await write(name, content)
    mockEmbeddings()
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    const saveSpy = jest.spyOn(tracker, 'save')

    // 4 files < 50, so only the final save happens — proving the default is
    // applied without error and does not save on every file.
    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full' })

    expect(saveSpy).toHaveBeenCalledTimes(1)
  })
})
