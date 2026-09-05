import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friedman, nemenyiCD, mcnemar, holm, chi2Survival } from './stats-agent.mjs'

test('chi2Survival df=1 is ~0.05 at x=3.841', () => {
  assert.ok(Math.abs(chi2Survival(3.841, 1) - 0.05) < 0.01)
})

test('chi2Survival df=2 is ~0.05 at x=5.991', () => {
  assert.ok(Math.abs(chi2Survival(5.991, 2) - 0.05) < 0.01)
})

test('friedman p is ~1 when all groups identical per block', () => {
  const matrix = [[0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0], [0.7, 0.7, 0.7], [0.3, 0.3, 0.3]]
  const { p } = friedman(matrix)
  assert.ok(Math.abs(p - 1) < 1e-9)
})

test('friedman p is small for consistent group separation', () => {
  const matrix = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.01, 0.5 + i * 0.01, 0.9 + i * 0.01])
  const { p } = friedman(matrix)
  assert.ok(p < 0.01)
})

test('nemenyiCD is positive and scales with group count', () => {
  const cd3 = nemenyiCD(20, 3)
  const cd4 = nemenyiCD(20, 4)
  assert.ok(cd3 > 0)
  assert.ok(cd4 > cd3)
})

test('mcnemar is significant when b much larger than c', () => {
  const { p } = mcnemar(10, 2)
  assert.ok(p < 0.05)
})

test('mcnemar p is large (not significant) when b equals c', () => {
  const { p } = mcnemar(3, 3)
  assert.ok(p > 0.5)
})

test('holm rejects strong effects and stops at the first weak one', () => {
  const reject = holm([0.01, 0.04, 0.05], 0.05)
  assert.deepEqual(reject, [true, false, false])
})

test('holm rejects all when all p-values are tiny', () => {
  const reject = holm([0.001, 0.002, 0.003], 0.05)
  assert.deepEqual(reject, [true, true, true])
})
