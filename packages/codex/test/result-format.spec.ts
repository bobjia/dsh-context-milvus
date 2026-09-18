import {
  formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain, errorResult, okResult,
  formatAdrSearch,
} from '../src/result-format.js'
import type { SearchResult, AdrSearchResult } from 'dsh-context-milvus-core'

/** 混合检索的说明行：每个输出只出现一次，且位于第一条结果之前。 */
const RRF_NOTE = '（混合检索：结果按 RRF 融合排序，仅提供名次，不提供绝对相似度分值。）'

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

describe('formatSearchResults score display', () => {
  it('keeps the legacy output byte-identical when scoreKind is absent', () => {
    expect(formatSearchResults([sample])).toBe([
      '[结果 1] 文件: /repo/src/config.ts (typescript), 第 12-40 行 「parseConfig」',
      '相关度: 0.8731',
      '类型: function_declaration',
      '内容:',
      '```typescript',
      'export const A = 1',
      '```',
    ].join('\n'))
  })

  it('prints 相关度 for an explicit similarity kind', () => {
    const text = formatSearchResults([{ ...sample, scoreKind: 'similarity' }])
    expect(text).toContain('相关度: 0.8731')
    expect(text).not.toContain('排序:')
  })

  it('prints the rank, not the RRF fusion score, with one note line up front', () => {
    const results: SearchResult[] = [
      { ...sample, score: 0.0164, scoreKind: 'rrf' },
      { ...sample, filePath: '/repo/src/b.ts', score: 0.0161, scoreKind: 'rrf' },
    ]
    const text = formatSearchResults(results)
    // The RRF score is a rank encoding, so printing it as 相关度 is the bug.
    expect(text).not.toContain('相关度:')
    expect(text).not.toContain('0.0164')
    expect(text).toContain('排序: 1/2')
    expect(text).toContain('排序: 2/2')
    expect(text.startsWith(RRF_NOTE + '\n')).toBe(true)
    // Exactly once per output, not once per result.
    expect(text.split(RRF_NOTE)).toHaveLength(2)
  })
})

describe('formatAdrSearch score display', () => {
  const adr = (over: Partial<AdrSearchResult> = {}): AdrSearchResult => ({
    adrId: 'ADR-0001', docType: 'adr', filePath: '/docs/a.md', status: 'active',
    section: '背景', content: 'body', score: 0.7412, triggerType: 'refactor',
    codeAnchors: [], ...over,
  })

  it('keeps the legacy output byte-identical when scoreKind is absent', () => {
    expect(formatAdrSearch([adr()])).toBe([
      '[结果 1] ADR: ADR-0001 (active), 章节: 背景',
      '文件: /docs/a.md',
      '相关度: 0.7412',
      '内容:',
      'body',
    ].join('\n'))
  })

  it('prints the rank, not the RRF fusion score, with one note line up front', () => {
    const text = formatAdrSearch([adr({ score: 0.0164, scoreKind: 'rrf' })])
    expect(text).not.toContain('相关度:')
    expect(text).toContain('排序: 1/1')
    expect(text.startsWith(RRF_NOTE + '\n')).toBe(true)
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
