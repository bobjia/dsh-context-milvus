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

// The core barrel re-exports adr-indexer.js with *named* re-exports, so this
// mock must satisfy every name the barrel lists — a missing one is a link-time
// SyntaxError ("does not provide an export named ..."), not a runtime
// undefined. (Task 4 added SPEC_FILE_RE/PLAN_FILE_RE here.) Spread the real
// module and override only what this test drives, so future barrel additions
// cannot break this spec.
const actualAdrIndexer = await import('../../core/src/adr-indexer.js')
const mockProbeSpecCorpus = jest.fn()
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  ...actualAdrIndexer,
  runAdrIndex: jest.fn(),
  getAdrIndexStatus: jest.fn(),
  probeSpecCorpus: mockProbeSpecCorpus,
  exceedsLargeSpecCorpus: jest.fn(),
  LARGE_SPEC_FILE_LIMIT: 100,
  LARGE_SPEC_BYTE_LIMIT: 200 * 1024,
}))

const mockFindCandidateFiles = jest.fn(async () => [])
const mockGenerateSpecFrontmatter = jest.fn()
jest.unstable_mockModule('../../core/src/adr-anchor-generator.js', () => ({
  findCandidateFiles: mockFindCandidateFiles,
  previewFrontmatter: jest.fn(),
  generateSpecFrontmatter: mockGenerateSpecFrontmatter,
  detectCodeReferences: jest.fn(),
}))

const mockWriteRunConfig = jest.fn(async () => '/tmp/run-config.json')
jest.unstable_mockModule('../../core/src/run-config.js', () => ({
  writeRunConfig: mockWriteRunConfig,
  readRunConfig: jest.fn(),
}))

const mockBuildIndexCommand = jest.fn((root: string, opts?: any) =>
  `node /pkg/bin/index.js --root "${root}"${opts?.specsOnly ? ' --specs-only' : ''}`)
jest.unstable_mockModule(
  '../src/plugins/dsh-context-milvus/index-command.js',
  () => ({ buildIndexCommand: mockBuildIndexCommand }),
)

const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

const config = {
  adrEnabled: true,
  indexRoot: '/workspace/test',
  adrRoot: 'docs/decisions',
  specRoot: 'docs/superpowers/specs',
  planRoot: 'docs/superpowers/plans',
}

function indexSpecsDef() {
  mockRegister.mockClear()
  const ctx = { tools: { register: mockRegister } } as any
  registerAdrTools(ctx, () => config as any, () => ({}) as any, {} as any, {} as any)
  return mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]
}

describe('index_specs large-corpus deferral', () => {
  it('defers without generating frontmatter or indexing', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 143, totalBytes: 320_000, exceedsLargeSpecCorpus: true,
    })

    const result = await indexSpecsDef().execute({})

    expect(result.deferred).toBe(true)
    expect(result.specFiles).toBe(143)
    expect(result.nextCommand).toContain('--specs-only')
    expect(mockGenerateSpecFrontmatter).not.toHaveBeenCalled()
    expect(mockFindCandidateFiles).not.toHaveBeenCalled()
    expect(mockWriteRunConfig).toHaveBeenCalledTimes(1)
  })

  it('does not defer a dry_run preview even when over the limit', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 143, totalBytes: 320_000, exceedsLargeSpecCorpus: true,
    })

    const result = await indexSpecsDef().execute({ dry_run: true })

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
  })

  it('keeps the normal path when under the limit', async () => {
    mockProbeSpecCorpus.mockResolvedValue({
      files: [], fileCount: 2, totalBytes: 100, exceedsLargeSpecCorpus: false,
    })

    const result = await indexSpecsDef().execute({})

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
  })
})
