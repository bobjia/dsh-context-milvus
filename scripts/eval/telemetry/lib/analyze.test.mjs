import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonl, groupByTool, quartiles, bootstrapCi, pearson } from './analyze.mjs'
import { mulberry32 } from '../../retrieval/lib/stats.mjs'

test('parseJsonl skips malformed lines', () => {
  const es = parseJsonl('{"tool":"a"}\nnot json\n\n{"tool":"b"}\n')
  assert.equal(es.length, 2)
  assert.equal(es[0].tool, 'a')
})

test('groupByTool groups entries by tool', () => {
  const g = groupByTool([{ tool: 'a' }, { tool: 'b' }, { tool: 'a' }])
  assert.equal(g.a.length, 2)
  assert.equal(g.b.length, 1)
})

test('quartiles median of odd array is middle', () => {
  assert.equal(quartiles([3, 1, 2]).median, 2)
})

test('bootstrapCi contains the sample mean', () => {
  const rng = mulberry32(9)
  const { mean, lo, hi } = bootstrapCi([1, 2, 3, 4, 5], { nBoot: 500, rng })
  assert.equal(mean, 3)
  assert.ok(lo <= mean && mean <= hi)
})

test('pearson is 1 for perfectly correlated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [4, 5, 6]) - 1) < 1e-9)
})

test('pearson is ~0 for uncorrelated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [1, 1, 1])) < 1e-9)
})
