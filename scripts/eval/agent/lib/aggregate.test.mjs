import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskSuccessFraction, medianOfRun } from './aggregate.mjs'

test('taskSuccessFraction is runs-passed over runs', () => {
  assert.equal(taskSuccessFraction([{ passed: true }, { passed: false }, { passed: true }]), 2 / 3)
  assert.equal(taskSuccessFraction([{ passed: false }]), 0)
})

test('medianOfRun returns median value for odd count', () => {
  assert.equal(medianOfRun([{ tokens: 3 }, { tokens: 1 }, { tokens: 2 }], 'tokens'), 2)
})

test('medianOfRun averages middle two for even count', () => {
  assert.equal(medianOfRun([{ tokens: 4 }, { tokens: 2 }], 'tokens'), 3)
})
