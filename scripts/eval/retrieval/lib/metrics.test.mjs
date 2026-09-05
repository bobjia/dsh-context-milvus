import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, hitAtK, precisionAtK, mrr, ndcgAtK } from './metrics.mjs'

test('recall@k counts unique relevant hits over total relevant', () => {
  assert.equal(recallAtK(['a', 'b', 'c'], ['b', 'z'], 3), 0.5)
  assert.equal(recallAtK(['a', 'a', 'b'], ['a', 'c'], 3), 0.5) // dedup 'a'
  assert.equal(recallAtK([], ['a'], 10), 0)
})

test('hitAtK is 1 if any relevant appears in top-k', () => {
  assert.equal(hitAtK(['x', 'a'], ['a'], 2), 1)
  assert.equal(hitAtK(['x', 'y'], ['a'], 2), 0)
})

test('precisionAtK is relevant count over k', () => {
  assert.equal(precisionAtK(['a', 'b'], ['a', 'z'], 2), 0.5)
  assert.equal(precisionAtK(['a', 'a', 'b'], ['a'], 3), 0.5)
})

test('mrr is reciprocal rank of first relevant', () => {
  assert.equal(mrr(['a', 'b', 'c'], ['c']), 1 / 3)
  assert.equal(mrr(['a', 'b'], ['a']), 1)
  assert.equal(mrr(['a', 'b'], ['z']), 0)
})

test('ndcg@k equals 1 for perfect ordering', () => {
  assert.ok(Math.abs(ndcgAtK(['a', 'b'], ['a', 'b'], 2) - 1) < 1e-9)
  assert.ok(ndcgAtK(['z', 'a'], ['a'], 2) < 1)
})
