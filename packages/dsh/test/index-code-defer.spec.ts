import { jest } from '@jest/globals'

const mockRegister = jest.fn(() => jest.fn())
const mockDefineTool = jest.fn((opts: any) => opts)
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({ defineTool: mockDefineTool }))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const mockRunIndex = jest.fn()
jest.unstable_mockModule('../../core/src/indexer.js', () => ({
  runIndex: mockRunIndex,
  getIndexStatus: jest.fn(),
  probeWorkspace: jest.fn(),
  exceedsLargeWorkspace: jest.fn(),
  LARGE_WORKSPACE_FILE_LIMIT: 1000,
  LARGE_WORKSPACE_BYTE_LIMIT: 500 * 1024,
  DEFAULT_CHECKPOINT_EVERY: 50,
}))

// The core barrel re-exports adr-indexer.js with *named* re-exports, so this
// mock must satisfy every name the barrel lists (a missing one is a link-time
// SyntaxError, not a runtime undefined). Spread the real module and override
// only what the subject uses, so new barrel exports cannot break this spec.
const actualAdrIndexer = await import('../../core/src/adr-indexer.js')
const mockRunAdrIndex = jest.fn()
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  ...actualAdrIndexer,
  runAdrIndex: mockRunAdrIndex,
  getAdrIndexStatus: jest.fn(),
}))

const mockWriteRunConfig = jest.fn(async () => '/tmp/run-config.json')
jest.unstable_mockModule('../../core/src/run-config.js', () => ({
  writeRunConfig: mockWriteRunConfig,
  readRunConfig: jest.fn(),
}))

const mockBuildIndexCommand = jest.fn((root: string) => `node /pkg/bin/index.js --root "${root}"`)
jest.unstable_mockModule(
  '../src/plugins/dsh-context-milvus/index-command.js',
  () => ({ buildIndexCommand: mockBuildIndexCommand }),
)

class MockHashTracker {
  constructor(_path: string) {}
  async load() {}
  async save() {}
  computeDelta() { return { toIndex: [], toRemove: [], unchanged: [] } }
  getStats() { return { totalFiles: 0, totalChunks: 0 } }
  getLastIndexedTimestamp() { return null }
}
jest.unstable_mockModule('../../core/src/merkle.js', () => ({ HashTracker: MockHashTracker }))

const { registerTools } = await import('../src/plugins/dsh-context-milvus/tools.js')

function makeCtx() {
  return { tools: { register: mockRegister } } as any
}

const baseConfig = {
  adrEnabled: false,
  indexRoot: '/workspace/test',
  adrRoot: 'docs/decisions',
  specRoot: 'docs/superpowers/specs',
  planRoot: 'docs/superpowers/plans',
  indexExtensions: ['.ts'],
  ignorePatterns: [],
  chunkContextLines: 2,
}

function indexCodeDef() {
  mockRegister.mockClear()
  registerTools(makeCtx(), () => baseConfig as any, () => ({}) as any, () => new MockHashTracker('x') as any, undefined)
  return mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]
}

describe('index_code large-workspace deferral', () => {
  it('returns the deferral payload, writes the run-config and skips ADR', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
    })

    const result = await indexCodeDef().execute({ mode: 'incremental' })

    expect(result.deferred).toBe(true)
    expect(result.workspaceFiles).toBe(1234)
    expect(result.nextCommand).toContain('--root')
    expect(mockWriteRunConfig).toHaveBeenCalledTimes(1)
    expect(mockRunAdrIndex).not.toHaveBeenCalled()
  })

  it('passes deferLargeWorkspace: true to runIndex', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 1, chunksIndexed: 1, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 0, durationMs: 5,
    })

    await indexCodeDef().execute({ mode: 'incremental' })

    expect(mockRunIndex.mock.calls[0][3]).toMatchObject({ deferLargeWorkspace: true })
  })

  it('renders the prompt with the command instead of index counts', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
    })
    const def = indexCodeDef()

    const blocks = def.output.render({}, {
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 1234, durationMs: 12,
      deferred: true, workspaceFiles: 1234, workspaceBytes: 1_800_000,
      nextCommand: 'node /pkg/bin/index.js --root "/workspace/test"',
    })
    const text = blocks.map((b: any) => b.text).join('\n')

    expect(text).toContain('已跳过 Embedding')
    expect(text).toContain('node /pkg/bin/index.js')
    expect(text).toContain('--dry-run')
  })

  it('still writes the run-config when it fails, and still returns the command', async () => {
    mockWriteRunConfig.mockRejectedValueOnce(new Error('EACCES'))
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 10, durationMs: 3,
      deferred: true, workspaceFiles: 10, workspaceBytes: 100,
    })

    const result = await indexCodeDef().execute({ mode: 'incremental' })

    expect(result.deferred).toBe(true)
    expect(result.nextCommand).toContain('--root')
  })

  it('reloads the effective tracker so state written by the standalone script is picked up', async () => {
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0,
      filesSkipped: 0, durationMs: 1,
    })
    const tracker = new MockHashTracker('x')
    const loadSpy = jest.spyOn(tracker, 'load')

    mockRegister.mockClear()
    registerTools(
      makeCtx(), () => baseConfig as any, () => ({}) as any, () => tracker as any, undefined,
    )
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]

    await def.execute({ mode: 'incremental' })

    expect(loadSpy).toHaveBeenCalled()
  })
})
