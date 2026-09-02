import { describe, expect, test, jest } from '@jest/globals'

// Mock the Milvus module
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({
    // mock methods as needed
  })),
  DataType: {
    Int64: 5,
    FloatVector: 101,
    VarChar: 21,
    Int32: 4,
    SparseFloatVector: 104,
  },
  MetricType: { COSINE: 'COSINE' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'RRF' },
  load: jest.fn(),
}))

describe('code-relations', () => {
  // ── Denoising ──────────────────────────────────────────────────────

  test('isNoiseSymbol filters single-character symbols', async () => {
    const { isNoiseSymbol } = await import('../src/plugins/dsh-context-milvus/code-relations.js')
    expect(isNoiseSymbol('a')).toBe(true)
    expect(isNoiseSymbol('x')).toBe(true)
    expect(isNoiseSymbol('ab')).toBe(false)
    expect(isNoiseSymbol('foo')).toBe(false)
  })

  test('isNoiseSymbol filters stop words', async () => {
    const { isNoiseSymbol } = await import('../src/plugins/dsh-context-milvus/code-relations.js')
    expect(isNoiseSymbol('data')).toBe(true)
    expect(isNoiseSymbol('config')).toBe(true)
    expect(isNoiseSymbol('result')).toBe(true)
    expect(isNoiseSymbol('parseConfig')).toBe(false)
  })

  // ── findCallers ────────────────────────────────────────────────────

  test('findCallers backward returns chunks that reference the symbol', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string) => {
      return [
        { filePath: 'src/a.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'callerA' },
        { filePath: 'src/b.ts', content: '...', startLine: 5, endLine: 15, chunkType: 'function_declaration', name: 'callerB' },
      ]
    }

    const result = await findCallers(mockFindBySymbol as any, 'targetFn', 'backward')
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0].name).toBe('callerA')
    expect(result.chunks[1].name).toBe('callerB')
  })

  test('findCallers returns empty for noise symbols', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async () => [{ filePath: 'x.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'x' }]

    const result = await findCallers(mockFindBySymbol as any, 'a', 'backward')  // single char
    expect(result.chunks).toHaveLength(0)
  })

  test('findCallers forward returns definition chunks', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string) => {
      return [
        { filePath: 'src/def.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'myFunc' },
      ]
    }

    const result = await findCallers(mockFindBySymbol as any, 'myFunc', 'forward')
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].filePath).toBe('src/def.ts')
  })

  // ── traceChain BFS ─────────────────────────────────────────────────

  test('traceChain BFS traverses backward chain', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string, limit: number) => {
      if (symbol === 'main') {
        return [{ filePath: 'src/index.ts', content: '', startLine: 1, endLine: 5, chunkType: 'function', name: 'runApp' }]
      }
      if (symbol === 'runApp') {
        return [{ filePath: 'src/app.ts', content: '', startLine: 10, endLine: 20, chunkType: 'function', name: 'initConfig' }]
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'main', { maxDepth: 3 })
    expect(result.chain.length).toBeGreaterThanOrEqual(2)
    expect(result.chain[0].symbol).toBe('main')
    expect(result.chain[0].callers).toContain('runApp')
  })

  test('traceChain respects maxDepth', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    let callCount = 0
    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      callCount++
      return [{ filePath: 'f.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'next' }]
    }

    await traceChain(mockFindBySymbol as any, 'start', { maxDepth: 1 })
    // With maxDepth=1, only the first level is searched (no expansion)
    expect(callCount).toBe(1)
  })

  test('traceChain prevents cycles', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      // Cycle: funcA → funcB → funcA
      if (symbol === 'funcA') {
        return [{ filePath: 'a.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'funcB' }]
      }
      if (symbol === 'funcB') {
        return [{ filePath: 'b.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'funcA' }]
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'funcA', { maxDepth: 5 })
    // Should not infinite loop
    expect(result.chain.length).toBeLessThanOrEqual(5)
    // Should have visited funcA and funcB (2 unique symbols)
    const symbols = result.chain.map(n => n.symbol)
    expect(symbols).toContain('funcA')
    expect(symbols).toContain('funcB')
  })

  test('traceChain returns empty for noise entry symbol', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async () => [{ filePath: 'f.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'x' }]

    const result = await traceChain(mockFindBySymbol as any, 'data', { maxDepth: 3 })  // stop word
    expect(result.chain).toHaveLength(0)
  })

  test('traceChain forward traverses callees via references', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      if (dir === 'forward') {
        if (symbol === 'main') {
          return [{ filePath: 'src/index.ts', content: '', startLine: 1, endLine: 5, chunkType: 'function', name: 'main', references: ['runApp'] }]
        }
        if (symbol === 'runApp') {
          return [{ filePath: 'src/app.ts', content: '', startLine: 10, endLine: 20, chunkType: 'function', name: 'runApp', references: ['initConfig'] }]
        }
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'main', { direction: 'forward', maxDepth: 3 })
    expect(result.chain.length).toBeGreaterThanOrEqual(2)
    expect(result.chain[0].callers).toContain('runApp')  // main calls runApp
    expect(result.chain[1].symbol).toBe('runApp')
    expect(result.chain[1].callers).toContain('initConfig')  // runApp calls initConfig
  })

  test('traceChain handles empty result mid-chain', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      if (symbol === 'entry') {
        return [{ filePath: 'e.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'leaf' }]
      }
      return []  // 'leaf' has no callers
    }

    const result = await traceChain(mockFindBySymbol as any, 'entry', { maxDepth: 3 })
    expect(result.chain).toHaveLength(2)  // entry → leaf
    expect(result.chain[0].callers).toContain('leaf')  // entry is referenced by leaf
    expect(result.chain[1].callers).toHaveLength(0)  // leaf has no further callers
  })
})