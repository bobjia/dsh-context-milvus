import { jest } from '@jest/globals'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const mockMilvusClient = jest.fn(() => ({
  connectPromise: Promise.resolve(),
  hasCollection: jest.fn(async () => true),
  createCollection: jest.fn(async () => ({})),
  createIndex: jest.fn(async () => ({})),
  loadCollectionSync: jest.fn(async () => ({})),
  insert: jest.fn(async () => ({ insertCnt: 0 })),
  delete: jest.fn(async () => ({ deleteCnt: 0 })),
  search: jest.fn(async () => ({ results: [] })),
  query: jest.fn(async () => ({ data: [] })),
}))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: mockMilvusClient,
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const mockProbeWorkspace = jest.fn()
const mockRunIndex = jest.fn()
jest.unstable_mockModule('../src/indexer.js', () => ({
  probeWorkspace: mockProbeWorkspace,
  runIndex: mockRunIndex,
}))

const { runIndexCli, CLI_USAGE } = await import('../src/cli.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  jest.clearAllMocks()
  tmp = await mkdtemp(path.join(tmpdir(), 'cli-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err }
}

describe('runIndexCli argument handling', () => {
  it('prints usage and returns 0 for --help', async () => {
    const c = capture()
    expect(await runIndexCli(['--help'], c.io)).toBe(0)
    expect(c.out.join('\n')).toContain('用法')
    expect(c.out.join('\n')).toContain('--specs-only')
  })

  it('returns 2 for an unknown flag', async () => {
    const c = capture()
    expect(await runIndexCli(['--nope'], c.io)).toBe(2)
    expect(c.err.join('\n')).toContain('未知参数')
    expect(c.err.join('\n')).toContain(CLI_USAGE.split('\n')[0])
  })

  it('returns 2 when --mode gets an invalid value', async () => {
    const c = capture()
    expect(await runIndexCli(['--mode', 'sideways'], c.io)).toBe(2)
    expect(c.err.join('\n')).toContain('--mode')
  })
})

describe('runIndexCli --dry-run', () => {
  it('probes and reports without constructing Milvus or running an index', async () => {
    mockProbeWorkspace.mockResolvedValue({
      files: new Map(), fileCount: 0, totalBytes: 0, exceedsLargeWorkspace: false,
    })
    const c = capture()

    const code = await runIndexCli(['--root', tmp, '--dry-run'], c.io)

    expect(code).toBe(0)
    expect(c.out.join('\n')).toContain('[dry-run]')
    expect(mockRunIndex).not.toHaveBeenCalled()
    expect(mockMilvusClient).not.toHaveBeenCalled()
  })
})

describe('runIndexCli config resolution', () => {
  it('warns and falls back to env defaults when no run-config exists', async () => {
    mockProbeWorkspace.mockResolvedValue({
      files: new Map(), fileCount: 0, totalBytes: 0, exceedsLargeWorkspace: false,
    })
    const c = capture()

    const code = await runIndexCli(['--root', tmp, '--dry-run'], c.io)

    expect(code).toBe(0)
    expect(c.err.join('\n')).toContain('未找到可用的 run-config')
    expect(c.err.join('\n')).toContain('回退')
  })
})

describe('runIndexCli --specs-only', () => {
  it('refuses when adrEnabled is false', async () => {
    const root = path.join(tmp, 'proj')
    await mkdir(root, { recursive: true })
    const c = capture()

    const code = await runIndexCli(['--root', root, '--specs-only'], c.io)

    expect(code).toBe(1)
    expect(c.err.join('\n')).toContain('adrEnabled')
    expect(mockRunIndex).not.toHaveBeenCalled()
  })
})

describe('runIndexCli full run', () => {
  it('reports the summary and returns 0', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 3, chunksIndexed: 7, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1, durationMs: 1234,
    })
    const root = path.join(tmp, 'proj2')
    await mkdir(root, { recursive: true })
    const c = capture()

    const code = await runIndexCli(['--root', root], c.io)

    expect(code).toBe(0)
    expect(c.out.join('\n')).toContain('3 个文件')
    expect(c.out.join('\n')).toContain('7 个代码块')
  })
})
