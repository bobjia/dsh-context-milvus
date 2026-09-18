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
// undefined. Spread the real module and override only what this test drives, so
// future barrel additions cannot break this spec.
//
// exceedsLargeSpecCorpus is deliberately NOT overridden: the deferral decision
// is a pure function of the candidate set, so these cases must exercise the real
// predicate through real inputs. A jest.fn() here would return undefined and
// silently make every decision falsy — the exact bug this spec guards against.
const actualAdrIndexer = await import('../../core/src/adr-indexer.js')
const mockProbeSpecCorpus = jest.fn()
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  ...actualAdrIndexer,
  runAdrIndex: jest.fn(),
  getAdrIndexStatus: jest.fn(),
  probeSpecCorpus: mockProbeSpecCorpus,
  LARGE_SPEC_FILE_LIMIT: 100,
  LARGE_SPEC_BYTE_LIMIT: 200 * 1024,
}))

const mockFindCandidateFiles = jest.fn(async () => [] as string[])
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

const SPECS_ROOT = '/workspace/test/docs/superpowers/specs'

/**
 * 会话 runtime 解析器的桩：defer 判定与 ADR 状态对象无关，这里只需要一个
 * 不会抛错的空 runtime（生产实现见 adr-runtime.ts）。
 */
function runtimeStub() {
  const rt = { root: '/workspace/test/docs/decisions', service: {}, anchorIndex: {}, tracker: {} }
  return { startup: rt, forExec: async () => rt, peek: () => rt }
}

function indexSpecsDef() {
  mockRegister.mockClear()
  const ctx = { tools: { register: mockRegister } } as any
  registerAdrTools(ctx, () => config as any, () => ({}) as any, runtimeStub())
  return mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]
}

/** N candidate paths, each reported by the probe as `bytes` long. */
function candidatesOf(n: number, bytes = 1024): { paths: string[]; sizes: Map<string, number> } {
  const paths = Array.from(
    { length: n },
    (_, i) => `${SPECS_ROOT}/2026-01-01-spec-${i}-design.md`,
  )
  return { paths, sizes: new Map(paths.map((p) => [p, bytes])) }
}

/** A probe result. `exceedsLargeSpecCorpus` describes the WHOLE corpus only. */
function probeOf(sizes: Map<string, number>, corpusFiles: number, corpusBytes: number) {
  return {
    files: [...sizes.keys()],
    fileCount: corpusFiles,
    totalBytes: corpusBytes,
    sizes,
    exceedsLargeSpecCorpus: corpusFiles > 100 || corpusBytes > 200 * 1024,
  }
}

describe('index_specs large-corpus deferral', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindCandidateFiles.mockResolvedValue([])
  })

  it('defers on the candidate set without generating frontmatter or indexing', async () => {
    // 101 candidates > 100-file limit, but only ~101 KiB — the decision must be
    // driven by the pending count, not the whole corpus.
    const { paths, sizes } = candidatesOf(101)
    mockFindCandidateFiles.mockResolvedValue(paths)
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 143, 320_000))

    // params.path makes planRoot empty, so findCandidateFiles is called once
    // and the candidate count is exactly 101.
    const result = await indexSpecsDef().execute({ path: SPECS_ROOT })

    expect(result.deferred).toBe(true)
    // Whole corpus, for reporting.
    expect(result.specFiles).toBe(143)
    expect(result.specBytes).toBe(320_000)
    // The actual decision inputs.
    expect(result.pendingFiles).toBe(101)
    expect(result.pendingBytes).toBe(101 * 1024)
    expect(result.nextCommand).toContain('--specs-only')
    expect(mockGenerateSpecFrontmatter).not.toHaveBeenCalled()
    // Candidates are now computed BEFORE the decision, so this flipped from
    // not.toHaveBeenCalled(): the predicate needs the candidate set.
    expect(mockFindCandidateFiles).toHaveBeenCalled()
    expect(mockWriteRunConfig).toHaveBeenCalledTimes(1)
  })

  it('defers on pending bytes even when the candidate count is small', async () => {
    const { paths, sizes } = candidatesOf(1, 200 * 1024 + 1)
    mockFindCandidateFiles.mockResolvedValue(paths)
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 1, 200 * 1024 + 1))

    const result = await indexSpecsDef().execute({ path: SPECS_ROOT })

    expect(result.deferred).toBe(true)
    expect(result.pendingFiles).toBe(1)
    expect(result.pendingBytes).toBe(200 * 1024 + 1)
    expect(mockGenerateSpecFrontmatter).not.toHaveBeenCalled()
  })

  it('does not defer when the corpus is over the limit but nothing is pending', async () => {
    // The regression this whole change fixes: every document already has
    // frontmatter, so there is zero work — yet the old whole-corpus check
    // deferred forever and sent the user to the terminal for nothing.
    mockFindCandidateFiles.mockResolvedValue([])
    mockProbeSpecCorpus.mockResolvedValue(probeOf(new Map(), 143, 320_000))

    const result = await indexSpecsDef().execute({ path: SPECS_ROOT })

    expect(result.deferred).toBeUndefined()
    expect(result.filesProcessed).toBe(0)
    expect(mockGenerateSpecFrontmatter).not.toHaveBeenCalled()
    expect(mockWriteRunConfig).not.toHaveBeenCalled()
  })

  it('does not defer a dry_run preview even when over the limit', async () => {
    const { paths, sizes } = candidatesOf(101)
    mockFindCandidateFiles.mockResolvedValue(paths)
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 143, 320_000))

    const result = await indexSpecsDef().execute({ path: SPECS_ROOT, dry_run: true })

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
    expect(mockWriteRunConfig).not.toHaveBeenCalled()
  })

  it('keeps the normal path when the candidate set is under the limit', async () => {
    const { paths, sizes } = candidatesOf(2, 50)
    mockFindCandidateFiles.mockResolvedValue(paths)
    // Corpus is over the limit — proves the decision ignores it now.
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 143, 320_000))

    const result = await indexSpecsDef().execute({ path: SPECS_ROOT })

    expect(result.deferred).toBeUndefined()
    expect(mockFindCandidateFiles).toHaveBeenCalled()
    expect(mockWriteRunConfig).not.toHaveBeenCalled()
  })

  it('renders the pending numbers, naming the corpus only when it differs', async () => {
    const { paths, sizes } = candidatesOf(101)
    mockFindCandidateFiles.mockResolvedValue(paths)
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 143, 320_000))

    const def = indexSpecsDef()
    const value = await def.execute({ path: SPECS_ROOT })
    const text = def.output.render({}, value)[0].text

    expect(text).toContain('101 篇待处理文档')
    expect(text).toContain('specs+plans 共 143 篇，本次需处理 101 篇')
  })

  it('omits the corpus line when every document is pending', async () => {
    const { paths, sizes } = candidatesOf(101)
    mockFindCandidateFiles.mockResolvedValue(paths)
    mockProbeSpecCorpus.mockResolvedValue(probeOf(sizes, 101, 101 * 1024))

    const def = indexSpecsDef()
    const value = await def.execute({ path: SPECS_ROOT })
    const text = def.output.render({}, value)[0].text

    expect(text).toContain('101 篇待处理文档')
    expect(text).not.toContain('specs+plans 共')
  })
})
