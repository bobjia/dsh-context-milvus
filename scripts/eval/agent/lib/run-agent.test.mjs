import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentOnce } from './run-agent.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const driver = path.join(__dirname, '..', 'drivers', 'simulated.mjs')

test('runAgentOnce parses driver JSON output', async () => {
  const r = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'P', root: '/tmp' })
  assert.equal(typeof r.passed, 'boolean')
  assert.ok(Number.isInteger(r.tokens) && r.tokens > 0)
  assert.ok(Number.isInteger(r.toolCalls) && r.toolCalls > 0)
  assert.ok(Number.isInteger(r.durationMs) && r.durationMs > 0)
})

test('runAgentOnce is deterministic for same task+group', async () => {
  const a = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'G', root: '/tmp' })
  const b = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'G', root: '/tmp' })
  assert.deepEqual(a, b)
})
