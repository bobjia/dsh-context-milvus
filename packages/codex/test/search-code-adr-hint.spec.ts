import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const { handleSearchCode } = await import('../src/handlers.js')
const { appendAdrHints, formatSearchResults } = await import('../src/result-format.js')
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-hint-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

// Built per test: `root` only exists once beforeEach has created it.
function hit(over: Record<string, unknown> = {}) {
  return {
    filePath: path.join(root, 'src', 'queue.ts'), content: 'code', score: 0.5,
    language: 'typescript', startLine: 1, endLine: 2, name: 'push', chunkType: 'function',
    ...over,
  }
}

function makeServices(adr?: any): HandlerServices {
  return {
    root,
    config: getConfig({ indexRoot: root }),
    milvus: { ensureCollection: jest.fn(async () => {}), search: jest.fn(async () => [hit()]) } as any,
    tracker: { getStats: () => ({ totalFiles: 1, totalChunks: 1 }),
               getLastIndexedTimestamp: () => Date.now() } as any,
    importResolver: {} as any,
    adr,
  }
}

function coveredAdr() {
  return {
    exists: true,
    adrRoot: path.join(root, 'docs', 'decisions'),
    anchorIndex: { getAdrsForFile: (f: string) => f === 'src/queue.ts' ? ['ADR-0003-retry-queue'] : [] },
    titles: async () => new Map([['ADR-0003-retry-queue', { title: '使用重试队列隔离下游故障', status: 'active' }]]),
  }
}

describe('search_code ADR hint', () => {
  it('reports no related ADRs when the bundle is absent', async () => {
    const s = makeServices()
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toEqual([])
  })

  it('maps hit files through the anchor index', async () => {
    const s = makeServices(coveredAdr())
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toEqual([
      { adrId: 'ADR-0003-retry-queue', title: '使用重试队列隔离下游故障', status: 'active' },
    ])
  })

  it('accepts both relative and absolute anchor index keys', async () => {
    const s = makeServices({
      ...coveredAdr(),
      anchorIndex: { getAdrsForFile: (f: string) => f === path.join(root, 'src/queue.ts') ? ['ADR-0007'] : [] },
      titles: async () => new Map([['ADR-0007', { title: 't', status: 'active' }]]),
    })
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toHaveLength(1)
  })

  it('deduplicates one ADR covering several hits', async () => {
    const s = makeServices(coveredAdr())
    ;(s.milvus.search as jest.Mock).mockResolvedValue([hit(), hit()])
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    expect(out.relatedAdrs).toHaveLength(1)
  })

  it('leaves the text byte-identical when nothing is covered', async () => {
    const plain = makeServices()
    const out = await handleSearchCode(async () => plain, silentLogger, { path: root, query: 'q' })
    expect(appendAdrHints(formatSearchResults(out.results), out.relatedAdrs))
      .toBe(formatSearchResults(out.results))
  })

  it('appends exactly one 相关决策 line when covered', async () => {
    const s = makeServices(coveredAdr())
    const out = await handleSearchCode(async () => s, silentLogger, { path: root, query: 'q' })
    const text = appendAdrHints(formatSearchResults(out.results), out.relatedAdrs)
    const lines = text.split('\n')
    expect(lines[lines.length - 1]).toBe(
      '相关决策: ADR-0003-retry-queue 使用重试队列隔离下游故障 (active)',
    )
    expect(lines.filter((l) => l.startsWith('相关决策:'))).toHaveLength(1)
    expect(text).toContain('[结果 1]')
  })
})
