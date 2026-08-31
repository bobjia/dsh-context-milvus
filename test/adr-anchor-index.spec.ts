// test/adr-anchor-index.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { AdrAnchorIndex } = await import('../src/plugins/dsh-context-milvus/adr-anchor-index.js')

describe('AdrAnchorIndex', () => {
  let tempDir: string
  let index: AdrAnchorIndex

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'anchor-test-'))
    index = new AdrAnchorIndex(path.join(tempDir, 'anchors.json'))
  })

  it('starts empty', async () => {
    await index.load()
    expect(index.getAdrsForFile('src/test.ts')).toEqual([])
    expect(index.getStats().adrCount).toBe(0)
  })

  it('stores and retrieves file-to-ADR mapping', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    index.setAdr('ADR-0002', ['src/b.ts', 'src/c.ts'])
    expect(index.getAdrsForFile('src/a.ts')).toEqual(['ADR-0001'])
    expect(index.getAdrsForFile('src/b.ts')).toEqual(['ADR-0001', 'ADR-0002'])
    expect(index.getAdrsForFile('src/c.ts')).toEqual(['ADR-0002'])
    expect(index.getAdrsForFile('src/unknown.ts')).toEqual([])
  })

  it('returns files for a given ADR', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    expect(index.getFilesForAdr('ADR-0001')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(index.getFilesForAdr('ADR-unknown')).toEqual([])
  })

  it('removes ADR and its anchor mappings', () => {
    index.setAdr('ADR-0001', ['src/a.ts'])
    index.setAdr('ADR-0002', ['src/a.ts'])
    index.removeAdr('ADR-0001')
    expect(index.getAdrsForFile('src/a.ts')).toEqual(['ADR-0002'])
    expect(index.getStats().adrCount).toBe(1)
  })

  it('persists and reloads', async () => {
    index.setAdr('ADR-0001', ['src/a.ts'])
    await index.save()

    const index2 = new AdrAnchorIndex(path.join(tempDir, 'anchors.json'))
    await index2.load()
    expect(index2.getAdrsForFile('src/a.ts')).toEqual(['ADR-0001'])
    expect(index2.getStats().adrCount).toBe(1)
  })

  it('provides stats', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    index.setAdr('ADR-0002', ['src/c.ts'])
    const stats = index.getStats()
    expect(stats.adrCount).toBe(2)
    expect(stats.anchorCount).toBe(3)
  })
})