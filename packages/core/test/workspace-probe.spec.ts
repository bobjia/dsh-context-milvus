import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// indexer.ts → milvus-service.ts → @zilliz/milvus2-sdk-node, which cannot be
// loaded under Jest's ESM runtime. Stub it before importing anything.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { probeWorkspace, exceedsLargeWorkspace, LARGE_WORKSPACE_FILE_LIMIT, LARGE_WORKSPACE_BYTE_LIMIT } =
  await import('../src/indexer.js')
const { getConfig } = await import('../src/config.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'probe-ws-'))
  // Keep the global ignore file and any HOME-derived default out of the real home.
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

function tsConfig() {
  return { ...getConfig({}), indexRoot: tmp, indexExtensions: ['.ts'] }
}

describe('exceedsLargeWorkspace', () => {
  it('uses the production constants by default', () => {
    expect(LARGE_WORKSPACE_FILE_LIMIT).toBe(1000)
    expect(LARGE_WORKSPACE_BYTE_LIMIT).toBe(500 * 1024)
  })

  it('does not trigger at exactly the limit and triggers above it', () => {
    expect(exceedsLargeWorkspace(1000, 0)).toBe(false)
    expect(exceedsLargeWorkspace(1001, 0)).toBe(true)
    expect(exceedsLargeWorkspace(0, 512000)).toBe(false)
    expect(exceedsLargeWorkspace(0, 512001)).toBe(true)
  })

  it('honours injected limits', () => {
    expect(exceedsLargeWorkspace(2, 0, { files: 2 })).toBe(false)
    expect(exceedsLargeWorkspace(3, 0, { files: 2 })).toBe(true)
    expect(exceedsLargeWorkspace(0, 10, { bytes: 10 })).toBe(false)
    expect(exceedsLargeWorkspace(0, 11, { bytes: 10 })).toBe(true)
  })
})

describe('probeWorkspace', () => {
  it('counts indexable files and their UTF-8 byte length', async () => {
    await write('a.ts', 'const a = 1')
    await write('b.ts', 'const bb = 22')
    await write('notes.md', 'not an indexable extension')

    const probe = await probeWorkspace(tsConfig())

    expect(probe.fileCount).toBe(2)
    expect(probe.files.size).toBe(2)
    expect(probe.totalBytes).toBe(
      Buffer.byteLength('const a = 1', 'utf-8') + Buffer.byteLength('const bb = 22', 'utf-8'),
    )
    // One size entry per walked file, with the exact UTF-8 byte length.
    expect(probe.sizes.size).toBe(probe.files.size)
    expect(probe.sizes.get(path.join(tmp, 'a.ts'))).toBe(Buffer.byteLength('const a = 1', 'utf-8'))
    expect(probe.sizes.get(path.join(tmp, 'b.ts'))).toBe(Buffer.byteLength('const bb = 22', 'utf-8'))
    expect(probe.exceedsLargeWorkspace).toBe(false)
  })

  it('measures multi-byte content in UTF-8 bytes, not characters', async () => {
    const content = 'const 中文变量 = 1'
    await write('cn.ts', content)

    const probe = await probeWorkspace(tsConfig())

    expect(probe.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(probe.totalBytes).toBeGreaterThan(content.length)
    expect(probe.sizes.get(path.join(tmp, 'cn.ts'))).toBe(Buffer.byteLength(content, 'utf-8'))
  })

  it('walks nested directories and skips ignored ones', async () => {
    await write('src/deep/a.ts', 'const a = 1')
    await write('node_modules/pkg/b.ts', 'const b = 2')

    const probe = await probeWorkspace(tsConfig())

    expect(probe.fileCount).toBe(1)
    expect([...probe.files.keys()][0]).toContain('src/deep/a.ts')
  })

  it('flags an over-threshold directory when limits are injected', async () => {
    await write('a.ts', 'x')

    expect((await probeWorkspace(tsConfig(), { limits: { files: 5 } })).exceedsLargeWorkspace).toBe(false)
    expect((await probeWorkspace(tsConfig(), { limits: { files: 0 } })).exceedsLargeWorkspace).toBe(true)
  })

  it('reports per-file progress through onFileProgress', async () => {
    await write('a.ts', 'x')
    await write('b.ts', 'y')
    const seen: string[] = []

    await probeWorkspace(tsConfig(), { onFileProgress: (p) => seen.push(p) })

    expect(seen).toHaveLength(2)
  })
})
