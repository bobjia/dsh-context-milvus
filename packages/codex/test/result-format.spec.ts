import {
  formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain, errorResult, okResult,
} from '../src/result-format.js'
import type { SearchResult } from 'dsh-context-milvus-core'

const sample: SearchResult = {
  filePath: '/repo/src/config.ts', content: 'export const A = 1',
  score: 0.8731, language: 'typescript',
  startLine: 12, endLine: 40, name: 'parseConfig', chunkType: 'function_declaration',
}

describe('formatSearchResults', () => {
  it('renders path, line range, name and score', () => {
    const text = formatSearchResults([sample])
    expect(text).toContain('/repo/src/config.ts')
    expect(text).toContain('12-40')
    expect(text).toContain('parseConfig')
    expect(text).toMatch(/0\.87/)
  })

  it('handles empty results', () => {
    expect(formatSearchResults([])).toContain('未找到')
  })
})

describe('tool result envelope', () => {
  it('wraps data in content + structuredContent', () => {
    const result = okResult({ totalFiles: 3 }, 'files: 3')
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'files: 3' })
    expect((result as any).structuredContent).toEqual({ totalFiles: 3 })
  })

  it('renders errors with code and hint only', () => {
    const result = errorResult('E_MILVUS_UNREACHABLE', '无法连接 Milvus', '请启动 Milvus 或修改 MILVUS_ADDRESS')
    expect(result.isError).toBe(true)
    expect((result as any).structuredContent).toBeUndefined()
    expect(result.content[0].text).toContain('E_MILVUS_UNREACHABLE')
    expect(result.content[0].text).toContain('请启动 Milvus')
  })
})

describe('other formatters', () => {
  it('formats index result numbers', () => {
    const text = formatIndexResult({
      filesIndexed: 2, chunksIndexed: 5, filesRemoved: 1,
      chunksRemoved: 3, filesSkipped: 9, durationMs: 1200,
    })
    expect(text).toContain('索引完成')
    expect(text).toContain('2')
  })

  it('formats status', () => {
    expect(formatStatus({ totalFiles: 4, totalChunks: 8, indexedExtensions: ['.ts'] }))
      .toContain('从未索引')
  })

  it('formats callers with warning', () => {
    const text = formatCallers({ chunks: [], warning: 'import map 未加载' })
    expect(text).toContain('import map 未加载')
  })

  it('formats an empty chain', () => {
    expect(formatChain({ chain: [] })).toContain('未找到调用链')
  })
})
