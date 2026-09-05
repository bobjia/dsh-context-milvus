import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTasks } from './tasks.mjs'

test('loadTasks parses task list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tsk-'))
  const fp = path.join(dir, 't.json')
  await writeFile(fp, JSON.stringify({ tasks: [{ id: 't1', repo: 'a/b', baseCommit: 'x', goldPatch: 'p', testCommand: 'npm test' }] }))
  const ts = await loadTasks(fp)
  assert.equal(ts.length, 1)
  assert.equal(ts[0].id, 't1')
  await rm(dir, { recursive: true, force: true })
})

test('loadTasks rejects missing testCommand', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tsk-'))
  const fp = path.join(dir, 'bad.json')
  await writeFile(fp, JSON.stringify({ tasks: [{ id: 't1', repo: 'a/b', baseCommit: 'x', goldPatch: 'p' }] }))
  await assert.rejects(() => loadTasks(fp), /testCommand/)
  await rm(dir, { recursive: true, force: true })
})
