// test/score-display.spec.ts
//
// 混合检索（hybridMode，Milvus RRF 融合）下 score 是名次的倒数编码，不是相似度。
// 适配器必须据此改口：similarity 照旧显示「相关度: 0.xxxx」，rrf 只显示名次。
//
// formatSearchResults / formatAdrSearchResults 都是模块私有函数，所以按
// adr-tools.spec.ts 的既有做法，通过注册后的工具定义 output.render 间接测试。

import { jest } from '@jest/globals'

// Mock dsh-tools
const mockRegister = jest.fn(() => jest.fn())  // returns a disposer function
const mockDefineTool = jest.fn((opts: any) => opts)

jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

// tools.ts / adr-tools.ts import the core barrel, which re-exports MilvusService;
// that module loads the Milvus SDK at import time, so stub the SDK here.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

// The core barrel re-exports these modules with *named* re-exports, so each mock
// has to satisfy every name the barrel lists: spread the real module and override
// only what the subject touches (a hand-written export list fails at link time).
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

const { registerTools } = await import('../src/plugins/dsh-context-milvus/tools.js')
const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

/** 混合检索的说明行：每个输出只出现一次，且位于第一条结果之前。 */
const RRF_NOTE = '（混合检索：结果按 RRF 融合排序，仅提供名次，不提供绝对相似度分值。）'

describe('search_code score display', () => {
  let ctx: any
  let milvus: any

  beforeEach(() => {
    jest.clearAllMocks()
    ctx = { tools: { register: mockRegister } }
    milvus = { search: jest.fn().mockResolvedValue([]) }
  })

  function searchCodeDef() {
    registerTools(
      ctx,
      () => ({ adrEnabled: false, indexRoot: '/workspace/test' }) as any,
      () => milvus,
      () => new MockHashTracker('/tmp/test') as any,
    )
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_code')?.[0]
    expect(def).toBeDefined()
    return def
  }

  const result = (over: any = {}) => ({
    filePath: '/repo/src/a.ts', content: 'const a = 1', score: 0.74,
    language: 'typescript', startLine: 1, endLine: 2, name: 'a',
    chunkType: 'function_declaration', ...over,
  })

  it('keeps the legacy line byte-identical when scoreKind is absent', () => {
    const rendered = searchCodeDef().output.render({}, [result()])
    expect(rendered[0].text).toBe([
      '[结果 1] 文件: /repo/src/a.ts (typescript), 第 1-2 行 「a」',
      '相关度: 0.7400',
      '类型: function_declaration',
      '内容:',
      '```typescript',
      'const a = 1',
      '```',
    ].join('\n'))
  })

  it('prints 相关度 for an explicit similarity kind', () => {
    const rendered = searchCodeDef().output.render({}, [result({ scoreKind: 'similarity' })])
    expect(rendered[0].text).toContain('相关度: 0.7400')
    expect(rendered[0].text).not.toContain('排序:')
  })

  it('prints the rank, not the RRF fusion score, with one note line up front', () => {
    const rendered = searchCodeDef().output.render({}, [
      result({ score: 0.0164, scoreKind: 'rrf' }),
      result({ filePath: '/repo/src/b.ts', score: 0.0161, scoreKind: 'rrf' }),
    ])
    const text = rendered[0].text
    // The RRF score is a rank encoding — showing it as 相关度 is the bug.
    expect(text).not.toContain('相关度:')
    expect(text).not.toContain('0.0164')
    expect(text).toContain('排序: 1/2')
    expect(text).toContain('排序: 2/2')
    expect(text.startsWith(RRF_NOTE + '\n')).toBe(true)
    // Exactly once per output, not once per result.
    expect(text.split(RRF_NOTE)).toHaveLength(2)
  })

  it('declares scoreKind in the output schema (additionalProperties: false)', () => {
    const def = searchCodeDef()
    expect(def.output.schema.items.properties.scoreKind).toEqual({ type: 'string' })
  })
})

describe('search_adr score display', () => {
  let ctx: any
  let milvus: any
  let adrService: any
  let anchorIndex: any
  let runtime: any

  beforeEach(() => {
    jest.clearAllMocks()
    ctx = { tools: { register: mockRegister } }
    milvus = { searchAdr: jest.fn().mockResolvedValue([]), ensureAdrCollection: jest.fn() }
    adrService = {
      createAdr: jest.fn(), updateAdr: jest.fn(), listAdrs: jest.fn(),
      loadAdr: jest.fn(), getActiveConstraints: jest.fn(),
    }
    anchorIndex = { getAdrsForFile: jest.fn(), getStats: jest.fn(), getAll: jest.fn() }
    // 会话 runtime 解析器的桩（生产实现见 adr-runtime.ts）。
    const rt = { root: '/test/docs/decisions', service: adrService, anchorIndex, tracker: {} }
    runtime = { startup: rt, forExec: jest.fn(async () => rt), peek: jest.fn(() => rt) }
  })

  function searchAdrDef() {
    registerAdrTools(ctx, () => ({ adrEnabled: true }) as any, () => milvus, runtime)
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    expect(def).toBeDefined()
    return def
  }

  const result = (over: any = {}) => ({
    adrId: 'ADR-0001', docType: 'adr', filePath: '/docs/a.md', status: 'active',
    section: '背景', content: 'body', score: 0.7412, triggerType: 'refactor',
    codeAnchors: [], ...over,
  })

  it('keeps the legacy line byte-identical when scoreKind is absent', () => {
    const rendered = searchAdrDef().output.render({}, [result()])
    expect(rendered[0].text).toBe([
      '[结果 1] ADR: ADR-0001 (active), 章节: 背景',
      '文件: /docs/a.md',
      '相关度: 0.7412',
      '内容:',
      'body',
    ].join('\n'))
  })

  it('prints the rank, not the RRF fusion score, with one note line up front', () => {
    const rendered = searchAdrDef().output.render({}, [result({ score: 0.0164, scoreKind: 'rrf' })])
    const text = rendered[0].text
    expect(text).not.toContain('相关度:')
    expect(text).toContain('排序: 1/1')
    expect(text.startsWith(RRF_NOTE + '\n')).toBe(true)
  })

  it('declares scoreKind in the output schema (additionalProperties: false)', () => {
    const def = searchAdrDef()
    expect(def.output.schema.items.properties.scoreKind).toEqual({ type: 'string' })
  })
})
