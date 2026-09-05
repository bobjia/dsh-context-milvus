import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliffsDelta, wilcoxonSignedRank, bootstrapMeanDiffCi, mulberry32 } from './stats.mjs'

test('cliffsDelta is -1 when all x < y', () => {
  assert.equal(cliffsDelta([0], [1]), -1)
})

test('cliffsDelta is 0 for identical paired samples', () => {
  assert.equal(cliffsDelta([1, 2], [1, 2]), 0)
})

test('cliffsDelta is 1 when all x > y', () => {
  assert.equal(cliffsDelta([2], [1]), 1)
})

test('wilcoxon p is large for no difference', () => {
  const { p, n } = wilcoxonSignedRank([0.5, 0.6, 0.55, 0.52, 0.58, 0.54, 0.53, 0.57], [0.5, 0.6, 0.55, 0.52, 0.58, 0.54, 0.53, 0.57])
  assert.equal(n, 0)
  assert.ok(Number.isNaN(p))
})

test('wilcoxon p is small for consistent positive shift', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const y = x.map((v) => v + 1)
  const { p } = wilcoxonSignedRank(x, y)
  assert.ok(p < 0.05)
})

test('bootstrap CI contains the sample mean', () => {
  const rng = mulberry32(42)
  const x = [1, 2, 3, 4, 5]
  const y = [0, 0, 0, 0, 0]
  const { mean, lo, hi } = bootstrapMeanDiffCi(x, y, { nBoot: 500, rng })
  assert.equal(mean, 3)
  assert.ok(lo <= mean && mean <= hi)
})

test('mulberry32 is deterministic for a seed', () => {
  const a = mulberry32(1)()
  const b = mulberry32(1)()
  assert.equal(a, b)
})
