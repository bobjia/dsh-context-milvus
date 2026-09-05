import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadDataset } from './dataset.mjs'

test('loadDataset parses queries and relevantFiles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-'))
  const fp = path.join(dir, 'd.json')
  await writeFile(fp, JSON.stringify({ queries: [{ query: 'q', relevantFiles: ['a.ts'] }] }))
  const qs = await loadDataset(fp)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].query, 'q')
  await rm(dir, { recursive: true, force: true })
})

test('loadDataset rejects missing query fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-'))
  const fp = path.join(dir, 'bad.json')
  await writeFile(fp, JSON.stringify({ queries: [{ query: 'q' }] }))
  await assert.rejects(() => loadDataset(fp), /relevantFiles/)
  await rm(dir, { recursive: true, force: true })
})
