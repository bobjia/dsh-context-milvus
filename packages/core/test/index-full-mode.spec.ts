import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockEnsureCollection = jest.fn(async () => {})
const mockInsertChunks = jest.fn(async (chunks: any[]) => chunks.length)
const mockDeleteByFilePath = jest.fn(async () => 1)
const mockDeleteByFilePaths = jest.fn(async () => 1)

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

// chunkCode is stubbed so the zero-chunk case is deterministic: content
// containing NOTHING yields no chunks, everything else yields exactly one.
const mockChunkCode = jest.fn(async (filePath: string, content: string) =>
  content.includes('NOTHING')
    ? []
    : [{
        filePath, content: 'x', startLine: 1, endLine: 1,
        language: 'typescript', chunkType: 'function', name: 'x',
      }],
)
jest.unstable_mockModule('../src/chunker.js', () => ({ chunkCode: mockChunkCode }))

const { runIndex } = await import('../src/indexer.js')
const { HashTracker } = await import('../src/merkle.js')
const { getConfig } = await import('../src/config.js')

/** Structural stand-in for MilvusService — only the methods runIndex calls. */
function fakeMilvus(): any {
  return {
    ensureCollection: mockEnsureCollection,
    insertChunks: mockInsertChunks,
    deleteByFilePath: mockDeleteByFilePath,
    deleteByFilePaths: mockDeleteByFilePaths,
  }
}

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'full-mode-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
  globalThis.fetch = jest.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body))
    return {
      ok: true,
      json: async () => ({
        data: Array.from({ length: body.input.length }, () => ({ embedding: [0.1, 0.2, 0.3] })),
      }),
    }
  }) as any
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

describe('runIndex full mode is a rebuild, not an append', () => {
  it('deletes each file\'s previous rows before re-inserting', async () => {
    await write('a.ts', 'const a = 1')
    await write('b.ts', 'const b = 2')

    await runIndex(cfg(), fakeMilvus(), new HashTracker(path.join(tmp, 'merkle.json')), { mode: 'full' })

    expect(mockDeleteByFilePath).toHaveBeenCalledTimes(2)
    const deleted = mockDeleteByFilePath.mock.calls.map((c: any) => path.basename(c[0])).sort()
    expect(deleted).toEqual(['a.ts', 'b.ts'])
    expect(mockInsertChunks).toHaveBeenCalledTimes(2)
  })

  it('still removes rows for files that disappeared from disk', async () => {
    await write('gone.ts', 'const gone = 1')
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'incremental' })
    expect(mockDeleteByFilePaths).not.toHaveBeenCalled()

    // Delete the file, then run a FULL rebuild: the orphan rows must still go.
    await rm(path.join(tmp, 'gone.ts'))
    mockDeleteByFilePaths.mockClear()

    const result = await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'full' })

    expect(result.filesRemoved).toBe(1)
    expect(mockDeleteByFilePaths).toHaveBeenCalledTimes(1)
  })

  it('drops stale rows when a file stops producing chunks', async () => {
    await write('a.ts', 'const a = 1')
    const tracker = new HashTracker(path.join(tmp, 'merkle.json'))
    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'incremental' })
    expect(mockInsertChunks).toHaveBeenCalledTimes(1)

    // Same path, but now it yields no chunks at all.
    await write('a.ts', '// NOTHING to chunk here')
    mockDeleteByFilePath.mockClear()
    mockInsertChunks.mockClear()

    await runIndex(cfg(), fakeMilvus(), tracker, { mode: 'incremental' })

    expect(mockDeleteByFilePath).toHaveBeenCalledTimes(1)
    expect(mockInsertChunks).not.toHaveBeenCalled()
  })

  it('keeps incremental delete-then-insert behaviour', async () => {
    await write('a.ts', 'const a = 1')

    await runIndex(cfg(), fakeMilvus(), new HashTracker(path.join(tmp, 'merkle.json')), { mode: 'incremental' })

    expect(mockDeleteByFilePath).toHaveBeenCalledTimes(1)
    expect(mockInsertChunks).toHaveBeenCalledTimes(1)
  })
})
