/**
 * Reranker tests.
 *
 * Covers: term overlap, name match bonus, edge cases.
 */
import { describe, expect, test } from '@jest/globals'
import type { SearchResult } from '../src/plugins/dsh-context-milvus/types.js'

describe('reranker', () => {
  let rerankResults: (query: string, results: SearchResult[], topK: number) => SearchResult[]

  beforeAll(async () => {
    const mod = await import('../src/plugins/dsh-context-milvus/reranker.js')
    rerankResults = mod.rerankResults
  })

  function makeResult(overrides: Partial<SearchResult> & { filePath: string }): SearchResult {
    return {
      filePath: overrides.filePath,
      content: overrides.content ?? 'some code content',
      score: overrides.score ?? 0.5,
      language: overrides.language ?? 'typescript',
      startLine: overrides.startLine ?? 1,
      endLine: overrides.endLine ?? 10,
      name: overrides.name ?? '',
      chunkType: overrides.chunkType ?? 'function_declaration',
    }
  }

  test('returns single result unchanged', () => {
    const r = [makeResult({ filePath: 'a.ts' })]
    expect(rerankResults('test', r, 5)).toEqual(r)
  })

  test('returns empty array for empty input', () => {
    expect(rerankResults('test', [], 5)).toEqual([])
  })

  test('boosts results whose name matches query term', () => {
    const results = [
      makeResult({ filePath: 'a.ts', name: 'otherFunc', score: 0.8 }),
      makeResult({ filePath: 'b.ts', name: 'loginUser', score: 0.7 }),
    ]
    // loginUser: nameMatch=1 → proven file → 15% reinforcement
    // Score: 0.7 * (1 + 0.15) * 1.15 = 0.92575
    // otherFunc: 0.8
    // loginUser wins
    const reranked = rerankResults('login function', results, 2)
    expect(reranked[0].name).toBe('loginUser')
  })

  test('preserves base-score order when no query terms match', () => {
    // Query "test query" — "test" and "query" don't appear in default content
    // "some code content", so no overlap/name boost → order by base score
    const results = [
      makeResult({ filePath: 'a.ts', score: 0.9, name: 'testParser' }),
      makeResult({ filePath: 'a.ts', score: 0.8 }),
      makeResult({ filePath: 'a.ts', score: 0.7 }),
      makeResult({ filePath: 'a.ts', score: 0.6 }),
      makeResult({ filePath: 'b.ts', score: 0.5 }),
    ]
    const reranked = rerankResults('test query', results, 5)
    // No term overlap, no name match → order by base score
    const order = reranked.map((r) => r.filePath)
    expect(order).toEqual(['a.ts', 'a.ts', 'a.ts', 'a.ts', 'b.ts'])
    expect(reranked).toHaveLength(5)
  })

  test('returns topK results', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ filePath: `f${i}.ts`, score: 0.9 - i * 0.05 }),
    )
    const reranked = rerankResults('test', results, 3)
    expect(reranked).toHaveLength(3)
  })

  test('term overlap boosts results containing query terms', () => {
    const results = [
      makeResult({ filePath: 'a.ts', content: 'function add(a, b) { return a + b }', score: 0.55 }),
      makeResult({ filePath: 'b.ts', content: 'class User { constructor(name) { this.name = name } }', score: 0.6 }),
    ]
    // Query "add numbers" → "add" matches in a.ts, "numbers" doesn't
    // a.ts: 0.55 * (1 + 0.5*0.3) = 0.6325, b.ts: 0.6 → a.ts wins
    const reranked = rerankResults('add numbers', results, 2)
    expect(reranked[0].filePath).toBe('a.ts')
  })

  test('preserves base-score order across different files', () => {
    const results = [
      makeResult({ filePath: 'a.ts', score: 0.9, name: 'foo' }),
      makeResult({ filePath: 'b.ts', score: 0.7, name: 'bar' }),
      makeResult({ filePath: 'c.ts', score: 0.5, name: 'baz' }),
    ]
    const reranked = rerankResults('test', results, 3)
    // All from different files, no query terms match → order by base score
    expect(reranked[0].filePath).toBe('a.ts')
    expect(reranked[1].filePath).toBe('b.ts')
    expect(reranked[2].filePath).toBe('c.ts')
  })
})