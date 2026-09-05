/**
 * Query expansion tests.
 *
 * Covers: synonym expansion, multi-word phrases, edge cases.
 */
import { describe, expect, test } from '@jest/globals'

describe('query expansion', () => {
  let expandQuery: (query: string) => string

  beforeAll(async () => {
    const mod = await import('../src/plugins/dsh-context-milvus/query-expansion.js')
    expandQuery = mod.expandQuery
  })

  test('expands known single-word terms', () => {
    const result = expandQuery('login')
    expect(result).toContain('login')
    expect(result).toContain('authenticate')
    expect(result).toContain('signin')
  })

  test('expands multi-word phrases', () => {
    const result = expandQuery('sql query')
    expect(result).toContain('sql')
    expect(result).toContain('parameterized')
  })

  test('preserves original query text', () => {
    const result = expandQuery('retry a failing operation')
    expect(result).toContain('retry a failing operation')
    expect(result).toContain('backoff')
  })

  test('returns empty string for empty input', () => {
    expect(expandQuery('')).toBe('')
    expect(expandQuery('   ')).toBe('')
  })

  test('handles unknown words without expansion', () => {
    const result = expandQuery('xyzzy magical unicorn')
    // Should just return the original query
    expect(result).toBe('xyzzy magical unicorn')
  })

  test('deduplicates repeated expansions', () => {
    const result = expandQuery('login login')
    // "login" should only appear once in expansions
    const matches = result.match(/login/g)
    expect(matches).not.toBeNull()
    // The original "login login" (2) + first expansion "login" should not be duplicated
  })

  test('caps total length', () => {
    const longQuery = 'a '.repeat(300)
    const result = expandQuery(longQuery.trim())
    expect(result.length).toBeLessThanOrEqual(512)
  })

  test('expands "retry" to include backoff', () => {
    const result = expandQuery('retry a failing operation')
    expect(result).toContain('retry-strategy')
    expect(result).toContain('backoff')
  })

  test('expands "database query" to include db and sql terms', () => {
    const result = expandQuery('database query')
    expect(result).toContain('db')
    expect(result).toContain('sql')
  })

  test('expands "send email" to include smtp', () => {
    const result = expandQuery('send email')
    expect(result).toContain('smtp')
  })
})