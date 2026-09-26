// test/telemetry-search-semantics.spec.ts
//
// 遥测只记 topScore、不记分数语义，事后无法反解。真实数据（2026-09-25，
// ~/.milvus-index/telemetry.jsonl）17 条 search_code 的 topScore 全挤在
// 0.0271–0.0328，无法据此判断这是 RRF 名次编码还是余弦相似度——按相似度读
// 会得出「检索质量极差」的反向结论（实测反解后 top-1 的真实名次中位数是 2）。
//
// 因此条目必须自带 scoreKind（来自 SearchResult，见 ADR-0009）与 bm25RrfK，
// 否则 RRF 分 Σ 1/(k+名次) 不可反解（k 在分数上不可辨识）。

import { jest } from '@jest/globals'

const mockRegister = jest.fn(() => jest.fn())
const mockDefineTool = jest.fn((opts: any) => opts)

jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

// 与 score-display.spec.ts 同款：core barrel 用命名再导出，所以每个 mock 都要
// 铺开真实模块、只覆盖被测点，否则 barrel 链接期就会失败。
const actualAdrIndexer = await import('../../core/src/adr-indexer.js')
jest.unstable_mockModule('../../core/src/adr-indexer.js', () => ({
  ...actualAdrIndexer,
  runAdrIndex: jest.fn(),
  getAdrIndexStatus: jest.fn(),
}))

const actualIndexer = await import('../../core/src/indexer.js')
jest.unstable_mockModule('../../core/src/indexer.js', () => ({
  ...actualIndexer,
  runIndex: jest.fn(),
  getIndexStatus: jest.fn(),
}))

class MockHashTracker {
  constructor(_path: string) {}
  async load() {}
  async save() {}
  computeDelta() { return { toIndex: [], toRemove: [], unchanged: [] } }
  getStats() { return { totalFiles: 0, totalChunks: 0 } }
  getLastIndexedTimestamp() { return null }
}
jest.unstable_mockModule('../../core/src/merkle.js', () => ({
  HashTracker: MockHashTracker,
}))

// 只替换落盘 sink，sanitizeQuery 等保持真实，条目内容仍是真实产物。
const logged: any[] = []
const actualTelemetry = await import('../../core/src/telemetry.js')
jest.unstable_mockModule('../../core/src/telemetry.js', () => ({
  ...actualTelemetry,
  createTelemetry: () => ({ log: (e: any) => logged.push(e), flush: async () => {} }),
}))

const { registerTools } = await import('../src/plugins/dsh-context-milvus/tools.js')

describe('search_code telemetry score semantics', () => {
  let ctx: any
  let milvus: any

  beforeEach(() => {
    jest.clearAllMocks()
    logged.length = 0
    ctx = { tools: { register: mockRegister } }
    milvus = { ensureCollection: jest.fn(async () => {}), lastSearchMeta: undefined, search: jest.fn() }
  })

  function searchCodeDef(config: any = {}) {
    registerTools(
      ctx,
      () => ({ adrEnabled: false, indexRoot: '/workspace/test', bm25RrfK: 60, ...config }) as any,
      () => milvus,
      () => new MockHashTracker('/tmp/test') as any,
    )
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_code')?.[0]
    expect(def).toBeDefined()
    return def
  }

  /** 让 milvus.search 同时给出结果与 lastSearchMeta，模拟真实服务的行为。 */
  function stubSearch(results: any[]) {
    milvus.search.mockImplementation(async () => {
      milvus.lastSearchMeta = {
        queryExpansionApplied: false,
        originalQuery: 'q',
        effectiveQuery: 'q',
        rerankEnabled: true,
        rerankTop1Flipped: false,
        rerankFlipCount: 0,
        resultFilePaths: results.map((r: any) => r.filePath),
      }
      return results
    })
  }

  const rrfResult = () => ({
    filePath: '/repo/src/a.ts', content: 'const a = 1', score: 0.031513646,
    scoreKind: 'rrf', language: 'typescript', startLine: 1, endLine: 2,
    name: 'a', chunkType: 'function_declaration',
  })

  async function lastEntry() {
    const def = searchCodeDef()
    await def.execute({ query: 'q', topK: 5 })
    const entry = logged.find((e) => e.tool === 'search_code')
    expect(entry).toBeDefined()
    return entry
  }

  it('records scoreKind: rrf so an RRF score cannot be read as a similarity', async () => {
    stubSearch([rrfResult()])
    expect((await lastEntry()).scoreKind).toBe('rrf')
  })

  it('records bm25RrfK so the RRF score can be inverted back to a rank', async () => {
    stubSearch([rrfResult()])
    expect((await lastEntry()).bm25RrfK).toBe(60)
  })

  it('records scoreKind: similarity when the collection fell back to dense-only', async () => {
    stubSearch([{ ...rrfResult(), score: 0.7412, scoreKind: 'similarity' }])
    expect((await lastEntry()).scoreKind).toBe('similarity')
  })

  it('treats a missing scoreKind as similarity, matching ADR-0009 defaults', async () => {
    const { scoreKind, ...withoutKind } = rrfResult()
    stubSearch([withoutKind])
    expect((await lastEntry()).scoreKind).toBe('similarity')
  })

  it('records null scoreKind when the search returned nothing', async () => {
    stubSearch([])
    const entry = await lastEntry()
    expect(entry.topScore).toBeNull()
    expect(entry.scoreKind).toBeNull()
  })
})
